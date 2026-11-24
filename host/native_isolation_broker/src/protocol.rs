//! The private test-boundary protocol: lease actions over a framed, HMAC-authenticated pipe.
//!
//! Framing, MAC construction and the nonce rule live in `frame.rs` and are shared with the production
//! launcher-to-tier-runner protocol. What stays here is what belongs to this protocol alone: the lease
//! action set, the lease bounds, and the request shape that carries them. The production frame set
//! must never gain a lease action, which is why the two sit in different modules rather than behind a
//! feature flag on one.

use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// The frame budget of *this* protocol, and nothing else.
///
/// A lease action is a handful of short scalars, so 16 KiB is already generous. It used to be the only
/// frame budget in the crate; the production launcher transport needs a far larger one to carry a
/// catalog start request, so each boundary now names the limit it enforces and this one keeps the value
/// it always had.
pub const MAX_TEST_FRAME_BYTES: usize = 16 * 1024;

pub const MIN_LEASE_MS: u64 = 250;
pub const MAX_LEASE_MS: u64 = 10_000;

/// The refusal set is shared with every other framed protocol here, so a caller reading `error_code`
/// does not have to know which pipe produced it.
pub type ProtocolError = FrameError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllowlistedTarget {
    FixedSleepChild,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Acquire {
        lease_id: String,
        target: AllowlistedTarget,
        timeout_ms: u64,
    },
    Renew {
        lease_id: String,
        timeout_ms: u64,
    },
    Release {
        lease_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub request_id: u64,
    pub owner_sid: String,
    pub nonce: String,
    pub action: Action,
    pub mac: String,
}

#[derive(Serialize)]
struct AuthenticatedPayload<'a> {
    version: u32,
    request_id: u64,
    owner_sid: &'a str,
    nonce: &'a str,
    action: &'a Action,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub request_id: u64,
    pub ok: bool,
    pub phase: String,
    pub error_code: String,
    pub child_pid: Option<u32>,
}

pub fn sign_request(request: &mut Request, key: &[u8]) -> Result<(), ProtocolError> {
    request.mac = frame::mac_hex(&authenticated_bytes(request)?, key)?;
    Ok(())
}

/// Parses and authenticates a request, refusing anything over `max_frame_bytes` before the JSON parser
/// runs.
pub fn parse_authenticated_request(
    payload: &[u8],
    key: &[u8],
    max_frame_bytes: usize,
) -> Result<Request, ProtocolError> {
    if payload.len() > max_frame_bytes {
        return Err(ProtocolError::Oversized);
    }
    let request: Request =
        serde_json::from_slice(payload).map_err(|_| ProtocolError::InvalidJson)?;
    validate_fields(&request)?;
    frame::verify_mac_hex(&authenticated_bytes(&request)?, &request.mac, key)?;
    Ok(request)
}

pub fn encode_frame<T: Serialize>(
    value: &T,
    max_frame_bytes: usize,
) -> Result<Vec<u8>, ProtocolError> {
    frame::encode_frame(value, max_frame_bytes)
}

pub fn declared_frame_len(prefix: [u8; 4], max_frame_bytes: usize) -> Result<usize, ProtocolError> {
    frame::declared_frame_len(prefix, max_frame_bytes)
}

fn authenticated_bytes(request: &Request) -> Result<Vec<u8>, ProtocolError> {
    serde_json::to_vec(&AuthenticatedPayload {
        version: request.version,
        request_id: request.request_id,
        owner_sid: &request.owner_sid,
        nonce: &request.nonce,
        action: &request.action,
    })
    .map_err(|_| ProtocolError::InvalidJson)
}

fn validate_fields(request: &Request) -> Result<(), ProtocolError> {
    if request.version != PROTOCOL_VERSION {
        return Err(ProtocolError::UnsupportedVersion);
    }
    if request.owner_sid.is_empty() || request.owner_sid.len() > 184 {
        return Err(ProtocolError::InvalidField);
    }
    frame::validate_nonce(&request.nonce)?;
    match &request.action {
        Action::Acquire {
            lease_id,
            timeout_ms,
            ..
        }
        | Action::Renew {
            lease_id,
            timeout_ms,
        } => validate_lease(lease_id, *timeout_ms),
        Action::Release { lease_id } => validate_lease_id(lease_id),
    }
}

fn validate_lease(lease_id: &str, timeout_ms: u64) -> Result<(), ProtocolError> {
    validate_lease_id(lease_id)?;
    if !(MIN_LEASE_MS..=MAX_LEASE_MS).contains(&timeout_ms) {
        return Err(ProtocolError::InvalidField);
    }
    Ok(())
}

fn validate_lease_id(lease_id: &str) -> Result<(), ProtocolError> {
    if lease_id.is_empty()
        || lease_id.len() > 64
        || !lease_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ProtocolError::InvalidField);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"01234567890123456789012345678901";

    fn request(action: Action) -> Request {
        let mut request = Request {
            version: PROTOCOL_VERSION,
            request_id: 7,
            owner_sid: "S-1-5-21-1-2-3-1001".to_owned(),
            nonce: "0011223344556677".to_owned(),
            action,
            mac: String::new(),
        };
        sign_request(&mut request, KEY).expect("test request should sign");
        request
    }

    #[test]
    fn strict_parsing_rejects_unknown_top_level_field() {
        let mut value = serde_json::to_value(request(Action::Release {
            lease_id: "lease-7".to_owned(),
        }))
        .expect("request should serialize");
        value
            .as_object_mut()
            .expect("request should be an object")
            .insert("unexpected".to_owned(), serde_json::json!(true));

        assert_eq!(
            parse_authenticated_request(
                &serde_json::to_vec(&value).expect("value should serialize"),
                KEY,
                MAX_TEST_FRAME_BYTES
            ),
            Err(ProtocolError::InvalidJson)
        );
    }

    #[test]
    fn invalid_hmac_is_rejected() {
        let mut request = request(Action::Release {
            lease_id: "lease-7".to_owned(),
        });
        request.mac = "00".repeat(32);

        assert_eq!(
            parse_authenticated_request(
                &serde_json::to_vec(&request).expect("request should serialize"),
                KEY,
                MAX_TEST_FRAME_BYTES
            ),
            Err(ProtocolError::InvalidMac)
        );
    }

    #[test]
    fn oversized_message_is_rejected_before_json_parsing() {
        assert_eq!(
            parse_authenticated_request(
                &vec![b' '; MAX_TEST_FRAME_BYTES + 1],
                KEY,
                MAX_TEST_FRAME_BYTES
            ),
            Err(ProtocolError::Oversized)
        );
        assert_eq!(
            declared_frame_len(
                ((MAX_TEST_FRAME_BYTES as u32) + 1).to_le_bytes(),
                MAX_TEST_FRAME_BYTES
            ),
            Err(ProtocolError::Oversized)
        );
    }

    /// The limit this protocol enforces is its own 16 KiB, not the largest limit in the crate. A body
    /// that a production frame would carry happily must still be refused here.
    #[test]
    fn this_protocol_keeps_its_own_budget_rather_than_the_crate_maximum() {
        use crate::launcher::wire::MAX_TIER_FRAME_BYTES;

        const { assert!(MAX_TEST_FRAME_BYTES < MAX_TIER_FRAME_BYTES) };
        let body = vec![b' '; MAX_TEST_FRAME_BYTES + 1];
        assert_eq!(
            parse_authenticated_request(&body, KEY, MAX_TEST_FRAME_BYTES),
            Err(ProtocolError::Oversized)
        );
        assert_eq!(
            parse_authenticated_request(&body, KEY, MAX_TIER_FRAME_BYTES),
            Err(ProtocolError::InvalidJson),
            "under the larger budget the same bytes reach the parser, so the limit is really the \
             caller's and not a constant"
        );
    }

    #[test]
    fn arbitrary_executable_field_is_rejected() {
        let value = serde_json::json!({
            "version": PROTOCOL_VERSION,
            "request_id": 7,
            "owner_sid": "S-1-5-21-1-2-3-1001",
            "nonce": "0011223344556677",
            "action": {
                "op": "acquire",
                "lease_id": "lease-7",
                "target": "fixed_sleep_child",
                "timeout_ms": 1000,
                "executable": "C:\\Windows\\System32\\cmd.exe"
            },
            "mac": "00".repeat(32)
        });

        assert_eq!(
            parse_authenticated_request(
                &serde_json::to_vec(&value).expect("value should serialize"),
                KEY,
                MAX_TEST_FRAME_BYTES
            ),
            Err(ProtocolError::InvalidJson)
        );
    }
}
