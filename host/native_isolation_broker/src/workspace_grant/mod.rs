//! Workspace authorization lifecycle, and the refusal vocabulary the apply beside it speaks.
//!
//! # What a plan is allowed to decide
//!
//! A plan arrives over the provision pipe from an unprivileged owner, so nothing in it is a decision. It
//! decides two things and nothing else: *which* authorized objects to converge, and it must agree with
//! the shipped policy about what converging them means.
//!
//! Everything that becomes an ACE comes from the embedded descriptor (`acl_descriptor`), and every path
//! is either derived by this side or required to be an object the requesting owner already owns
//! (`acl_authorized_root`). The plan's own `required` block is compared against the shipped expectation
//! and refused when it differs; it is never translated into SDDL. That is the difference between a broker
//! that validates a plan and a broker that executes one. The apply itself is in `apply`.

use crate::grant_store::{
    WorkspaceAuthorizationSnapshot, load_snapshot, revoke_snapshot, save_snapshot,
    snapshot_from_path_set,
};
use crate::managed_root_path::{ManagedPathRefusal, UnreadableKind};
use crate::security_descriptor_apply::revoke_explicit_sids_from_path;
use crate::tier::IsolationTier;
use serde_json::Value;
use std::io;
use std::path::Path;

mod apply;

pub use apply::apply_acl_plan;

pub const ACL_APPLY_OBJECT_COVERAGE_LIMIT: usize = 4096;
pub const STALE_DESCENDANT_WALK_LIMIT: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AclApplyFailure {
    CoverageBoundExceeded {
        planned: usize,
        limit: usize,
    },
    PlanShapeInvalid(String),
    AuthorizationMissing,
    /// The object a plan named was refused on its path: a reparse point somewhere in the chain, the wrong
    /// object type, a shape the guards do not accept, or a component that could not be opened at all.
    ///
    /// A class of its own rather than a `Win32PermissionDenied`, because it used to be one. Every path
    /// refusal collapsed into the permission variant, so "a junction sits above this managed root" and
    /// "this DACL could not be written" arrived at the caller as the same word - and the first of those is
    /// a refusal to act on an object the caller does not actually own, which no retry can fix.
    PathRefused(ManagedPathRefusal),
    /// The plan asks for a descriptor that is not the one this build ships.
    ///
    /// Its own class because it is the refusal that makes the whole apply path safe, and a caller has to be
    /// able to tell it from "your paths are wrong" and from "the machine is not ready". The name matches
    /// the planner refusal reason the contract bundle already defines.
    DescriptorNotTheShippedPolicy(String),
    /// The plan named an object this side will not write: a derived root whose path does not match, an
    /// object that does not exist, or an object the requesting owner does not own.
    RootNotAuthorized(String),
    /// Something the provision needs was not in place - the state directory, the tier identities, the
    /// snapshot store.
    ///
    /// Split out of `Win32PermissionDenied`, which used to absorb all three. "The tier accounts are not
    /// provisioned yet" and "this DACL could not be written" are different situations with different
    /// answers, and reporting them under one word told an operator to check the wrong thing.
    PreconditionMissing(String),
    Win32PermissionDenied(String),
}

impl AclApplyFailure {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::CoverageBoundExceeded { .. } => "coverage_bound_exceeded",
            Self::PlanShapeInvalid(_) | Self::AuthorizationMissing => "plan_shape_invalid",
            Self::PathRefused(refusal) => refusal.code(),
            Self::DescriptorNotTheShippedPolicy(_) => "descriptor_not_the_shipped_policy",
            Self::RootNotAuthorized(_) => "managed_root_not_authorized",
            Self::PreconditionMissing(_) => "provision_precondition_missing",
            Self::Win32PermissionDenied(_) => "win32_permission_denied",
        }
    }

    pub fn detail(&self) -> String {
        match self {
            Self::CoverageBoundExceeded { planned, limit } => {
                format!("planned to apply {planned} objects but the coverage limit is {limit}")
            }
            Self::PlanShapeInvalid(message)
            | Self::DescriptorNotTheShippedPolicy(message)
            | Self::RootNotAuthorized(message)
            | Self::PreconditionMissing(message)
            | Self::Win32PermissionDenied(message) => message.clone(),
            Self::AuthorizationMissing => {
                "no workspace authorization snapshot is recorded for this owner".to_owned()
            }
            Self::PathRefused(refusal) => refusal.detail(),
        }
    }

    /// Whether this failure is the caller being denied access, as opposed to being told no.
    ///
    /// One path refusal belongs here and the rest do not: a component that could not be *opened* because
    /// of access is an access failure however it is discovered, while a reparse point, a wrong object type
    /// or a bad shape is a decision about the object that would be reached the same way with every
    /// privilege in the system.
    pub fn is_permission_class(&self) -> bool {
        match self {
            Self::Win32PermissionDenied(_) => true,
            Self::PathRefused(ManagedPathRefusal::Unreadable { kind, .. }) => {
                *kind == UnreadableKind::PermissionDenied
            }
            _ => false,
        }
    }
}

pub fn record_path_set_authorization(
    path_set: &Value,
) -> io::Result<WorkspaceAuthorizationSnapshot> {
    let mut snapshot = snapshot_from_path_set(path_set)?;
    if let Some(previous) = load_snapshot(&snapshot.owner_sid)? {
        preserve_revoke_evidence(&mut snapshot, previous);
    }
    save_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn preserve_revoke_evidence(
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    previous: WorkspaceAuthorizationSnapshot,
) {
    snapshot.applied_paths = previous.applied_paths;
    snapshot.tier_account_sids = previous.tier_account_sids;
    snapshot.profile_ancestor_aces = previous.profile_ancestor_aces;
}

pub fn revoke_workspace_authorization(owner_sid: &str) -> io::Result<()> {
    revoke_snapshot(owner_sid)
}

pub fn revoke_applied_acl(owner_sid: &str) -> io::Result<()> {
    match load_snapshot(owner_sid) {
        Ok(Some(snapshot)) => revoke_snapshot_acl(&snapshot),
        Ok(None) => Ok(()),
        // A corrupt snapshot carries no usable revoke evidence; revoke_owner still deletes it.
        Err(error) if error.kind() == io::ErrorKind::InvalidData => Ok(()),
        Err(error) => Err(error),
    }
}

/// Best effort: an interrupted provision leaves paths or SIDs missing, and revoke must still converge.
fn revoke_snapshot_acl(snapshot: &WorkspaceAuthorizationSnapshot) -> io::Result<()> {
    let mut first_error = None;
    for value in &snapshot.applied_paths {
        let path = Path::new(value);
        if !path.exists() {
            continue;
        }
        if let Err(error) = revoke_explicit_sids_from_path(path, true, &snapshot.tier_account_sids)
        {
            first_error.get_or_insert(error);
        }
    }
    if let Err(error) = crate::profile_ancestor_apply::remove_from_snapshot(snapshot) {
        first_error.get_or_insert(error);
    }
    first_error.map_or(Ok(()), Err)
}

fn names_every_tier(tier_account_sids: &[String]) -> bool {
    tier_account_sids.len() == IsolationTier::ALL.len()
}

#[cfg(test)]
mod tests;
