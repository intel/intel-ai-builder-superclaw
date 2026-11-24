//! Length-prefixed framing, HMAC authentication and nonce rules shared by every pipe protocol in
//! this crate.
//!
//! Two protocols build on these primitives. `protocol.rs` is the private test-boundary protocol;
//! `launcher/wire.rs` is the production launcher-to-tier-runner protocol. They share the framing,
//! the MAC construction and the nonce rule on purpose, and share nothing else on purpose: the test
//! protocol's lease actions are not part of the production frame set and must not become part of it.
//!
//! # Why every limit is a parameter
//!
//! There is no single correct frame budget in this crate. The test protocol carries a lease action
//! and needs 16 KiB; a catalog start request needs 64 KiB; the production envelope that carries one
//! start request plus its own authenticated fields needs more again. A single crate-wide constant
//! would have to be the largest of those, which would let the test protocol accept frames six times
//! the size it has any use for, or the smallest, which would make a legal production start request
//! impossible to send. Both were true of the single constant this module replaced, so the limit is
//! now supplied by the caller at every boundary that enforces one.

use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Bytes of little-endian length prefix in front of every frame body.
pub const FRAME_PREFIX_BYTES: usize = 4;

/// Every authentication key in this crate is a 32-byte HMAC-SHA256 key.
pub const AUTH_KEY_BYTES: usize = 32;

/// Nonce bounds. Long enough that a randomly generated nonce cannot collide by accident, short
/// enough that a peer cannot spend the frame budget on one field.
pub const NONCE_MIN_LEN: usize = 16;
pub const NONCE_MAX_LEN: usize = 128;

/// The refusal classes every framed protocol shares. Each maps to one stable code, because a caller
/// has to be able to tell an oversize frame from a bad MAC from a shape it does not understand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    Oversized,
    InvalidJson,
    UnsupportedVersion,
    InvalidField,
    InvalidMac,
}

impl FrameError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Oversized => "request_oversized",
            Self::InvalidJson => "invalid_json",
            Self::UnsupportedVersion => "unsupported_version",
            Self::InvalidField => "invalid_field",
            Self::InvalidMac => "invalid_hmac",
        }
    }
}

/// Serializes `value` and frames it, refusing anything over `max_frame_bytes` before the frame is
/// built rather than after it is on the wire.
pub fn encode_frame<T: Serialize>(
    value: &T,
    max_frame_bytes: usize,
) -> Result<Vec<u8>, FrameError> {
    encode_payload_frame(&encode_body(value, max_frame_bytes)?, max_frame_bytes)
}

/// Serializes `value` as one frame *body*, with no length prefix, under the same bound.
///
/// The counterpart to `encode_frame` for a transport that supplies its own prefix - the production tier
/// pipes do, in `launcher/pipe.rs`. Having both share this bound is the point: a body this accepts is a
/// body `encode_payload_frame` would accept too, so one protocol cannot end up with two different ideas
/// of how large a frame may be. Prefixing an already-prefixed body is exactly the mistake that makes a
/// peer's first read look like malformed JSON, so the two operations are named apart.
pub fn encode_body<T: Serialize>(value: &T, max_frame_bytes: usize) -> Result<Vec<u8>, FrameError> {
    let payload = serde_json::to_vec(value).map_err(|_| FrameError::InvalidJson)?;
    if payload.is_empty() {
        return Err(FrameError::InvalidField);
    }
    if payload.len() > max_frame_bytes {
        return Err(FrameError::Oversized);
    }
    Ok(payload)
}

/// Frames bytes that are already serialized.
///
/// An empty body is refused rather than framed: a zero-length frame is indistinguishable from a peer
/// that sent a prefix and then stopped, and no protocol here has a meaning for one.
pub fn encode_payload_frame(payload: &[u8], max_frame_bytes: usize) -> Result<Vec<u8>, FrameError> {
    if payload.is_empty() {
        return Err(FrameError::InvalidField);
    }
    if payload.len() > max_frame_bytes || payload.len() > u32::MAX as usize {
        return Err(FrameError::Oversized);
    }
    let mut frame = Vec::with_capacity(FRAME_PREFIX_BYTES + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// Decodes a length prefix, refusing an out-of-range declaration before a single body byte is read and
/// before any buffer is allocated for it.
///
/// Zero is out of range, on the same grounds as `encode_payload_frame`'s refusal to produce one: an empty
/// frame has no meaning in any protocol here, and a reader that returned one would hand its caller a body
/// that cannot parse and charge it against whatever per-connection frame budget that caller keeps. The
/// two directions have to agree, or a peer can send something no peer will ever write.
pub fn declared_frame_len(prefix: [u8; 4], max_frame_bytes: usize) -> Result<usize, FrameError> {
    let length = u32::from_le_bytes(prefix) as usize;
    if length == 0 {
        return Err(FrameError::InvalidField);
    }
    if length > max_frame_bytes {
        return Err(FrameError::Oversized);
    }
    Ok(length)
}

pub fn mac_hex(authenticated: &[u8], key: &[u8]) -> Result<String, FrameError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| FrameError::InvalidMac)?;
    mac.update(authenticated);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// Verifies a hex-encoded MAC in constant time, via the `hmac` crate's own comparison rather than a
/// string or slice equality on the decoded bytes.
pub fn verify_mac_hex(
    authenticated: &[u8],
    supplied_hex: &str,
    key: &[u8],
) -> Result<(), FrameError> {
    let supplied = hex::decode(supplied_hex).map_err(|_| FrameError::InvalidMac)?;
    if supplied.len() != 32 {
        return Err(FrameError::InvalidMac);
    }
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| FrameError::InvalidMac)?;
    mac.update(authenticated);
    mac.verify_slice(&supplied)
        .map_err(|_| FrameError::InvalidMac)
}

pub fn validate_nonce(nonce: &str) -> Result<(), FrameError> {
    if (NONCE_MIN_LEN..=NONCE_MAX_LEN).contains(&nonce.len()) {
        Ok(())
    } else {
        Err(FrameError::InvalidField)
    }
}

/// Decodes a hex authentication key argument, requiring exactly `AUTH_KEY_BYTES`.
pub fn decode_auth_key(value: &str) -> Result<Vec<u8>, FrameError> {
    let key = hex::decode(value).map_err(|_| FrameError::InvalidField)?;
    if key.len() != AUTH_KEY_BYTES {
        return Err(FrameError::InvalidField);
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"01234567890123456789012345678901";

    #[test]
    fn a_frame_is_a_little_endian_length_followed_by_the_body() {
        let frame = encode_payload_frame(b"abc", 16).expect("a short body should frame");
        assert_eq!(frame, vec![3, 0, 0, 0, b'a', b'b', b'c']);
        assert_eq!(
            declared_frame_len([3, 0, 0, 0], 16).expect("the prefix should decode"),
            3
        );
    }

    #[test]
    fn each_limit_is_enforced_against_the_caller_s_own_budget() {
        // The same bytes are legal under one protocol's budget and oversize under another's, which is
        // the whole reason the budget is a parameter.
        let body = vec![b'x'; 32];
        assert!(encode_payload_frame(&body, 64).is_ok());
        assert_eq!(
            encode_payload_frame(&body, 16),
            Err(FrameError::Oversized),
            "a body over the caller's budget must not be framed"
        );
        assert_eq!(
            declared_frame_len(33u32.to_le_bytes(), 32),
            Err(FrameError::Oversized)
        );
        assert_eq!(encode_payload_frame(&[], 64), Err(FrameError::InvalidField));
    }

    /// The two directions of the empty-frame rule. A reader that accepted what no writer will produce
    /// would let a peer spend a frame budget on a body that cannot possibly parse.
    #[test]
    fn a_zero_length_frame_is_refused_when_it_is_declared_as_well_as_when_it_is_written() {
        assert_eq!(encode_payload_frame(&[], 64), Err(FrameError::InvalidField));
        assert_eq!(
            declared_frame_len([0, 0, 0, 0], 64),
            Err(FrameError::InvalidField),
            "a prefix declaring nothing must be refused before a body is allocated for it"
        );
        assert_eq!(
            declared_frame_len([1, 0, 0, 0], 64).expect("one byte is a legal declaration"),
            1
        );
    }

    #[test]
    fn a_mac_verifies_against_its_own_bytes_and_nothing_else() {
        let mac = mac_hex(b"authenticated", KEY).expect("the MAC should compute");
        assert!(verify_mac_hex(b"authenticated", &mac, KEY).is_ok());
        assert_eq!(
            verify_mac_hex(b"authenticatee", &mac, KEY),
            Err(FrameError::InvalidMac)
        );
        assert_eq!(
            verify_mac_hex(b"authenticated", &mac, b"other key, also thirty two bytes"),
            Err(FrameError::InvalidMac)
        );
        assert_eq!(
            verify_mac_hex(b"authenticated", "not hex", KEY),
            Err(FrameError::InvalidMac)
        );
        assert_eq!(
            verify_mac_hex(b"authenticated", "00", KEY),
            Err(FrameError::InvalidMac),
            "a MAC of the wrong length must be refused rather than compared"
        );
    }

    #[test]
    fn nonces_and_keys_are_bounded() {
        assert!(validate_nonce(&"a".repeat(NONCE_MIN_LEN)).is_ok());
        assert!(validate_nonce(&"a".repeat(NONCE_MIN_LEN - 1)).is_err());
        assert!(validate_nonce(&"a".repeat(NONCE_MAX_LEN + 1)).is_err());

        assert_eq!(
            decode_auth_key(&"ab".repeat(AUTH_KEY_BYTES))
                .expect("a 32-byte key should decode")
                .len(),
            AUTH_KEY_BYTES
        );
        assert_eq!(
            decode_auth_key(&"ab".repeat(AUTH_KEY_BYTES - 1)),
            Err(FrameError::InvalidField)
        );
        assert_eq!(decode_auth_key("zz"), Err(FrameError::InvalidField));
    }
}
