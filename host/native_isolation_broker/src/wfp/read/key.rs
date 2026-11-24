//! WFP keys: the contract's GUID spelling, the Windows `GUID` layout, and the one derivation of a
//! filter's key.
//!
//! A key is held as the GUID's 128 bits read as RFC 4122 big-endian fields, which is the order the
//! contract spells it in. A Windows `GUID` keeps Data1-Data3 little-endian in memory, so the struct is
//! built from that value's fields and never by copying bytes; copying them is the mistake the shared
//! golden vectors exist to catch.

use super::contract::{FilterMatch, Layer, Transport, WfpRules};
use sha2::{Digest, Sha256};
use std::io;
use windows_sys::core::GUID;

/// Parses the contract's canonical spelling: lower-case hex, 8-4-4-4-12, nothing around it.
pub(crate) fn parse_key(text: &str) -> io::Result<u128> {
    let refuse = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "a WFP key is not a canonical lower-case GUID",
        )
    };
    if text.len() != 36 {
        return Err(refuse());
    }
    let mut key: u128 = 0;
    for (index, byte) in text.bytes().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if byte != b'-' {
                return Err(refuse());
            }
            continue;
        }
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => return Err(refuse()),
        };
        key = (key << 4) | u128::from(digit);
    }
    Ok(key)
}

/// The contract's spelling of a key.
pub(crate) fn format_key(key: u128) -> String {
    let hex = format!("{key:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The Windows layout of a key.
pub(crate) fn to_guid(key: u128) -> GUID {
    GUID::from_u128(key)
}

/// The key of one filter, as the contract's `egressWfpFilterKey` derives it: SHA-256 over the domain,
/// the object key, the layer, the match and the transport, one per line; the first sixteen bytes, with
/// the version nibble set to 8 and the RFC 4122 variant.
pub(crate) fn filter_key(
    rules: &WfpRules,
    object_key: &str,
    layer: Layer,
    matched: FilterMatch,
    transport: Transport,
) -> u128 {
    let input = format!(
        "{}\n{object_key}\n{}\n{}\n{}",
        rules.filter_key_domain,
        layer.as_str(),
        matched.as_str(),
        transport.as_str()
    );
    let digest = Sha256::digest(input.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    u128::from_be_bytes(bytes)
}
