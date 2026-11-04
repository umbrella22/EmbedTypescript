use crate::{Error, ErrorKind, ENGINE_ID};
#[cfg(feature = "compiler")]
use alloc::vec::Vec;
use sha2::{Digest, Sha256};

pub const HOST_ABI: u32 = 3;
/// magic(8), format(2), flags(2), payload length(4), engine id(32),
/// host ABI(4), payload SHA-256(32). All integers are little-endian.
pub const HEADER_BYTES: usize = 84;
const MAGIC: &[u8; 8] = b"EMBEDTS\0";

/// Integrity-checked bytecode. This proves format/compatibility, not authorship.
pub struct Package<'a> {
    payload: &'a [u8],
}
impl<'a> Package<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, Error> {
        let bad = || Error::new(ErrorKind::Package, "invalid bytecode package");
        if bytes.len() < HEADER_BYTES || &bytes[..8] != MAGIC || bytes[8..12] != [1, 0, 0, 0] {
            return Err(bad());
        }
        let size = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        if size == 0 || bytes.len().checked_sub(HEADER_BYTES) != Some(size) {
            return Err(bad());
        }
        if bytes[16..48] != ENGINE_ID || bytes[48..52] != HOST_ABI.to_le_bytes() {
            return Err(Error::new(
                ErrorKind::Compatibility,
                "engine profile or host ABI mismatch",
            ));
        }
        let payload = &bytes[HEADER_BYTES..];
        if Sha256::digest(payload)[..] != bytes[52..84] {
            return Err(Error::new(ErrorKind::Integrity, "bytecode digest mismatch"));
        }
        Ok(Self { payload })
    }
    pub(crate) fn payload(&self) -> &[u8] {
        self.payload
    }
}

#[cfg(feature = "compiler")]
pub(crate) fn encode(payload: &[u8]) -> Result<Vec<u8>, Error> {
    let size = u32::try_from(payload.len())
        .map_err(|_| Error::new(ErrorKind::Package, "bytecode exceeds package format"))?;
    let mut bytes = Vec::with_capacity(HEADER_BYTES + payload.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&[1, 0, 0, 0]);
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.extend_from_slice(&ENGINE_ID);
    bytes.extend_from_slice(&HOST_ABI.to_le_bytes());
    bytes.extend_from_slice(&Sha256::digest(payload));
    bytes.extend_from_slice(payload);
    Ok(bytes)
}
