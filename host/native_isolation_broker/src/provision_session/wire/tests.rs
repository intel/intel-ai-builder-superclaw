//! Frame contract tests for the provision pipe.
//!
//! One positive case per direction, one negative case per refusal class, and a fixed vector the Python
//! `broker_client` asserts the same four constants against. Each refusal is asserted to arrive for its own
//! stated reason rather than for whichever check happens to run first, because the order the checks run in
//! is itself load-bearing: nothing that a frame's own bytes can decide may be decided after the replay set
//! has been touched.

use super::*;
use crate::managed_root_path::UnreadableKind;
use serde_json::json;

const OWNER: &str = "S-1-5-21-1-2-3-1001";
const OTHER_OWNER: &str = "S-1-5-21-1-2-3-1002";

// The cross-language fixed vector. Everything below is computed by
// `hmac.new(bytes(range(32)), json.dumps(authenticated, sort_keys=True,
// separators=(",", ":"), ensure_ascii=False).encode("utf-8"), hashlib.sha256)` in Python, so the
// Python `broker_client` on the other end of this pipe can assert the same four constants against its
// own implementation. Neither side is allowed to be the definition of "canonical"; these bytes are.
//
// The path deliberately carries a non-ASCII component, which is what pins `ensure_ascii=False`: with
// the default `ensure_ascii=True` Python would emit `\u00e9` and the MAC would differ. The canonical
// bytes are asserted as hex rather than as a string literal so this stays a real check even if the
// source file's own encoding is ever mangled in transit.
//
// Readable form of `VECTOR_CANONICAL_HEX`:
//
//   {"frame":{"acl_plan":{"contract_version":1,"managed_root_plans":[],"workspace_root_plans":[]},
//   "op":"provision","path_set":{"owner_sid":"S-1-5-21-1-2-3-1001","workspace_roots":[{"path":
//   "C:\\ws\\café","root_id":"w1"}]}},"nonce":"0123456789abcdef",
//   "owner_sid":"S-1-5-21-1-2-3-1001","version":1}
const VECTOR_NONCE: &str = "0123456789abcdef";
const VECTOR_KEY_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const VECTOR_MAC: &str = "f58fce862d83c4817dd4881a458b5ed631257e9545cb380de1a5c31a7cd7f08f";
const VECTOR_PATH_SET_DIGEST: &str =
    "c5884e4642399f41f87f2a4a575c9664d1a275ba6d253eb0a072ce3700b1da5b";
const VECTOR_ACL_PLAN_DIGEST: &str =
    "60e00b2ceac610b7583b2c808c61ce5d8f70a8ffe8e118898ead02b16fa592f0";
const VECTOR_CANONICAL_HEX: &str = concat!(
    "7b226672616d65223a7b2261636c5f706c616e223a7b22636f6e74726163745f76657273696f6e223a312c22",
    "6d616e616765645f726f6f745f706c616e73223a5b5d2c22776f726b73706163655f726f6f745f706c616e73",
    "223a5b5d7d2c226f70223a2270726f766973696f6e222c22706174685f736574223a7b226f776e65725f7369",
    "64223a22532d312d352d32312d312d322d332d31303031222c22776f726b73706163655f726f6f7473223a5b",
    "7b2270617468223a22433a5c5c77735c5c636166c3a9222c22726f6f745f6964223a227731227d5d7d7d2c22",
    "6e6f6e6365223a2230313233343536373839616263646566222c226f776e65725f736964223a22532d312d35",
    "2d32312d312d322d332d31303031222c2276657273696f6e223a317d",
);

fn vector_key() -> Vec<u8> {
    hex::decode(VECTOR_KEY_HEX).expect("the vector key is hex")
}

fn vector_path_set() -> Value {
    json!({
        "owner_sid": OWNER,
        "workspace_roots": [{"root_id": "w1", "path": "C:\\ws\\café"}],
    })
}

fn vector_acl_plan() -> Value {
    json!({
        "contract_version": 1,
        "managed_root_plans": [],
        "workspace_root_plans": [],
    })
}

fn provision_frame() -> ProvisionFrame {
    ProvisionFrame::Provision {
        path_set: vector_path_set(),
        acl_plan: vector_acl_plan(),
    }
}

fn session() -> ProvisionSession {
    ProvisionSession::new(vector_key(), OWNER)
}

fn nonce(tag: u32) -> String {
    format!("{tag:016x}")
}

/// Seals without the checks `seal` performs, so a negative test can put a shape on the wire that this
/// crate would never send and still have the MAC be correct - which is the only way to prove the
/// *receiving* side rejects it rather than the sending side.
fn sealed_bypassing_checks(
    key: &[u8],
    owner_sid: &str,
    version: u32,
    nonce: &str,
    frame: ProvisionFrame,
) -> Vec<u8> {
    let mut envelope = ProvisionEnvelope {
        version,
        owner_sid: owner_sid.to_owned(),
        nonce: nonce.to_owned(),
        frame,
        mac: String::new(),
    };
    let authenticated = authenticated_bytes(&envelope).expect("authenticated bytes");
    envelope.mac = frame::mac_hex(&authenticated, key).expect("mac over the authenticated bytes");
    serde_json::to_vec(&envelope).expect("envelope serializes")
}

/// Re-serializes a sealed body after `edit` has changed it as untyped JSON, leaving the MAC alone.
fn tampered(body: &[u8], edit: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(body).expect("sealed body is json");
    edit(&mut value);
    serde_json::to_vec(&value).expect("tampered body serializes")
}

/// Grows `base` with one padding member until its canonical form is exactly `target` bytes.
fn padded_to(mut base: Value, target: usize) -> Value {
    base["pad"] = Value::String(String::new());
    let overhead = normalized_payload(&base).expect("padded payload").len();
    base["pad"] = Value::String("a".repeat(target - overhead));
    assert_eq!(
        normalized_payload(&base).expect("padded payload").len(),
        target
    );
    base
}

#[test]
fn a_request_sealed_by_the_owner_opens_on_the_elevated_side() {
    let body = session()
        .seal(provision_frame(), nonce(1))
        .expect("the request seals");
    let opened = session()
        .open(&body, Direction::ToBroker)
        .expect("the request opens");
    assert_eq!(opened, provision_frame());
}

#[test]
fn a_receipt_sealed_by_the_elevated_side_opens_on_the_owner() {
    let receipt = ProvisionFrame::Applied {
        path_set_digest: normalized_digest(&vector_path_set()).expect("path set digest"),
        acl_plan_digest: normalized_digest(&vector_acl_plan()).expect("acl plan digest"),
        observation: json!({"contract_version": 1, "managed_roots": []}),
    };
    let body = session()
        .seal(receipt.clone(), nonce(2))
        .expect("the receipt seals");
    let opened = session()
        .open(&body, Direction::ToOwner)
        .expect("the receipt opens");
    assert_eq!(opened, receipt);
    match opened {
        ProvisionFrame::Applied {
            path_set_digest,
            acl_plan_digest,
            ..
        } => {
            assert_eq!(path_set_digest, VECTOR_PATH_SET_DIGEST);
            assert_eq!(acl_plan_digest, VECTOR_ACL_PLAN_DIGEST);
        }
        other => panic!("expected an applied receipt, got {other:?}"),
    }
}

#[test]
fn the_fixed_vector_pins_the_bytes_the_python_peer_signs() {
    let envelope = ProvisionEnvelope {
        version: PROVISION_CONTRACT_VERSION,
        owner_sid: OWNER.to_owned(),
        nonce: VECTOR_NONCE.to_owned(),
        frame: provision_frame(),
        mac: String::new(),
    };
    let authenticated = authenticated_bytes(&envelope).expect("authenticated bytes");
    assert_eq!(hex::encode(&authenticated), VECTOR_CANONICAL_HEX);
    assert_eq!(
        frame::mac_hex(&authenticated, &vector_key()).expect("mac"),
        VECTOR_MAC
    );
}

#[test]
fn the_fixed_vector_pins_the_mac_a_sealed_frame_actually_carries() {
    let body = session()
        .seal(provision_frame(), VECTOR_NONCE.to_owned())
        .expect("the request seals");
    let envelope: ProvisionEnvelope = serde_json::from_slice(&body).expect("sealed envelope");
    assert_eq!(envelope.mac, VECTOR_MAC);
}

#[test]
fn the_fixed_vector_pins_both_receipt_digests() {
    assert_eq!(
        normalized_digest(&vector_path_set()).expect("path set digest"),
        VECTOR_PATH_SET_DIGEST
    );
    assert_eq!(
        normalized_digest(&vector_acl_plan()).expect("acl plan digest"),
        VECTOR_ACL_PLAN_DIGEST
    );
}

#[test]
fn a_digest_is_taken_over_normalized_bytes_so_document_shape_cannot_change_it() {
    // Reversed member order and indentation, which is what a peer that built the same path set with a
    // different JSON library would hand over. Normalizing before digesting is what lets the client
    // store a digest and later recompute it from its own inputs without matching the broker's
    // serializer byte for byte.
    let document = r#"{
          "workspace_roots": [ { "root_id": "w1", "path": "C:\\ws\\café" } ] ,
          "owner_sid": "S-1-5-21-1-2-3-1001"
        }"#;
    let reordered: Value = serde_json::from_str(document).expect("reordered path set");
    let normalized = normalized_payload(&reordered).expect("normalized bytes");
    assert_ne!(document.as_bytes(), normalized.as_slice());
    assert_eq!(
        normalized,
        normalized_payload(&vector_path_set()).expect("normalized bytes")
    );
    assert_eq!(
        normalized_digest(&reordered).expect("digest"),
        VECTOR_PATH_SET_DIGEST
    );
}

#[test]
fn a_substituted_mac_is_refused() {
    let body = session()
        .seal(provision_frame(), nonce(3))
        .expect("the request seals");
    let forged = tampered(&body, |value| {
        value["mac"] = Value::String("11".repeat(32));
    });
    assert_eq!(
        session().open(&forged, Direction::ToBroker),
        Err(ProvisionProtocolError::Frame(FrameError::InvalidMac))
    );
}

#[test]
fn a_payload_edited_under_a_valid_mac_is_refused() {
    let body = session()
        .seal(provision_frame(), nonce(4))
        .expect("the request seals");
    let forged = tampered(&body, |value| {
        value["frame"]["path_set"]["workspace_roots"][0]["path"] =
            Value::String("C:\\Windows".to_owned());
    });
    assert_eq!(
        session().open(&forged, Direction::ToBroker),
        Err(ProvisionProtocolError::Frame(FrameError::InvalidMac))
    );
}

#[test]
fn a_frame_sealed_under_another_sessions_key_is_refused() {
    let body = ProvisionSession::new(vec![0x5a; 32], OWNER)
        .seal(provision_frame(), nonce(5))
        .expect("the request seals");
    assert_eq!(
        session().open(&body, Direction::ToBroker),
        Err(ProvisionProtocolError::Frame(FrameError::InvalidMac))
    );
}

#[test]
fn a_frame_minted_for_another_owner_is_refused() {
    let body = ProvisionSession::new(vector_key(), OTHER_OWNER)
        .seal(provision_frame(), nonce(6))
        .expect("the request seals");
    assert_eq!(
        session().open(&body, Direction::ToBroker),
        Err(ProvisionProtocolError::OwnerMismatch)
    );
}

#[test]
fn a_nonce_outside_the_allowed_length_is_refused_by_both_sides() {
    let too_long = "a".repeat(frame::NONCE_MAX_LEN + 1);
    for bad in ["", "short", too_long.as_str()] {
        assert_eq!(
            session().seal(provision_frame(), bad.to_owned()),
            Err(ProvisionProtocolError::Frame(FrameError::InvalidField)),
            "seal accepted the nonce {bad:?}"
        );
        let body = sealed_bypassing_checks(
            &vector_key(),
            OWNER,
            PROVISION_CONTRACT_VERSION,
            bad,
            provision_frame(),
        );
        assert_eq!(
            session().open(&body, Direction::ToBroker),
            Err(ProvisionProtocolError::Frame(FrameError::InvalidField)),
            "open accepted the nonce {bad:?}"
        );
    }
}

#[test]
fn a_replayed_nonce_is_refused_on_its_second_arrival() {
    let body = session()
        .seal(provision_frame(), nonce(7))
        .expect("the request seals");
    let mut receiver = session();
    receiver
        .open(&body, Direction::ToBroker)
        .expect("the first arrival opens");
    assert_eq!(
        receiver.open(&body, Direction::ToBroker),
        Err(ProvisionProtocolError::NonceReplayed)
    );
}

#[test]
fn a_frame_that_failed_its_mac_does_not_consume_its_nonce() {
    let body = session()
        .seal(provision_frame(), nonce(8))
        .expect("the request seals");
    let forged = tampered(&body, |value| {
        value["mac"] = Value::String("22".repeat(32));
    });
    let mut receiver = session();
    assert_eq!(
        receiver.open(&forged, Direction::ToBroker),
        Err(ProvisionProtocolError::Frame(FrameError::InvalidMac))
    );
    receiver
        .open(&body, Direction::ToBroker)
        .expect("the authentic frame still opens under the same nonce");
}

#[test]
fn an_unknown_envelope_field_is_refused() {
    let body = session()
        .seal(provision_frame(), nonce(9))
        .expect("the request seals");
    let widened = tampered(&body, |value| {
        value["executable_path"] = Value::String("C:\\evil.exe".to_owned());
    });
    assert_eq!(
        session().open(&widened, Direction::ToBroker),
        Err(ProvisionProtocolError::Frame(FrameError::InvalidJson))
    );
}

#[test]
fn an_unknown_frame_field_is_refused() {
    let body = session()
        .seal(provision_frame(), nonce(10))
        .expect("the request seals");
    let widened = tampered(&body, |value| {
        value["frame"]["command_line"] = Value::String("cmd.exe /c whoami".to_owned());
    });
    assert_eq!(
        session().open(&widened, Direction::ToBroker),
        Err(ProvisionProtocolError::Frame(FrameError::InvalidJson))
    );
}

#[test]
fn an_operation_outside_the_closed_frame_set_is_refused() {
    let body = session()
        .seal(provision_frame(), nonce(11))
        .expect("the request seals");
    let renamed = tampered(&body, |value| {
        value["frame"]["op"] = Value::String("apply_anything".to_owned());
    });
    assert_eq!(
        session().open(&renamed, Direction::ToBroker),
        Err(ProvisionProtocolError::Frame(FrameError::InvalidJson))
    );
}

#[test]
fn a_refusal_reason_outside_the_closed_vocabulary_is_refused() {
    let body = session()
        .seal(
            ProvisionFrame::Refused {
                reason: ProvisionRefusal::CoverageBoundExceeded,
            },
            nonce(12),
        )
        .expect("the refusal seals");
    let invented = tampered(&body, |value| {
        value["frame"]["reason"] = Value::String("owner_is_admin_now".to_owned());
    });
    assert_eq!(
        session().open(&invented, Direction::ToOwner),
        Err(ProvisionProtocolError::Frame(FrameError::InvalidJson))
    );
}

#[test]
fn a_frame_from_another_contract_version_is_refused() {
    let body = sealed_bypassing_checks(
        &vector_key(),
        OWNER,
        PROVISION_CONTRACT_VERSION + 1,
        &nonce(13),
        provision_frame(),
    );
    assert_eq!(
        session().open(&body, Direction::ToBroker),
        Err(ProvisionProtocolError::Frame(
            FrameError::UnsupportedVersion
        ))
    );
}

#[test]
fn an_oversized_body_is_refused_before_anything_parses_it() {
    let body = vec![b'{'; MAX_PROVISION_FRAME_BYTES + 1];
    assert_eq!(
        session().open(&body, Direction::ToBroker),
        Err(ProvisionProtocolError::Frame(FrameError::Oversized))
    );
}

#[test]
fn an_oversized_path_set_is_refused_on_its_own_bound() {
    let frame = ProvisionFrame::Provision {
        path_set: padded_to(vector_path_set(), MAX_PATH_SET_BYTES + 1),
        acl_plan: vector_acl_plan(),
    };
    assert_eq!(
        session().seal(frame.clone(), nonce(14)),
        Err(ProvisionProtocolError::PathSetOversized)
    );
    let body = sealed_bypassing_checks(
        &vector_key(),
        OWNER,
        PROVISION_CONTRACT_VERSION,
        &nonce(14),
        frame,
    );
    assert_eq!(
        session().open(&body, Direction::ToBroker),
        Err(ProvisionProtocolError::PathSetOversized)
    );
}

#[test]
fn an_oversized_acl_plan_is_refused_on_its_own_bound() {
    let frame = ProvisionFrame::Provision {
        path_set: vector_path_set(),
        acl_plan: padded_to(vector_acl_plan(), MAX_ACL_PLAN_BYTES + 1),
    };
    assert_eq!(
        session().seal(frame.clone(), nonce(15)),
        Err(ProvisionProtocolError::AclPlanOversized)
    );
    let body = sealed_bypassing_checks(
        &vector_key(),
        OWNER,
        PROVISION_CONTRACT_VERSION,
        &nonce(15),
        frame,
    );
    assert_eq!(
        session().open(&body, Direction::ToBroker),
        Err(ProvisionProtocolError::AclPlanOversized)
    );
}

#[test]
fn a_maximum_path_set_beside_a_maximum_plan_still_fits_one_frame() {
    let frame = ProvisionFrame::Provision {
        path_set: padded_to(vector_path_set(), MAX_PATH_SET_BYTES),
        acl_plan: padded_to(vector_acl_plan(), MAX_ACL_PLAN_BYTES),
    };
    let body = session()
        .seal(frame.clone(), nonce(16))
        .expect("a maximum request seals");
    assert!(body.len() <= MAX_PROVISION_FRAME_BYTES);
    assert_eq!(
        session()
            .open(&body, Direction::ToBroker)
            .expect("a maximum request opens"),
        frame
    );
}

#[test]
fn a_frame_from_the_wrong_peer_is_refused_in_both_directions() {
    let request = session()
        .seal(provision_frame(), nonce(17))
        .expect("the request seals");
    assert_eq!(
        session().open(&request, Direction::ToOwner),
        Err(ProvisionProtocolError::WrongDirection)
    );
    let refusal = session()
        .seal(
            ProvisionFrame::Refused {
                reason: ProvisionRefusal::ReparsePointInPath,
            },
            nonce(18),
        )
        .expect("the refusal seals");
    assert_eq!(
        session().open(&refusal, Direction::ToBroker),
        Err(ProvisionProtocolError::WrongDirection)
    );
}

#[test]
fn more_frames_than_the_conversation_needs_are_refused() {
    let mut receiver = session();
    for index in 0..MAX_FRAMES_PER_CONNECTION {
        let body = session()
            .seal(provision_frame(), nonce(100 + index as u32))
            .expect("the request seals");
        receiver
            .open(&body, Direction::ToBroker)
            .expect("a frame inside the bound opens");
    }
    let body = session()
        .seal(provision_frame(), nonce(200))
        .expect("the request seals");
    assert_eq!(
        receiver.open(&body, Direction::ToBroker),
        Err(ProvisionProtocolError::FrameLimitExceeded)
    );
}

#[test]
fn every_protocol_refusal_carries_a_distinct_code() {
    let codes = [
        ProvisionProtocolError::Frame(FrameError::Oversized).code(),
        ProvisionProtocolError::Frame(FrameError::InvalidJson).code(),
        ProvisionProtocolError::Frame(FrameError::UnsupportedVersion).code(),
        ProvisionProtocolError::Frame(FrameError::InvalidField).code(),
        ProvisionProtocolError::Frame(FrameError::InvalidMac).code(),
        ProvisionProtocolError::NonceReplayed.code(),
        ProvisionProtocolError::WrongDirection.code(),
        ProvisionProtocolError::UnexpectedFrame.code(),
        ProvisionProtocolError::OwnerMismatch.code(),
        ProvisionProtocolError::PathSetOversized.code(),
        ProvisionProtocolError::AclPlanOversized.code(),
        ProvisionProtocolError::FrameLimitExceeded.code(),
    ];
    let distinct: HashSet<&&str> = codes.iter().collect();
    assert_eq!(distinct.len(), codes.len());
}

#[test]
fn a_protocol_refusal_is_never_reported_as_an_access_decision() {
    let error = io::Error::from(ProvisionProtocolError::OwnerMismatch);
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("owner_mismatch"));
}

#[test]
fn each_apply_failure_maps_to_the_wire_refusal_that_describes_it() {
    let cases = [
        (
            AclApplyFailure::CoverageBoundExceeded {
                planned: 9,
                limit: 4,
            },
            ProvisionRefusal::CoverageBoundExceeded,
        ),
        (
            AclApplyFailure::PlanShapeInvalid("root not authorized".to_owned()),
            ProvisionRefusal::PlanShapeInvalid,
        ),
        (
            AclApplyFailure::AuthorizationMissing,
            ProvisionRefusal::PlanShapeInvalid,
        ),
        (
            AclApplyFailure::PathRefused(ManagedPathRefusal::ReparsePointInPath),
            ProvisionRefusal::ReparsePointInPath,
        ),
        (
            AclApplyFailure::PathRefused(ManagedPathRefusal::ObjectTypeMismatch),
            ProvisionRefusal::ManagedPathRefused,
        ),
        (
            AclApplyFailure::PathRefused(ManagedPathRefusal::Unreadable {
                kind: UnreadableKind::PermissionDenied,
                message: "access is denied".to_owned(),
            }),
            ProvisionRefusal::ManagedPathRefused,
        ),
        (
            AclApplyFailure::DescriptorNotTheShippedPolicy("not this build's policy".to_owned()),
            ProvisionRefusal::DescriptorNotTheShippedPolicy,
        ),
        (
            AclApplyFailure::RootNotAuthorized("not the derived root".to_owned()),
            ProvisionRefusal::ManagedRootNotAuthorized,
        ),
        (
            AclApplyFailure::PreconditionMissing("no tier identities".to_owned()),
            ProvisionRefusal::ProvisionPreconditionMissing,
        ),
        (
            AclApplyFailure::Win32PermissionDenied("SetSecurityInfo failed".to_owned()),
            ProvisionRefusal::Win32PermissionDenied,
        ),
    ];
    for (failure, expected) in cases {
        assert_eq!(ProvisionRefusal::from(&failure), expected, "{failure:?}");
    }
    // The three classes a caller can act on must not read as access failures, or a client would retry a
    // provision that cannot succeed until something else changes.
    for failure in [
        AclApplyFailure::DescriptorNotTheShippedPolicy(String::new()),
        AclApplyFailure::RootNotAuthorized(String::new()),
        AclApplyFailure::PreconditionMissing(String::new()),
    ] {
        assert!(!failure.is_permission_class(), "{failure:?}");
    }
}

#[test]
fn a_wire_refusal_carries_no_detail_a_privileged_process_wrote() {
    let body = session()
        .seal(
            ProvisionFrame::Refused {
                reason: ProvisionRefusal::Win32PermissionDenied,
            },
            nonce(19),
        )
        .expect("the refusal seals");
    let value: Value = serde_json::from_slice(&body).expect("sealed body is json");
    let members: Vec<&String> = value["frame"]
        .as_object()
        .expect("the frame is an object")
        .keys()
        .collect();
    assert_eq!(members, ["op", "reason"]);
    assert_eq!(value["frame"]["reason"], "win32_permission_denied");
}
