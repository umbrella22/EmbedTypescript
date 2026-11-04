use crate::{
    CallState, Draw, Host, HostError, HostReply, HostRequest, MemoryStats, Package, RawAllocator,
    Request, RequestId,
};
#[cfg(test)]
mod allocator_tests;
use alloc::{boxed::Box, collections::VecDeque, ffi::CString, rc::Rc, string::String, vec::Vec};
use core::sync::atomic::{AtomicU32, Ordering};
static INSTANCE: AtomicU32 = AtomicU32::new(1);
use core::{
    ffi::{c_char, c_int, c_void},
    fmt,
    marker::PhantomData,
    ptr::NonNull,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Package,
    Compatibility,
    Integrity,
    Memory,
    Budget,
    Exception,
    State,
    Host,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}
impl Error {
    pub(crate) fn new(kind: ErrorKind, message: &str) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}
impl core::error::Error for Error {}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub memory_bytes: usize,
    /// Copied requests and replies have a separate host transport budget.
    pub host_bytes: usize,
    pub pending_requests: usize,
    pub stack_bytes: usize,
    /// Interrupt polling budget also bounds executions without a hardware clock.
    pub interrupt_polls: u32,
    pub execution_us: u64,
    pub clock: Option<fn() -> u64>,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            memory_bytes: 2 * 1024 * 1024,
            host_bytes: 2 * 1024 * 1024,
            pending_requests: 16,
            stack_bytes: 24 * 1024,
            interrupt_polls: 100,
            execution_us: 4_000,
            clock: None,
        }
    }
}
/// Cumulative pipeline measurements. Host work can be nested inside jobs.
#[derive(Clone, Copy, Debug, Default)]
pub struct Profile {
    pub calls: u64,
    pub clocks: u64,
    pub draws: u64,
    pub requests: u64,
    pub delays: u64,
    pub jobs: u64,
    pub dispatch_us: u64,
    pub enqueue_us: u64,
    pub complete_us: u64,
    pub jobs_us: u64,
}
struct Pending {
    id: RequestId,
    bytes: usize,
    mode: u32,
}
pub(crate) struct State {
    pub allocator: RawAllocator,
    pub limits: Limits,
    pub stats: MemoryStats,
    pub oom: bool,
    interrupted: bool,
    polls: u32,
    deadline: Option<u64>,
    host_us: u64,
    slow_host_us: u64,
    slow_host: String,
    host: Box<dyn Host>,
    host_error: Option<Error>,
    instance: u32,
    sequence: u32,
    queued: VecDeque<Request>,
    outstanding: Vec<Pending>,
    transport_bytes: usize,
    reply: HostReply,
    profile: Profile,
}
impl State {
    fn elapsed(&self, start: Option<u64>) -> u64 {
        start
            .zip(self.limits.clock)
            .map_or(0, |(start, clock)| clock().saturating_sub(start))
    }
    fn request_slot(&mut self, bytes: usize, mode: u32) -> Result<RequestId, c_int> {
        if self.outstanding.len() >= self.limits.pending_requests
            || bytes > self.limits.host_bytes.saturating_sub(self.transport_bytes)
        {
            return Err(crate::platform::error_code::NO_MEM);
        }
        let sequence = self
            .sequence
            .checked_add(1)
            .ok_or(crate::platform::error_code::INVALID_STATE)?;
        let id = RequestId((u64::from(self.instance) << 32) | u64::from(sequence));
        self.sequence = sequence;
        self.transport_bytes += bytes;
        self.outstanding.push(Pending { id, bytes, mode });
        Ok(id)
    }
    fn failed(&self) -> bool {
        self.interrupted || self.oom || self.host_error.is_some()
    }
    fn begin(&mut self) {
        self.oom = false;
        self.interrupted = false;
        self.polls = self.limits.interrupt_polls;
        self.deadline = self
            .limits
            .clock
            .map(|clock| clock().saturating_add(self.limits.execution_us));
        self.host_error = None;
        self.host_us = 0;
        self.slow_host_us = 0;
        self.slow_host.clear();
    }
    fn error(&mut self, text: &[u8]) -> Error {
        if self.interrupted {
            let elapsed = self.deadline.zip(self.limits.clock).map(|(end, clock)| {
                clock().saturating_sub(end.saturating_sub(self.limits.execution_us))
            });
            return Error {
                kind: ErrorKind::Budget,
                message: alloc::format!(
                    "execution budget exhausted (elapsed_us={elapsed:?} limit_us={} polls_left={} host_us={} slow_host={}:{}us)",
                    self.limits.execution_us, self.polls, self.host_us, self.slow_host, self.slow_host_us
                ),
            };
        }
        if let Some(error) = self.host_error.take() {
            return error;
        }
        if self.oom {
            return Error::new(ErrorKind::Memory, "runtime allocation failed");
        }
        let end = text.iter().position(|b| *b == 0).unwrap_or(text.len());
        Error {
            kind: ErrorKind::Exception,
            message: String::from_utf8_lossy(&text[..end]).into_owned(),
        }
    }
}
#[no_mangle]
unsafe extern "C" fn embedts_interrupt(_ctx: *mut c_void, opaque: *mut c_void) -> c_int {
    let state = unsafe { &mut *opaque.cast::<State>() };
    if state.polls == 0
        || state
            .deadline
            .is_some_and(|end| state.limits.clock.is_some_and(|clock| clock() >= end))
    {
        state.interrupted = true;
        return 1;
    }
    state.polls -= 1;
    0
}
#[no_mangle]
unsafe extern "C" fn embedts_emit(opaque: *mut c_void, value: i32) -> c_int {
    let state = unsafe { &mut *opaque.cast::<State>() };
    match state.host.emit(value) {
        Ok(()) => 0,
        Err(error) => {
            state.host_error = Some(error);
            1
        }
    }
}
// The bridge copies each result before making another host callback.
#[repr(C)]
struct ReplyView {
    json: *const u8,
    json_len: usize,
    bytes: *const u8,
    bytes_len: usize,
}
impl State {
    fn response(
        &mut self,
        result: Result<HostReply, HostError>,
        out: *mut ReplyView,
        mode: u32,
    ) -> c_int {
        let (mut reply, mut code) = match result {
            Ok(reply)
                if reply.json.len().saturating_add(reply.bytes.len()) <= self.limits.host_bytes =>
            {
                (reply, 0)
            }
            Ok(_) => (
                HostReply::json("host reply exceeds transport budget"),
                crate::platform::error_code::NO_MEM,
            ),
            Err(error) => (
                HostReply::json(error.message),
                if error.code == 0 {
                    crate::platform::error_code::FAIL
                } else {
                    error.code
                },
            ),
        };
        let mut json_len = reply.json.len();
        // JS_ParseJSON requires a trailing NUL outside its logical input length.
        // Binary/void successes and error messages do not use that parser.
        if code == 0 && matches!(mode, 0 | 2) {
            if reply.json.try_reserve(1).is_err() {
                reply = HostReply::json("host JSON buffer allocation failed");
                code = crate::platform::error_code::NO_MEM;
                json_len = reply.json.len();
            } else {
                reply.json.push('\0');
            }
        }
        self.reply = reply;
        unsafe {
            *out = ReplyView {
                json: self.reply.json.as_ptr(),
                json_len,
                bytes: self.reply.bytes.as_ptr(),
                bytes_len: self.reply.bytes.len(),
            };
        }
        code
    }
}
unsafe fn text_arg<'a>(ptr: *const u8, len: usize) -> Result<&'a str, HostError> {
    core::str::from_utf8(unsafe { core::slice::from_raw_parts(ptr, len) }).map_err(|_| {
        HostError::new(
            crate::platform::error_code::INVALID_ARG,
            "host text must be valid UTF-8",
        )
    })
}
#[no_mangle]
unsafe extern "C" fn embedts_host_call(
    opaque: *mut c_void,
    op: *const u8,
    op_len: usize,
    args: *const u8,
    args_len: usize,
    bytes: *const u8,
    bytes_len: usize,
    mode: u32,
    out: *mut ReplyView,
) -> c_int {
    let s = unsafe { &mut *opaque.cast::<State>() };
    if op_len.saturating_add(args_len).saturating_add(bytes_len) > s.limits.host_bytes {
        return s.response(
            Err(HostError::new(
                crate::platform::error_code::NO_MEM,
                "host arguments exceed transport budget",
            )),
            out,
            mode,
        );
    }
    let (op, args) = match (unsafe { text_arg(op, op_len) }, unsafe {
        text_arg(args, args_len)
    }) {
        (Ok(op), Ok(args)) => (op, args),
        (Err(e), _) | (_, Err(e)) => return s.response(Err(e), out, mode),
    };
    let started = s.limits.clock.map(|clock| clock());
    let result = s.host.call(
        op,
        args,
        if bytes_len == 0 {
            &[]
        } else {
            unsafe { core::slice::from_raw_parts(bytes, bytes_len) }
        },
    );
    s.profile.calls = s.profile.calls.saturating_add(1);
    if let Some((started, clock)) = started.zip(s.limits.clock) {
        let elapsed = clock().saturating_sub(started);
        s.host_us = s.host_us.saturating_add(elapsed);
        s.profile.dispatch_us = s.profile.dispatch_us.saturating_add(elapsed);
        if elapsed > s.slow_host_us {
            s.slow_host_us = elapsed;
            s.slow_host.clear();
            s.slow_host.push_str(op);
        }
    }
    s.response(result, out, mode)
}
#[no_mangle]
unsafe extern "C" fn embedts_host_request(
    opaque: *mut c_void,
    op: *const u8,
    op_len: usize,
    args: *const u8,
    args_len: usize,
    bytes: *const u8,
    bytes_len: usize,
    mode: u32,
    id: *mut u64,
) -> c_int {
    let s = unsafe { &mut *opaque.cast::<State>() };
    let size = op_len.saturating_add(args_len).saturating_add(bytes_len);
    if s.outstanding.len() >= s.limits.pending_requests
        || size > s.limits.host_bytes.saturating_sub(s.transport_bytes)
    {
        return crate::platform::error_code::NO_MEM;
    }
    let started = s.limits.clock.map(|clock| clock());
    let mut operation = String::new();
    let mut json = String::new();
    let mut data = Vec::new();
    if operation.try_reserve_exact(op_len).is_err()
        || json.try_reserve_exact(args_len).is_err()
        || data.try_reserve_exact(bytes_len).is_err()
    {
        return crate::platform::error_code::NO_MEM;
    }
    let (op, args) = match (unsafe { text_arg(op, op_len) }, unsafe {
        text_arg(args, args_len)
    }) {
        (Ok(op), Ok(args)) => (op, args),
        _ => return crate::platform::error_code::INVALID_ARG,
    };
    operation.push_str(op);
    json.push_str(args);
    if bytes_len != 0 {
        data.extend_from_slice(unsafe { core::slice::from_raw_parts(bytes, bytes_len) });
    }
    let id_value = match s.request_slot(size, mode) {
        Ok(id) => id,
        Err(code) => return code,
    };
    s.queued.push_back(Request::Host(HostRequest {
        id: id_value,
        operation,
        args: json,
        bytes: data,
    }));
    s.profile.requests = s.profile.requests.saturating_add(1);
    s.profile.enqueue_us = s.profile.enqueue_us.saturating_add(s.elapsed(started));
    unsafe {
        *id = id_value.0;
    }
    0
}
#[no_mangle]
unsafe extern "C" fn embedts_host_delay(opaque: *mut c_void, micros: u64, id: *mut u64) -> c_int {
    let s = unsafe { &mut *opaque.cast::<State>() };
    let started = s.limits.clock.map(|clock| clock());
    let value = match s.request_slot(core::mem::size_of::<u64>(), 3) {
        Ok(id) => id,
        Err(code) => return code,
    };
    s.queued.push_back(Request::Delay { id: value, micros });
    s.profile.delays = s.profile.delays.saturating_add(1);
    s.profile.enqueue_us = s.profile.enqueue_us.saturating_add(s.elapsed(started));
    unsafe {
        *id = value.0;
    }
    0
}
#[no_mangle]
unsafe extern "C" fn embedts_host_now_ms(
    opaque: *mut c_void,
    value: *mut u64,
    out: *mut ReplyView,
) -> c_int {
    let s = unsafe { &mut *opaque.cast::<State>() };
    let started = s.limits.clock.map(|clock| clock());
    let result = s.host.now_ms();
    s.profile.clocks = s.profile.clocks.saturating_add(1);
    s.profile.dispatch_us = s.profile.dispatch_us.saturating_add(s.elapsed(started));
    match result {
        Ok(now) => {
            unsafe {
                *value = now;
            }
            0
        }
        Err(error) => s.response(Err(error), out, 3),
    }
}
#[no_mangle]
unsafe extern "C" fn embedts_host_draw(
    opaque: *mut c_void,
    draw: *const Draw,
    out: *mut ReplyView,
) -> c_int {
    let s = unsafe { &mut *opaque.cast::<State>() };
    let started = s.limits.clock.map(|clock| clock());
    let result = s.host.draw(unsafe { *draw });
    s.profile.draws = s.profile.draws.saturating_add(1);
    let elapsed = s.elapsed(started);
    s.host_us = s.host_us.saturating_add(elapsed);
    s.profile.dispatch_us = s.profile.dispatch_us.saturating_add(elapsed);
    if elapsed > s.slow_host_us {
        s.slow_host_us = elapsed;
        s.slow_host.clear();
        s.slow_host.push_str("draw");
    }
    match result {
        Ok(()) => 0,
        Err(error) => s.response(Err(error), out, 3),
    }
}
unsafe extern "C" {
    fn embedts_create(opaque: *mut c_void, stack: usize, pending: usize) -> *mut c_void;
    fn embedts_drop(vm: *mut c_void);
    fn embedts_load(
        vm: *mut c_void,
        bytes: *const u8,
        len: usize,
        error: *mut c_char,
        cap: usize,
    ) -> c_int;
    fn embedts_call(
        vm: *mut c_void,
        name: *const c_char,
        has_arg: c_int,
        arg: i32,
        out: *mut i32,
        error: *mut c_char,
        cap: usize,
    ) -> c_int;
    fn embedts_start(
        vm: *mut c_void,
        name: *const c_char,
        has_arg: c_int,
        arg: i32,
        out: *mut i32,
        error: *mut c_char,
        cap: usize,
    ) -> c_int;
    fn embedts_entry(vm: *mut c_void, out: *mut i32, error: *mut c_char, cap: usize) -> c_int;
    fn embedts_complete(
        vm: *mut c_void,
        id: u64,
        code: c_int,
        reply: *const ReplyView,
        error: *mut c_char,
        cap: usize,
    ) -> c_int;
    fn embedts_job(vm: *mut c_void, error: *mut c_char, cap: usize) -> c_int;
    fn embedts_pending(vm: *mut c_void) -> c_int;
    fn embedts_rejections(vm: *mut c_void, error: *mut c_char, cap: usize) -> c_int;
}
/// A runtime remains on its creating execution thread. All errors during
/// application execution fault it; catchable HostError values reject only their
/// operation. Cancellation destroys the VM after host quiescence.
pub struct Vm {
    raw: NonNull<c_void>,
    state: Box<State>,
    loaded: bool,
    faulted: bool,
    _thread: PhantomData<Rc<()>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobProgress {
    pub executed: usize,
    pub pending: bool,
}
impl Vm {
    pub fn new(
        host: Box<dyn Host>,
        limits: Limits,
        allocator: &RawAllocator,
    ) -> Result<Self, Error> {
        if limits.host_bytes == 0
            || limits.pending_requests == 0
            || limits.memory_bytes == 0
            || limits.stack_bytes == 0
            || limits.interrupt_polls == 0
            || limits.execution_us == 0
        {
            return Err(Error::new(
                ErrorKind::State,
                "runtime limits must be nonzero",
            ));
        }
        let instance = INSTANCE
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| Error::new(ErrorKind::State, "runtime instance ids exhausted"))?;
        let mut queued = VecDeque::new();
        let mut outstanding = Vec::new();
        queued
            .try_reserve(limits.pending_requests)
            .map_err(|_| Error::new(ErrorKind::Memory, "request queue allocation failed"))?;
        outstanding
            .try_reserve(limits.pending_requests)
            .map_err(|_| Error::new(ErrorKind::Memory, "request ledger allocation failed"))?;
        let mut state = Box::new(State {
            allocator: *allocator,
            limits,
            stats: MemoryStats::default(),
            oom: false,
            interrupted: false,
            polls: 0,
            deadline: None,
            host_us: 0,
            slow_host_us: 0,
            slow_host: String::new(),
            host,
            host_error: None,
            instance,
            sequence: 0,
            queued,
            outstanding,
            transport_bytes: 0,
            reply: HostReply::json(""),
            profile: Profile::default(),
        });
        state.begin();
        let raw = unsafe {
            embedts_create(
                (&mut *state as *mut State).cast(),
                limits.stack_bytes,
                limits.pending_requests,
            )
        };
        let Some(raw) = NonNull::new(raw) else {
            debug_assert_eq!(state.stats.used, 0);
            return Err(state.error(b"runtime initialization failed\0"));
        };
        if state.failed() {
            unsafe {
                embedts_drop(raw.as_ptr());
            }
            debug_assert_eq!(state.stats.used, 0);
            return Err(state.error(b"runtime initialization failed\0"));
        }
        Ok(Self {
            raw,
            state,
            loaded: false,
            faulted: false,
            _thread: PhantomData,
        })
    }
    fn check(&self) -> Result<(), Error> {
        if self.faulted {
            Err(Error::new(ErrorKind::State, "runtime faulted"))
        } else {
            Ok(())
        }
    }
    /// # Safety
    /// The package must come from a trusted compiler and delivery chain. Its
    /// digest/ABI checks do not make hostile QuickJS bytecode safe to deserialize.
    pub unsafe fn load(&mut self, package: Package<'_>) -> Result<(), Error> {
        self.check()?;
        if self.loaded {
            return Err(Error::new(ErrorKind::State, "module already loaded"));
        }
        self.state.begin();
        let mut text = [0u8; 256];
        let payload = package.payload();
        let result = unsafe {
            embedts_load(
                self.raw.as_ptr(),
                payload.as_ptr(),
                payload.len(),
                text.as_mut_ptr().cast(),
                text.len(),
            )
        };
        if result < 0 || self.state.failed() {
            self.faulted = true;
            return Err(self.state.error(&text));
        }
        self.loaded = true;
        Ok(())
    }
    pub fn call(&mut self, name: &str, arg: Option<i32>) -> Result<Option<i32>, Error> {
        self.check()?;
        if !self.loaded {
            return Err(Error::new(ErrorKind::State, "module not loaded"));
        }
        let name = CString::new(name)
            .map_err(|_| Error::new(ErrorKind::State, "export name contains NUL"))?;
        self.state.begin();
        let mut text = [0u8; 256];
        let mut out = 0;
        let result = unsafe {
            embedts_call(
                self.raw.as_ptr(),
                name.as_ptr(),
                arg.is_some() as c_int,
                arg.unwrap_or(0),
                &mut out,
                text.as_mut_ptr().cast(),
                text.len(),
            )
        };
        if result < 0 || self.state.failed() {
            self.faulted = true;
            Err(self.state.error(&text))
        } else {
            Ok((result == 0).then_some(out))
        }
    }
    /// Starts one synchronous or asynchronous entry. Only one entry may wait at
    /// a time; host requests and bounded jobs can run while it waits.
    pub fn start(&mut self, name: &str, arg: Option<i32>) -> Result<CallState, Error> {
        self.check()?;
        if !self.loaded {
            return Err(Error::new(ErrorKind::State, "module not loaded"));
        }
        let name = CString::new(name)
            .map_err(|_| Error::new(ErrorKind::State, "export name contains NUL"))?;
        self.state.begin();
        let mut text = [0u8; 256];
        let mut out = 0;
        let result = unsafe {
            embedts_start(
                self.raw.as_ptr(),
                name.as_ptr(),
                arg.is_some() as c_int,
                arg.unwrap_or(0),
                &mut out,
                text.as_mut_ptr().cast(),
                text.len(),
            )
        };
        self.entry_result(result, out, &text)
    }
    pub fn entry_status(&mut self) -> Result<CallState, Error> {
        self.check()?;
        self.state.begin();
        let mut text = [0u8; 256];
        let mut out = 0;
        let result = unsafe {
            embedts_entry(
                self.raw.as_ptr(),
                &mut out,
                text.as_mut_ptr().cast(),
                text.len(),
            )
        };
        self.entry_result(result, out, &text)
    }
    fn entry_result(&mut self, result: c_int, out: i32, text: &[u8]) -> Result<CallState, Error> {
        if result < 0 || self.state.failed() {
            self.faulted = true;
            Err(self.state.error(text))
        } else {
            Ok(match result {
                0 => CallState::Done(out),
                1 => CallState::Missing,
                _ => CallState::Pending,
            })
        }
    }
    pub fn take_request(&mut self) -> Option<Request> {
        self.state.queued.pop_front()
    }
    pub(crate) fn has_queued_requests(&self) -> bool {
        !self.state.queued.is_empty()
    }
    pub fn pending_requests(&self) -> usize {
        self.state.outstanding.len()
    }
    pub fn transport_bytes(&self) -> usize {
        self.state.transport_bytes
    }
    pub fn complete(
        &mut self,
        id: RequestId,
        result: Result<HostReply, HostError>,
    ) -> Result<(), Error> {
        self.settle(id, Some(result))
    }
    /// Complete a typed delay without constructing a JSON or binary reply.
    pub fn complete_void(&mut self, id: RequestId) -> Result<(), Error> {
        self.settle(id, None)
    }
    fn settle(
        &mut self,
        id: RequestId,
        result: Option<Result<HostReply, HostError>>,
    ) -> Result<(), Error> {
        self.check()?;
        let Some(index) = self
            .state
            .outstanding
            .iter()
            .position(|pending| pending.id == id)
        else {
            return Err(Error::new(
                ErrorKind::State,
                "unknown or completed host request",
            ));
        };
        self.state.begin();
        let started = self.state.limits.clock.map(|clock| clock());
        let mut view = ReplyView {
            json: b"null\0".as_ptr(),
            json_len: 4,
            bytes: core::ptr::null(),
            bytes_len: 0,
        };
        let mode = self.state.outstanding[index].mode;
        let code = result.map_or(0, |result| self.state.response(result, &mut view, mode));
        let mut text = [0u8; 256];
        let status = unsafe {
            embedts_complete(
                self.raw.as_ptr(),
                id.0,
                code,
                &view,
                text.as_mut_ptr().cast(),
                text.len(),
            )
        };
        if status < 0 || self.state.failed() {
            self.faulted = true;
            return Err(self.state.error(&text));
        }
        self.state.profile.complete_us = self
            .state
            .profile
            .complete_us
            .saturating_add(self.state.elapsed(started));
        let pending = self.state.outstanding.remove(index);
        self.state.transport_bytes -= pending.bytes;
        // A synchronous test host may complete before taking its queued message.
        self.state.queued.retain(|request| request.id() != id);
        Ok(())
    }
    pub fn drain_jobs(&mut self, maximum: usize) -> Result<JobProgress, Error> {
        self.check()?;
        if !self.loaded {
            return Err(Error::new(ErrorKind::State, "module not loaded"));
        }
        self.state.begin();
        let started = self.state.limits.clock.map(|clock| clock());
        let mut executed = 0;
        let mut text = [0u8; 256];
        while executed < maximum {
            let result =
                unsafe { embedts_job(self.raw.as_ptr(), text.as_mut_ptr().cast(), text.len()) };
            if result < 0 || self.state.failed() {
                self.faulted = true;
                return Err(self.state.error(&text));
            }
            if result == 0 {
                break;
            }
            executed += 1;
            if self
                .state
                .deadline
                .is_some_and(|end| self.state.limits.clock.is_some_and(|clock| clock() >= end))
            {
                break;
            }
        }
        let pending = unsafe { embedts_pending(self.raw.as_ptr()) } != 0;
        if !pending
            && unsafe {
                embedts_rejections(self.raw.as_ptr(), text.as_mut_ptr().cast(), text.len())
            } < 0
        {
            self.faulted = true;
            return Err(self.state.error(&text));
        }
        self.state.profile.jobs = self.state.profile.jobs.saturating_add(executed as u64);
        self.state.profile.jobs_us = self
            .state
            .profile
            .jobs_us
            .saturating_add(self.state.elapsed(started));
        Ok(JobProgress { executed, pending })
    }
    pub fn has_pending_jobs(&self) -> bool {
        unsafe { embedts_pending(self.raw.as_ptr()) != 0 }
    }
    pub fn memory_stats(&self) -> MemoryStats {
        self.state.stats
    }
    pub fn profile(&self) -> Profile {
        self.state.profile
    }
    /// Releases all engine allocations and returns their final ledger.
    pub fn close(self) -> MemoryStats {
        let mut this = core::mem::ManuallyDrop::new(self);
        unsafe {
            embedts_drop(this.raw.as_ptr());
        }
        let stats = this.state.stats;
        unsafe {
            core::ptr::drop_in_place(&mut this.state);
        }
        stats
    }
}
impl Drop for Vm {
    fn drop(&mut self) {
        unsafe {
            embedts_drop(self.raw.as_ptr());
        }
        debug_assert_eq!(self.state.stats.used, 0);
    }
}

#[cfg(feature = "compiler")]
pub fn compile_module(source: &str) -> Result<alloc::vec::Vec<u8>, Error> {
    unsafe extern "C" {
        fn embedts_compile(
            vm: *mut c_void,
            source: *const c_char,
            len: usize,
            out: *mut *mut u8,
            size: *mut usize,
            error: *mut c_char,
            cap: usize,
        ) -> c_int;
        fn embedts_compiled_free(vm: *mut c_void, bytes: *mut u8);
    }
    let source =
        CString::new(source).map_err(|_| Error::new(ErrorKind::Package, "source contains NUL"))?;
    let mut vm = Vm::new(
        Box::new(()),
        Limits {
            memory_bytes: 32 * 1024 * 1024,
            stack_bytes: 512 * 1024,
            interrupt_polls: 10_000,
            ..Default::default()
        },
        &crate::GLOBAL_ALLOCATOR,
    )?;
    vm.state.begin();
    let mut text = [0u8; 256];
    let mut raw = core::ptr::null_mut();
    let mut size = 0;
    let result = unsafe {
        embedts_compile(
            vm.raw.as_ptr(),
            source.as_ptr(),
            source.as_bytes().len(),
            &mut raw,
            &mut size,
            text.as_mut_ptr().cast(),
            text.len(),
        )
    };
    if result < 0 {
        return Err(vm.state.error(&text));
    }
    let package = crate::package::encode(unsafe { core::slice::from_raw_parts(raw, size) });
    unsafe {
        embedts_compiled_free(vm.raw.as_ptr(), raw);
    }
    package
}
