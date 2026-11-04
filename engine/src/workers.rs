//! Cooperative bytecode workers with isolated VMs and owner-checked synchronization.
use crate::{
    CallState, Host, HostError, HostReply, HostRequest, Limits, Package, RawAllocator, Request,
    RequestId, Vm,
};
use alloc::{
    boxed::Box,
    collections::{BTreeMap, VecDeque},
    format,
    rc::Rc,
    string::{String, ToString},
    vec::Vec,
};
use core::cell::{Cell, RefCell};
use serde_json::{json, Value};
const JOBS: usize = 8;
const HISTORY: usize = 32;
const SYNC: usize = 32;
const SYNC_BYTES: usize = 256 * 1024;
struct Command {
    op: String,
    args: Value,
    bytes: Vec<u8>,
}
type Reply = HostReply;
fn values(v: Value) -> Reply {
    Reply::json(json!({"count":v.as_array().map_or(0,Vec::len),"values":v}).to_string())
}
fn ok(s: &str) -> Reply {
    values(json!([true, s]))
}
fn fail(s: &str) -> Reply {
    values(json!([null, s]))
}
fn timed(op: &str, s: &str) -> Reply {
    if op == "queue_recv" {
        fail(s)
    } else {
        values(json!([false, s]))
    }
}
struct Queue {
    depth: usize,
    item: usize,
    messages: VecDeque<Vec<u8>>,
}
struct Semaphore {
    count: u8,
    max: u8,
}
struct Pending {
    owner: u64,
    id: RequestId,
    command: Command,
    deadline: u64,
    run: Option<u64>,
}
struct Job {
    id: u64,
    name: String,
    exclusive: Option<String>,
    status: String,
    vm: Option<Vm>,
    logs: Rc<RefCell<String>>,
    error: String,
    deadline: Option<u64>,
    main_pending: bool,
    timers: Vec<(RequestId, u64)>,
}
impl Job {
    fn summary(&self) -> String {
        format!(
            "id={} name={} status={}\n{}{}",
            self.id,
            self.name,
            self.status,
            self.error,
            self.logs.borrow()
        )
    }
}
struct WorkerHost {
    logs: Rc<RefCell<String>>,
    now: Rc<Cell<u64>>,
    args: Value,
}
impl Host for WorkerHost {
    fn now_ms(&mut self) -> Result<u64, HostError> {
        Ok(self.now.get())
    }
    fn call(&mut self, op: &str, args: &str, bytes: &[u8]) -> Result<HostReply, HostError> {
        let a: Value = serde_json::from_str(args)
            .map_err(|_| HostError::new(0x102, "invalid worker arguments"))?;
        if !bytes.is_empty() {
            return Err(HostError::new(0x102, "worker operation accepts no bytes"));
        }
        let value = match op {
            "print" | "log" => {
                let line = a[0]
                    .as_str()
                    .ok_or_else(|| HostError::new(0x102, "log text required"))?;
                let mut logs = self.logs.borrow_mut();
                for ch in line.chars().chain(core::iter::once('\n')) {
                    if logs.len() + ch.len_utf8() > 8192 {
                        break;
                    }
                    logs.push(ch);
                }
                Value::Null
            }
            "now_ms" => json!(self.now.get()),
            "unix_us" => Value::Null,
            "args" => self.args.clone(),
            "date" => json!(crate::platform::date(
                a[0].as_i64()
                    .ok_or_else(|| HostError::new(0x102, "date seconds required"))?,
                a[1].as_str()
                    .ok_or_else(|| HostError::new(0x102, "date format required"))?
            )
            .map_err(|code| HostError::new(code, "date failed"))?),
            _ => return Err(HostError::new(0x106, "operation unavailable in worker")),
        };
        Ok(HostReply::json(value.to_string()))
    }
}
/// Parent owns this group and pumps it even while its own entry is suspended.
pub struct Group {
    jobs: BTreeMap<u64, Job>,
    next: u64,
    queues: BTreeMap<String, Queue>,
    sems: BTreeMap<String, Semaphore>,
    locks: BTreeMap<String, Option<u64>>,
    pending: VecDeque<Pending>,
    completed: Vec<(RequestId, HostReply)>,
    now: Rc<Cell<u64>>,
    limits: Limits,
    allocator: RawAllocator,
}
impl Group {
    pub fn new(limits: Limits, allocator: &RawAllocator) -> Self {
        Self {
            jobs: BTreeMap::new(),
            next: 1,
            queues: BTreeMap::new(),
            sems: BTreeMap::new(),
            locks: BTreeMap::new(),
            pending: VecDeque::new(),
            completed: Vec::new(),
            now: Rc::new(Cell::new(0)),
            limits,
            allocator: *allocator,
        }
    }
    pub fn command(&mut self, request: HostRequest, now: u64) {
        self.accept(0, request, now)
    }
    pub fn take_completion(&mut self) -> Option<(RequestId, HostReply)> {
        self.completed.pop()
    }
    pub fn active(&self) -> bool {
        self.jobs.values().any(|j| j.vm.is_some())
    }
    /// Work that can advance at this instant, including requests queued by a
    /// worker's initial entry. Sleeping or synchronization-blocked jobs alone
    /// do not require a busy parent poll loop.
    pub fn has_ready_work(&self, now_us: u64) -> bool {
        !self.completed.is_empty()
            || self.pending.iter().any(|pending| {
                pending
                    .run
                    .is_some_and(|id| !self.jobs.get(&id).is_some_and(|job| job.vm.is_some()))
            })
            || self.jobs.values().any(|job| {
                job.vm.as_ref().is_some_and(|vm| {
                    vm.has_pending_jobs()
                        || vm.has_queued_requests()
                        || job.timers.iter().any(|(_, end)| *end <= now_us)
                        || job.deadline.is_some_and(|end| end <= now_us / 1000)
                        || (!job.main_pending && vm.pending_requests() == 0)
                })
            })
    }
    fn reply(&mut self, owner: u64, id: RequestId, reply: HostReply) {
        if owner == 0 {
            self.completed.push((id, reply))
        } else if let Some(vm) = self.jobs.get_mut(&owner).and_then(|j| j.vm.as_mut()) {
            if let Err(e) = vm.complete(id, Ok(reply)) {
                self.finish(owner, "failed", e.to_string());
            }
        }
    }
    fn finish(&mut self, owner: u64, status: &str, error: String) {
        if let Some(j) = self.jobs.get_mut(&owner) {
            j.vm = None;
            j.status = status.into();
            j.error = error.chars().take(2048).collect();
            j.timers.clear();
        }
        self.pending.retain(|p| p.owner != owner);
        self.release_locks(owner);
    }
    fn accept(&mut self, owner: u64, r: HostRequest, now: u64) {
        let op = r
            .operation
            .strip_prefix("thread.")
            .unwrap_or("")
            .to_string();
        let args: Value = match serde_json::from_str::<Value>(&r.args) {
            Ok(v) if v.is_array() => v,
            _ => {
                self.reply(owner, r.id, fail("thread arguments must be an array"));
                return;
            }
        };
        if r.args.len() > 65536 || (!matches!(op.as_str(), "start" | "run") && r.bytes.len() > 4096)
        {
            self.reply(owner, r.id, fail("thread argument budget exceeded"));
            return;
        }
        let c = Command {
            op,
            args,
            bytes: r.bytes,
        };
        let reply = match c.op.as_str() {
            "start" | "run" => {
                if owner != 0 {
                    fail("nested workers are not supported")
                } else {
                    match self.start(&c.args, &c.bytes, now) {
                        Err(e) => fail(&e),
                        Ok(id) => {
                            if c.op == "run" {
                                self.pending.push_back(Pending {
                                    owner,
                                    id: r.id,
                                    command: c,
                                    deadline: u64::MAX,
                                    run: Some(id),
                                });
                                return;
                            }
                            ok(&self.jobs[&id].summary())
                        }
                    }
                }
            }
            "get" => self
                .find(&c.args[0])
                .map(|id| ok(&self.jobs[&id].summary()))
                .unwrap_or_else(|| fail("job not found")),
            "stop" => {
                if let Some(id) = self.find(&c.args[0]) {
                    self.stop_job(id);
                    ok(&self.jobs[&id].summary())
                } else {
                    fail("job not found")
                }
            }
            "list" => {
                let status = c.args[0].as_str().unwrap_or("all");
                if ![
                    "all", "queued", "running", "done", "failed", "timeout", "stopped",
                ]
                .contains(&status)
                {
                    fail("invalid job status")
                } else {
                    ok(&self
                        .jobs
                        .values()
                        .filter(|j| status == "all" || j.status == status)
                        .map(Job::summary)
                        .collect::<Vec<_>>()
                        .join("\n"))
                }
            }
            _ => match self.sync(owner, &c) {
                SyncResult::Reply(r) => r,
                SyncResult::Blocked => {
                    let timeout = c.args[1].as_u64().unwrap_or(0).min(86400000);
                    if timeout == 0 {
                        timed(&c.op, "timeout")
                    } else {
                        self.pending.push_back(Pending {
                            owner,
                            id: r.id,
                            command: c,
                            deadline: now.saturating_add(timeout),
                            run: None,
                        });
                        return;
                    }
                }
            },
        };
        self.reply(owner, r.id, reply);
    }
    pub fn poll(&mut self, now: u64) {
        self.poll_us(now.saturating_mul(1000));
    }
    pub fn poll_us(&mut self, now_us: u64) {
        let now = now_us / 1000;
        self.now.set(now);
        // Retain the queue's storage and FIFO order across blocked polls.
        for _ in 0..self.pending.len() {
            let Some(p) = self.pending.pop_front() else {
                break;
            };
            if p.owner != 0 && !self.jobs.get(&p.owner).is_some_and(|j| j.vm.is_some()) {
                continue;
            }
            let reply = if let Some(id) = p.run {
                match self.jobs.get(&id) {
                    None => Some(fail("job not found")),
                    Some(j) if j.vm.is_none() => Some(if j.status == "done" {
                        ok(&j.summary())
                    } else {
                        fail(&j.summary())
                    }),
                    _ => None,
                }
            } else {
                match self.sync(p.owner, &p.command) {
                    SyncResult::Reply(r) => Some(r),
                    SyncResult::Blocked if now >= p.deadline => {
                        Some(timed(&p.command.op, "timeout"))
                    }
                    _ => None,
                }
            };
            if let Some(r) = reply {
                self.reply(p.owner, p.id, r)
            } else {
                self.pending.push_back(p)
            }
        }
        let mut ids = [0; JOBS];
        let mut count = 0;
        for (&id, job) in &self.jobs {
            if job.vm.is_some() {
                ids[count] = id;
                count += 1;
            }
        }
        for id in ids.into_iter().take(count) {
            if self.jobs[&id].deadline.is_some_and(|d| now >= d) {
                self.finish(id, "timeout", String::new());
                continue;
            }
            let result = (|| -> Result<bool, crate::Error> {
                let j = self.jobs.get_mut(&id).unwrap();
                let vm = j.vm.as_mut().unwrap();
                let mut n = 0;
                while n < j.timers.len() {
                    if now_us >= j.timers[n].1 {
                        let (r, _) = j.timers.swap_remove(n);
                        vm.complete_void(r)?;
                    } else {
                        n += 1;
                    }
                }
                vm.drain_jobs(32)?;
                if j.main_pending {
                    j.main_pending = vm.entry_status()? == CallState::Pending;
                }
                Ok(!j.main_pending && vm.pending_requests() == 0 && !vm.has_pending_jobs())
            })();
            match result {
                Err(e) => {
                    self.finish(id, "failed", e.to_string());
                    continue;
                }
                Ok(true) => {
                    self.finish(id, "done", String::new());
                    continue;
                }
                _ => {}
            }
            while let Some(r) = self
                .jobs
                .get_mut(&id)
                .and_then(|job| job.vm.as_mut())
                .and_then(Vm::take_request)
            {
                let r = match r {
                    Request::Delay {
                        id: request,
                        micros,
                    } => {
                        self.jobs
                            .get_mut(&id)
                            .unwrap()
                            .timers
                            .push((request, now_us.saturating_add(micros)));
                        continue;
                    }
                    Request::Host(request) => request,
                };
                if r.operation.starts_with("thread.") {
                    self.accept(id, r, now)
                } else if r.operation == "sleep" || r.operation == "sleep_us" {
                    let ms = serde_json::from_str::<Vec<Value>>(&r.args)
                        .ok()
                        .filter(|a| a.len() == 1)
                        .and_then(|a| a[0].as_u64())
                        .filter(|n| *n <= u32::MAX as u64);
                    if let Some(mut ms) = ms {
                        if r.operation == "sleep_us" {
                            if ms > 1000000 {
                                self.reply_error(id, r.id, "delayUs must be 0..1000000");
                                continue;
                            }
                        } else {
                            ms = ms.saturating_mul(1000);
                        }
                        self.jobs
                            .get_mut(&id)
                            .unwrap()
                            .timers
                            .push((r.id, now_us.saturating_add(ms)));
                    } else {
                        self.reply_error(id, r.id, "invalid sleep duration");
                    }
                } else {
                    self.reply_error(id, r.id, "operation unavailable in worker");
                }
            }
        }
    }
    fn reply_error(&mut self, owner: u64, id: RequestId, message: &str) {
        if let Some(vm) = self.jobs.get_mut(&owner).and_then(|j| j.vm.as_mut()) {
            let _ = vm.complete(id, Err(HostError::new(0x106, message)));
        }
    }
    fn find(&self, v: &Value) -> Option<u64> {
        v.as_u64()
            .filter(|id| self.jobs.contains_key(id))
            .or_else(|| {
                v.as_str().and_then(|name| {
                    self.jobs
                        .values()
                        .rev()
                        .find(|j| j.name == name)
                        .map(|j| j.id)
                })
            })
    }
    fn release_locks(&mut self, id: u64) {
        for owner in self.locks.values_mut() {
            if *owner == Some(id) {
                *owner = None;
            }
        }
    }
    fn stop_job(&mut self, id: u64) {
        let pending: Vec<_> = self
            .pending
            .iter()
            .filter(|p| p.owner == id)
            .map(|p| (p.id, timed(&p.command.op, "stopped")))
            .collect();
        if let Some(vm) = self.jobs.get_mut(&id).and_then(|j| j.vm.as_mut()) {
            for (r, reply) in pending {
                let _ = vm.complete(r, Ok(reply));
            }
            let _ = vm.drain_jobs(32);
        }
        self.finish(id, "stopped", String::new());
    }
    fn start(&mut self, a: &Value, bytes: &[u8], now: u64) -> Result<u64, String> {
        let path = a[0].as_str().ok_or("worker package path required")?;
        if !path.starts_with('/')
            || !path.ends_with(".etb")
            || path.split('/').any(|s| s == ".." || s == ".")
            || path.contains('\0')
        {
            return Err("absolute .etb package path required".into());
        }
        if bytes.len() > 256 * 1024 {
            return Err("worker package exceeds 256 KiB".into());
        }
        let package = Package::parse(bytes).map_err(|e| e.to_string())?;
        let opts = &a[2];
        let name = opts["name"]
            .as_str()
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("job_{}", self.next));
        validate_name(&name)?;
        let exclusive = opts["exclusive"].as_str().map(ToString::to_string);
        if let Some(e) = exclusive.as_ref() {
            validate_name(e)?;
        }
        let conflicting: Vec<_> = self
            .jobs
            .values()
            .filter(|j| {
                j.vm.is_some()
                    && (j.name == name
                        || exclusive
                            .as_ref()
                            .is_some_and(|e| j.exclusive.as_ref() == Some(e)))
            })
            .map(|j| j.id)
            .collect();
        if !conflicting.is_empty() && !opts["replace"].as_bool().unwrap_or(false) {
            return Err("job name or exclusive group already running".into());
        }
        for id in conflicting {
            self.stop_job(id);
        }
        if self.jobs.values().filter(|j| j.vm.is_some()).count() >= JOBS {
            return Err("worker limit reached".into());
        }
        while self.jobs.len() >= HISTORY {
            let old = self
                .jobs
                .iter()
                .find(|(_, j)| j.vm.is_none())
                .map(|(id, _)| *id)
                .ok_or("job history full")?;
            self.jobs.remove(&old);
        }
        let logs = Rc::new(RefCell::new(String::new()));
        let mut limits = self.limits;
        limits.memory_bytes = limits.memory_bytes.min(1024 * 1024);
        let mut vm = Vm::new(
            Box::new(WorkerHost {
                logs: logs.clone(),
                now: self.now.clone(),
                args: a[1].clone(),
            }),
            limits,
            &self.allocator,
        )
        .map_err(|e| e.to_string())?;
        // Packages use the same controlled compilation/install chain as their parent.
        unsafe { vm.load(package) }.map_err(|e| e.to_string())?;
        let state = vm.start("main", None).map_err(|e| e.to_string())?;
        if state == CallState::Missing {
            return Err("worker has no main".into());
        }
        let id = self.next;
        self.next = self.next.checked_add(1).ok_or("job identifier overflow")?;
        let timeout = opts["timeout_ms"].as_u64().unwrap_or(5000);
        self.jobs.insert(
            id,
            Job {
                id,
                name,
                exclusive,
                status: "running".into(),
                vm: Some(vm),
                logs,
                error: String::new(),
                deadline: if timeout == 0 {
                    None
                } else {
                    Some(now.saturating_add(timeout))
                },
                main_pending: state == CallState::Pending,
                timers: Vec::new(),
            },
        );
        Ok(id)
    }
    fn busy(&self, name: &str) -> bool {
        self.pending
            .iter()
            .any(|p| p.command.args[0].as_str() == Some(name))
    }
    fn sync(&mut self, owner: u64, c: &Command) -> SyncResult {
        let name = match c.args[0].as_str() {
            Some(n) => n,
            None => return SyncResult::Reply(fail("sync name required")),
        };
        if let Err(e) = validate_name(name) {
            return SyncResult::Reply(fail(&e));
        }
        let a = &c.args;
        let family = c.op.split('_').next().unwrap_or("");
        let conflict = match family {
            "queue" => self.sems.contains_key(name) || self.locks.contains_key(name),
            "sem" => self.queues.contains_key(name) || self.locks.contains_key(name),
            _ => self.queues.contains_key(name) || self.sems.contains_key(name),
        };
        if conflict {
            return SyncResult::Reply(Reply {
                json: json!({"error":"sync name belongs to a different type"}).to_string(),
                bytes: Vec::new(),
            });
        }
        let result = match c.op.as_str() {
            "queue_create" => {
                let depth = a[1]["depth"].as_u64().unwrap_or(8).min(usize::MAX as u64) as usize;
                let item = a[1]["item_size"]
                    .as_u64()
                    .unwrap_or(256)
                    .min(usize::MAX as u64) as usize;
                if !(1..=32).contains(&depth) || !(1..=4096).contains(&item) {
                    fail("invalid queue bounds")
                } else if self.queues.contains_key(name) {
                    fail("exists")
                } else if self.queues.len() >= SYNC
                    || self
                        .queues
                        .values()
                        .map(|q| q.depth * q.item)
                        .sum::<usize>()
                        + depth * item
                        > SYNC_BYTES
                {
                    fail("queue registry budget exceeded")
                } else {
                    self.queues.insert(
                        name.into(),
                        Queue {
                            depth,
                            item,
                            messages: VecDeque::new(),
                        },
                    );
                    ok("created")
                }
            }
            "queue_send" => match self.queues.get_mut(name) {
                None => fail("not_found"),
                Some(q) => {
                    if c.bytes.len() > q.item {
                        fail("message exceeds item_size")
                    } else if q.messages.len() >= q.depth {
                        return SyncResult::Blocked;
                    } else {
                        q.messages.push_back(c.bytes.clone());
                        ok("sent")
                    }
                }
            },
            "queue_recv" => match self.queues.get_mut(name) {
                None => fail("not_found"),
                Some(q) => {
                    if let Some(bytes) = q.messages.pop_front() {
                        Reply {
                            json: json!({"binary":true}).to_string(),
                            bytes,
                        }
                    } else {
                        return SyncResult::Blocked;
                    }
                }
            },
            "queue_delete" => {
                if self.busy(name)
                    || self
                        .queues
                        .get(name)
                        .is_some_and(|q| !q.messages.is_empty())
                {
                    fail("busy")
                } else if self.queues.remove(name).is_some() {
                    ok("deleted")
                } else {
                    fail("not_found")
                }
            }
            "sem_create" => {
                let max = a[1]["max"].as_u64().unwrap_or(1);
                let initial = a[1]["initial"].as_u64().unwrap_or(0);
                if max < 1 || max > 255 || initial > max {
                    fail("invalid semaphore bounds")
                } else if self.sems.contains_key(name) {
                    fail("exists")
                } else if self.sems.len() >= SYNC {
                    fail("semaphore limit reached")
                } else {
                    self.sems.insert(
                        name.into(),
                        Semaphore {
                            count: initial as u8,
                            max: max as u8,
                        },
                    );
                    ok("created")
                }
            }
            "sem_take" => match self.sems.get_mut(name) {
                None => fail("not_found"),
                Some(s) => {
                    if s.count == 0 {
                        return SyncResult::Blocked;
                    } else {
                        s.count -= 1;
                        ok("taken")
                    }
                }
            },
            "sem_give" => match self.sems.get_mut(name) {
                None => fail("not_found"),
                Some(s) => {
                    if s.count == s.max {
                        values(json!([false, "full"]))
                    } else {
                        s.count += 1;
                        ok("given")
                    }
                }
            },
            "sem_delete" => {
                if self.busy(name) {
                    fail("busy")
                } else if self.sems.remove(name).is_some() {
                    ok("deleted")
                } else {
                    fail("not_found")
                }
            }
            "lock_create" => {
                if self.locks.contains_key(name) {
                    fail("exists")
                } else if self.locks.len() >= SYNC {
                    fail("lock limit reached")
                } else {
                    self.locks.insert(name.into(), None);
                    ok("created")
                }
            }
            "lock" => match self.locks.get_mut(name) {
                None => fail("not_found"),
                Some(slot) => {
                    if slot.is_some() {
                        return SyncResult::Blocked;
                    } else {
                        *slot = Some(owner);
                        ok("locked")
                    }
                }
            },
            "unlock" => match self.locks.get_mut(name) {
                None => fail("not_found"),
                Some(slot) => {
                    if *slot != Some(owner) {
                        values(json!([false, "not_owner"]))
                    } else {
                        *slot = None;
                        ok("unlocked")
                    }
                }
            },
            "lock_delete" => {
                if self.busy(name) || self.locks.get(name).is_some_and(Option::is_some) {
                    fail("busy")
                } else if self.locks.remove(name).is_some() {
                    ok("deleted")
                } else {
                    fail("not_found")
                }
            }
            _ => fail("unknown thread operation"),
        };
        SyncResult::Reply(result)
    }
}
enum SyncResult {
    Reply(Reply),
    Blocked,
}
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 31 {
        Err("name length must be 1..31".into())
    } else if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        Err("invalid character in sync name".into())
    } else {
        Ok(())
    }
}
