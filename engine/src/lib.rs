//! Bounded, single-thread QuickJS-NG bytecode execution.
#![no_std]
#![deny(unsafe_op_in_unsafe_fn)]
extern crate alloc;
#[cfg(all(target_os = "none", feature = "compiler"))]
compile_error!("embedts-engine/compiler is available only to host tools");
mod allocator;
mod host;
mod package;
mod platform;
mod runtime;
pub mod workers;
pub use allocator::MemoryStats;
pub use host::{CallState, Draw, Host, HostError, HostReply, HostRequest, Request, RequestId};
pub use package::{Package, HEADER_BYTES, HOST_ABI};
pub use platform::{RawAllocator, GLOBAL_ALLOCATOR};
#[cfg(feature = "compiler")]
pub use runtime::compile_module;
pub use runtime::{Error, ErrorKind, JobProgress, Limits, Profile, Vm};
include!(concat!(env!("OUT_DIR"), "/engine_id.rs"));
