use super::*;
use crate::allocator::{embedts_alloc, embedts_calloc, embedts_free, embedts_realloc};
use core::{alloc::Layout, mem::size_of, ptr};

fn state(allocator: &'static RawAllocator) -> State {
    State {
        allocator: *allocator,
        limits: Limits::default(),
        stats: MemoryStats::default(),
        oom: false,
        interrupted: false,
        polls: 0,
        deadline: None,
        host_us: 0,
        slow_host_us: 0,
        slow_host: String::new(),
        host: Box::new(()),
        host_error: None,
        instance: 0,
        sequence: 0,
        queued: VecDeque::new(),
        outstanding: Vec::new(),
        transport_bytes: 0,
        reply: HostReply::json("null"),
        profile: Profile::default(),
    }
}

// A backing block with spare capacity provides deterministic in-place resize.
unsafe fn spare_alloc(layout: Layout) -> *mut u8 {
    assert!(layout.size() <= 4096);
    unsafe { alloc::alloc::alloc(Layout::from_size_align(4096, layout.align()).unwrap()) }
}
unsafe fn spare_free(p: *mut u8, layout: Layout) {
    unsafe { alloc::alloc::dealloc(p, Layout::from_size_align(4096, layout.align()).unwrap()) }
}
unsafe fn in_place(p: *mut u8, _: Layout, size: usize) -> *mut u8 {
    assert!(size <= 4096);
    p
}
unsafe fn moving(p: *mut u8, old: Layout, size: usize) -> *mut u8 {
    let resized =
        unsafe { alloc::alloc::alloc(Layout::from_size_align(size, old.align()).unwrap()) };
    if !resized.is_null() {
        unsafe {
            ptr::copy_nonoverlapping(p, resized, size.min(old.size()));
            alloc::alloc::dealloc(p, old);
        }
    }
    resized
}
unsafe fn fail_resize(_: *mut u8, _: Layout, _: usize) -> *mut u8 {
    ptr::null_mut()
}
static IN_PLACE: RawAllocator = RawAllocator {
    alloc: spare_alloc,
    dealloc: spare_free,
    realloc: Some(in_place),
};
static MOVING: RawAllocator = RawAllocator {
    alloc: crate::GLOBAL_ALLOCATOR.alloc,
    dealloc: crate::GLOBAL_ALLOCATOR.dealloc,
    realloc: Some(moving),
};
static FALLBACK: RawAllocator = RawAllocator {
    realloc: None,
    ..MOVING
};
static FAILING: RawAllocator = RawAllocator {
    realloc: Some(fail_resize),
    ..MOVING
};

fn check_resize(allocator: &'static RawAllocator, expected_moves: usize) {
    let mut state = state(allocator);
    let opaque = ptr::from_mut(&mut state).cast();
    let original = unsafe { embedts_alloc(opaque, 128) };
    assert!(!original.is_null());
    assert_eq!(original as usize % 16, 0);
    unsafe {
        ptr::write_bytes(original, 0x5a, 128);
    }
    assert_eq!(unsafe { embedts_realloc(opaque, original, 128) }, original);
    assert_eq!(state.stats.allocations, 1);
    let smaller = unsafe { embedts_realloc(opaque, original, 64) };
    assert!(!smaller.is_null());
    assert_eq!(
        unsafe { core::slice::from_raw_parts(smaller.cast::<u8>(), 64) },
        &[0x5a; 64]
    );
    let larger = unsafe { embedts_realloc(opaque, smaller, 256) };
    assert!(!larger.is_null());
    assert_eq!(larger as usize % 16, 0);
    assert_eq!(
        unsafe { core::slice::from_raw_parts(larger.cast::<u8>(), 64) },
        &[0x5a; 64]
    );
    if expected_moves == 0 {
        assert_eq!(larger, original);
    }
    assert_eq!(state.stats.reallocations, 3);
    assert_eq!(state.stats.realloc_moved, expected_moves);
    assert_eq!(state.stats.allocations, 1 + expected_moves);
    assert_eq!(state.stats.realloc_copied_bytes, expected_moves as u64 * 64);
    assert_eq!(
        state.stats.used,
        256 + size_of::<crate::allocator::Header>()
    );
    assert!(state.stats.peak <= state.limits.memory_bytes);
    unsafe {
        embedts_free(opaque, larger);
    }
    assert_eq!(state.stats.used, 0);
}

#[test]
fn in_place_resize_preserves_payload_alignment_and_accounting() {
    check_resize(&IN_PLACE, 0);
}

#[test]
fn moving_and_fallback_resize_preserve_payload_and_accounting() {
    check_resize(&MOVING, 2);
    check_resize(&FALLBACK, 2);
}

#[test]
fn resize_failure_overflow_and_transient_quota_keep_the_old_block_live() {
    let mut state = state(&FAILING);
    let opaque = ptr::from_mut(&mut state).cast();
    let original = unsafe { embedts_alloc(opaque, 512) };
    assert!(!original.is_null());
    unsafe {
        ptr::write_bytes(original, 0xa5, 512);
    }
    let used = state.stats.used;
    for size in [640, usize::MAX] {
        assert!(unsafe { embedts_realloc(opaque, original, size) }.is_null());
        assert_eq!(state.stats.used, used);
        assert!(state.oom);
    }
    state.allocator = IN_PLACE;
    // Reject before invoking a callback that could have resized in place.
    state.limits.memory_bytes = used + 256 + size_of::<crate::allocator::Header>() - 1;
    assert!(unsafe { embedts_realloc(opaque, original, 256) }.is_null());
    assert_eq!(state.stats.failures, 3);
    assert_eq!(state.stats.used, used);
    assert_eq!(
        unsafe { core::slice::from_raw_parts(original.cast::<u8>(), 512) },
        &[0xa5; 512]
    );
    state.allocator = FAILING;
    unsafe {
        embedts_free(opaque, original);
    }
    assert_eq!(state.stats.used, 0);
}

#[test]
fn null_zero_and_calloc_overflow_do_not_leak() {
    let mut state = state(&FALLBACK);
    let opaque = ptr::from_mut(&mut state).cast();
    assert!(unsafe { embedts_calloc(opaque, usize::MAX, 2) }.is_null());
    assert_eq!(state.stats.used, 0);
    let p = unsafe { embedts_realloc(opaque, ptr::null_mut(), 32) };
    assert!(!p.is_null());
    assert!(unsafe { embedts_realloc(opaque, p, 0) }.is_null());
    assert_eq!(state.stats.used, 0);
}
