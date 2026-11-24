//! Applying descriptor-declared placeholder directories under workspace roots.

use super::{
    apply_object, plan_required, record_applied_path, require_first_mention, require_inside_root,
    require_relative_path_stays_inside_root, require_shipped_descriptor,
};
use crate::acl_descriptor::{workspace_placeholder_expectation, ExpectedPlaceholder};
use crate::acl_policy_apply::{ObjectOwnership, PrincipalResolver};
use crate::grant_store::WorkspaceAuthorizationSnapshot;
use crate::workspace_grant::AclApplyFailure;
use serde_json::{json, Value};
use std::path::Path;

/// The protected placeholders one workspace root plan names, each looked up in the shipped descriptor.
///
/// The relative path is a key into the descriptor, not a path the plan gets to choose: a plan naming a
/// placeholder the descriptor does not declare is refused rather than having a protected descriptor written
/// at an arbitrary relative path under the root. `placeholder_kind` is checked for the same reason the
/// object type is checked everywhere else - a directory is the only kind of placeholder this side knows how
/// to make, so a plan asking for another kind is asking for something that would be silently mistranslated.
///
/// These directories are created here when they are absent, so ownership is written rather than required:
/// they are inside a root that has already been authorized and their names come from the descriptor, so
/// there is nothing left for a caller to choose, and a freshly created one is owned by the elevated token
/// anyway, so requiring owner ownership would refuse the object this side had just made. The owner written
/// is `Administrators`, as it is for everything this side creates; every placeholder descriptor grants
/// `host_user` `WRITE_DAC` outright, so the owner is not what gives the owner access to its own workspace.
#[allow(clippy::too_many_arguments)]
pub(super) fn apply_workspace_placeholders(
    root: &Path,
    policy_class: &str,
    placeholders: Option<&Vec<Value>>,
    owner_sid: &str,
    policy_version: u64,
    resolver: &PrincipalResolver,
    snapshot: &mut WorkspaceAuthorizationSnapshot,
) -> Result<Vec<Value>, AclApplyFailure> {
    let mut seen: Vec<&str> = Vec::new();
    let mut observations = Vec::new();
    for placeholder in placeholders.into_iter().flatten() {
        let relative = placeholder
            .get("relative_path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AclApplyFailure::PlanShapeInvalid("placeholder relative_path missing".to_owned())
            })?;
        require_first_mention(&mut seen, relative, "placeholder relative_path")?;
        require_relative_path_stays_inside_root(relative)?;
        require_placeholder_kind(placeholder)?;
        let ExpectedPlaceholder { role, dacl, .. } =
            workspace_placeholder_expectation(policy_class, relative).map_err(|error| {
                AclApplyFailure::DescriptorNotTheShippedPolicy(error.to_string())
            })?;
        let required = plan_required(placeholder, "a placeholder")?;
        require_shipped_descriptor(
            &format!("placeholder {relative}"),
            required,
            &dacl,
            owner_sid,
            policy_version,
        )?;

        let path = root.join(relative);
        require_inside_root(&path, root)?;
        super::require_creatable_chain(&path)?;
        std::fs::create_dir_all(&path)
            .map_err(|error| AclApplyFailure::Win32PermissionDenied(error.to_string()))?;
        let (is_reparse_point, security) = apply_object(
            &path,
            &dacl,
            owner_sid,
            ObjectOwnership::OwnedByAdministrators,
            resolver,
        )?;
        // After the apply, for the reason given in `apply_workspace_roots`. A placeholder is a path this
        // side composed from a descriptor-declared name, so the arbitrary-path risk is not what is at stake
        // here; the ordering is uniform so that reading any one of these four call sites teaches the rule.
        record_applied_path(snapshot, &path)?;
        let is_empty = std::fs::read_dir(&path)
            .map(|mut dir| dir.next().is_none())
            .unwrap_or(false);
        observations.push(json!({
            "relative_path": relative,
            "present": true,
            "is_reparse_point": is_reparse_point,
            "is_empty": role == "protected_mask" && is_empty,
            "security": security,
        }));
    }
    Ok(observations)
}

/// A placeholder must be the one object kind this side creates.
pub(super) fn require_placeholder_kind(placeholder: &Value) -> Result<(), AclApplyFailure> {
    match placeholder.get("placeholder_kind").and_then(Value::as_str) {
        Some("empty_directory") => Ok(()),
        Some(other) => Err(AclApplyFailure::PlanShapeInvalid(format!(
            "placeholder_kind {other} is not a kind this side creates"
        ))),
        None => Err(AclApplyFailure::PlanShapeInvalid(
            "a placeholder carries no placeholder_kind".to_owned(),
        )),
    }
}
