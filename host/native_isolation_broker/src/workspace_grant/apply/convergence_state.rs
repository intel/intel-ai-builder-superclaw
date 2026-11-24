use super::super::AclApplyFailure;
use super::tier_subtrees::startup_convergence_fingerprint;
use crate::grant_store::{
    ConvergedTierState, ConvergenceSkipState, WorkspaceAuthorizationSnapshot,
};
use serde_json::Value;
use std::path::Path;

#[cfg(test)]
pub(super) fn convergence_has_skips(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(convergence_has_skips),
        Value::Object(object) => {
            if object
                .get("convergence")
                .and_then(Value::as_object)
                .and_then(|convergence| convergence.get("skipped"))
                .and_then(Value::as_u64)
                .is_some_and(|skipped| skipped > 0)
            {
                return true;
            }
            object.values().any(convergence_has_skips)
        }
        _ => false,
    }
}

/// Whether the targeted startup convergence pass needs to run.
pub(super) fn descendants_need_converging(
    converged: Option<&ConvergedTierState>,
    current_policy_version: u64,
    current_sids: &[String],
    current_paths: &[String],
) -> bool {
    match converged {
        Some(state)
            if state.policy_version == current_policy_version
                && walked_this_target_table(state)
                && state.tier_account_sids == current_sids
                && current_paths.iter().all(|path| state.paths.contains(path))
                && state.paths == current_paths
                && state.resume_after.is_none()
                && state.checkpoints.is_empty()
                && state.skip_state.retryable == 0
                && !state.skip_state.coverage_bound_exceeded =>
        {
            false
        }
        _ => true,
    }
}

pub(super) fn can_reuse_convergence_checkpoints(
    state: &ConvergedTierState,
    current_policy_version: u64,
    current_sids: &[String],
    current_paths: &[String],
) -> bool {
    state.policy_version == current_policy_version
        && walked_this_target_table(state)
        && state.tier_account_sids == current_sids
        && state.paths == current_paths
        && state.skip_state.retryable == 0
}

fn walked_this_target_table(state: &ConvergedTierState) -> bool {
    state.targets_fingerprint.as_deref() == Some(startup_convergence_fingerprint().as_str())
}

pub(super) fn take_convergence_state(
    value: &mut Value,
) -> (Vec<String>, ConvergenceSkipState) {
    fn visit(
        value: &mut Value,
        checkpoints: &mut Vec<String>,
        skip_state: &mut ConvergenceSkipState,
    ) {
        match value {
            Value::Array(values) => {
                for value in values {
                    visit(value, checkpoints, skip_state);
                }
            }
            Value::Object(object) => {
                let exact_retryable_skips = object
                    .get("retryable_skips")
                    .and_then(Value::as_u64);
                if let Some(count) = exact_retryable_skips {
                    skip_state.retryable += count;
                }
                if let Some(checkpoint) = object
                    .remove("resume_after")
                    .and_then(|value| value.as_str().map(str::to_owned))
                {
                    if !checkpoints.contains(&checkpoint) {
                        checkpoints.push(checkpoint);
                    }
                }
                if let Some(entries) = object
                    .get("skipped_entries")
                    .and_then(Value::as_array)
                {
                    for entry in entries {
                        let reason = entry.get("reason").and_then(Value::as_str).unwrap_or("");
                        if reason == "coverage_bound_exceeded" {
                            skip_state.coverage_bound_exceeded = true;
                        } else if is_structural_skip_reason(reason) {
                            skip_state.structural += 1;
                        } else if exact_retryable_skips.is_none() {
                            skip_state.retryable += 1;
                        }
                    }
                }
                if object
                    .get("skipped_entries_truncated")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    // Truncation only limits diagnostic detail; it is not evidence that a hidden
                    // entry is retryable. The individual visible reasons above remain authoritative.
                    skip_state.structural += 1;
                }
                for value in object.values_mut() {
                    visit(value, checkpoints, skip_state);
                }
            }
            _ => {}
        }
    }
    let mut checkpoints = Vec::new();
    let mut skip_state = ConvergenceSkipState::default();
    visit(value, &mut checkpoints, &mut skip_state);
    (checkpoints, skip_state)
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

pub(super) fn planned_descendant_paths(
    managed_plans: &[Value],
    snapshot: &WorkspaceAuthorizationSnapshot,
) -> Result<Vec<String>, AclApplyFailure> {
    let mut paths = Vec::new();
    for managed_plan in managed_plans {
        let scope = managed_plan
            .get("managed_root_scope")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AclApplyFailure::PlanShapeInvalid("managed_root_scope missing".to_owned())
            })?;
        let Some(root) = snapshot.managed_roots.get(scope) else {
            continue;
        };
        let subtrees = managed_plan
            .get("tier_subtrees")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                AclApplyFailure::PlanShapeInvalid(
                    "a managed root plan must carry a tier_subtrees array".to_owned(),
                )
            })?;
        for subtree in subtrees {
            let tier = subtree
                .get("tier")
                .and_then(Value::as_str)
                .ok_or_else(|| AclApplyFailure::PlanShapeInvalid("tier missing".to_owned()))?;
            super::require_single_path_segment(tier, "tier")?;
            paths.push(Path::new(root).join(tier).to_string_lossy().into_owned());
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}
