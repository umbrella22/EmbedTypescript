#![cfg(feature = "compiler")]
use embedts_engine::{compile_module, ErrorKind, Host, Limits, Package, Vm, GLOBAL_ALLOCATOR};
use std::{cell::RefCell, rc::Rc};
struct Capture(Rc<RefCell<Vec<i32>>>);
impl Host for Capture {
    fn emit(&mut self, value: i32) -> Result<(), embedts_engine::Error> {
        self.0.borrow_mut().push(value);
        Ok(())
    }
}
fn loaded(source: &str, limits: Limits) -> Vm {
    let bytes = compile_module(source).unwrap();
    let mut vm = Vm::new(Box::new(()), limits, &GLOBAL_ALLOCATOR).unwrap();
    // Every fixture is produced by the trusted compiler in this process.
    unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
    vm
}
#[test]
fn module_native_calls_events_and_close_release_every_allocation() {
    let bytes=compile_module("import {emit} from 'dango:host'; let total=2; export function main(){emit(40); return total;} export function onTick(n){total+=n;emit(total);return total;}").unwrap();
    let capture = Rc::new(RefCell::new(Vec::new()));
    let mut vm = Vm::new(
        Box::new(Capture(capture.clone())),
        Limits::default(),
        &GLOBAL_ALLOCATOR,
    )
    .unwrap();
    unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
    assert_eq!(vm.call("main", None).unwrap(), Some(2));
    assert_eq!(vm.call("onTick", Some(5)).unwrap(), Some(7));
    assert_eq!(vm.call("absent", None).unwrap(), None);
    assert_eq!(&*capture.borrow(), &[40, 7]);
    let stats = vm.close();
    assert_eq!(stats.used, 0);
    assert!(stats.peak > 0);
    assert!(stats.allocations > 10);
}
#[test]
fn infinite_execution_is_terminal_and_does_not_poison_another_runtime() {
    let mut vm = loaded(
        "export function main(){while(true){}}",
        Limits {
            interrupt_polls: 2,
            ..Default::default()
        },
    );
    assert_eq!(vm.call("main", None).unwrap_err().kind, ErrorKind::Budget);
    assert_eq!(vm.call("main", None).unwrap_err().kind, ErrorKind::State);
    assert_eq!(vm.close().used, 0);
    let mut other = loaded("export function main(){return 42}", Default::default());
    assert_eq!(other.call("main", None).unwrap(), Some(42));
    assert_eq!(other.close().used, 0);
}
#[test]
fn oom_and_failed_initialization_release_the_backing_allocator() {
    let mut vm = loaded(
        "export function main(){const x=[];while(true){x.push(new Array(1000).fill(7));}}",
        Limits {
            memory_bytes: 256 * 1024,
            interrupt_polls: 1000,
            ..Default::default()
        },
    );
    assert_eq!(vm.call("main", None).unwrap_err().kind, ErrorKind::Memory);
    let stats = vm.close();
    assert_eq!(stats.used, 0);
    assert!(stats.failures > 0);
    assert!(stats.peak <= 256 * 1024);
    assert_eq!(
        Vm::new(
            Box::new(()),
            Limits {
                memory_bytes: 128,
                ..Default::default()
            },
            &GLOBAL_ALLOCATOR
        )
        .err()
        .unwrap()
        .kind,
        ErrorKind::Memory
    );
}
#[test]
fn source_generation_and_unknown_native_modules_are_unavailable() {
    let mut vm = loaded(
        "export function main(){return (function(){}).constructor('return 42')();}",
        Default::default(),
    );
    assert_eq!(
        vm.call("main", None).unwrap_err().kind,
        ErrorKind::Exception
    );
    assert_eq!(vm.close().used, 0);
    assert!(
        compile_module("import {x} from 'unavailable'; export function main(){return x;}").is_err()
    );
}
#[test]
fn jobs_are_bounded_and_return_values_do_not_silently_truncate() {
    let mut vm = loaded(
        "export function main(){Promise.resolve().then(()=>{}).then(()=>{});return 1;}",
        Default::default(),
    );
    assert_eq!(vm.call("main", None).unwrap(), Some(1));
    assert!(vm.drain_jobs(0).unwrap().pending);
    let first = vm.drain_jobs(1).unwrap();
    assert_eq!(first.executed, 1);
    assert!(first.pending);
    assert!(!vm.drain_jobs(8).unwrap().pending);
    assert_eq!(vm.close().used, 0);
    for result in [
        "1.5",
        "NaN",
        "Infinity",
        "2147483648",
        "'42'",
        "Promise.resolve(42)",
    ] {
        let mut vm = loaded(
            &format!("export function main(){{return {result}}}"),
            Default::default(),
        );
        assert_eq!(
            vm.call("main", None).unwrap_err().kind,
            ErrorKind::Exception,
            "{result}"
        );
        assert_eq!(vm.close().used, 0);
    }
}
#[test]
fn corrupted_incompatible_truncated_and_appended_packages_fail_before_deserialization() {
    let bytes = compile_module("export function main(){return 42}").unwrap();
    for cut in 0..bytes.len() {
        assert!(Package::parse(&bytes[..cut]).is_err());
    }
    let mut changed = bytes.clone();
    changed.push(0);
    assert_eq!(
        Package::parse(&changed).err().unwrap().kind,
        ErrorKind::Package
    );
    changed = bytes.clone();
    changed[16] ^= 1;
    assert_eq!(
        Package::parse(&changed).err().unwrap().kind,
        ErrorKind::Compatibility
    );
    changed = bytes.clone();
    changed[48] ^= 1;
    assert_eq!(
        Package::parse(&changed).err().unwrap().kind,
        ErrorKind::Compatibility
    );
    changed = bytes.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert_eq!(
        Package::parse(&changed).err().unwrap().kind,
        ErrorKind::Integrity
    );
}

#[test]
fn a_clock_deadline_interrupts_initialization_and_job_execution() {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CLOCK: AtomicU64 = AtomicU64::new(0);
    fn clock() -> u64 {
        CLOCK.fetch_add(10, Ordering::Relaxed)
    }
    let limits = Limits {
        clock: Some(clock),
        execution_us: 20,
        interrupt_polls: 1000,
        ..Default::default()
    };
    let bytes = compile_module("while(true){} export function main(){}").unwrap();
    let mut vm = Vm::new(Box::new(()), limits, &GLOBAL_ALLOCATOR).unwrap();
    assert_eq!(
        unsafe { vm.load(Package::parse(&bytes).unwrap()) }
            .unwrap_err()
            .kind,
        ErrorKind::Budget
    );
    assert_eq!(vm.close().used, 0);
    let mut vm = loaded(
        "export function main(){Promise.resolve().then(()=>{while(true){}});}",
        limits,
    );
    vm.call("main", None).unwrap();
    assert_eq!(vm.drain_jobs(10).unwrap_err().kind, ErrorKind::Budget);
    assert_eq!(vm.close().used, 0);
}

#[test]
fn native_integer_boundaries_and_host_failure_remain_explicit() {
    for value in ["1.5", "NaN", "Infinity", "2147483648", "'42'"] {
        let mut vm = loaded(
            &format!("import {{emit}} from 'dango:host';export function main(){{emit({value});}}"),
            Default::default(),
        );
        assert_eq!(
            vm.call("main", None).unwrap_err().kind,
            ErrorKind::Exception,
            "{value}"
        );
        assert_eq!(vm.close().used, 0);
    }
    struct Unavailable;
    impl Host for Unavailable {
        fn emit(&mut self, _: i32) -> Result<(), embedts_engine::Error> {
            Err(embedts_engine::Error {
                kind: ErrorKind::Host,
                message: "host unavailable".into(),
            })
        }
    }
    let bytes=compile_module("import {emit} from 'dango:host';export function main(){try {emit(-2147483648);} catch (_) {} return 42;}").unwrap();
    let mut vm = Vm::new(Box::new(Unavailable), Limits::default(), &GLOBAL_ALLOCATOR).unwrap();
    unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
    assert_eq!(vm.call("main", None).unwrap_err().kind, ErrorKind::Host);
    assert_eq!(vm.call("main", None).unwrap_err().kind, ErrorKind::State);
    assert_eq!(vm.close().used, 0);
}

#[test]
fn rejection_checkpoint_distinguishes_handled_and_unhandled_promises() {
    let mut vm = loaded(
        "export function main(){Promise.reject('handled').catch(()=>{});}",
        Default::default(),
    );
    vm.call("main", None).unwrap();
    assert!(!vm.drain_jobs(8).unwrap().pending);
    assert_eq!(vm.close().used, 0);
    // Handling a newer rejection must not lose an older unhandled reason.
    let mut vm=loaded("export function main(){Promise.reject('unhandled');Promise.reject('handled').catch(()=>{});}",Default::default());
    vm.call("main", None).unwrap();
    let error = vm.drain_jobs(8).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Exception);
    assert_eq!(error.message, "unhandled");
    assert_eq!(vm.close().used, 0);
}

#[test]
fn partial_initialization_failure_returns_all_backing_allocations() {
    use std::{
        alloc::{alloc, dealloc, Layout},
        sync::atomic::{AtomicUsize, Ordering},
    };
    static LIVE: AtomicUsize = AtomicUsize::new(0);
    unsafe fn allocate(layout: Layout) -> *mut u8 {
        let out = unsafe { alloc(layout) };
        if !out.is_null() {
            LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        }
        out
    }
    unsafe fn release(ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { dealloc(ptr, layout) };
    }
    static BACKING: embedts_engine::RawAllocator = embedts_engine::RawAllocator {
        alloc: allocate,
        dealloc: release,
        realloc: None,
    };
    for memory in [128, 8 * 1024, 32 * 1024, 128 * 1024] {
        match Vm::new(
            Box::new(()),
            Limits {
                memory_bytes: memory,
                ..Default::default()
            },
            &BACKING,
        ) {
            Ok(vm) => assert_eq!(vm.close().used, 0),
            Err(error) => assert_eq!(error.kind, ErrorKind::Memory),
        }
        assert_eq!(LIVE.load(Ordering::Relaxed), 0, "memory={memory}");
    }
}

#[test]
fn asynchronous_entries_copy_views_and_recover_from_service_errors() {
    use embedts_engine::{CallState, HostError, HostReply};
    let mut vm = loaded(
        r#"
        import {requestReply as request} from 'dango:host';
        export async function main() {
            const backing=new Uint8Array([99,10,0,255,88]);
            const view=backing.subarray(1,4);
            const reply=await request('write','["团子\\u0000os"]',view);
            backing.fill(0);
            if(reply.bytes[0]!==42 || reply.value!=='团子\u0000os') throw new Error('reply');
            try {await request('missing','[]');} catch(e) {if(e.code===2) return 42;throw e;}
            return 0;
        }
    "#,
        Default::default(),
    );
    assert_eq!(vm.start("main", None).unwrap(), CallState::Pending);
    let request = take_host(&mut vm);
    assert_eq!(request.operation, "write");
    assert_eq!(request.args, "[\"团子\\u0000os\"]");
    assert_eq!(request.bytes, [10, 0, 255]);
    assert_eq!(vm.pending_requests(), 1);
    vm.complete(
        request.id,
        Ok(HostReply {
            json: "\"团子\\u0000os\"".into(),
            bytes: vec![42],
        }),
    )
    .unwrap();
    assert!(vm
        .complete(request.id, Ok(HostReply::json("null")))
        .is_err());
    vm.drain_jobs(16).unwrap();
    let request = take_host(&mut vm);
    vm.complete(request.id, Err(HostError::new(2, "missing file")))
        .unwrap();
    vm.drain_jobs(16).unwrap();
    assert_eq!(vm.entry_status().unwrap(), CallState::Done(42));
    assert_eq!(vm.pending_requests(), 0);
    assert_eq!(vm.transport_bytes(), 0);
    assert_eq!(vm.close().used, 0);
}

#[test]
fn host_queue_limits_and_cancellation_are_bounded_across_instances() {
    use embedts_engine::{CallState, HostReply};
    let mut vm=loaded("import {request} from 'dango:host';export async function main(){const a=request('one','[]');try {await request('two','[]');}catch(e){if(e.code!==257)throw e;}await a;return 42;}",Limits{pending_requests:1,..Default::default()});
    assert_eq!(vm.start("main", None).unwrap(), CallState::Pending);
    vm.drain_jobs(32).unwrap();
    assert_eq!(vm.pending_requests(), 1);
    let stale = take_host(&mut vm);
    assert_eq!(
        vm.close().used,
        0,
        "unsettled promise cancellation frees waiters"
    );
    let mut vm=loaded("import {request} from 'dango:host';export async function main(){await request('new','[]');return 7;}",Default::default());
    vm.start("main", None).unwrap();
    assert!(vm.complete(stale.id, Ok(HostReply::json("null"))).is_err());
    let current = take_host(&mut vm);
    vm.complete(current.id, Ok(HostReply::json("null")))
        .unwrap();
    vm.drain_jobs(32).unwrap();
    assert_eq!(vm.entry_status().unwrap(), CallState::Done(7));
    assert_eq!(vm.close().used, 0);
}

#[test]
fn synchronous_service_errors_are_catchable_and_strings_keep_their_length() {
    use embedts_engine::{HostError, HostReply};
    struct Echo;
    impl Host for Echo {
        fn call(&mut self, op: &str, args: &str, bytes: &[u8]) -> Result<HostReply, HostError> {
            if op == "unavailable" {
                return Err(HostError::new(262, "unavailable"));
            }
            assert_eq!(op, "团子\0os");
            assert_eq!(args, "[1]");
            assert_eq!(bytes, [0, 255]);
            Ok(HostReply {
                json: "\"团子\\u0000os\"".into(),
                bytes: vec![255, 0],
            })
        }
    }
    let source = r#"import {callBytes as call} from 'dango:host';export function main(){try{call('unavailable','[]');}catch(e){if(e.code!==262)throw e;}const r=call('团子\0os','[1]',new Uint8Array([0,255]));return r[0];}"#;
    let bytes = compile_module(source).unwrap();
    let mut vm = Vm::new(Box::new(Echo), Limits::default(), &GLOBAL_ALLOCATOR).unwrap();
    unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
    assert_eq!(vm.call("main", None).unwrap(), Some(255));
    assert_eq!(vm.close().used, 0);
}

#[test]
fn async_rejections_and_invalid_async_return_values_fault_the_instance() {
    for source in [
        "export async function main(){throw new Error('failed');}",
        "export async function main(){return 1.5;}",
        "import {request} from 'dango:host';export function main(){request('ignored','[]');}",
    ] {
        let mut vm = loaded(source, Default::default());
        vm.start("main", None).unwrap();
        if let Some(queued) = vm.take_request() {
            let embedts_engine::Request::Host(request) = queued else {
                panic!("expected host request");
            };
            vm.complete(
                request.id,
                Err(embedts_engine::HostError::new(2, "unhandled")),
            )
            .unwrap();
        }
        let result = vm
            .drain_jobs(32)
            .and_then(|_| vm.entry_status().map(|_| ()));
        assert_eq!(result.unwrap_err().kind, ErrorKind::Exception);
        assert_eq!(vm.close().used, 0);
    }
}

#[test]
fn concurrent_requests_complete_out_of_order_without_losing_jobs() {
    use embedts_engine::{CallState, HostReply};
    let mut vm=loaded("import {request} from 'dango:host';export async function main(){const values=await Promise.all([request('first','[]'),request('second','[]')]);return values[0]+values[1];}",Default::default());
    vm.start("main", None).unwrap();
    let first = take_host(&mut vm);
    let second = take_host(&mut vm);
    vm.complete(second.id, Ok(HostReply::json("2"))).unwrap();
    vm.drain_jobs(32).unwrap();
    assert_eq!(vm.entry_status().unwrap(), CallState::Pending);
    vm.complete(first.id, Ok(HostReply::json("40"))).unwrap();
    assert!(
        vm.has_pending_jobs(),
        "completing a request can enqueue jobs after the previous pump"
    );
    vm.drain_jobs(32).unwrap();
    assert_eq!(vm.entry_status().unwrap(), CallState::Done(42));
    assert_eq!(vm.close().used, 0);
}

#[test]
fn transport_capacity_rejection_is_recoverable_but_reply_allocation_failure_is_terminal() {
    use embedts_engine::{CallState, HostReply};
    let mut vm=loaded("import {request} from 'dango:host';export async function main(){try{await request('x','[]',new Uint8Array(10));}catch(e){if(e.code===257)return 7;throw e;}return 0;}",Limits{host_bytes:12,..Default::default()});
    vm.start("main", None).unwrap();
    vm.drain_jobs(32).unwrap();
    assert_eq!(vm.pending_requests(), 0);
    assert_eq!(vm.entry_status().unwrap(), CallState::Done(7));
    assert_eq!(vm.close().used, 0);
    let mut vm=loaded("import {request} from 'dango:host';export async function main(){try{await request('large','[]');}catch(e){}return 1;}",Limits{memory_bytes:256*1024,..Default::default()});
    vm.start("main", None).unwrap();
    let request = take_host(&mut vm);
    assert_eq!(
        vm.complete(
            request.id,
            Ok(HostReply::json(format!("\"{}\"", "x".repeat(1024 * 1024))))
        )
        .unwrap_err()
        .kind,
        ErrorKind::Memory
    );
    assert_eq!(vm.drain_jobs(32).unwrap_err().kind, ErrorKind::State);
    assert_eq!(vm.close().used, 0);
}

fn take_host(vm: &mut Vm) -> embedts_engine::HostRequest {
    match vm.take_request().unwrap() {
        embedts_engine::Request::Host(request) => request,
        other => panic!("expected host request, got {other:?}"),
    }
}
