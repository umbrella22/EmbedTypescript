use crate::runtime::State;
use core::{alloc::Layout, ffi::c_void, mem::size_of, ptr};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemoryStats {
    /// Backing allocations, including alignment headers and the C wrapper.
    pub used: usize,
    pub peak: usize,
    pub allocations: usize,
    pub failures: usize,
    pub reallocations: usize,
    pub realloc_moved: usize,
    /// Required payload bytes preserved by a moving realloc, excluding headers.
    pub realloc_copied_bytes: u64,
}
#[repr(C, align(16))]
pub(crate) struct Header {
    size: usize,
}

#[no_mangle]
pub(crate) unsafe extern "C" fn embedts_alloc(opaque: *mut c_void, size: usize) -> *mut c_void {
    // SAFETY: the C runtime retains the stable State pointer until destruction.
    let state = unsafe { &mut *opaque.cast::<State>() };
    let layout = size
        .checked_add(size_of::<Header>())
        .and_then(|total| Layout::from_size_align(total, 16).ok());
    let Some(layout) = layout.filter(|layout| {
        state
            .stats
            .used
            .checked_add(layout.size())
            .is_some_and(|used| used <= state.limits.memory_bytes)
    }) else {
        state.stats.failures += 1;
        state.oom = true;
        return ptr::null_mut();
    };
    let raw = unsafe { (state.allocator.alloc)(layout) };
    if raw.is_null() {
        state.stats.failures += 1;
        state.oom = true;
        return ptr::null_mut();
    }
    unsafe {
        raw.cast::<Header>().write(Header { size });
    }
    state.stats.used += layout.size();
    state.stats.peak = state.stats.peak.max(state.stats.used);
    state.stats.allocations += 1;
    unsafe { raw.add(size_of::<Header>()).cast() }
}
#[no_mangle]
pub(crate) unsafe extern "C" fn embedts_allocation_size(user: *const c_void) -> usize {
    if user.is_null() {
        return 0;
    }
    unsafe { (*user.cast::<u8>().sub(size_of::<Header>()).cast::<Header>()).size }
}
#[no_mangle]
pub(crate) unsafe extern "C" fn embedts_free(opaque: *mut c_void, user: *mut c_void) {
    if user.is_null() {
        return;
    }
    let size = unsafe { embedts_allocation_size(user) };
    let total = size + size_of::<Header>();
    let state = unsafe { &mut *opaque.cast::<State>() };
    state.stats.used -= total;
    unsafe {
        (state.allocator.dealloc)(
            user.cast::<u8>().sub(size_of::<Header>()),
            Layout::from_size_align_unchecked(total, 16),
        );
    }
}
#[no_mangle]
pub(crate) unsafe extern "C" fn embedts_calloc(
    opaque: *mut c_void,
    count: usize,
    size: usize,
) -> *mut c_void {
    let Some(size) = count.checked_mul(size) else {
        let state = unsafe { &mut *opaque.cast::<State>() };
        state.stats.failures += 1;
        state.oom = true;
        return ptr::null_mut();
    };
    let out = unsafe { embedts_alloc(opaque, size) };
    if !out.is_null() {
        unsafe {
            ptr::write_bytes(out, 0, size);
        }
    }
    out
}
#[no_mangle]
pub(crate) unsafe extern "C" fn embedts_realloc(
    opaque: *mut c_void,
    user: *mut c_void,
    size: usize,
) -> *mut c_void {
    if size == 0 {
        unsafe {
            embedts_free(opaque, user);
        }
        return ptr::null_mut();
    }
    if user.is_null() {
        return unsafe { embedts_alloc(opaque, size) };
    }
    let old = unsafe { embedts_allocation_size(user) };
    let state = unsafe { &mut *opaque.cast::<State>() };
    state.stats.reallocations += 1;
    if old == size {
        return user;
    }
    if let Some(realloc) = state.allocator.realloc {
        let layout = size
            .checked_add(size_of::<Header>())
            .and_then(|total| Layout::from_size_align(total, 16).ok());
        // Preserve the existing transient limit even when the backing allocator
        // could grow in place. Moving realloc may briefly retain both blocks.
        let Some(layout) = layout.filter(|layout| {
            state
                .stats
                .used
                .checked_add(layout.size())
                .is_some_and(|used| used <= state.limits.memory_bytes)
        }) else {
            state.stats.failures += 1;
            state.oom = true;
            return ptr::null_mut();
        };
        let old_total = old + size_of::<Header>();
        let raw = unsafe { user.cast::<u8>().sub(size_of::<Header>()) };
        let resized = unsafe {
            realloc(
                raw,
                Layout::from_size_align_unchecked(old_total, 16),
                layout.size(),
            )
        };
        if resized.is_null() {
            state.stats.failures += 1;
            state.oom = true;
            return ptr::null_mut();
        }
        if resized != raw {
            state.stats.allocations += 1;
            state.stats.realloc_moved += 1;
            state.stats.realloc_copied_bytes = state
                .stats
                .realloc_copied_bytes
                .saturating_add(old.min(size) as u64);
            state.stats.peak = state.stats.peak.max(state.stats.used + layout.size());
        }
        state.stats.used = state.stats.used - old_total + layout.size();
        state.stats.peak = state.stats.peak.max(state.stats.used);
        unsafe {
            resized.cast::<Header>().write(Header { size });
        }
        return unsafe { resized.add(size_of::<Header>()).cast() };
    }
    let out = unsafe { embedts_alloc(opaque, size) };
    if !out.is_null() {
        let state = unsafe { &mut *opaque.cast::<State>() };
        state.stats.realloc_moved += 1;
        state.stats.realloc_copied_bytes = state
            .stats
            .realloc_copied_bytes
            .saturating_add(old.min(size) as u64);
        unsafe {
            ptr::copy_nonoverlapping(user, out, old.min(size));
            embedts_free(opaque, user);
        }
    }
    out
}
