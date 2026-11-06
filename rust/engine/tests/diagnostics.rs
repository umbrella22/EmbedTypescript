#![cfg(all(feature = "compiler", feature = "diagnostics"))]
use embedts_engine::{compile_module, opcode_name, Limits, Package, Vm, GLOBAL_ALLOCATOR};

#[test]
fn counters_are_per_vm_and_reset_without_changing_execution() {
    let bytes = compile_module(
        "export function main(n){let sum=0;for(let i=0;i<n;i++){if(i<5)sum+=i;}return sum;}",
    )
    .unwrap();
    let create = || {
        let mut vm = Vm::new(Box::new(()), Limits::default(), &GLOBAL_ALLOCATOR).unwrap();
        // The module was compiled by this test's matching trusted compiler.
        unsafe { vm.load(Package::parse(&bytes).unwrap()) }.unwrap();
        vm.interpreter_diagnostics(true);
        vm
    };
    let mut first = create();
    let mut second = create();
    assert_eq!(first.call("main", Some(10)).unwrap(), Some(10));
    let a = first.interpreter_diagnostics(true);
    assert!(a.dispatches > 0 && a.compare_branches >= 10);
    assert!(a.opcodes.iter().sum::<u64>() >= a.dispatches);
    assert_eq!(second.interpreter_diagnostics(false).dispatches, 0);
    assert_eq!(first.interpreter_diagnostics(false).opcodes, [0; 256]);
    assert_eq!(second.call("main", Some(10)).unwrap(), Some(10));
    assert_eq!(second.interpreter_diagnostics(false), a);
    assert_eq!(opcode_name(256), None);
    assert_eq!(opcode_name(usize::MAX), None);
    for (op, count) in a.opcodes.iter().enumerate() {
        if *count > 0 {
            assert!(opcode_name(op).is_some());
        }
    }
    assert_eq!(first.close().used, 0);
    assert_eq!(second.close().used, 0);
}
