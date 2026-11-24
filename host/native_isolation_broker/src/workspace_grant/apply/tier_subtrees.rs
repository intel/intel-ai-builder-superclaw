//! The per-tier subtrees under a managed root, and converging what tier processes already wrote there.
//!
//! Split from `super` for the crate's file-size limit; it uses the same guards and `apply_object` the
//! rest of the apply path does, so nothing here is a second policy.

use super::{
    apply_object, plan_required, record_applied_path, require_creatable_chain,
    require_first_mention, require_inside_root, require_shipped_descriptor,
    require_single_path_segment,
};
use crate::acl_descriptor::{ExpectedAce, ExpectedDacl, managed_root_tier_expectation};
use crate::acl_policy_apply::{
    AclWriteFailure, ObjectOwnership, PrincipalResolver, apply_expected_to_descendant,
};
use crate::grant_store::WorkspaceAuthorizationSnapshot;
use crate::managed_root_path::{ManagedPathRefusal, UnreadableKind, measure_reparse_state};
use crate::security_descriptor_apply::AclApplyOutcome;
use crate::workspace_grant::{AclApplyFailure, STALE_DESCENDANT_WALK_LIMIT};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;
use windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION;
use windows_sys::Win32::Security::{CONTAINER_INHERIT_ACE, INHERIT_ONLY_ACE, OBJECT_INHERIT_ACE};

const MAX_REPORTED_SKIPS: usize = 100;

/// The tier subtrees one managed root plan names, each looked up in the shipped descriptor by scope and
/// tier, so a plan cannot ask for a tier the scope does not have or for a descriptor of its own.
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(super) fn apply_tier_subtrees(
    managed_root: &Path,
    scope: &str,
    subtrees: Option<&Vec<Value>>,
    owner_sid: &str,
    policy_version: u64,
    resolver: &PrincipalResolver,
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    converge_descendants: bool,
) -> Result<Vec<Value>, AclApplyFailure> {
    apply_tier_subtrees_with_checkpoint(
        managed_root,
        scope,
        subtrees,
        owner_sid,
        policy_version,
        resolver,
        snapshot,
        converge_descendants,
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_tier_subtrees_with_checkpoint(
    managed_root: &Path,
    scope: &str,
    subtrees: Option<&Vec<Value>>,
    owner_sid: &str,
    policy_version: u64,
    resolver: &PrincipalResolver,
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    converge_descendants: bool,
    checkpoints: &[String],
) -> Result<Vec<Value>, AclApplyFailure> {
    let mut seen: Vec<&str> = Vec::new();
    let mut observations = Vec::new();
    for subtree in subtrees.into_iter().flatten() {
        let tier = subtree
            .get("tier")
            .and_then(Value::as_str)
            .ok_or_else(|| AclApplyFailure::PlanShapeInvalid("tier missing".to_owned()))?;
        require_first_mention(&mut seen, tier, "tier")?;
        require_single_path_segment(tier, "tier")?;
        let expected = managed_root_tier_expectation(scope, tier)
            .map_err(|error| AclApplyFailure::DescriptorNotTheShippedPolicy(error.to_string()))?;
        let required = plan_required(subtree, "a tier subtree")?;
        require_shipped_descriptor(
            &format!("{scope} tier subtree {tier}"),
            required,
            &expected,
            owner_sid,
            policy_version,
        )?;

        let path = managed_root.join(tier);
        require_inside_root(&path, managed_root)?;
        require_creatable_chain(&path)?;
        std::fs::create_dir_all(&path)
            .map_err(|error| AclApplyFailure::Win32PermissionDenied(error.to_string()))?;
        // The measured reparse state is dropped rather than reported: C3's tier-subtree observation has no
        // `is_reparse_point` member and this slice does not change a contract shape. The guard still ran -
        // a junction anywhere on this path is refused here exactly as it is on a managed root - so what is
        // discarded is a value that is only ever `false`, not a check.
        let (_, security) = apply_object(
            &path,
            &expected,
            owner_sid,
            ObjectOwnership::OwnedByAdministrators,
            resolver,
        )?;
        // Record the tier root for revoke, as in `apply_workspace_roots`.
        record_applied_path(snapshot, &path)?;
        // Tier processes may have written descendants under this subtree before revoke. Revoke leaves
        // those objects with the previous tier account's ACL, so convergence repairs them before restart.
        // Convergence repairs the retained objects before the replacement tier account starts.
        if converge_descendants {
            let prefix = format!("{scope}\u{1f}{tier}\u{1f}");
            let checkpoint = checkpoints
                .iter()
                .find_map(|checkpoint| checkpoint.strip_prefix(&prefix));
            let targets =
                startup_convergence_targets_with_checkpoint(managed_root, scope, tier, checkpoint)?;
            let stats = converge_stale_startup_targets(
                &targets.paths,
                targets.collection_skips,
                &expected,
                &targets.expected_kinds,
                resolver,
            )?;
            observations.push(json!({
                "tier": tier,
                "present": true,
                "security": security,
                "convergence": {
                    "visited": stats.visited,
                    "repaired": stats.repaired,
                    "skipped": stats.skipped,
                    "duration_ms": stats.duration_ms,
                    "skipped_entries": stats.skipped_entries,
                    "skipped_entries_truncated": stats.skipped_entries_truncated,
                    "retryable_skips": stats.retryable_skips,
                    "coverage_bound_exceeded": stats.coverage_bound_exceeded,
                    "resume_after": stats.last_processed_path.map(|path| {
                        format!("{scope}\u{1f}{tier}\u{1f}{path}")
                    }),
                },
            }));
            continue;
        }
        observations.push(json!({
            "tier": tier,
            "present": true,
            "security": security,
        }));
    }
    Ok(observations)
}

type StartupConvergenceRow = (
    &'static str,
    &'static str,
    &'static [&'static str],
    Option<&'static str>,
);

/// What startup convergence repairs under each `(scope, tier)` subtree: exact targets relative to the
/// tier root, then the directory relative to the tier root (`""` for the tier root itself) whose
/// descendants are walked. A tier of `"*"` matches every tier; an unlisted pair converges nothing.
///
/// Its fingerprint is part of the broker's convergence record and of the client's provision marker
/// (`_STARTUP_CONVERGENCE_FINGERPRINT` in `sandbox_manager/broker_client/markers.py`), so changing a
/// row repairs retained state on an update that keeps the tier SIDs (#3846).
const STARTUP_CONVERGENCE_TARGETS: &[StartupConvergenceRow] = &[
    (
        "config_root",
        "bootstrap",
        &["runtime-generations"],
        Some("runtime-generations"),
    ),
    (
        "data_root",
        "bootstrap",
        &[
            "runtime",
            "runtime/runtime-instance-evidence.json",
            "openwork-orchestrator",
        ],
        Some("openwork-orchestrator"),
    ),
    (
        "config_root",
        "file_tool",
        &["superclaw/connector-client.json"],
        None,
    ),
    (
        "config_root",
        "network_connector",
        &["superclaw/connector-provider.json"],
        None,
    ),
    // The file-tool runtime owns all of this subtree, including its HOME, cache and state
    // directories. Keep this walk scoped to file_tool rather than the complete data root.
    ("data_root", "file_tool", &[], Some("")),
    // The connector may retain startup state beside its owner-written module, so its complete
    // tier-owned data subtree is converged.
    ("data_root", "network_connector", &[], Some("")),
    // The router reopens its database and log under opencode-router on every start. The
    // inbox and outbox beside it are cross-tier openings with their own descriptors.
    (
        "data_root",
        "channel",
        &["opencode-router"],
        Some("opencode-router"),
    ),
    (
        "logs_root",
        "network_connector",
        &["connector-audit.jsonl", "proxy-audit.jsonl"],
        None,
    ),
    // Bootstrap and file-tool logs are broker-owned per-launch artifacts. The broker creates each
    // file with CREATE_NEW and passes its append-only handle to the tier; the tier never reopens
    // an existing log, so a file carrying a retired tier SID cannot affect a later launch.
    // The broker owns per-tier process logs. Temp is different: every catalog role receives its
    // own temp root, so converge that tier-scoped subtree without walking the managed root.
    ("temp_root", "*", &[], Some("")),
];

/// The lowercase sha256 hex of [`STARTUP_CONVERGENCE_TARGETS`] as JSON.
pub(super) fn startup_convergence_fingerprint() -> String {
    let table = serde_json::to_vec(STARTUP_CONVERGENCE_TARGETS)
        .expect("a table of string literals serializes");
    hex::encode(Sha256::digest(table))
}

#[cfg(test)]
pub(super) fn startup_convergence_targets(
    managed_root: &Path,
    scope: &str,
    tier: &str,
) -> Result<StartupConvergenceTargets, AclApplyFailure> {
    startup_convergence_targets_with_checkpoint(managed_root, scope, tier, None)
}

pub(super) fn startup_convergence_targets_with_checkpoint(
    managed_root: &Path,
    scope: &str,
    tier: &str,
    resume_after: Option<&str>,
) -> Result<StartupConvergenceTargets, AclApplyFailure> {
    require_single_path_segment(tier, "tier")?;
    let tier_root = managed_root.join(tier);
    let (relatives, walk_root) = STARTUP_CONVERGENCE_TARGETS
        .iter()
        .find(|(entry_scope, entry_tier, _, _)| {
            *entry_scope == scope && (*entry_tier == tier || *entry_tier == "*")
        })
        .map_or((&[][..], None), |(_, _, relatives, walk_root)| {
            (*relatives, *walk_root)
        });
    let mut targets: Vec<PathBuf> = relatives.iter().map(|path| tier_root.join(path)).collect();
    let expected_kinds = relatives
        .iter()
        .map(|relative| {
            (
                tier_root.join(relative),
                matches!(
                    *relative,
                    "runtime-generations" | "runtime" | "openwork-orchestrator" | "opencode-router"
                ),
            )
        })
        .collect();
    let mut collection_skips = Vec::new();
    let mut collected = targets.len();
    if let Some(walk_root) = walk_root {
        // `join("")` would append a trailing separator to the reported walk root.
        let walk_root = if walk_root.is_empty() {
            tier_root.clone()
        } else {
            tier_root.join(walk_root)
        };
        collect_descendants_without_reparse_traversal(
            &walk_root,
            &mut targets,
            &[],
            &mut collection_skips,
            &mut collected,
            resume_after,
            STALE_DESCENDANT_WALK_LIMIT,
        )?;
    }
    if let Some(resume_after) = resume_after {
        let checkpoint = Path::new(resume_after);
        targets.retain(|path| path.as_path() > checkpoint);
    }

    Ok(StartupConvergenceTargets {
        paths: targets,
        collection_skips,
        expected_kinds,
    })
}

pub(super) struct StartupConvergenceTargets {
    pub paths: Vec<PathBuf>,
    pub collection_skips: Vec<Value>,
    pub expected_kinds: Vec<(PathBuf, bool)>,
}

pub(super) fn collect_descendants_without_reparse_traversal(
    root: &Path,
    targets: &mut Vec<PathBuf>,
    excluded_directory_names: &[&str],
    collection_skips: &mut Vec<Value>,
    collected: &mut usize,
    resume_after: Option<&str>,
    walk_limit: usize,
) -> Result<(), AclApplyFailure> {
    if collection_skips
        .iter()
        .any(|entry| entry.get("reason").and_then(Value::as_str) == Some("coverage_bound_exceeded"))
    {
        return Ok(());
    }
    match measure_reparse_state(root) {
        Ok(_) => {}
        Err(ManagedPathRefusal::Unreadable {
            kind: UnreadableKind::NotFound,
            ..
        }) => return Ok(()),
        Err(refusal) => {
            collection_skips.push(json!({
                "path": root.to_string_lossy(),
                "reason": refusal.code(),
            }));
            return Ok(());
        }
    }
    // Walk depth-first in lexical order, but add a directory only after its whole enumerated
    // subtree. The checkpoint is the last processed target, so a parent must not be able to
    // advance past a child directory whose walk stopped at the coverage bound.
    let read_entries = |directory: &Path,
                        collection_skips: &mut Vec<Value>,
                        resume_after: Option<&str>,
                        capacity: usize| {
        let directory_entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
            Err(_) => {
                collection_skips.push(json!({
                    "path": directory.to_string_lossy(),
                    "reason": "startup_target_enumeration_failed",
                }));
                return None;
            }
        };
        let mut entries = BTreeSet::new();
        let mut over_capacity = false;
        for entry_result in directory_entries {
            match entry_result {
                Ok(entry) => {
                    let path = entry.path();
                    if let Some(resume_after) = resume_after {
                        let checkpoint = Path::new(resume_after);
                        let is_strict_ancestor =
                            checkpoint != path.as_path() && checkpoint.starts_with(&path);
                        if path.as_path() <= checkpoint && !is_strict_ancestor {
                            continue;
                        }
                    }
                    if capacity == 0 {
                        over_capacity = true;
                    } else {
                        entries.insert(path);
                        if entries.len() > capacity {
                            entries.pop_last();
                            over_capacity = true;
                        }
                    }
                }
                Err(_) => collection_skips.push(json!({
                    "path": directory.to_string_lossy(),
                    "reason": "startup_target_entry_read_failed",
                })),
            }
        }
        Some((entries.into_iter().collect::<Vec<_>>(), over_capacity))
    };
    let capacity = walk_limit.saturating_sub(*collected);
    let Some((root_entries, root_bound_hit)) =
        read_entries(root, collection_skips, resume_after, capacity)
    else {
        return Ok(());
    };
    let mut pending = vec![(root.to_owned(), root_entries, 0usize, true, root_bound_hit)];
    loop {
        let Some(frame_index) = pending.len().checked_sub(1) else {
            break;
        };
        if pending[frame_index].2 == pending[frame_index].1.len() {
            let (completed_directory, _, _, is_root, bound_hit) =
                pending.pop().expect("frame index was present");
            if !is_root && !bound_hit {
                targets.push(completed_directory);
            }
            if bound_hit {
                collection_skips.push(json!({
                    "path": root.to_string_lossy(),
                    "reason": "coverage_bound_exceeded",
                }));
                return Ok(());
            }
            continue;
        }
        let path = {
            let frame = &mut pending[frame_index];
            let path = frame.1[frame.2].clone();
            frame.2 += 1;
            path
        };
        let is_resume_ancestor = resume_after.is_some_and(|resume_after| {
            let checkpoint = Path::new(resume_after);
            checkpoint != path.as_path() && checkpoint.starts_with(&path)
        });
        if !is_resume_ancestor {
            *collected += 1;
            if *collected > walk_limit {
                collection_skips.push(json!({
                    "path": root.to_string_lossy(),
                    "reason": "coverage_bound_exceeded",
                }));
                return Ok(());
            }
        }
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                collection_skips.push(json!({
                    "path": path.to_string_lossy(),
                    "reason": "startup_target_metadata_failed",
                }));
                continue;
            }
        };
        let name = path.file_name().unwrap_or_default();
        if metadata.is_dir()
            && excluded_directory_names
                .iter()
                .any(|excluded| name.to_string_lossy().eq_ignore_ascii_case(excluded))
        {
            continue;
        }
        if metadata.is_dir() {
            match measure_reparse_state(&path) {
                Ok(_) => {
                    let capacity = walk_limit.saturating_sub(*collected);
                    if let Some((child_entries, child_bound_hit)) =
                        read_entries(&path, collection_skips, resume_after, capacity)
                    {
                        pending.push((path, child_entries, 0, false, child_bound_hit));
                    }
                }
                Err(ManagedPathRefusal::Unreadable {
                    kind: UnreadableKind::NotFound,
                    ..
                }) => {}
                Err(refusal) => {
                    collection_skips.push(json!({
                        "path": path.to_string_lossy(),
                        "reason": refusal.code(),
                    }));
                }
            }
        } else {
            targets.push(path);
        }
    }
    Ok(())
}

pub(super) fn converge_stale_startup_targets(
    targets: &[PathBuf],
    collection_skips: Vec<Value>,
    expected: &ExpectedDacl,
    expected_kinds: &[(PathBuf, bool)],
    resolver: &PrincipalResolver,
) -> Result<ConvergenceStats, AclApplyFailure> {
    if targets.len() > STALE_DESCENDANT_WALK_LIMIT {
        let path = targets
            .last()
            .map(|target| target.to_string_lossy().into_owned())
            .unwrap_or_else(|| "<convergence-targets>".to_owned());
        return Ok(ConvergenceStats {
            visited: 0,
            repaired: 0,
            skipped: 1,
            duration_ms: 0,
            skipped_entries: vec![json!({
                "path": path,
                "reason": "coverage_bound_exceeded",
            })],
            skipped_entries_truncated: false,
            retryable_skips: 0,
            coverage_bound_exceeded: true,
            last_processed_path: None,
        });
    }
    let expected = &inherited_by_descendants(expected);
    let started = Instant::now();
    let mut visited = 0usize;
    let mut repaired = 0usize;
    let mut skipped = collection_skips.len();
    let mut retryable_skips = collection_skips
        .iter()
        .filter_map(|entry| entry.get("reason").and_then(Value::as_str))
        .filter(|reason| *reason != "coverage_bound_exceeded" && !is_structural_skip_reason(reason))
        .count();
    let mut skipped_entries = collection_skips;
    let coverage_bound_hit = skipped_entries.iter().any(|entry| {
        entry.get("reason").and_then(Value::as_str) == Some("coverage_bound_exceeded")
    });
    let mut skipped_entries_truncated = skipped_entries.len() > MAX_REPORTED_SKIPS;
    skipped_entries.truncate(MAX_REPORTED_SKIPS);
    let mut last_processed_path = None;

    for path in targets {
        last_processed_path = Some(path.to_string_lossy().into_owned());
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                record_skip(
                    path,
                    "startup_target_unavailable",
                    &mut skipped,
                    &mut skipped_entries,
                    &mut skipped_entries_truncated,
                    &mut retryable_skips,
                );
                continue;
            }
        };
        visited += 1;
        if let Some((_, expected_is_directory)) =
            expected_kinds.iter().find(|(target, _)| target == path)
        {
            if metadata.is_dir() != *expected_is_directory {
                record_skip(
                    path,
                    "startup_target_kind_mismatch",
                    &mut skipped,
                    &mut skipped_entries,
                    &mut skipped_entries_truncated,
                    &mut retryable_skips,
                );
                continue;
            }
        }
        match measure_reparse_state(path) {
            Ok(_) => {}
            Err(ManagedPathRefusal::Unreadable {
                kind: UnreadableKind::NotFound,
                ..
            }) => continue,
            Err(refusal) => {
                record_skip(
                    path,
                    refusal.code(),
                    &mut skipped,
                    &mut skipped_entries,
                    &mut skipped_entries_truncated,
                    &mut retryable_skips,
                );
                continue;
            }
        }
        match apply_expected_to_descendant(path, metadata.is_dir(), expected, resolver) {
            Ok(AclApplyOutcome::Applied) => repaired += 1,
            Ok(AclApplyOutcome::AlreadyConverged) | Err(AclWriteFailure::ObjectMissing) => {}
            Err(AclWriteFailure::MultiplyLinked) => record_skip(
                path,
                "multiply_linked",
                &mut skipped,
                &mut skipped_entries,
                &mut skipped_entries_truncated,
                &mut retryable_skips,
            ),
            Err(AclWriteFailure::ObjectNotOwnedByOwner(_)) => record_skip(
                path,
                "owner_mismatch",
                &mut skipped,
                &mut skipped_entries,
                &mut skipped_entries_truncated,
                &mut retryable_skips,
            ),
            Err(AclWriteFailure::Io(error)) => {
                let reason = if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) {
                    "sharing_violation"
                } else {
                    "acl_write_failed"
                };
                record_skip(
                    path,
                    reason,
                    &mut skipped,
                    &mut skipped_entries,
                    &mut skipped_entries_truncated,
                    &mut retryable_skips,
                );
            }
        }
    }

    let resume_after = coverage_bound_hit.then_some(last_processed_path).flatten();
    Ok(ConvergenceStats {
        visited,
        repaired,
        skipped,
        duration_ms: started.elapsed().as_millis() as u64,
        skipped_entries,
        skipped_entries_truncated,
        retryable_skips,
        coverage_bound_exceeded: coverage_bound_hit,
        last_processed_path: resume_after,
    })
}

fn record_skip(
    path: &Path,
    reason: &str,
    skipped: &mut usize,
    entries: &mut Vec<Value>,
    truncated: &mut bool,
    retryable_skips: &mut usize,
) {
    *skipped += 1;
    if !is_structural_skip_reason(reason) && reason != "coverage_bound_exceeded" {
        *retryable_skips += 1;
    }
    if entries.len() < MAX_REPORTED_SKIPS {
        entries.push(json!({
            "path": path.to_string_lossy(),
            "reason": reason,
        }));
    } else {
        *truncated = true;
    }
}

fn is_structural_skip_reason(reason: &str) -> bool {
    matches!(
        reason,
        "multiply_linked"
            | "managed_path_not_absolute"
            | "managed_path_too_deep"
            | "managed_path_component_not_normal"
            | "managed_path_object_type"
            | "managed_path_reparse_point"
            | "managed_path_identity_mismatch"
    ) || reason.contains("reparse")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ConvergenceStats {
    pub visited: usize,
    pub repaired: usize,
    pub skipped: usize,
    pub duration_ms: u64,
    pub skipped_entries: Vec<Value>,
    pub skipped_entries_truncated: bool,
    pub retryable_skips: usize,
    pub coverage_bound_exceeded: bool,
    pub last_processed_path: Option<String>,
}

/// The descriptor a child of an object carrying `expected` inherits: `this_object_only` ACEs are not
/// inherited, and `children_only` ACEs apply to the child itself and keep propagating below it.
pub(super) fn inherited_by_descendants(expected: &ExpectedDacl) -> ExpectedDacl {
    let propagates = (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8;
    let inherit_only = INHERIT_ONLY_ACE as u8;
    ExpectedDacl {
        protected: false,
        aces: expected
            .aces
            .iter()
            .filter(|ace| ace.flags & propagates != 0)
            .map(|ace| ExpectedAce {
                flags: ace.flags & !inherit_only,
                ..ace.clone()
            })
            .collect(),
    }
}
