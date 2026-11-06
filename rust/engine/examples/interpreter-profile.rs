//! Portable work counters for a trusted JavaScript module and exported entry.
use embedts_engine::{
    compile_module, opcode_name, CallState, Limits, Package, Vm, GLOBAL_ALLOCATOR,
};
use serde_json::json;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "interpreter-profile <module.js> <entry> <int32>"
    );
    let source = std::fs::read_to_string(&args[1]).unwrap();
    let bytes = compile_module(&source).unwrap();
    let mut vm = Vm::new(
        Box::new(()),
        Limits {
            memory_bytes: 4 * 1024 * 1024,
            interrupt_polls: 10_000_000,
            ..Default::default()
        },
        &GLOBAL_ALLOCATOR,
    )
    .unwrap();
    // This process compiled the trusted module using the matching engine.
    unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
    vm.interpreter_diagnostics(true);
    let mut state = vm.start(&args[2], Some(args[3].parse().unwrap())).unwrap();
    let mut jobs = 0;
    while state == CallState::Pending {
        jobs += vm.drain_jobs(32).unwrap().executed;
        state = vm.entry_status().unwrap();
    }
    let CallState::Done(result) = state else {
        panic!("entry did not complete")
    };
    let d = vm.interpreter_diagnostics(false);
    let mut opcodes: Vec<_> = d
        .opcodes
        .iter()
        .enumerate()
        .filter(|(_, n)| **n != 0)
        .map(|(op, n)| json!({"opcode":opcode_name(op).unwrap(), "count":n}))
        .collect();
    opcodes.sort_by_key(|entry| core::cmp::Reverse(entry["count"].as_u64().unwrap()));
    let memory = vm.close();
    assert_eq!(memory.used, 0);
    assert_eq!(memory.failures, 0);
    println!(
        "{}",
        json!({
            "engine_id":embedts_engine::ENGINE_ID, "entry":args[2], "argument":args[3],
            "result":result, "jobs":jobs, "opcodes":opcodes, "dispatches":d.dispatches,
            "adjacent_candidates":{"compare_branch":d.compare_branches,
            "local_load_pair":d.local_load_pairs,"multiply_remainder":d.multiply_remainders,
        "arithmetic_store":d.arithmetic_stores,"nullish_branch":d.nullish_branches},
            "allocator_calls":{"malloc":d.malloc_calls,"calloc":d.calloc_calls,
            "realloc":d.realloc_calls,"free":d.free_calls},
            "backing_memory":{"peak_bytes":memory.peak,"allocations":memory.allocations,
            "reallocations":memory.reallocations,"copied_bytes":memory.realloc_copied_bytes,
            "used_after_close":memory.used},
            "measurement":"instrumented work counts; no timing or intrinsic cycle attribution"
        })
    );
}
