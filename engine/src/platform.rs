use core::alloc::Layout;
/// Fallible allocation callbacks supplied by the embedding.
#[derive(Clone, Copy)]
pub struct RawAllocator {
    pub alloc: unsafe fn(Layout) -> *mut u8,
    pub dealloc: unsafe fn(*mut u8, Layout),
    /// Resize a live allocation with unchanged alignment. On failure the old
    /// allocation remains valid. The callback may allocate before releasing it.
    pub realloc: Option<unsafe fn(*mut u8, Layout, usize) -> *mut u8>,
}

unsafe fn global_alloc(layout: Layout) -> *mut u8 {
    unsafe { alloc::alloc::alloc(layout) }
}
unsafe fn global_dealloc(ptr: *mut u8, layout: Layout) {
    unsafe { alloc::alloc::dealloc(ptr, layout) }
}
unsafe fn global_realloc(ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
    unsafe { alloc::alloc::realloc(ptr, layout, size) }
}

/// The Rust global allocator.
pub static GLOBAL_ALLOCATOR: RawAllocator = RawAllocator {
    alloc: global_alloc,
    dealloc: global_dealloc,
    realloc: Some(global_realloc),
};

// Numeric errors are part of the existing Host ABI, independent of ESP headers.
pub(crate) mod error_code {
    pub const FAIL: i32 = -1;
    pub const NO_MEM: i32 = 0x101;
    pub const INVALID_ARG: i32 = 0x102;
    pub const INVALID_STATE: i32 = 0x103;
    pub const NOT_SUPPORTED: i32 = 0x106;
}
unsafe extern "C" {
    fn embedts_format_date(
        seconds: i64,
        format: *const core::ffi::c_char,
        out: *mut core::ffi::c_char,
        cap: usize,
    ) -> usize;
}
pub(crate) fn date(seconds: i64, format: &str) -> Result<alloc::string::String, i32> {
    use alloc::ffi::CString;
    if format.len() > 64 {
        return Err(error_code::INVALID_ARG);
    }
    let format = CString::new(format).map_err(|_| error_code::INVALID_ARG)?;
    let mut out = [0u8; 128];
    let size = unsafe {
        embedts_format_date(seconds, format.as_ptr(), out.as_mut_ptr().cast(), out.len())
    };
    if size == 0 {
        return Err(error_code::INVALID_ARG);
    }
    Ok(core::str::from_utf8(&out[..size])
        .map_err(|_| error_code::INVALID_ARG)?
        .into())
}
