//! Copied host messages. No VM values or native pointers cross this interface.
use alloc::{string::String, vec::Vec};

/// A service failure can be caught by the application without faulting the VM.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostError {
    pub code: i32,
    pub message: String,
}
impl HostError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostReply {
    /// Serialized result, decoded by the native bridge for value replies.
    pub json: String,
    pub bytes: Vec<u8>,
}
impl HostReply {
    pub fn json(json: impl Into<String>) -> Self {
        Self {
            json: json.into(),
            bytes: Vec::new(),
        }
    }
}

/// Validated scalar drawing command. No JS values or owned payloads cross FFI.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Draw {
    pub operation: i32,
    pub coordinates: [i32; 6],
    pub color: u32,
    pub start: f64,
    pub end: f64,
}
/// Host callbacks run synchronously, must be bounded, nonblocking and not panic.
/// Blocking operations are delivered through `Vm::take_request` instead.
pub trait Host {
    fn draw(&mut self, _draw: Draw) -> Result<(), HostError> {
        Err(HostError::new(
            crate::platform::error_code::NOT_SUPPORTED,
            "graphics unavailable",
        ))
    }
    fn now_ms(&mut self) -> Result<u64, HostError> {
        Err(HostError::new(
            crate::platform::error_code::NOT_SUPPORTED,
            "monotonic clock unavailable",
        ))
    }
    fn emit(&mut self, _value: i32) -> Result<(), crate::Error> {
        Ok(())
    }
    fn call(
        &mut self,
        _operation: &str,
        _args: &str,
        _bytes: &[u8],
    ) -> Result<HostReply, HostError> {
        Err(HostError::new(
            crate::platform::error_code::NOT_SUPPORTED,
            "host operation unavailable",
        ))
    }
}
impl Host for () {}

/// Identifies a request across VM lifetimes as well as within one VM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestId(pub(crate) u64);
#[derive(Debug)]
pub struct HostRequest {
    pub id: RequestId,
    pub operation: String,
    pub args: String,
    pub bytes: Vec<u8>,
}
#[derive(Debug)]
pub enum Request {
    Host(HostRequest),
    Delay { id: RequestId, micros: u64 },
}
impl Request {
    pub fn id(&self) -> RequestId {
        match self {
            Self::Host(request) => request.id,
            Self::Delay { id, .. } => *id,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallState {
    Missing,
    Done(i32),
    Pending,
}
