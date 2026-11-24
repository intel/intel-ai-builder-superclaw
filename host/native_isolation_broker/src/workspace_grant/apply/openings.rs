//! Applying the descriptor-declared openings below a managed root's tier subtrees: directories another
//! tier is let into. Each is looked up in the shipped descriptor by scope, tier and relative path, so a plan
//! chooses neither a tier nor a directory.

use super::{
    apply_object, plan_required, record_applied_path, require_creatable_chain, require_inside_root,
    require_relative_path_stays_inside_root, require_shipped_descriptor,
    require_single_path_segment,
};
use crate::acl_descriptor::managed_root_opening_expectation;
use crate::acl_policy_apply::{ObjectOwnership, PrincipalResolver};
use crate::grant_store::WorkspaceAuthorizationSnapshot;
use crate::workspace_grant::AclApplyFailure;
use serde_json::{json, Value};
use std::path::Path;

/// The openings one managed root plan names below its tier subtrees, each looked up in the shipped
/// descriptor by scope, tier and relative path, so a plan cannot ask for a directory another tier is let
/// into that the policy does not declare.
///
/// An opening is a directory below a tier subtree that this side has already applied in the same plan, so
/// it is created here when absent and owned by `Administrators`, as everything this side creates is. Its
/// DACL is protected and names both tiers, which is what lets a second tier in without opening the
/// subtree around it.
#[allow(clippy::too_many_arguments)]
pub(super) fn apply_tier_openings(
    managed_root: &Path,
    scope: &str,
    openings: Option<&Vec<Value>>,
    owner_sid: &str,
    policy_version: u64,
    resolver: &PrincipalResolver,
    snapshot: &mut WorkspaceAuthorizationSnapshot,
) -> Result<Vec<Value>, AclApplyFailure> {
    let mut seen: Vec<String> = Vec::new();
    let mut observations = Vec::new();
    for opening in openings.into_iter().flatten() {
        let tier = opening
            .get("tier")
            .and_then(Value::as_str)
            .ok_or_else(|| AclApplyFailure::PlanShapeInvalid("opening tier missing".to_owned()))?;
        let relative = opening
            .get("relative_path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AclApplyFailure::PlanShapeInvalid("opening relative_path missing".to_owned())
            })?;
        require_single_path_segment(tier, "tier")?;
        require_relative_path_stays_inside_root(relative)?;
        let key = format!("{tier}/{relative}");
        if seen.contains(&key) {
            return Err(AclApplyFailure::PlanShapeInvalid(format!(
                "opening {key} appears more than once in the plan"
            )));
        }
        seen.push(key);
        let expected = managed_root_opening_expectation(scope, tier, relative)
            .map_err(|error| AclApplyFailure::DescriptorNotTheShippedPolicy(error.to_string()))?;
        let required = plan_required(opening, "a tier opening")?;
        require_shipped_descriptor(
            &format!("{scope} tier opening {tier}/{relative}"),
            required,
            &expected,
            owner_sid,
            policy_version,
        )?;

        let tier_root = managed_root.join(tier);
        let path = tier_root.join(relative);
        require_inside_root(&path, &tier_root)?;
        require_creatable_chain(&path)?;
        std::fs::create_dir_all(&path)
            .map_err(|error| AclApplyFailure::Win32PermissionDenied(error.to_string()))?;
        let (_, security) = apply_object(
            &path,
            &expected,
            owner_sid,
            ObjectOwnership::OwnedByAdministrators,
            resolver,
        )?;
        record_applied_path(snapshot, &path)?;
        observations.push(json!({
            "tier": tier,
            "relative_path": relative,
            "present": true,
            "security": security,
        }));
    }
    Ok(observations)
}
