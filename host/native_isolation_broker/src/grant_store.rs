//! Persisted workspace authorization and managed-root bindings under isolation data.

use crate::acl_windows::{read_broker_file, write_broker_file};
use crate::state;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

const SNAPSHOT_VERSION: u32 = 1;
const LIFECYCLE_VERSION: u32 = 1;
const MAX_SNAPSHOT_SIZE: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceRootGrant {
    pub root_id: String,
    pub path: String,
    pub policy_class: String,
}

/// One profile ancestor ACE this broker inserted: the folder, and the tier SID the ACE names.
///
/// Only an ACE this side added is recorded, so revoke and rotation never remove an identical ACE that
/// was already there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileAncestorAce {
    pub path: String,
    pub sid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceAuthorizationSnapshot {
    pub version: u32,
    pub owner_sid: String,
    pub workspace_roots: Vec<WorkspaceRootGrant>,
    pub managed_roots: HashMap<String, String>,
    #[serde(default)]
    pub applied_paths: Vec<String>,
    #[serde(default)]
    pub tier_account_sids: Vec<String>,
    #[serde(default)]
    pub profile_ancestor_aces: Vec<ProfileAncestorAce>,
    pub recorded_at: String,
}

pub fn grants_dir_for_owner(owner_sid: &str) -> io::Result<PathBuf> {
    if !is_valid_owner_sid(owner_sid) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "owner_sid is not a well-formed Windows SID",
        ));
    }
    Ok(state::isolation_data_dir()?.join("grants").join(owner_sid))
}

pub fn snapshot_path(owner_sid: &str) -> io::Result<PathBuf> {
    Ok(grants_dir_for_owner(owner_sid)?.join("authorization.json"))
}

pub fn load_snapshot(owner_sid: &str) -> io::Result<Option<WorkspaceAuthorizationSnapshot>> {
    let path = snapshot_path(owner_sid)?;
    if !path.is_file() {
        return Ok(None);
    }
    let payload = read_broker_file(&path, MAX_SNAPSHOT_SIZE)?;
    let snapshot: WorkspaceAuthorizationSnapshot = serde_json::from_slice(&payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if snapshot.version != SNAPSHOT_VERSION || snapshot.owner_sid != owner_sid {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "authorization snapshot version or owner does not match",
        ));
    }
    Ok(Some(snapshot))
}

pub fn save_snapshot(snapshot: &WorkspaceAuthorizationSnapshot) -> io::Result<()> {
    if snapshot.version != SNAPSHOT_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported authorization snapshot version",
        ));
    }
    let path = snapshot_path(&snapshot.owner_sid)?;
    let payload = serde_json::to_vec(snapshot)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if payload.len() > MAX_SNAPSHOT_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "authorization snapshot exceeds the maximum size",
        ));
    }
    // write_broker_file creates and DACL-protects the parent directory itself; do not
    // pre-create it here, or the directory would briefly exist unprotected.
    write_broker_file(&path, &payload)
}

pub fn revoke_snapshot(owner_sid: &str) -> io::Result<()> {
    let had_authorization = snapshot_path(owner_sid)?.is_file();
    let had_convergence = converged_tier_sids_path(owner_sid)?.is_file();
    if had_authorization || had_convergence {
        advance_convergence_epoch(owner_sid)?;
    }
    let snapshot = remove_if_present(&snapshot_path(owner_sid)?);
    let converged = remove_if_present(&converged_tier_sids_path(owner_sid)?);
    snapshot.and(converged)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// The policy version, tier SIDs and subtree paths for the last attempted descendant convergence epoch
/// (#2957). The epoch may contain recorded skips when the bounded walk could not repair every object.
///
/// Separate from the snapshot's `tier_account_sids` on purpose: that field is revoke evidence and is
/// saved before any write, so it cannot also mean "the descendant walk finished".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConvergedTierState {
    pub policy_version: u64,
    pub tier_account_sids: Vec<String>,
    pub paths: Vec<String>,
    #[serde(default)]
    pub resume_after: Option<String>,
    #[serde(default)]
    pub checkpoints: Vec<String>,
    #[serde(default)]
    pub skip_state: ConvergenceSkipState,
    /// The startup convergence target table the epoch walked. Records from builds before #3846 have
    /// none, and a record that names no table or another table never counts as converged.
    #[serde(default)]
    pub targets_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConvergenceSkipState {
    #[serde(default)]
    pub retryable: u64,
    #[serde(default)]
    pub structural: u64,
    #[serde(default)]
    pub coverage_bound_exceeded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceLifecycleState {
    version: u32,
    convergence_epoch: u64,
}

fn converged_tier_sids_path(owner_sid: &str) -> io::Result<PathBuf> {
    Ok(grants_dir_for_owner(owner_sid)?.join("converged-tier-sids.json"))
}

fn lifecycle_state_path(owner_sid: &str) -> io::Result<PathBuf> {
    Ok(grants_dir_for_owner(owner_sid)?.join("lifecycle.json"))
}

pub fn load_convergence_epoch(owner_sid: &str) -> io::Result<Option<u64>> {
    let path = lifecycle_state_path(owner_sid)?;
    if !path.is_file() {
        return Ok(None);
    }
    let payload = read_broker_file(&path, MAX_SNAPSHOT_SIZE)?;
    let state: WorkspaceLifecycleState = serde_json::from_slice(&payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if state.version != LIFECYCLE_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workspace lifecycle version does not match",
        ));
    }
    Ok(Some(state.convergence_epoch))
}

pub fn ensure_convergence_epoch(owner_sid: &str) -> io::Result<u64> {
    if let Some(epoch) = load_convergence_epoch(owner_sid)? {
        return Ok(epoch);
    }
    let payload = serde_json::to_vec(&WorkspaceLifecycleState {
        version: LIFECYCLE_VERSION,
        convergence_epoch: 0,
    })
    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_broker_file(&lifecycle_state_path(owner_sid)?, &payload)?;
    Ok(0)
}

pub fn advance_convergence_epoch(owner_sid: &str) -> io::Result<u64> {
    let epoch = load_convergence_epoch(owner_sid)?.unwrap_or(0);
    let next = epoch
        .checked_add(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "convergence epoch exhausted"))?;
    let payload = serde_json::to_vec(&WorkspaceLifecycleState {
        version: LIFECYCLE_VERSION,
        convergence_epoch: next,
    })
    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_broker_file(&lifecycle_state_path(owner_sid)?, &payload)?;
    Ok(next)
}

/// `None` when absent or unreadable, which callers treat as "walk again" - never as converged.
pub fn load_converged_tier_state(owner_sid: &str) -> Option<ConvergedTierState> {
    let path = converged_tier_sids_path(owner_sid).ok()?;
    let payload = read_broker_file(&path, MAX_SNAPSHOT_SIZE).ok()?;
    serde_json::from_slice(&payload).ok()
}

#[allow(clippy::too_many_arguments)]
pub fn save_converged_tier_state(
    owner_sid: &str,
    policy_version: u64,
    tier_account_sids: &[String],
    paths: &[String],
    resume_after: Option<String>,
    checkpoints: Vec<String>,
    skip_state: ConvergenceSkipState,
    targets_fingerprint: String,
) -> io::Result<()> {
    let payload = serde_json::to_vec(&ConvergedTierState {
        policy_version,
        tier_account_sids: tier_account_sids.to_vec(),
        paths: paths.to_vec(),
        resume_after,
        checkpoints,
        skip_state,
        targets_fingerprint: Some(targets_fingerprint),
    })
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_broker_file(&converged_tier_sids_path(owner_sid)?, &payload)
}

pub fn snapshot_from_path_set(
    path_set: &serde_json::Value,
) -> io::Result<WorkspaceAuthorizationSnapshot> {
    let owner_sid = path_set
        .get("owner_sid")
        .and_then(|value| value.as_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "path set owner_sid missing"))?;
    let workspace_roots = path_set
        .get("workspace_roots")
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "path set workspace_roots missing",
            )
        })?
        .iter()
        .map(|member| {
            Ok(WorkspaceRootGrant {
                root_id: member
                    .get("root_id")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidData, "workspace root_id missing")
                    })?
                    .to_owned(),
                path: member
                    .get("path")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidData, "workspace path missing")
                    })?
                    .to_owned(),
                policy_class: member
                    .get("policy_class")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidData, "workspace policy_class missing")
                    })?
                    .to_owned(),
            })
        })
        .collect::<io::Result<Vec<_>>>()?;

    let managed_keys = [
        "config_root",
        "data_root",
        "logs_root",
        "payload_root",
        "temp_root",
        "protected_root",
        "isolation_root",
    ];
    let mut managed_roots = HashMap::new();
    for key in managed_keys {
        let path = path_set
            .get(key)
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("path set {key} missing"),
                )
            })?;
        managed_roots.insert(key.to_owned(), path.to_owned());
    }

    let ancestors = crate::backend_ancestors::derive(
        Path::new(&managed_roots["config_root"]),
        Path::new(&managed_roots["data_root"]),
        Path::new(&managed_roots["logs_root"]),
        Path::new(&managed_roots["payload_root"]),
        Path::new(&managed_roots["temp_root"]),
    )?;
    for (scope, path) in crate::backend_ancestors::SCOPES.into_iter().zip(ancestors) {
        managed_roots.insert(scope.to_owned(), path.to_string_lossy().into_owned());
    }

    Ok(WorkspaceAuthorizationSnapshot {
        version: SNAPSHOT_VERSION,
        owner_sid: owner_sid.to_owned(),
        workspace_roots,
        managed_roots,
        applied_paths: Vec::new(),
        tier_account_sids: Vec::new(),
        profile_ancestor_aces: Vec::new(),
        recorded_at: iso8601_now(),
    })
}

/// Matches the same shape as `shared/contracts` `ACL_OWNER_SID_PATTERN` (`^S-1-(?:\d+-)+\d+$`):
/// a textual Windows SID made only of `S`, `1`, hyphens, and ASCII digits, so it can never
/// contain a path separator or `..` when used as a path component.
fn is_valid_owner_sid(owner_sid: &str) -> bool {
    let mut segments = owner_sid.split('-');
    if segments.next() != Some("S") || segments.next() != Some("1") {
        return false;
    }
    let rest: Vec<&str> = segments.collect();
    rest.len() >= 2 && rest.iter().all(|segment| is_ascii_digits(segment))
}

fn is_ascii_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn iso8601_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{seconds}")
}

#[cfg(test)]
mod tests {
    use super::is_valid_owner_sid;

    #[test]
    fn accepts_well_formed_sids() {
        assert!(is_valid_owner_sid("S-1-5-18"));
        assert!(is_valid_owner_sid("S-1-5-32-544"));
        assert!(is_valid_owner_sid(
            "S-1-5-21-4157954928-3401976220-2881858016-1003"
        ));
    }

    #[test]
    fn rejects_malformed_or_traversal_like_input() {
        for value in [
            "",
            "S-1",
            "S-1-",
            "S-1-abc",
            "S-2-5-18",
            "../../evil",
            "S-1-5-18/../../evil",
            "S-1-5-18:evil",
        ] {
            assert!(
                !is_valid_owner_sid(value),
                "expected {value:?} to be rejected"
            );
        }
    }
}
