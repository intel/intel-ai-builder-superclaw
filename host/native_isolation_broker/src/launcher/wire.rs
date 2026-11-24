//! The launcher's on-the-wire shapes.
//!
//! Two channels, two budgets, one framing:
//!
//! 1. **Sandbox Manager to launcher.** The owner side still reads one start-request frame from its own
//!    standard input. That channel stays until execution plan P7 gives the Sandbox Manager a real
//!    control pipe, and it carries the catalog start request unwrapped.
//! 2. **Launcher to tier runner.** Two one-way named pipes carrying [`TierEnvelope`], a strict JSON
//!    envelope with a nonce and an HMAC around a closed [`TierFrame`].
//!
//! # Why the frame set is closed and small
//!
//! `Start` and `Started`. There is no stop frame, no exit report, no lease action, no error frame and
//! no free-form field. The owner holds the role's Job and ends the runner and its tree by terminating
//! it, so nothing about stopping depends on the runner reading or answering anything (#3010). A refusal
//! is not a frame: a peer that refuses stops talking and exits with a reason on its own standard error,
//! so a compromised peer cannot use the refusal path as an output channel.
//!
//! # What the HMAC is and is not
//!
//! It is frame integrity plus session binding: it ties every frame to one launch's random key, one
//! tier, and one nonce that is never accepted twice. It is *not* an identity boundary against the tier
//! account. The runner and the role share an account (authority document section 4.1), so any code
//! already running as the tier can read the key off the runner's command line. What binds the peer
//! initially is the pipe's own ACL plus `FILE_FLAG_FIRST_PIPE_INSTANCE`, the connecting process id
//! matching the runner the launcher itself created, and that process's token SID matching the expected
//! tier SID. Everything the runner then reports is a tier self-report and is never security evidence.

use crate::broker_wire::canonical_wire_json;
use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::io::{self, Read};

pub const LAUNCHER_CONTRACT_VERSION: u32 = 1;

/// Hard cap on one catalog start request, measured on its canonical serialization.
///
/// This is the inner limit: it bounds the request itself, wherever it is carried. The Sandbox Manager
/// channel enforces it directly, and the production envelope enforces it on the request it wraps, so a
/// request that one hop accepts cannot be one the next hop has to refuse for size.
pub const MAX_CATALOG_REQUEST_BYTES: usize = 64 * 1024;

/// Room the production envelope is allowed for its own fields on top of the request it carries: the
/// version, the tier, the nonce, the hex MAC, the frame tag and the JSON punctuation. The real cost is
/// a couple of hundred bytes; the budget is deliberately far larger than that so a future field cannot
/// silently make a legal request unsendable, and small enough that it is still a bound.
const TIER_ENVELOPE_OVERHEAD_BUDGET: usize = 32 * 1024;

/// Cap on one whole production frame. Derived rather than written out, so the relationship it has to
/// hold - an envelope must always be able to carry a maximum-size request - is stated in the code
/// instead of being a property of two independently chosen numbers.
pub const MAX_TIER_FRAME_BYTES: usize = MAX_CATALOG_REQUEST_BYTES + TIER_ENVELOPE_OVERHEAD_BUDGET;

/// Bound on how many frames one connection may carry, so a peer cannot grow the replay set without
/// limit. The production sequence is one frame each way; anything near this bound is a violation.
pub const MAX_FRAMES_PER_CONNECTION: usize = 64;

/// The largest volume of tier-runner diagnostics the owner side will buffer, so a misbehaving runner
/// cannot drive the launcher out of memory through its standard error.
pub const MAX_REPORT_BYTES: usize = 64 * 1024;

pub const RUNNER_SELF_REPORT: &str = "tier_runner_self_report";

/// Which peer is allowed to send a frame. A closed enum shared by both directions is easier to read
/// and to keep in sync than two enums, but only if each reader refuses the frames it must never see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Launcher to runner, over the control pipe.
    ToRunner,
    /// Runner to launcher, over the report pipe.
    ToLauncher,
}

/// The complete production frame set. No executable path, no command line, no shell and no free-form
/// argument appears anywhere in it, and `deny_unknown_fields` means none can be smuggled in either.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum TierFrame {
    /// Start the role described by `request`, which is a catalog start request in the broker's own
    /// wire shape. It is carried as an object rather than an encoded string so both hops validate the
    /// same canonical bytes against the same shipped catalog.
    Start { request: Value },
    /// The role is running and has its payload. Every field is the tier's own account of what it did:
    /// the runner holds no Job, so whatever is claimed about the Job is checked by the owner instead.
    Started {
        tier: String,
        launch_role: String,
        role_pid: u32,
        /// Exactly the variable names handed to the role, so an operator can see that nothing from the
        /// launching environment leaked in.
        role_environment_names: Vec<String>,
    },
}

impl TierFrame {
    pub const fn direction(&self) -> Direction {
        match self {
            Self::Start { .. } => Direction::ToRunner,
            Self::Started { .. } => Direction::ToLauncher,
        }
    }

    pub const fn op(&self) -> &'static str {
        match self {
            Self::Start { .. } => "start",
            Self::Started { .. } => "started",
        }
    }
}

pub const OWNER_KERNEL: &str = "owner_kernel";

/// The role's Job as the owner-side launcher held it, read from the Job's own state by the owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerJobEvidence {
    pub source: String,
    /// The runner was a Job member before its first instruction ran.
    pub runner_membership_verified_before_resume: bool,
    /// The role the runner reported is in the Job's own process list, and is not the runner.
    pub role_membership_verified: bool,
    /// Runner, its console host when it has one, role and descendants, once the count settled.
    pub active_processes_at_ready: u32,
    pub active_processes_before_cleanup: u32,
    /// Required to be zero: anything else is a cleanup failure and the launch is refused instead.
    pub active_processes_after_cleanup: u32,
    pub cleanup_confirmed: bool,
    /// From the stop instruction to the Job's count reaching zero.
    pub cleanup_elapsed_ms: u64,
}

/// The authenticated wrapper every production frame travels in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TierEnvelope {
    pub version: u32,
    /// The tier both peers were launched for. Binding it into the MAC is what stops a frame minted for
    /// one tier's session from being replayed into another's.
    pub tier: String,
    pub nonce: String,
    pub frame: TierFrame,
    pub mac: String,
}

/// Why a production frame was refused. Every variant maps to one stable code, because "the runner is
/// not who we expected" and "the frame does not parse" are different failures and an operator has to be
/// able to tell them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TierProtocolError {
    Frame(FrameError),
    /// A nonce arrived twice on the same connection.
    NonceReplayed,
    /// A frame arrived from the peer that is not allowed to send it.
    WrongDirection,
    /// A frame arrived that is legal but not the one the sequence calls for.
    UnexpectedFrame,
    /// The envelope's tier does not match the tier this process was launched for.
    TierMismatch,
    /// The wrapped catalog request is over `MAX_CATALOG_REQUEST_BYTES` on its own.
    CatalogRequestOversized,
    /// More frames arrived on one connection than the protocol has any use for.
    FrameLimitExceeded,
}

impl TierProtocolError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Frame(error) => error.code(),
            Self::NonceReplayed => "nonce_replayed",
            Self::WrongDirection => "frame_wrong_direction",
            Self::UnexpectedFrame => "unexpected_frame",
            Self::TierMismatch => "tier_mismatch",
            Self::CatalogRequestOversized => "catalog_request_oversized",
            Self::FrameLimitExceeded => "frame_limit_exceeded",
        }
    }
}

impl From<FrameError> for TierProtocolError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl From<TierProtocolError> for io::Error {
    /// Refusals map onto `InvalidData` rather than `PermissionDenied` on purpose: none of them is an
    /// authorization decision, and the peer-identity failures that *are* one live in `pipe.rs` and keep
    /// `PermissionDenied` to themselves. `lib.rs::error_code` turns the two into `invalid_input` and
    /// `access_denied`, so the distinction survives to the caller.
    fn from(error: TierProtocolError) -> Self {
        Self::new(
            io::ErrorKind::InvalidData,
            format!("tier frame refused: {}", error.code()),
        )
    }
}

/// One side's view of a production connection: the shared key, the tier, and the nonces already seen.
///
/// Signing and verifying live on the same type because they have to agree byte for byte about what is
/// authenticated, and the replay set lives here because it is per-connection state, not global state.
pub struct TierSession {
    key: Vec<u8>,
    tier: String,
    seen_nonces: HashSet<String>,
    frames_seen: usize,
}

impl TierSession {
    pub fn new(key: Vec<u8>, tier: &str) -> Self {
        Self {
            key,
            tier: tier.to_owned(),
            seen_nonces: HashSet::new(),
            frames_seen: 0,
        }
    }

    /// Wraps `frame` in a signed envelope with a freshly drawn nonce, and returns the envelope's bytes.
    ///
    /// The result is a frame *body*: no length prefix. The pipe transport adds one, and adding a second
    /// here would make the peer's first read start on four bytes of binary length rather than on `{`.
    pub fn seal(&self, frame: TierFrame, nonce: String) -> Result<Vec<u8>, TierProtocolError> {
        let mut envelope = TierEnvelope {
            version: LAUNCHER_CONTRACT_VERSION,
            tier: self.tier.clone(),
            nonce,
            frame,
            mac: String::new(),
        };
        if let TierFrame::Start { request } = &envelope.frame {
            check_catalog_request_size(request)?;
        }
        frame::validate_nonce(&envelope.nonce)?;
        envelope.mac = frame::mac_hex(&authenticated_bytes(&envelope)?, &self.key)?;
        Ok(frame::encode_body(&envelope, MAX_TIER_FRAME_BYTES)?)
    }

    /// Authenticates one frame body and returns it, refusing a replayed nonce, a foreign tier, a frame
    /// from the wrong peer, and an oversize wrapped request.
    ///
    /// Order matters: everything that can be decided from the bytes alone is decided before the replay
    /// set is touched, so a peer cannot fill the set with nonces from frames that were never valid.
    pub fn open(
        &mut self,
        body: &[u8],
        expected_from: Direction,
    ) -> Result<TierFrame, TierProtocolError> {
        self.frames_seen += 1;
        if self.frames_seen > MAX_FRAMES_PER_CONNECTION {
            return Err(TierProtocolError::FrameLimitExceeded);
        }
        if body.len() > MAX_TIER_FRAME_BYTES {
            return Err(FrameError::Oversized.into());
        }
        let envelope: TierEnvelope =
            serde_json::from_slice(body).map_err(|_| FrameError::InvalidJson)?;
        if envelope.version != LAUNCHER_CONTRACT_VERSION {
            return Err(FrameError::UnsupportedVersion.into());
        }
        frame::validate_nonce(&envelope.nonce)?;
        if envelope.tier != self.tier {
            return Err(TierProtocolError::TierMismatch);
        }
        frame::verify_mac_hex(&authenticated_bytes(&envelope)?, &envelope.mac, &self.key)?;
        if envelope.frame.direction() != expected_from {
            return Err(TierProtocolError::WrongDirection);
        }
        if let TierFrame::Start { request } = &envelope.frame {
            check_catalog_request_size(request)?;
        }
        if !self.seen_nonces.insert(envelope.nonce) {
            return Err(TierProtocolError::NonceReplayed);
        }
        Ok(envelope.frame)
    }
}

/// The exact bytes the MAC covers: the envelope minus its own `mac`, canonicalized.
///
/// Canonicalized rather than serialized directly because the wrapped request is a `serde_json::Value`,
/// whose member order is a property of the JSON library's map type rather than of this protocol. A MAC
/// over a re-serialization would then be a MAC over an implementation detail, and enabling a serde_json
/// feature would break every signature in the crate without touching a line of this file.
fn authenticated_bytes(envelope: &TierEnvelope) -> Result<Vec<u8>, TierProtocolError> {
    #[derive(Serialize)]
    struct Authenticated<'a> {
        version: u32,
        tier: &'a str,
        nonce: &'a str,
        frame: &'a TierFrame,
    }
    let value = serde_json::to_value(Authenticated {
        version: envelope.version,
        tier: &envelope.tier,
        nonce: &envelope.nonce,
        frame: &envelope.frame,
    })
    .map_err(|_| FrameError::InvalidJson)?;
    let canonical = canonical_wire_json(&value).map_err(|_| FrameError::InvalidJson)?;
    Ok(canonical.into_bytes())
}

/// The canonical bytes of a wrapped catalog request, refused if they exceed the inner cap.
///
/// The same function produces the bytes both hops validate, so the size that is checked and the bytes
/// that are parsed can never be two different things.
pub fn canonical_catalog_request(request: &Value) -> Result<Vec<u8>, TierProtocolError> {
    let canonical = canonical_wire_json(request).map_err(|_| FrameError::InvalidJson)?;
    if canonical.len() > MAX_CATALOG_REQUEST_BYTES {
        return Err(TierProtocolError::CatalogRequestOversized);
    }
    Ok(canonical.into_bytes())
}

fn check_catalog_request_size(request: &Value) -> Result<(), TierProtocolError> {
    canonical_catalog_request(request).map(|_| ())
}

/// Frames a start request for the Sandbox Manager channel, under the inner request cap.
pub fn encode_frame(payload: &[u8]) -> io::Result<Vec<u8>> {
    if payload.is_empty() || payload.len() > MAX_CATALOG_REQUEST_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "a start request frame must be 1..={MAX_CATALOG_REQUEST_BYTES} bytes, got {}",
                payload.len()
            ),
        ));
    }
    let mut frame = Vec::with_capacity(frame::FRAME_PREFIX_BYTES + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn encode_stop_frame() -> io::Result<Vec<u8>> {
    encode_frame(br#"{"op":"stop"}"#)
}

/// Reads exactly one Sandbox Manager frame. A reader that ends before the declared length is an error
/// rather than a short request, and a declared length out of range is refused without reading the body.
///
/// The range check is `frame::declared_frame_len`, not a second copy of it: an empty declaration and an
/// oversize one are refused here on exactly the terms every other reader in the crate uses.
///
/// This bounds the *raw* bytes at the same number the canonical bytes are bounded at later. Canonicalizing
/// is normally shrinking, but it is not guaranteed to be - a renormalized number can grow - so a request
/// that arrives just under the cap can still be refused for size after canonicalization. That is a
/// refusal, never an acceptance of something the next hop must reject, which is the direction that would
/// matter.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Vec<u8>> {
    read_optional_frame(reader)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "the control stream closed before a frame arrived",
        )
    })
}

pub fn read_optional_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut prefix = [0u8; 4];
    match reader.read(&mut prefix[..1])? {
        0 => return Ok(None),
        1 => reader.read_exact(&mut prefix[1..])?,
        _ => unreachable!("a one-byte buffer cannot read more than one byte"),
    }
    let length = frame::declared_frame_len(prefix, MAX_CATALOG_REQUEST_BYTES).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "start request frame declares {} bytes, which is out of range ({})",
                u32::from_le_bytes(prefix),
                error.code()
            ),
        )
    })?;
    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TierLaunchStartedReport {
    pub contract_version: u32,
    pub event: String,
    pub launch_path: String,
    pub tier: String,
    pub owner_sid: String,
    pub runner_sid: String,
    pub launch_role: String,
    pub runner_pid: u32,
    pub role_pid: u32,
}

/// The single line the owner-side launcher prints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TierLaunchReport {
    pub contract_version: u32,
    pub event: String,
    /// Which runner-start primitive produced this launch: `tier_logon` for the production first hop,
    /// `loopback_self_test` for the internal same-account mode. Stated rather than left to be inferred,
    /// because everything else in this report looks identical either way, and a reader that mistook the
    /// self-test for a cross-account launch would be reading the strongest claim off the weakest
    /// evidence.
    pub launch_path: String,
    pub tier: String,
    pub owner_sid: String,
    /// The tier SID the launcher required both pipe connections to present. On the production hop it is
    /// resolved from the derived account name with `LookupAccountNameW`, never accepted as an argument;
    /// the loopback self-test injects it, which is one more reason `launch_path` distinguishes the two.
    pub runner_sid: String,
    pub launch_role: String,
    pub runner_pid: u32,
    /// The Job's termination code: the owner ends the runner by terminating the Job it is in.
    pub runner_exit_code: u32,
    /// Names where `runner_frames` came from: the tier's own account of what it did. The owner side
    /// observed the runner's exit code, its process id, both pipe bindings and `owner_job` itself.
    pub evidence_source: String,
    pub runner_frames: Vec<TierFrame>,
    pub owner_job: OwnerJobEvidence,
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"01234567890123456789012345678901";
    const NONCE: &str = "00112233445566778899aabbccddeeff";

    fn session() -> TierSession {
        TierSession::new(KEY.to_vec(), "bootstrap")
    }

    fn start() -> TierFrame {
        TierFrame::Start {
            request: serde_json::json!({"launch_role": "test_fixed_sleep_child"}),
        }
    }

    fn started() -> TierFrame {
        TierFrame::Started {
            tier: "bootstrap".to_owned(),
            launch_role: "test_fixed_sleep_child".to_owned(),
            role_pid: 4242,
            role_environment_names: vec!["SYSTEMROOT".to_owned()],
        }
    }

    #[test]
    fn the_frame_set_is_exactly_two_ops_with_fixed_directions() {
        let frames = [start(), started()];
        let ops: Vec<&str> = frames.iter().map(TierFrame::op).collect();
        assert_eq!(ops, ["start", "started"]);
        assert_eq!(frames[0].direction(), Direction::ToRunner);
        assert_eq!(frames[1].direction(), Direction::ToLauncher);
    }

    /// Stopping is the owner terminating its Job, so no frame asks the runner to stop or reports that it
    /// did, and a runner cannot claim Job evidence it has no handle to collect.
    #[test]
    fn no_frame_asks_the_runner_to_stop_or_lets_it_report_on_a_job() {
        for retired in [
            serde_json::json!({"op": "stop"}),
            serde_json::json!({
                "op": "exited",
                "code": 0,
                "job_active_processes_before_cleanup": 2,
                "job_active_processes_after_cleanup": 0,
                "cleanup_confirmed": true
            }),
        ] {
            assert!(
                serde_json::from_value::<TierFrame>(retired.clone()).is_err(),
                "{retired} must not parse"
            );
        }
        let mut claimed = serde_json::to_value(started()).expect("serialize");
        claimed.as_object_mut().expect("object").insert(
            "job_membership_verified_before_resume".to_owned(),
            Value::Bool(true),
        );
        assert!(serde_json::from_value::<TierFrame>(claimed).is_err());
    }

    #[test]
    fn a_sealed_frame_opens_once_and_never_again() {
        let sealed = session()
            .seal(start(), NONCE.to_owned())
            .expect("a start frame should seal");
        let mut reader = session();
        assert_eq!(
            reader
                .open(&sealed, Direction::ToRunner)
                .expect("the frame should authenticate"),
            start()
        );
        assert_eq!(
            reader.open(&sealed, Direction::ToRunner),
            Err(TierProtocolError::NonceReplayed),
            "replaying a frame within one connection must be refused"
        );
    }

    #[test]
    fn every_refusal_class_has_its_own_code() {
        let sealed = session()
            .seal(start(), NONCE.to_owned())
            .expect("a start frame should seal");

        // Wrong direction: a Start arriving on the report pipe is not a Start at all.
        assert_eq!(
            session().open(&sealed, Direction::ToLauncher),
            Err(TierProtocolError::WrongDirection)
        );
        // Foreign key.
        assert_eq!(
            TierSession::new(b"another key of thirty two bytes!".to_vec(), "bootstrap")
                .open(&sealed, Direction::ToRunner),
            Err(TierProtocolError::Frame(FrameError::InvalidMac))
        );
        // Foreign tier, checked before the MAC so the code names the real disagreement.
        assert_eq!(
            TierSession::new(KEY.to_vec(), "workspace").open(&sealed, Direction::ToRunner),
            Err(TierProtocolError::TierMismatch)
        );

        let mut envelope: Value =
            serde_json::from_slice(&sealed).expect("the envelope should parse");
        let object = envelope.as_object_mut().expect("the envelope is an object");

        let mut with_unknown = object.clone();
        with_unknown.insert("extra".to_owned(), Value::Bool(true));
        assert_eq!(
            session().open(
                &serde_json::to_vec(&with_unknown).expect("serialize"),
                Direction::ToRunner
            ),
            Err(TierProtocolError::Frame(FrameError::InvalidJson)),
            "an unknown envelope field must be refused, not ignored"
        );

        let mut wrong_version = object.clone();
        wrong_version.insert(
            "version".to_owned(),
            Value::from(LAUNCHER_CONTRACT_VERSION + 1),
        );
        assert_eq!(
            session().open(
                &serde_json::to_vec(&wrong_version).expect("serialize"),
                Direction::ToRunner
            ),
            Err(TierProtocolError::Frame(FrameError::UnsupportedVersion))
        );

        let mut bad_mac = object.clone();
        bad_mac.insert("mac".to_owned(), Value::from("00".repeat(32)));
        assert_eq!(
            session().open(
                &serde_json::to_vec(&bad_mac).expect("serialize"),
                Direction::ToRunner
            ),
            Err(TierProtocolError::Frame(FrameError::InvalidMac))
        );

        let mut short_nonce = object.clone();
        short_nonce.insert("nonce".to_owned(), Value::from("tooshort"));
        assert_eq!(
            session().open(
                &serde_json::to_vec(&short_nonce).expect("serialize"),
                Direction::ToRunner
            ),
            Err(TierProtocolError::Frame(FrameError::InvalidField))
        );

        assert_eq!(
            session().open(&vec![b' '; MAX_TIER_FRAME_BYTES + 1], Direction::ToRunner),
            Err(TierProtocolError::Frame(FrameError::Oversized))
        );

        let codes = [
            TierProtocolError::Frame(FrameError::Oversized),
            TierProtocolError::Frame(FrameError::InvalidJson),
            TierProtocolError::Frame(FrameError::UnsupportedVersion),
            TierProtocolError::Frame(FrameError::InvalidField),
            TierProtocolError::Frame(FrameError::InvalidMac),
            TierProtocolError::NonceReplayed,
            TierProtocolError::WrongDirection,
            TierProtocolError::UnexpectedFrame,
            TierProtocolError::TierMismatch,
            TierProtocolError::CatalogRequestOversized,
            TierProtocolError::FrameLimitExceeded,
        ]
        .map(TierProtocolError::code);
        let unique: HashSet<&str> = codes.iter().copied().collect();
        assert_eq!(
            unique.len(),
            codes.len(),
            "two refusal classes share a code, so a caller cannot tell them apart: {codes:?}"
        );
    }

    /// A permission refusal and a forbidden-payload refusal must not look alike. The tier ACL and PID
    /// or SID checks in `pipe.rs` are the permission class; a start request carrying an executable path
    /// is a payload class, and it is the catalog that names it.
    #[test]
    fn a_forbidden_payload_is_not_reported_as_a_permission_problem() {
        use crate::launch_catalog::validate_start_request_bytes;

        let request = serde_json::json!({
            "contract_version": 1,
            "manifest_version": 1,
            "manifest_digest": "00".repeat(32),
            "launch_role": "test_fixed_sleep_child",
            "workspace_root_id": null,
            "path_bindings": [],
            "scalar_bindings": [],
            "executable": "C:\\Windows\\System32\\cmd.exe"
        });
        let canonical =
            canonical_catalog_request(&request).expect("a small request is within the cap");
        let refusal = validate_start_request_bytes(&canonical)
            .expect_err("an executable path must be refused");
        assert_eq!(refusal.reason, "forbidden_executable_path");
        assert_ne!(refusal.reason, "access_denied");
        assert_ne!(
            refusal.reason,
            TierProtocolError::Frame(FrameError::InvalidField).code()
        );
    }

    #[test]
    fn the_envelope_can_always_carry_a_maximum_size_request() {
        // Not a round number chosen by hand: the envelope budget is the request budget plus stated
        // overhead, and this is the proof that the overhead is enough for a request at the limit.
        assert_eq!(MAX_TIER_FRAME_BYTES, 96 * 1024);
        let filler = "x".repeat(MAX_CATALOG_REQUEST_BYTES - 64);
        let request = serde_json::json!({"launch_role": filler});
        let canonical =
            canonical_catalog_request(&request).expect("a request just under the cap is legal");
        assert!(canonical.len() > MAX_CATALOG_REQUEST_BYTES - 128);

        let sealed = session()
            .seal(TierFrame::Start { request }, NONCE.to_owned())
            .expect("a maximum-size request must still fit in one envelope");
        assert!(sealed.len() <= frame::FRAME_PREFIX_BYTES + MAX_TIER_FRAME_BYTES);
        assert!(
            session().open(&sealed, Direction::ToRunner).is_ok(),
            "and it must be readable at the far end"
        );
    }

    #[test]
    fn a_request_over_the_inner_cap_is_refused_even_though_the_envelope_has_room() {
        let request = serde_json::json!({"launch_role": "x".repeat(MAX_CATALOG_REQUEST_BYTES)});
        assert_eq!(
            canonical_catalog_request(&request),
            Err(TierProtocolError::CatalogRequestOversized)
        );
        assert_eq!(
            session().seal(TierFrame::Start { request }, NONCE.to_owned()),
            Err(TierProtocolError::CatalogRequestOversized),
            "the inner cap binds even when the whole frame would still fit"
        );
    }

    #[test]
    fn one_connection_cannot_grow_the_replay_set_without_limit() {
        let mut reader = session();
        for index in 0..MAX_FRAMES_PER_CONNECTION {
            let sealed = session()
                .seal(start(), format!("{index:032x}"))
                .expect("seal");
            reader
                .open(&sealed, Direction::ToRunner)
                .expect("a fresh nonce should be accepted");
        }
        let sealed = session()
            .seal(start(), format!("{:032x}", MAX_FRAMES_PER_CONNECTION))
            .expect("seal");
        assert_eq!(
            reader.open(&sealed, Direction::ToRunner),
            Err(TierProtocolError::FrameLimitExceeded)
        );
    }

    #[test]
    fn the_mac_does_not_depend_on_the_wrapped_request_s_member_order() {
        let ordered = serde_json::json!({"a": 1, "b": 2, "c": [3, {"d": 4}]});
        let shuffled: Value = serde_json::from_str("{\"c\":[3,{\"d\":4}],\"b\":2,\"a\":1}")
            .expect("the same object in a different order");
        let first = session()
            .seal(TierFrame::Start { request: ordered }, NONCE.to_owned())
            .expect("seal");
        let second = session()
            .seal(TierFrame::Start { request: shuffled }, NONCE.to_owned())
            .expect("seal");
        let mac = |sealed: &[u8]| -> String {
            serde_json::from_slice::<TierEnvelope>(sealed)
                .expect("parse")
                .mac
        };
        assert_eq!(mac(&first), mac(&second));
    }

    #[test]
    fn a_sandbox_manager_frame_round_trips_and_bounds_its_own_channel() {
        let frame = encode_frame(b"{\"launch_role\":\"x\"}").expect("frame should encode");
        assert_eq!(
            read_frame(&mut frame.as_slice()).expect("frame should decode"),
            b"{\"launch_role\":\"x\"}"
        );

        assert!(encode_frame(&[]).is_err());
        assert!(encode_frame(&vec![b'x'; MAX_CATALOG_REQUEST_BYTES + 1]).is_err());

        let mut oversize = ((MAX_CATALOG_REQUEST_BYTES as u32) + 1)
            .to_le_bytes()
            .to_vec();
        oversize.extend_from_slice(b"x");
        assert_eq!(
            read_frame(&mut oversize.as_slice())
                .expect_err("an oversize declaration must be refused before the body is read")
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            read_frame(&mut 0u32.to_le_bytes().as_slice())
                .expect_err("an empty frame must be refused")
                .kind(),
            io::ErrorKind::InvalidData
        );

        let mut truncated = 8u32.to_le_bytes().to_vec();
        truncated.extend_from_slice(b"abc");
        assert_eq!(
            read_frame(&mut truncated.as_slice())
                .expect_err("a truncated frame must not look like a short request")
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn no_frame_field_can_carry_an_executable_path_or_a_command_line() {
        // The gate is `deny_unknown_fields` on both the envelope and every frame variant. This states
        // it as a property of the parser rather than of a reviewer's attention.
        for smuggled in ["executable", "command_line", "argv", "shell", "env"] {
            let mut envelope: Value =
                serde_json::from_slice(&session().seal(start(), NONCE.to_owned()).expect("seal"))
                    .expect("parse");
            envelope
                .as_object_mut()
                .expect("object")
                .insert(smuggled.to_owned(), Value::from("C:\\Windows\\cmd.exe"));
            assert_eq!(
                session().open(
                    &serde_json::to_vec(&envelope).expect("serialize"),
                    Direction::ToRunner
                ),
                Err(TierProtocolError::Frame(FrameError::InvalidJson)),
                "{smuggled} was not refused at the envelope"
            );

            let mut frame: Value = serde_json::to_value(started()).expect("serialize");
            frame
                .as_object_mut()
                .expect("object")
                .insert(smuggled.to_owned(), Value::from("C:\\Windows\\cmd.exe"));
            assert!(
                serde_json::from_value::<TierFrame>(frame).is_err(),
                "{smuggled} was not refused at the frame"
            );
        }
    }
}
