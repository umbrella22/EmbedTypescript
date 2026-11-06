//! Optional interpreter counters. Diagnostic builds are unsuitable for timing.
use core::ffi::{c_char, c_void, CStr};

/// Executed opcode counts and opportunities for adjacent instruction fusion.
/// Opcode IDs are specific to the pinned engine; use [`opcode_name`] for reports.
/// Sequence counts include operations that subsequently throw. Allocation counts
/// count QuickJS allocator entry calls, including nested calls and zero sizes.
#[repr(C)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InterpreterDiagnostics {
    pub opcodes: [u64; 256],
    pub dispatches: u64,
    pub compare_branches: u64,
    pub local_load_pairs: u64,
    pub multiply_remainders: u64,
    pub arithmetic_stores: u64,
    pub nullish_branches: u64,
    pub malloc_calls: u64,
    pub calloc_calls: u64,
    pub realloc_calls: u64,
    pub free_calls: u64,
}
unsafe extern "C" {
    pub(crate) fn embedts_diagnostics(
        vm: *mut c_void,
        out: *mut InterpreterDiagnostics,
        reset: i32,
    );
    fn embedts_qjs_opcode_name(opcode: u32) -> *const c_char;
}
/// Return a static upstream opcode name, or `None` outside the opcode table.
pub fn opcode_name(opcode: usize) -> Option<&'static str> {
    let opcode = u32::try_from(opcode).ok()?;
    let name = unsafe { embedts_qjs_opcode_name(opcode) };
    if name.is_null() {
        None
    } else {
        // The C table contains only static ASCII string literals.
        unsafe { CStr::from_ptr(name) }.to_str().ok()
    }
}
