//! The provision pipe's on-the-wire shapes.
//!
//! One channel, three frames, the same framing primitives the tier pipes use. The unprivileged broker
//! client sends exactly one [`ProvisionFrame::Provision`] and the elevated broker answers with exactly one
//! [`ProvisionFrame::Applied`] or one [`ProvisionFrame::Refused`], then both sides close.
//!
//! # Why the frame set is closed and small
//!
//! No executable path, no command line, no shell and no free-form argument appears anywhere in it, and
//! `deny_unknown_fields` means none can be smuggled in either. The two payload fields are the *contract*
//! shapes C2 and C3 already define - a path set and an ACL plan - and the elevated side re-validates both
//! from scratch rather than trusting that the sender built them from the shipped descriptor.
//!
//! `Refused` carries a closed reason enum and nothing else. It exists because this boundary has no other
//! channel at all: the elevated broker is started through `runas`, so its standard error goes nowhere the
//! owner can read, and an owner that could only observe "the broker exited non-zero" could not tell a
//! coverage refusal from a permission failure. A reason word is not authorization evidence and is not
//! treated as any: a client that receives `Refused` has learned nothing except why to give up.
//!
//! # What the HMAC is and is not
//!
//! It is frame integrity plus session binding: it ties every frame to one provision attempt's random key,
//! one owner SID, and one nonce that is never accepted twice. It is *not* the identity boundary. What
//! binds the peers is the pipe's own first-instance creation by the owner, the owner accepting only the
//! process id of the elevated broker it launched, and the elevated broker accepting only a pipe whose
//! server process runs as the owner SID it was asked to provision for. The key is on the elevated
//! broker's command line, which any process already running as the owner could read, so the MAC's job is
//! to make a *substituted* frame detectable, not to prove who sent one.

use crate::broker_wire::canonical_wire_json;
use crate::frame::{self, FrameError};
use crate::managed_root_path::ManagedPathRefusal;
use crate::workspace_grant::AclApplyFailure;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io;

pub const PROVISION_CONTRACT_VERSION: u32 = 1;

/// Hard cap on one path set, measured on its canonical serialization. A path set is an owner SID, a
/// handful of workspace roots and seven managed roots; this is orders of magnitude above that.
pub const MAX_PATH_SET_BYTES: usize = 64 * 1024;

/// Hard cap on one ACL plan, measured the same way. A plan carries a full descriptor per object, so it is
/// the larger of the two payloads by a wide margin.
pub const MAX_ACL_PLAN_BYTES: usize = 256 * 1024;

/// Room the envelope is allowed for its own fields on top of the payloads it carries: the version, the
/// owner SID, the nonce, the hex MAC, the frame tag and the JSON punctuation. The real cost is a few
/// hundred bytes; the budget is deliberately far larger so a future field cannot silently make a legal
/// request unsendable, and small enough that it is still a bound.
const ENVELOPE_OVERHEAD_BUDGET: usize = 32 * 1024;

/// Cap on one whole frame. Derived rather than written out, so the relationship it has to hold - an
/// envelope must always be able to carry a maximum-size path set beside a maximum-size plan - is stated
/// in the code instead of being a property of independently chosen numbers.
pub const MAX_PROVISION_FRAME_BYTES: usize =
    MAX_PATH_SET_BYTES + MAX_ACL_PLAN_BYTES + ENVELOPE_OVERHEAD_BUDGET;

/// The most a WFP plan may weigh on its own. The same bound as the ACL plan, so the frame's budget is
/// unchanged: a WFP plan travels in a frame of its own, never beside a path set.
pub const MAX_WFP_PLAN_BYTES: usize = 256 * 1024;

/// Bound on how many frames one connection may carry, so a peer cannot grow the replay set without
/// limit. The whole conversation is one frame in each direction; anything near this bound is already a
/// violation.
pub const MAX_FRAMES_PER_CONNECTION: usize = 4;

/// Which peer is allowed to send a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Unprivileged owner client to elevated broker.
    ToBroker,
    /// Elevated broker to unprivileged owner client.
    ToOwner,
}

/// Why the elevated broker declined to provision, as a closed vocabulary.
///
/// Deliberately coarser than the internal refusal types: the owner needs to distinguish "the plan asked
/// for more objects than the bound allows" from "a managed root could not be written" from "something on
/// a managed path is a junction", and needs nothing more specific than that. A detail string would be a
/// free-form field on a privileged boundary, which this protocol does not have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvisionRefusal {
    /// The path set names an owner other than the one the elevated broker authenticated.
    OwnerBindingInvalid,
    /// The path set does not have the shape C2 defines.
    PathSetShapeInvalid,
    /// The ACL plan does not have the shape C3 defines, or names a root that is not authorized.
    PlanShapeInvalid,
    /// The plan would touch more objects than the coverage bound allows.
    CoverageBoundExceeded,
    /// A component of a managed path is a reparse point.
    ReparsePointInPath,
    /// A managed path was refused for its shape, depth, object type or readability.
    ManagedPathRefused,
    /// The plan asks for a descriptor other than the one this build ships.
    ///
    /// The same word the planner refuses with, because it is the same disagreement seen from the other end:
    /// the caller planned against a policy this build does not enforce, and the answer is to replan rather
    /// than to retry.
    DescriptorNotTheShippedPolicy,
    /// The plan named an object this side will not write - a derived root at the wrong path, an object that
    /// does not exist, or an object the requesting owner does not own.
    ManagedRootNotAuthorized,
    /// Something provision needs was not in place: the state directory, the tier identities, the store.
    ///
    /// Distinct from `Win32PermissionDenied` because a caller can act on it - provision the tier identities
    /// first - and cannot act on the other.
    ProvisionPreconditionMissing,
    /// A Win32 call on a managed object failed, which at this point is almost always access.
    Win32PermissionDenied,
    /// `--provision-identities-and-session` could not provision the owner's tier identities, so nothing
    /// was recorded and nothing was applied.
    ///
    /// Not `ProvisionPreconditionMissing`, for two reasons. The client answers that word by forcing
    /// `--provision` and another session, which is two more UAC prompts for the step that has just failed.
    /// And the apply step raises that word itself, so reusing it would leave the receipt unable to say
    /// whether the identity step or an apply precondition refused.
    TierIdentityProvisionFailed,
}

impl ProvisionRefusal {
    /// Every variant once, for the test that compares this vocabulary with the published one.
    #[cfg(test)]
    pub const ALL: [Self; 11] = [
        Self::OwnerBindingInvalid,
        Self::PathSetShapeInvalid,
        Self::PlanShapeInvalid,
        Self::CoverageBoundExceeded,
        Self::ReparsePointInPath,
        Self::ManagedPathRefused,
        Self::DescriptorNotTheShippedPolicy,
        Self::ManagedRootNotAuthorized,
        Self::ProvisionPreconditionMissing,
        Self::Win32PermissionDenied,
        Self::TierIdentityProvisionFailed,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::OwnerBindingInvalid => "owner_binding_invalid",
            Self::PathSetShapeInvalid => "path_set_shape_invalid",
            Self::PlanShapeInvalid => "plan_shape_invalid",
            Self::CoverageBoundExceeded => "coverage_bound_exceeded",
            Self::ReparsePointInPath => "reparse_point_in_path",
            Self::ManagedPathRefused => "managed_path_refused",
            Self::DescriptorNotTheShippedPolicy => "descriptor_not_the_shipped_policy",
            Self::ManagedRootNotAuthorized => "managed_root_not_authorized",
            Self::ProvisionPreconditionMissing => "provision_precondition_missing",
            Self::Win32PermissionDenied => "win32_permission_denied",
            Self::TierIdentityProvisionFailed => "tier_identity_provision_failed",
        }
    }
}

impl From<&AclApplyFailure> for ProvisionRefusal {
    fn from(failure: &AclApplyFailure) -> Self {
        match failure {
            AclApplyFailure::CoverageBoundExceeded { .. } => Self::CoverageBoundExceeded,
            AclApplyFailure::PlanShapeInvalid(_) | AclApplyFailure::AuthorizationMissing => {
                Self::PlanShapeInvalid
            }
            AclApplyFailure::PathRefused(ManagedPathRefusal::ReparsePointInPath) => {
                Self::ReparsePointInPath
            }
            AclApplyFailure::PathRefused(_) => Self::ManagedPathRefused,
            AclApplyFailure::DescriptorNotTheShippedPolicy(_) => {
                Self::DescriptorNotTheShippedPolicy
            }
            AclApplyFailure::RootNotAuthorized(_) => Self::ManagedRootNotAuthorized,
            AclApplyFailure::PreconditionMissing(_) => Self::ProvisionPreconditionMissing,
            AclApplyFailure::Win32PermissionDenied(_) => Self::Win32PermissionDenied,
        }
    }
}

/// Why the elevated side did not install the WFP plan, as a closed vocabulary.
///
/// Each name is spelled out because it crosses to Python: `code()` is the wire word, and a test pins the
/// two together and to `shared/contracts/test-fixtures/egress-wfp-install-refusals.json`.
///
/// A WFP failure never fails the provision: the ACL plan has already converged and been answered, and the
/// isolation report carries this word instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WfpInstallRefusal {
    /// The plan is not the shape the shipped contract defines.
    #[serde(rename = "wfp_plan_shape_invalid")]
    PlanShapeInvalid,
    /// The plan is for another owner than the one this broker authenticated.
    #[serde(rename = "wfp_plan_owner_mismatch")]
    OwnerMismatch,
    /// The plan holds filters, and this build installs only the presence anchor.
    #[serde(rename = "wfp_objects_not_installable")]
    ObjectsNotInstallable,
    /// The applier refused, or aborted its transaction; nothing of the plan is installed.
    #[serde(rename = "wfp_apply_refused")]
    ApplyRefused,
    /// The filtering engine could not be opened.
    #[serde(rename = "wfp_engine_unavailable")]
    EngineUnavailable,
}

impl WfpInstallRefusal {
    #[cfg_attr(not(test), allow(dead_code))]
    pub const fn code(self) -> &'static str {
        match self {
            Self::PlanShapeInvalid => "wfp_plan_shape_invalid",
            Self::OwnerMismatch => "wfp_plan_owner_mismatch",
            Self::ObjectsNotInstallable => "wfp_objects_not_installable",
            Self::ApplyRefused => "wfp_apply_refused",
            Self::EngineUnavailable => "wfp_engine_unavailable",
        }
    }
}

/// The complete provision frame set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProvisionFrame {
    /// Record this path set as the owner's authorization and converge this plan onto it.
    ///
    /// Both are carried as objects rather than encoded strings so the elevated side validates the same
    /// canonical bytes the digests in the receipt are computed over.
    Provision { path_set: Value, acl_plan: Value },
    /// The plan converged. The digests are over the *normalized* payloads, so a client that stores them
    /// and later recomputes them from its own inputs is comparing the same bytes the broker saw.
    ///
    /// The observation is the C3 shape, unchanged. It is a receipt, not authorization: the launcher
    /// re-reads every bound root's DACL at start and never consults this or the marker derived from it.
    Applied {
        path_set_digest: String,
        acl_plan_digest: String,
        observation: Value,
    },
    /// Nothing was applied, for this reason.
    Refused { reason: ProvisionRefusal },
    /// After Applied: the WFP plan to install in this same elevated session. The owner may close the
    /// pipe instead, which is no install and no error.
    WfpPlan { wfp_plan: Value },
    /// The WFP plan is installed. The digest is over the normalized plan, as the receipts above are.
    WfpInstalled { wfp_plan_digest: String },
    /// The WFP plan was not installed, for this reason; the ACL receipt already stands.
    WfpRefused { reason: WfpInstallRefusal },
}

impl ProvisionFrame {
    pub const fn direction(&self) -> Direction {
        match self {
            Self::Provision { .. } | Self::WfpPlan { .. } => Direction::ToBroker,
            Self::Applied { .. }
            | Self::Refused { .. }
            | Self::WfpInstalled { .. }
            | Self::WfpRefused { .. } => Direction::ToOwner,
        }
    }
}

/// The authenticated wrapper every provision frame travels in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProvisionEnvelope {
    pub version: u32,
    /// The owner both peers were started for. Binding it into the MAC is what stops a frame minted for
    /// one owner's provision from being replayed into another's.
    pub owner_sid: String,
    pub nonce: String,
    pub frame: ProvisionFrame,
    pub mac: String,
}

/// Why a provision frame was refused. Distinct from [`ProvisionRefusal`], which is a decision *about a
/// plan* that the protocol carries; these are failures of the protocol itself and are never sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvisionProtocolError {
    Frame(FrameError),
    /// A nonce arrived twice on the same connection.
    NonceReplayed,
    /// A frame arrived from the peer that is not allowed to send it.
    WrongDirection,
    /// A frame arrived that is legal but not the one the sequence calls for.
    UnexpectedFrame,
    /// The envelope's owner SID does not match the owner this process was started for.
    OwnerMismatch,
    /// The wrapped path set is over `MAX_PATH_SET_BYTES` on its own.
    PathSetOversized,
    /// The wrapped ACL plan is over `MAX_ACL_PLAN_BYTES` on its own.
    AclPlanOversized,
    /// The wrapped WFP plan is over MAX_WFP_PLAN_BYTES.
    WfpPlanOversized,
    /// More frames arrived on one connection than the protocol has any use for.
    FrameLimitExceeded,
}

impl ProvisionProtocolError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Frame(error) => error.code(),
            Self::NonceReplayed => "nonce_replayed",
            Self::WrongDirection => "frame_wrong_direction",
            Self::UnexpectedFrame => "unexpected_frame",
            Self::OwnerMismatch => "owner_mismatch",
            Self::PathSetOversized => "path_set_oversized",
            Self::AclPlanOversized => "acl_plan_oversized",
            Self::WfpPlanOversized => "wfp_plan_oversized",
            Self::FrameLimitExceeded => "frame_limit_exceeded",
        }
    }
}

impl From<FrameError> for ProvisionProtocolError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl From<ProvisionProtocolError> for io::Error {
    /// `InvalidData` rather than `PermissionDenied` on purpose, for the same reason the tier protocol
    /// does it: none of these is an authorization decision, and the peer-identity failures that *are* one
    /// live in `pipe.rs` and keep `PermissionDenied` to themselves.
    fn from(error: ProvisionProtocolError) -> Self {
        Self::new(
            io::ErrorKind::InvalidData,
            format!("provision frame refused: {}", error.code()),
        )
    }
}

/// One side's view of a provision connection: the shared key, the owner, and the nonces already seen.
pub struct ProvisionSession {
    key: Vec<u8>,
    owner_sid: String,
    seen_nonces: HashSet<String>,
    frames_seen: usize,
}

impl ProvisionSession {
    pub fn new(key: Vec<u8>, owner_sid: &str) -> Self {
        Self {
            key,
            owner_sid: owner_sid.to_owned(),
            seen_nonces: HashSet::new(),
            frames_seen: 0,
        }
    }

    /// Wraps `frame` in a signed envelope and returns the envelope's bytes.
    ///
    /// The result is a frame *body*: no length prefix. The pipe transport adds one, and adding a second
    /// here would make the peer's first read start on four bytes of binary length rather than on `{`.
    pub fn seal(
        &self,
        frame: ProvisionFrame,
        nonce: String,
    ) -> Result<Vec<u8>, ProvisionProtocolError> {
        let mut envelope = ProvisionEnvelope {
            version: PROVISION_CONTRACT_VERSION,
            owner_sid: self.owner_sid.clone(),
            nonce,
            frame,
            mac: String::new(),
        };
        check_payload_sizes(&envelope.frame)?;
        frame::validate_nonce(&envelope.nonce)?;
        envelope.mac = frame::mac_hex(&authenticated_bytes(&envelope)?, &self.key)?;
        Ok(frame::encode_body(&envelope, MAX_PROVISION_FRAME_BYTES)?)
    }

    /// Authenticates one frame body and returns it, refusing a replayed nonce, a foreign owner, a frame
    /// from the wrong peer, and an oversize wrapped payload.
    ///
    /// Order matters, and it is the same order the tier session uses: everything that can be decided from
    /// the bytes alone is decided before the replay set is touched, so a peer cannot fill the set with
    /// nonces from frames that were never valid.
    pub fn open(
        &mut self,
        body: &[u8],
        expected_from: Direction,
    ) -> Result<ProvisionFrame, ProvisionProtocolError> {
        self.frames_seen += 1;
        if self.frames_seen > MAX_FRAMES_PER_CONNECTION {
            return Err(ProvisionProtocolError::FrameLimitExceeded);
        }
        if body.len() > MAX_PROVISION_FRAME_BYTES {
            return Err(FrameError::Oversized.into());
        }
        let envelope: ProvisionEnvelope =
            serde_json::from_slice(body).map_err(|_| FrameError::InvalidJson)?;
        if envelope.version != PROVISION_CONTRACT_VERSION {
            return Err(FrameError::UnsupportedVersion.into());
        }
        frame::validate_nonce(&envelope.nonce)?;
        if envelope.owner_sid != self.owner_sid {
            return Err(ProvisionProtocolError::OwnerMismatch);
        }
        frame::verify_mac_hex(&authenticated_bytes(&envelope)?, &envelope.mac, &self.key)?;
        if envelope.frame.direction() != expected_from {
            return Err(ProvisionProtocolError::WrongDirection);
        }
        check_payload_sizes(&envelope.frame)?;
        if !self.seen_nonces.insert(envelope.nonce) {
            return Err(ProvisionProtocolError::NonceReplayed);
        }
        Ok(envelope.frame)
    }
}

/// The exact bytes the MAC covers: the envelope minus its own `mac`, canonicalized.
///
/// Canonicalized rather than serialized directly because the payloads are `serde_json::Value`s, whose
/// member order is a property of the JSON library's map type rather than of this protocol - and because
/// the peer on the other end of this pipe is a Python implementation that has to agree byte for byte.
/// `canonical_wire_json` is exactly `json.dumps(sort_keys=True, separators=(",", ":"))`, which is what
/// makes that agreement writable down as a fixed test vector on both sides rather than hoped for.
fn authenticated_bytes(envelope: &ProvisionEnvelope) -> Result<Vec<u8>, ProvisionProtocolError> {
    #[derive(Serialize)]
    struct Authenticated<'a> {
        version: u32,
        owner_sid: &'a str,
        nonce: &'a str,
        frame: &'a ProvisionFrame,
    }
    let value = serde_json::to_value(Authenticated {
        version: envelope.version,
        owner_sid: &envelope.owner_sid,
        nonce: &envelope.nonce,
        frame: &envelope.frame,
    })
    .map_err(|_| FrameError::InvalidJson)?;
    let canonical = canonical_wire_json(&value).map_err(|_| FrameError::InvalidJson)?;
    Ok(canonical.into_bytes())
}

/// The canonical bytes of one payload, and their length checked against that payload's own cap.
///
/// The same function produces the bytes both sides validate and the bytes the digest is taken over, so
/// the size that is checked, the bytes that are parsed and the digest that is reported can never be three
/// different things.
pub fn normalized_payload(value: &Value) -> Result<Vec<u8>, ProvisionProtocolError> {
    let canonical = canonical_wire_json(value).map_err(|_| FrameError::InvalidJson)?;
    Ok(canonical.into_bytes())
}

/// The digest a receipt reports for one payload: sha256 over its normalized bytes, hex-encoded.
pub fn normalized_digest(value: &Value) -> Result<String, ProvisionProtocolError> {
    Ok(hex::encode(Sha256::digest(normalized_payload(value)?)))
}

fn check_payload_sizes(frame: &ProvisionFrame) -> Result<(), ProvisionProtocolError> {
    if let ProvisionFrame::WfpPlan { wfp_plan } = frame
        && normalized_payload(wfp_plan)?.len() > MAX_WFP_PLAN_BYTES
    {
        return Err(ProvisionProtocolError::WfpPlanOversized);
    }
    if let ProvisionFrame::Provision { path_set, acl_plan } = frame {
        if normalized_payload(path_set)?.len() > MAX_PATH_SET_BYTES {
            return Err(ProvisionProtocolError::PathSetOversized);
        }
        if normalized_payload(acl_plan)?.len() > MAX_ACL_PLAN_BYTES {
            return Err(ProvisionProtocolError::AclPlanOversized);
        }
    }
    Ok(())
}

// In its own file rather than inline, because the cross-language fixed vector and one negative case per
// refusal class add up to more lines than the protocol itself, and the per-file size limit this crate
// enforces is there to keep a reader's unit of work small.
#[cfg(test)]
mod tests;
