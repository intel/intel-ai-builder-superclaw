//! The elevated half of provisioning: one connection, one plan, one receipt.
//!
//! # What moved here and why
//!
//! Recording a workspace authorization and applying an ACL plan used to happen on the *start* path, from
//! the catalog, on every launch. That made every start a potential DACL write, which meant every start
//! needed a privileged component within reach of it. Both operations now happen only here, in a process
//! that exists for the duration of one provision and then exits.
//!
//! The consequence for the rest of the product is that starting is a *read-only* check: the launcher proves
//! a managed root still carries the descriptor with `READ_CONTROL` and, if it does not, says
//! `provision_required` and stops. It cannot repair drift, because repairing drift is what this module is
//! and this module is not reachable from it.
//!
//! # What the elevated side refuses to take on trust
//!
//! Everything except the owner SID it authenticated. The owner's client hands over a path set and an ACL
//! plan; this module then independently re-establishes every property that makes applying them safe:
//!
//! - the path set names the owner this broker authenticated, not some other owner ([`provision`]);
//! - neither payload carries an executable path, command line, shell or free environment
//!   ([`crate::broker_wire::scan_forbidden_caller_fields`]);
//! - the plan has the shape C3 defines, and every root it names is one the recorded authorization
//!   actually contains (`workspace_grant::apply_acl_plan`);
//! - the object count is within the coverage bound, before a single object is touched;
//! - every path component of every managed root is a plain directory and none is a reparse point
//!   (`managed_root_path::verify_managed_path_chain`, reached from both the typed guard in
//!   `workspace_grant::apply_and_observe` and the handle open in `security_descriptor`);
//! - the descriptor is applied through a handle and read back entry by entry, so the receipt states what
//!   the object carries rather than what was requested.
//!
//! No path, root or right in either payload is ever turned into an ACL write on its own authority: a plan
//! entry can only name a root the *snapshot* already lists, and the descriptor applied to it is composed
//! from the shipped policy vocabulary, not from anything on the wire.
//!
//! # The same session, preceded by the owner's tier identities
//!
//! A first start needs both of this crate's provisioning steps, and as two elevated invocations they cost
//! the user two UAC prompts. `--provision-identities-and-session` is the one-prompt form, and it is still
//! one closed operation: the same three closed arguments as `--provision-session`, the same pipe, the same
//! single request and single receipt. Between authenticating the request and recording anything it runs
//! `--provision`'s own identity step ([`crate::product::provision_owner`]), with that step's idempotence,
//! owner gate and rollback unchanged. If the step fails, nothing is recorded, nothing is applied, and the
//! receipt says `tier_identity_provision_failed`.
//!
//! The full order is: the pipe's server bound to `--owner-sid`; the request's MAC and nonce; the
//! forbidden-field scan of both payloads; the path set's owner binding; the identity step; the record,
//! which is where the path set's structure is parsed; and the apply, which checks the plan's shape, policy
//! version and coverage bound before it touches any object. So a request refused at the record or the
//! apply may already have ensured the owner's identities. That is harmless: it is `--provision`'s
//! idempotent, owner-scoped step, and the request authenticated as that owner.
//!
//! # What this process does not do
//!
//! It does not launch anything, does not write a marker, and does not decide whether a provision was
//! needed. The unprivileged `broker_client` decides that from digests it already holds, and writes its own
//! marker into the *owner's* `LOCALAPPDATA` after this process succeeds - which is the only way the marker
//! can land in the owner's profile when the UAC administrator is a different account. The marker is a hint
//! about whether to prompt, and nothing reads it as evidence that anything was applied.

pub mod pipe;
pub mod wire;

use crate::broker_wire::scan_forbidden_caller_fields;
use crate::frame::decode_auth_key;
use crate::product::{broker_authorization, provision_owner};
use crate::random_bytes::random_hex;
use crate::sid_win32::canonical_sid;
use crate::wfp::WfpPlanFailure;
use crate::workspace_grant::{
    ACL_APPLY_OBJECT_COVERAGE_LIMIT, AclApplyFailure, apply_acl_plan, record_path_set_authorization,
};
use pipe::ProvisionPipeClient;
use serde_json::Value;
use std::io;
use std::time::{Duration, Instant};
use wire::{
    Direction, ProvisionFrame, ProvisionProtocolError, ProvisionRefusal, ProvisionSession,
    WfpInstallRefusal, normalized_digest, normalized_payload,
};

/// How long to wait for the owner's pipe to exist and accept this process.
///
/// The owner creates the pipe *before* launching this process, so in the ordinary case the first open
/// succeeds. The window exists for the case where the elevated process wins the race against the owner's
/// own `CreateNamedPipeW` returning, which is short, and it is bounded because a broker that waits forever
/// for a pipe nobody will create is a UAC prompt the user cannot dismiss into any useful state.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for the owner's request, and how long the owner has to accept the answer.
///
/// Not the time budget for the apply itself, which is bounded by the coverage limit rather than by a clock:
/// the deadline is set again for the response after the plan has converged, so a long but legitimate apply
/// cannot fail on the response write.
const FRAME_TIMEOUT: Duration = Duration::from_secs(30);

/// The number of random bytes behind each frame nonce.
///
/// Sixteen bytes, so 32 hex characters, which is inside `frame`'s 16..=128 nonce window with room to spare
/// and far past the point where a collision within one connection is worth reasoning about.
const NONCE_BYTES: usize = 16;

/// Serves one provision request on the pipe the owner created, then returns.
///
/// A refusal is answered on the pipe *and* returned as an error. Both are needed: the owner has no other
/// channel to this process - it was started through `runas`, so its standard error goes nowhere the owner
/// can read - and the exit code is what makes a failed provision fail rather than continue. Neither of the
/// two paths out of this function can be reached without one of them having happened.
pub fn run(
    owner_sid: &str,
    pipe_id: &str,
    auth_key_hex: &str,
    identity: IdentityStep,
) -> io::Result<()> {
    serve(
        owner_sid,
        pipe_id,
        auth_key_hex,
        |owner| identity.run(owner),
        crate::wfp::install_plan,
    )
}

/// The identity step a session runs before it records anything, chosen by the command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityStep {
    /// `--provision-session`: the owner's tier identities are already provisioned.
    Skip,
    /// `--provision-identities-and-session`: `--provision`'s own identity step, for the first start's single
    /// UAC prompt.
    ProvisionOwner,
}

impl IdentityStep {
    /// Called for its effect: the session's receipt is the only report.
    fn run(self, owner: &str) -> io::Result<()> {
        match self {
            Self::Skip => Ok(()),
            Self::ProvisionOwner => provision_owner(&broker_authorization(), owner).map(|_| ()),
        }
    }
}

fn serve(
    owner_sid: &str,
    pipe_id: &str,
    auth_key_hex: &str,
    tier_identities: impl FnOnce(&str) -> io::Result<()>,
    install_wfp: impl FnOnce(&str, &[u8]) -> Result<(), WfpPlanFailure>,
) -> io::Result<()> {
    let owner = canonical_sid(owner_sid)?;
    let key = decode_auth_key(auth_key_hex).map_err(ProvisionProtocolError::from)?;

    let client = ProvisionPipeClient::connect(pipe_id, Instant::now() + CONNECT_TIMEOUT)?;
    client.bind_server(&owner)?;

    let mut session = ProvisionSession::new(key, &owner);
    let request = client
        .receive(Instant::now() + FRAME_TIMEOUT)?
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the provision pipe closed before a request arrived",
            )
        })?;
    let (path_set, acl_plan) = match session.open(&request, Direction::ToBroker)? {
        ProvisionFrame::Provision { path_set, acl_plan } => (path_set, acl_plan),
        _ => return Err(ProvisionProtocolError::UnexpectedFrame.into()),
    };

    match provision(&owner, &path_set, &acl_plan, tier_identities) {
        Ok(observation) => {
            let receipt = ProvisionFrame::Applied {
                path_set_digest: normalized_digest(&path_set)?,
                acl_plan_digest: normalized_digest(&acl_plan)?,
                observation,
            };
            // The apply already converged by this point, so a delivery failure here must not read like
            // the same kind of error as one from `provision` itself: the plan did succeed, and the only
            // open question is whether the owner ever learned that.
            answer(&client, &session, receipt).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "the provision converged, but the receipt could not be delivered: {error}"
                    ),
                )
            })?;
            // The ACL receipt stands whatever happens next: a WFP install that fails, or a peer that
            // never asks for one, is reported on the pipe and does not change this session's result.
            let _ = wfp_exchange(&client, &mut session, &owner, install_wfp);
            Ok(())
        }
        Err(failure) => {
            // The refusal is reported before the error is returned, so the owner learns *why* even though
            // this process is about to exit with nothing but a status code. A failure to deliver it does
            // not turn the refusal into a success: either way this returns `Err`.
            let sent = answer(
                &client,
                &session,
                ProvisionFrame::Refused {
                    reason: failure.reason(),
                },
            );
            Err(refusal_error(&failure, sent.err()))
        }
    }
}

/// The optional second half of a session: the owner's WFP plan, installed in this same elevated process.
///
/// There is no second elevation and no second entry point. The owner learns the tier accounts' SIDs only
/// once this process has provisioned them, so the plan can only be written after Applied; it then comes
/// back over the same authenticated pipe, and is re-validated from scratch here exactly as the ACL plan
/// was. An owner that closes the pipe instead asked for no install, which is not an error.
fn wfp_exchange(
    client: &ProvisionPipeClient,
    session: &mut ProvisionSession,
    owner: &str,
    install_wfp: impl FnOnce(&str, &[u8]) -> Result<(), WfpPlanFailure>,
) -> io::Result<()> {
    let Some(body) = client.receive(Instant::now() + FRAME_TIMEOUT)? else {
        return Ok(());
    };
    let wfp_plan = match session.open(&body, Direction::ToBroker)? {
        ProvisionFrame::WfpPlan { wfp_plan } => wfp_plan,
        _ => return Err(ProvisionProtocolError::UnexpectedFrame.into()),
    };
    answer(client, session, wfp_reply(owner, &wfp_plan, install_wfp))
}

/// The frame that answers a WFP plan: installed, or refused for one closed reason.
fn wfp_reply(
    owner: &str,
    wfp_plan: &Value,
    install_wfp: impl FnOnce(&str, &[u8]) -> Result<(), WfpPlanFailure>,
) -> ProvisionFrame {
    if scan_forbidden_caller_fields(wfp_plan).is_some() {
        return ProvisionFrame::WfpRefused {
            reason: WfpInstallRefusal::PlanShapeInvalid,
        };
    }
    let (Ok(bytes), Ok(digest)) = (normalized_payload(wfp_plan), normalized_digest(wfp_plan)) else {
        return ProvisionFrame::WfpRefused {
            reason: WfpInstallRefusal::PlanShapeInvalid,
        };
    };
    match install_wfp(owner, &bytes) {
        Ok(()) => ProvisionFrame::WfpInstalled {
            wfp_plan_digest: digest,
        },
        Err(failure) => ProvisionFrame::WfpRefused {
            reason: match failure {
                WfpPlanFailure::Plan(_) => WfpInstallRefusal::PlanShapeInvalid,
                WfpPlanFailure::OwnerMismatch => WfpInstallRefusal::OwnerMismatch,
                WfpPlanFailure::ObjectsNotInstallable => WfpInstallRefusal::ObjectsNotInstallable,
                WfpPlanFailure::Apply(_) => WfpInstallRefusal::ApplyRefused,
                WfpPlanFailure::Engine(_) => WfpInstallRefusal::EngineUnavailable,
            },
        },
    }
}

/// Why a provision was refused, in the two forms this process needs at once.
///
/// The peer gets a [`ProvisionRefusal`] and nothing else, because a privileged boundary has no business
/// emitting free-form text to an unprivileged caller. This process's own exit error gets the full code and
/// detail, which is what a human reading the failure - and, once P6 lands, a log line - actually needs.
/// Keeping the two apart in one type means they cannot drift into disagreeing about what happened.
enum ProvisionFailure {
    /// A refusal decided from the payloads' shape or binding alone, before any object was inspected.
    Shape {
        reason: ProvisionRefusal,
        detail: String,
    },
    /// A refusal from the plan validator, which already carries its own reason code and detail.
    Apply(AclApplyFailure),
    /// The identity step of `--provision-identities-and-session` failed, before anything was recorded.
    TierIdentities(io::Error),
}

impl ProvisionFailure {
    /// The coarse reason the peer is told.
    fn reason(&self) -> ProvisionRefusal {
        match self {
            Self::Shape { reason, .. } => *reason,
            Self::Apply(failure) => ProvisionRefusal::from(failure),
            Self::TierIdentities(_) => ProvisionRefusal::TierIdentityProvisionFailed,
        }
    }

    /// The precise reason code this process reports about itself, which is finer than the wire's: a
    /// reparse point, a wrong object type and an unreadable component are one wire word and three codes.
    /// An identity failure reports the code `--provision` reports for the same error.
    fn code(&self) -> &str {
        match self {
            Self::Shape { reason, .. } => reason.code(),
            Self::Apply(failure) => failure.reason_code(),
            Self::TierIdentities(error) => crate::error_code(error),
        }
    }

    fn detail(&self) -> String {
        match self {
            Self::Shape { detail, .. } => detail.clone(),
            Self::Apply(failure) => failure.detail(),
            Self::TierIdentities(error) => {
                format!("the tier identities could not be provisioned: {error}")
            }
        }
    }

    /// Whether this was the broker being denied access, rather than the broker declining.
    ///
    /// A shape or binding refusal is never in this class: it is decided from the payload, with no object
    /// touched and no access requested, so reporting it as an access failure would invite a caller to
    /// retry something that will be refused identically forever.
    fn is_permission_class(&self) -> bool {
        match self {
            Self::Shape { .. } => false,
            Self::Apply(failure) => failure.is_permission_class(),
            Self::TierIdentities(error) => error.kind() == io::ErrorKind::PermissionDenied,
        }
    }
}

/// Seals one frame under a fresh nonce and writes it.
fn answer(
    client: &ProvisionPipeClient,
    session: &ProvisionSession,
    frame: ProvisionFrame,
) -> io::Result<()> {
    let body = session.seal(frame, random_hex(NONCE_BYTES)?)?;
    client.send(&body, Instant::now() + FRAME_TIMEOUT)
}

/// The refusal as this process's own exit error, carrying whether the owner was told.
///
/// The error *kind* separates the permission class from everything else, which is what keeps a coverage
/// refusal from being mistaken for an access failure by a caller that retries the latter.
fn refusal_error(failure: &ProvisionFailure, undelivered: Option<io::Error>) -> io::Error {
    let kind = if failure.is_permission_class() {
        io::ErrorKind::PermissionDenied
    } else {
        io::ErrorKind::InvalidData
    };
    let refused = format!(
        "provision refused: {} ({})",
        failure.code(),
        failure.detail()
    );
    match undelivered {
        None => io::Error::new(kind, refused),
        Some(error) => io::Error::new(
            kind,
            format!("{refused}, and the refusal could not be delivered: {error}"),
        ),
    }
}

/// Records the authorization and converges the plan onto it, under this owner and nothing else.
///
/// The order is load-bearing. The snapshot is written first because it is what turns a root *name* in the
/// plan into a path: `apply_acl_plan` resolves every `root_id` and `managed_root_scope` through the
/// snapshot and refuses one it does not find, so the plan carries no paths at all and cannot name an object
/// the path set did not.
///
/// That is a separation of the two payloads and not, by itself, an authorization: both arrived in the same
/// request, so a `managed_root_not_authorized` refusal for one of the five owner-owned scopes or for a
/// workspace root means "the plan and the path set disagree", not "someone else vouched for this path".
/// What authorizes those paths is `acl_authorized_root`'s owner-owned rule, asked of the apply handle. The
/// two derived `%ProgramData%` roots are the only scopes whose path this side decides on its own.
///
/// A consequence worth stating: a request refused during the apply has still replaced this owner's recorded
/// `workspace_roots` and `managed_roots`. That is a record of what was asked for, it is scoped to the owner
/// that asked, and nothing reads it as evidence that a plan was applied - `applied_paths`, which the revoke
/// path does reopen, is written only after an object has been authorized and written.
///
/// `tier_identities` runs after the forbidden-field scans and the owner binding and before the record, so a
/// failed identity step records and applies nothing. A path-set structure, plan shape, policy version or
/// coverage refusal comes after it, at the record or the apply. It is a no-op for a plain
/// `--provision-session`.
fn provision(
    owner: &str,
    path_set: &Value,
    acl_plan: &Value,
    tier_identities: impl FnOnce(&str) -> io::Result<()>,
) -> Result<Value, ProvisionFailure> {
    if let Some(error) = scan_forbidden_caller_fields(path_set) {
        return Err(ProvisionFailure::Shape {
            reason: ProvisionRefusal::PathSetShapeInvalid,
            detail: format!(
                "path set carries a forbidden field: {}",
                error.reason_code()
            ),
        });
    }
    if let Some(error) = scan_forbidden_caller_fields(acl_plan) {
        return Err(ProvisionFailure::Shape {
            reason: ProvisionRefusal::PlanShapeInvalid,
            detail: format!(
                "ACL plan carries a forbidden field: {}",
                error.reason_code()
            ),
        });
    }
    if path_set.get("owner_sid").and_then(Value::as_str) != Some(owner) {
        return Err(ProvisionFailure::Shape {
            reason: ProvisionRefusal::OwnerBindingInvalid,
            detail: "the path set does not name the owner this broker authenticated".to_owned(),
        });
    }
    tier_identities(owner).map_err(ProvisionFailure::TierIdentities)?;
    record_path_set_authorization(path_set).map_err(|error| ProvisionFailure::Shape {
        reason: ProvisionRefusal::PathSetShapeInvalid,
        detail: format!("the path set could not be recorded as an authorization: {error}"),
    })?;
    apply_acl_plan(owner, acl_plan, ACL_APPLY_OBJECT_COVERAGE_LIMIT)
        .map_err(ProvisionFailure::Apply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The wire reason a call to `provision` refused with, which is what a peer would be told.
    fn refusal(owner: &str, path_set: &Value, acl_plan: &Value) -> ProvisionRefusal {
        provision(owner, path_set, acl_plan, |_| Ok(()))
            .map(|_| ())
            .expect_err("this payload must be refused")
            .reason()
    }

    /// The owner binding, which is the check that stops a plan minted for one account from being applied
    /// under another's authorization. It runs before anything is recorded or written.
    #[test]
    fn a_path_set_naming_another_owner_is_refused_before_anything_is_recorded() {
        let plan = json!({"contract_version": 1});
        for foreign in ["S-1-5-21-9-9-9-500", "S-1-5-18", ""] {
            assert_eq!(
                refusal("S-1-5-21-1-2-3-1001", &json!({"owner_sid": foreign}), &plan),
                ProvisionRefusal::OwnerBindingInvalid
            );
        }
    }

    #[test]
    fn a_path_set_without_an_owner_is_refused_rather_than_defaulted() {
        assert_eq!(
            refusal(
                "S-1-5-21-1-2-3-1001",
                &json!({"workspace_roots": []}),
                &json!({"contract_version": 1}),
            ),
            ProvisionRefusal::OwnerBindingInvalid
        );
    }

    /// The forbidden-field scan, which is what keeps an executable path or a command line from riding into
    /// the elevated process inside an otherwise well-formed payload. It is checked on both payloads
    /// because a plan and a path set are equally attacker-supplied here.
    #[test]
    fn a_payload_carrying_an_executable_or_a_command_line_is_refused() {
        let owner = "S-1-5-21-1-2-3-1001";
        for field in ["executable", "command_line", "argv", "shell", "env"] {
            let mut path_set = json!({"owner_sid": owner});
            path_set[field] = json!("whatever");
            assert_eq!(
                refusal(owner, &path_set, &json!({"contract_version": 1})),
                ProvisionRefusal::PathSetShapeInvalid
            );

            let mut plan = json!({"contract_version": 1});
            plan[field] = json!("whatever");
            assert_eq!(
                refusal(owner, &json!({"owner_sid": owner}), &plan),
                ProvisionRefusal::PlanShapeInvalid
            );
        }
    }

    /// A forbidden field nested well inside a legal-looking structure is still found. The scan is
    /// recursive, and a check that only looked at the top level would be trivially avoidable.
    #[test]
    fn a_forbidden_field_nested_inside_the_plan_is_still_refused() {
        let owner = "S-1-5-21-1-2-3-1001";
        let plan = json!({
            "contract_version": 1,
            "managed_root_plans": [{
                "managed_root_scope": "data_root",
                "tier_subtrees": [{"tier": "bootstrap", "command_line": "cmd.exe /c whoami"}],
            }],
        });
        assert_eq!(
            refusal(owner, &json!({"owner_sid": owner}), &plan),
            ProvisionRefusal::PlanShapeInvalid
        );
    }

    /// A refusal that could not be delivered is still a refusal. The receipt is how the owner learns the
    /// reason; it is never what makes the provision have failed.
    #[test]
    fn an_undelivered_refusal_still_fails_and_says_so() {
        let over_bound = ProvisionFailure::Apply(AclApplyFailure::CoverageBoundExceeded {
            planned: 5_000,
            limit: 4_096,
        });

        let delivered = refusal_error(&over_bound, None);
        assert_eq!(delivered.kind(), io::ErrorKind::InvalidData);
        assert!(delivered.to_string().contains("coverage_bound_exceeded"));
        assert!(
            delivered.to_string().contains("5000"),
            "the local error keeps the detail the wire does not carry: {delivered}"
        );
        assert!(!delivered.to_string().contains("could not be delivered"));

        let lost = refusal_error(
            &over_bound,
            Some(io::Error::new(io::ErrorKind::BrokenPipe, "pipe closed")),
        );
        assert_eq!(lost.kind(), io::ErrorKind::InvalidData);
        assert!(lost.to_string().contains("coverage_bound_exceeded"));
        assert!(
            lost.to_string().contains("could not be delivered"),
            "a lost receipt must be visible in the failure: {lost}"
        );
    }

    /// A coverage refusal and a permission refusal must not arrive as the same error kind, or a caller
    /// that retries on access failures would retry a plan that is simply too large.
    #[test]
    fn a_coverage_refusal_is_a_different_error_kind_than_a_permission_refusal() {
        let over_bound = ProvisionFailure::Apply(AclApplyFailure::CoverageBoundExceeded {
            planned: 5_000,
            limit: 4_096,
        });
        let denied = ProvisionFailure::Apply(AclApplyFailure::Win32PermissionDenied(
            "access is denied".to_owned(),
        ));
        assert_eq!(
            refusal_error(&over_bound, None).kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            refusal_error(&denied, None).kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            over_bound.reason(),
            ProvisionRefusal::CoverageBoundExceeded,
            "the coarse wire word must stay distinct too"
        );
        assert_eq!(denied.reason(), ProvisionRefusal::Win32PermissionDenied);
    }

    /// A reparse point is not a permission problem. It used to be reported as one, because every path
    /// refusal collapsed into `Win32PermissionDenied`, and a caller that retries access failures would have
    /// retried a junction forever.
    #[test]
    fn a_reparse_point_refusal_is_neither_a_permission_nor_a_coverage_failure() {
        let junction = ProvisionFailure::Apply(AclApplyFailure::PathRefused(
            crate::managed_root_path::ManagedPathRefusal::ReparsePointInPath,
        ));
        assert!(!junction.is_permission_class());
        assert_eq!(
            refusal_error(&junction, None).kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(junction.reason(), ProvisionRefusal::ReparsePointInPath);
        assert_eq!(junction.code(), "managed_path_reparse_point");
    }

    /// A component that could not be opened *because of access* is the one path refusal that is a
    /// permission failure, and it must not be flattened into the same word as a junction.
    #[test]
    fn an_unreadable_component_is_a_permission_failure_but_still_a_path_refusal() {
        let unreadable = ProvisionFailure::Apply(AclApplyFailure::PathRefused(
            crate::managed_root_path::ManagedPathRefusal::Unreadable {
                kind: crate::managed_root_path::UnreadableKind::PermissionDenied,
                message: "access is denied".to_owned(),
            },
        ));
        assert!(unreadable.is_permission_class());
        assert_eq!(
            refusal_error(&unreadable, None).kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(unreadable.reason(), ProvisionRefusal::ManagedPathRefused);
    }

    /// A shape or binding refusal never claims to be an access failure: nothing was opened, so nothing
    /// could have been denied.
    #[test]
    fn a_shape_refusal_is_never_reported_as_an_access_failure() {
        let shape = ProvisionFailure::Shape {
            reason: ProvisionRefusal::OwnerBindingInvalid,
            detail: "the path set does not name the owner this broker authenticated".to_owned(),
        };
        assert!(!shape.is_permission_class());
        assert_eq!(
            refusal_error(&shape, None).kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(shape.code(), "owner_binding_invalid");
    }
}

// In its own file rather than inline, because these cases drive the whole session over a real pipe, and the
// per-file size limit this crate enforces is there to keep a reader's unit of work small.
#[cfg(test)]
mod tier_identity_tests;

#[cfg(test)]
mod wfp_session_tests;
