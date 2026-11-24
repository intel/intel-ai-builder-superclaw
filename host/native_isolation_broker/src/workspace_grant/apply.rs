//! Converging one ACL plan onto the objects it is allowed to name.
//!
//! Split from the authorization lifecycle in `super` because the two answer different questions. That
//! module records what an owner asked for and takes it back; this one decides, for every object a plan
//! names, whether this side is willing to write it and what it is willing to write. Only the second is a
//! privilege boundary, and it is long enough to be read on its own.

use super::AclApplyFailure;
use crate::acl_authorized_root::{managed_root_binding, path_is_within, RootBinding};
use crate::acl_descriptor::{
    expected_dacl_from_plan, managed_root_expectation, shipped_policy_version,
    workspace_root_expectation, ExpectedDacl,
};
use crate::acl_policy_apply::{
    apply_expected_and_observe, AclWriteFailure, ObjectOwnership, PrincipalResolver,
};
use crate::grant_store::{
    ensure_convergence_epoch, load_converged_tier_state, load_snapshot,
    save_converged_tier_state, save_snapshot,
    WorkspaceAuthorizationSnapshot,
};
use crate::managed_root_path::{measure_reparse_state, same_managed_path};
use crate::profile_ancestor_apply::ProfileAncestorFailure;
use crate::state;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

mod openings;
mod placeholders;
mod tier_subtrees;
mod convergence_state;
use openings::apply_tier_openings;
use placeholders::apply_workspace_placeholders;
#[cfg(test)]
use placeholders::require_placeholder_kind;
use tier_subtrees::apply_tier_subtrees_with_checkpoint;
#[cfg(test)]
use tier_subtrees::apply_tier_subtrees;
use convergence_state::{
    can_reuse_convergence_checkpoints, descendants_need_converging, planned_descendant_paths,
    take_convergence_state,
};
#[cfg(test)]
use convergence_state::convergence_has_skips;
#[cfg(test)]
use tier_subtrees::inherited_by_descendants;

/// Applies the ACL plan to every object it names and schedules targeted startup convergence.
///
/// The plan is read for *which* objects to converge and for its agreement with the shipped policy. Every
/// byte that becomes an ACE comes from `acl_descriptor`, every path is either derived here or required to
/// be an object the requesting owner already owns, and every write goes through a handle that has proved
/// which object it holds. A plan that disagrees with the shipped policy anywhere is refused whole: nothing
/// is applied for the entries that did agree, because a half-converged root set is the state the start-time
/// drift check would report as a failure anyway.
pub fn apply_acl_plan(
    owner_sid: &str,
    plan: &Value,
    coverage_limit: usize,
) -> Result<Value, AclApplyFailure> {
    if plan.get("contract_version").and_then(Value::as_u64) != Some(1) {
        return Err(AclApplyFailure::PlanShapeInvalid(
            "unsupported ACL plan contract_version".to_owned(),
        ));
    }
    let policy_version = shipped_policy_version()
        .map_err(|error| AclApplyFailure::PreconditionMissing(error.to_string()))?;
    if plan.get("policy_version").and_then(Value::as_u64) != Some(policy_version) {
        return Err(AclApplyFailure::DescriptorNotTheShippedPolicy(format!(
            "the plan is for a policy_version other than this build's {policy_version}"
        )));
    }

    let workspace_plans = plan
        .get("workspace_root_plans")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AclApplyFailure::PlanShapeInvalid("workspace_root_plans missing".to_owned())
        })?;
    let managed_plans = plan
        .get("managed_root_plans")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AclApplyFailure::PlanShapeInvalid("managed_root_plans missing".to_owned())
        })?;
    require_plan_collection_shapes(workspace_plans, managed_plans)?;
    for scope in crate::backend_ancestors::SCOPES {
        if managed_plans
            .iter()
            .filter(|plan| plan.get("managed_root_scope").and_then(Value::as_str) == Some(scope))
            .count()
            != 1
        {
            return Err(AclApplyFailure::PlanShapeInvalid(
                "the ACL plan must cover each backend ancestor exactly once".to_owned(),
            ));
        }
    }

    let object_count = count_planned_objects(workspace_plans, managed_plans);
    if object_count > coverage_limit {
        return Err(AclApplyFailure::CoverageBoundExceeded {
            planned: object_count,
            limit: coverage_limit,
        });
    }

    let mut snapshot = match load_snapshot(owner_sid) {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => return Err(AclApplyFailure::AuthorizationMissing),
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
            return Err(AclApplyFailure::PlanShapeInvalid(format!(
                "workspace authorization snapshot is corrupted: {error}"
            )));
        }
        Err(error) => return Err(AclApplyFailure::PreconditionMissing(error.to_string())),
    };

    let state_dir = state::default_state_dir()
        .map_err(|error| AclApplyFailure::PreconditionMissing(error.to_string()))?;
    let resolver = PrincipalResolver::for_owner(owner_sid, &state_dir)
        .map_err(|error| AclApplyFailure::PreconditionMissing(error.to_string()))?;
    let tier_account_sids = resolver.tier_account_sids();
    if !super::names_every_tier(&tier_account_sids) {
        return Err(AclApplyFailure::PreconditionMissing(
            "every tier identity must be provisioned before ACL apply".to_owned(),
        ));
    }
    let planned_descendant_paths = planned_descendant_paths(managed_plans, &snapshot)?;
    let convergence_epoch = ensure_convergence_epoch(owner_sid)
        .map_err(|error| AclApplyFailure::PreconditionMissing(error.to_string()))?;
    let previous_convergence = load_converged_tier_state(owner_sid);
    let retained_tier_state_exists = planned_descendant_paths
        .iter()
        .any(|path| std::fs::symlink_metadata(path).is_ok());
    let has_prior_tier_state = convergence_epoch > 0
        || previous_convergence.is_some()
        || !snapshot.tier_account_sids.is_empty()
        || retained_tier_state_exists;
    let converge_descendants = has_prior_tier_state
        && descendants_need_converging(
            previous_convergence.as_ref(),
            policy_version,
            &tier_account_sids,
            &planned_descendant_paths,
        );
    snapshot.tier_account_sids = tier_account_sids.clone();
    save_snapshot(&snapshot)
        .map_err(|error| AclApplyFailure::PreconditionMissing(error.to_string()))?;

    let checkpoints = previous_convergence
        .as_ref()
        .filter(|state| {
            // A retryable skip may be before the checkpoint. Restart the walk so that
            // completing a later chunk cannot silently forget to retry that object.
            can_reuse_convergence_checkpoints(
                state,
                policy_version,
                &tier_account_sids,
                &planned_descendant_paths,
            )
        })
        .map(|state| {
            let mut checkpoints = state.checkpoints.clone();
            if let Some(resume_after) = state.resume_after.clone() {
                checkpoints.push(resume_after);
            }
            checkpoints
        })
        .unwrap_or_default();
    let mut observations = converge_plan_with_checkpoint(
        owner_sid,
        workspace_plans,
        managed_plans,
        policy_version,
        &resolver,
        &mut snapshot,
        crate::tier_profile::profile_path_for,
        converge_descendants,
        &checkpoints,
    )?;
    // `resume_after` is an internal broker checkpoint. Remove it before returning the observation;
    // `retryable_skips` is public because marker invalidation must not infer retryability from a
    // truncated diagnostic list.
    let (checkpoints, skip_state) = take_convergence_state(&mut observations);
    if converge_descendants {
        // Record the attempted epoch even when the bounded descendant pass reports skips. New descendants
        // inherit the repaired tier-root DACL, and policy/SID/path/target-table changes invalidate this
        // marker. Best effort: failing to record costs another targeted pass.
        let _ = save_converged_tier_state(
            owner_sid,
            policy_version,
            &tier_account_sids,
            &planned_descendant_paths,
            None,
            checkpoints,
            skip_state,
            tier_subtrees::startup_convergence_fingerprint(),
        );
    }
    Ok(observations)
}

/// The writes, roots first. Profile ancestors go last so a plan refused on any workspace or managed
/// root leaves no ACE on the user's profile folders. The owner-profile binding is checked before
/// either, so refusing a backend in someone else's profile writes no root either.
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn converge_plan(
    owner_sid: &str,
    workspace_plans: &[Value],
    managed_plans: &[Value],
    policy_version: u64,
    resolver: &PrincipalResolver,
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    owner_profile: impl Fn(&str) -> io::Result<Option<String>>,
    converge_descendants: bool,
) -> Result<Value, AclApplyFailure> {
    converge_plan_with_checkpoint(
        owner_sid,
        workspace_plans,
        managed_plans,
        policy_version,
        resolver,
        snapshot,
        owner_profile,
        converge_descendants,
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
fn converge_plan_with_checkpoint(
    owner_sid: &str,
    workspace_plans: &[Value],
    managed_plans: &[Value],
    policy_version: u64,
    resolver: &PrincipalResolver,
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    owner_profile: impl Fn(&str) -> io::Result<Option<String>>,
    converge_descendants: bool,
    checkpoints: &[String],
) -> Result<Value, AclApplyFailure> {
    crate::profile_ancestor_apply::authorize_owner_profile(snapshot, &owner_profile)
        .map_err(ancestor_failure)?;
    let workspace_observations = apply_workspace_roots(
        owner_sid,
        workspace_plans,
        policy_version,
        resolver,
        snapshot,
    )?;
    let managed_observations = apply_managed_roots(
        owner_sid,
        managed_plans,
        policy_version,
        resolver,
        snapshot,
        converge_descendants,
        checkpoints,
    )?;
    crate::profile_ancestor_apply::apply_from_snapshot(
        snapshot,
        &owner_profile,
        |principal| resolver.resolve_principal(principal),
        save_snapshot,
    )
    .map_err(ancestor_failure)?;
    Ok(json!({
        "contract_version": 1,
        "descendant_convergence_required": converge_descendants,
        "workspace_root_observations": workspace_observations,
        "managed_root_observations": managed_observations,
    }))
}

fn ancestor_failure(failure: ProfileAncestorFailure) -> AclApplyFailure {
    match failure {
        ProfileAncestorFailure::NotOwnersProfile(detail) => {
            AclApplyFailure::RootNotAuthorized(detail)
        }
        ProfileAncestorFailure::Precondition(error) => {
            AclApplyFailure::PreconditionMissing(error.to_string())
        }
        ProfileAncestorFailure::Dacl(error) => {
            AclApplyFailure::Win32PermissionDenied(error.to_string())
        }
    }
}

/// Every workspace root the plan names, each authorized by the owner already owning it.
///
/// The root is converged before its placeholders, which is the opposite of the order this used to use and
/// matters: the placeholders are directories *this side creates*, and creating them under a root that
/// turns out not to be authorized would be an elevated write at a path the caller chose, performed before
/// anything checked whether the path was allowed.
fn apply_workspace_roots(
    owner_sid: &str,
    workspace_plans: &[Value],
    policy_version: u64,
    resolver: &PrincipalResolver,
    snapshot: &mut WorkspaceAuthorizationSnapshot,
) -> Result<Vec<Value>, AclApplyFailure> {
    let grants = workspace_root_grants(snapshot);
    let mut seen: Vec<&str> = Vec::new();
    let mut observations = Vec::new();
    for root_plan in workspace_plans {
        let root_id = root_plan
            .get("root_id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AclApplyFailure::PlanShapeInvalid("workspace root_id missing".to_owned())
            })?;
        require_first_mention(&mut seen, root_id, "root_id")?;
        let (path, policy_class) = grants.get(root_id).ok_or_else(|| {
            AclApplyFailure::RootNotAuthorized(format!(
                "workspace root_id {root_id} is not in this owner's authorization"
            ))
        })?;
        // The class comes from the recorded authorization rather than from the plan, because it selects
        // the descriptor. The plan has to agree with it, so a plan built for a different class is a
        // refusal here instead of a silently different DACL.
        require_matching_class(root_plan, policy_class)?;
        let expected = workspace_root_expectation(policy_class).map_err(|error| {
            AclApplyFailure::PlanShapeInvalid(format!(
                "the recorded policy_class {policy_class} is not in the shipped descriptor: {error}"
            ))
        })?;
        let required = plan_required(root_plan, "a workspace root")?;
        require_shipped_descriptor(
            &format!("workspace root {root_id}"),
            required,
            &expected,
            owner_sid,
            policy_version,
        )?;

        let (is_reparse_point, security) = apply_object(
            path,
            &expected,
            owner_sid,
            ObjectOwnership::OwnedByRequester,
            resolver,
        )?;
        // After the apply, never before. `applied_paths` is what an elevated `--revoke` later reopens for
        // `WRITE_DAC`, and the path in hand is one the caller named. Recorded first, a request refused by
        // `apply_object` would still leave a caller-chosen path in this owner's snapshot for a later elevated
        // run to write to; recorded here, every entry is a path this side has already authorized and written.
        record_applied_path(snapshot, path)?;
        let placeholders = apply_workspace_placeholders(
            path,
            policy_class,
            root_plan.get("placeholders").and_then(Value::as_array),
            owner_sid,
            policy_version,
            resolver,
            snapshot,
        )?;
        observations.push(json!({
            "root_id": root_id,
            "present": true,
            "is_reparse_point": is_reparse_point,
            "security": security,
            "placeholders": placeholders,
        }));
    }
    Ok(observations)
}

/// Every managed root the plan names, each authorized by `acl_authorized_root`'s two rules.
fn apply_managed_roots(
    owner_sid: &str,
    managed_plans: &[Value],
    policy_version: u64,
    resolver: &PrincipalResolver,
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    converge_descendants: bool,
    checkpoints: &[String],
) -> Result<Vec<Value>, AclApplyFailure> {
    let mut seen: Vec<&str> = Vec::new();
    let mut observations = Vec::new();
    let mut ordered: Vec<&Value> = managed_plans.iter().collect();
    ordered.sort_by_key(|plan| {
        crate::backend_ancestors::SCOPES
            .iter()
            .position(|scope| {
                plan.get("managed_root_scope").and_then(Value::as_str) == Some(*scope)
            })
            .unwrap_or(3)
    });
    for managed_plan in ordered {
        let scope = managed_plan
            .get("managed_root_scope")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AclApplyFailure::PlanShapeInvalid("managed_root_scope missing".to_owned())
            })?;
        require_first_mention(&mut seen, scope, "managed_root_scope")?;
        let expected = managed_root_expectation(scope).map_err(|error| {
            AclApplyFailure::PlanShapeInvalid(format!(
                "{scope} is not a managed root scope in the shipped descriptor: {error}"
            ))
        })?;
        let required = plan_required(managed_plan, "a managed root")?;
        require_shipped_descriptor(
            &format!("managed root {scope}"),
            required,
            &expected,
            owner_sid,
            policy_version,
        )?;
        let (managed_path, ownership) = authorized_managed_root_path(scope, owner_sid, snapshot)?;

        let (is_reparse_point, security) =
            apply_object(&managed_path, &expected, owner_sid, ownership, resolver)?;
        // After the apply, for the reason given in `apply_workspace_roots`.
        record_applied_path(snapshot, &managed_path)?;
        let tier_observations = apply_tier_subtrees_with_checkpoint(
            &managed_path,
            scope,
            managed_plan.get("tier_subtrees").and_then(Value::as_array),
            owner_sid,
            policy_version,
            resolver,
            snapshot,
            converge_descendants,
            checkpoints,
        )?;
        let opening_observations = apply_tier_openings(
            &managed_path,
            scope,
            managed_plan.get("tier_openings").and_then(Value::as_array),
            owner_sid,
            policy_version,
            resolver,
            snapshot,
        )?;
        observations.push(json!({
            "managed_root_scope": scope,
            "present": true,
            "is_reparse_point": is_reparse_point,
            "security": security,
            "tier_subtree_observations": tier_observations,
            "tier_opening_observations": opening_observations,
        }));
    }
    Ok(observations)
}

/// The path one managed root scope may be written at, and which principal ends up owning it.
///
/// The recorded authorization is still consulted for a derived scope, and the derived path still has to
/// match what it recorded. Ignoring the recorded path there would work, but then a client whose own
/// derivation had drifted from this one would converge the roots this side chose while believing it had
/// converged the roots it chose, and every later start would report drift on paths nobody had applied.
fn authorized_managed_root_path(
    scope: &str,
    owner_sid: &str,
    snapshot: &WorkspaceAuthorizationSnapshot,
) -> Result<(PathBuf, ObjectOwnership), AclApplyFailure> {
    let recorded = snapshot.managed_roots.get(scope).ok_or_else(|| {
        AclApplyFailure::RootNotAuthorized(format!(
            "managed root {scope} is not in this owner's authorization"
        ))
    })?;
    let recorded = PathBuf::from(recorded);
    let binding = managed_root_binding(scope, owner_sid)
        .map_err(|error| AclApplyFailure::PlanShapeInvalid(error.to_string()))?;
    let ownership = binding.ownership();
    match binding {
        RootBinding::Derived(derived) => {
            if !same_managed_path(&recorded, &derived) {
                return Err(AclApplyFailure::RootNotAuthorized(format!(
                    "managed root {scope} must be {} and not {}",
                    derived.display(),
                    recorded.display()
                )));
            }
            // Created here, unlike an owner-owned root, because this path is this side's own derivation
            // rather than a name the caller chose. The chain of whatever already exists is checked first so
            // a junction planted in `%ProgramData%` cannot make this create a directory somewhere else.
            require_creatable_chain(&derived)?;
            std::fs::create_dir_all(&derived)
                .map_err(|error| AclApplyFailure::PreconditionMissing(error.to_string()))?;
            // The ownership rule comes from the binding, not from here: `RootBinding::ownership` is where
            // the reason a derived root is owned by `Administrators` rather than by the requester is
            // written down.
            Ok((derived, ownership))
        }
        RootBinding::OwnerOwned => Ok((recorded, ownership)),
    }
}

/// One object's write: refuse its path, then apply the shipped descriptor through a single handle and read
/// the result back off that same handle.
///
/// The chain check comes first so a junction anywhere above the object is refused before an elevated
/// `WRITE_DAC` is opened on whatever it points at. It is a cheap early refusal and not the guarantee: the
/// handle `apply_expected_and_observe` opens proves its own identity, which is what closes the window
/// between checking a name and writing through it.
///
/// It returns the *measured* reparse state, which is how `is_reparse_point` got out of the observation JSON
/// as a hardcoded `false`. The value is always `false` when this returns - `measure_reparse_state` refuses a
/// reparse point rather than reporting one - and that is the difference between an observation that has
/// been checked and one that merely claims to have been.
fn apply_object(
    path: &Path,
    expected: &ExpectedDacl,
    owner_sid: &str,
    ownership: ObjectOwnership,
    resolver: &PrincipalResolver,
) -> Result<(bool, Value), AclApplyFailure> {
    let is_reparse_point = measure_reparse_state(path).map_err(AclApplyFailure::PathRefused)?;
    let (_, security) =
        apply_expected_and_observe(path, true, expected, owner_sid, ownership, resolver)
            .map_err(|failure| write_failure(path, failure))?;
    Ok((is_reparse_point, security))
}

fn write_failure(path: &Path, failure: AclWriteFailure) -> AclApplyFailure {
    match failure {
        AclWriteFailure::ObjectMissing => AclApplyFailure::RootNotAuthorized(format!(
            "{} does not exist, and this side does not create objects at paths a caller named",
            path.display()
        )),
        AclWriteFailure::ObjectNotOwnedByOwner(observed) => {
            AclApplyFailure::RootNotAuthorized(format!(
                "{} is owned by {} rather than by the requesting owner",
                path.display(),
                observed
                    .as_deref()
                    .unwrap_or("an owner this side could not read")
            ))
        }
        AclWriteFailure::MultiplyLinked => AclApplyFailure::Win32PermissionDenied(format!(
            "{} has more than one hard link, so its security descriptor is shared with a name this \
             side did not authorize",
            path.display()
        )),
        AclWriteFailure::Io(error) => AclApplyFailure::Win32PermissionDenied(error.to_string()),
    }
}

/// Refuses a child path that does not sit under the root it was joined onto.
///
/// The component checks on `relative_path` and `tier` already make an escaping join impossible, so this is
/// the invariant those checks exist to produce, stated where the join happens. It costs a string compare
/// and it means a future change to either check cannot quietly turn a name into a path outside the root.
fn require_inside_root(path: &Path, root: &Path) -> Result<(), AclApplyFailure> {
    if path_is_within(path, root) {
        Ok(())
    } else {
        Err(AclApplyFailure::PlanShapeInvalid(format!(
            "{} is not inside the authorized root {}",
            path.display(),
            root.display()
        )))
    }
}

/// Refuses a reparse point anywhere in the part of `path` that exists, before anything is created.
///
/// `verify_managed_path_chain` needs every component to exist, so it cannot answer this question about a
/// path that is about to be created. The components created below this point are created by this process,
/// and the apply that follows walks the whole chain again and holds a handle that proves its identity, so
/// this check only has to cover the part that was already there when the request arrived.
fn require_creatable_chain(path: &Path) -> Result<(), AclApplyFailure> {
    let mut existing = path;
    while !existing.exists() {
        match existing.parent() {
            Some(parent) => existing = parent,
            None => return Ok(()),
        }
    }
    measure_reparse_state(existing).map_err(AclApplyFailure::PathRefused)?;
    Ok(())
}

fn record_applied_path(
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    path: &Path,
) -> Result<(), AclApplyFailure> {
    let value = path.to_string_lossy().into_owned();
    if !snapshot.applied_paths.contains(&value) {
        snapshot.applied_paths.push(value);
        save_snapshot(snapshot)
            .map_err(|error| AclApplyFailure::PreconditionMissing(error.to_string()))?;
    }
    Ok(())
}

/// One plan entry's `required` block.
fn plan_required<'plan>(entry: &'plan Value, what: &str) -> Result<&'plan Value, AclApplyFailure> {
    entry
        .get("required")
        .ok_or_else(|| AclApplyFailure::PlanShapeInvalid(format!("{what} carries no required")))
}

/// The plan's descriptor for one object must be the shipped one, stamped with this owner and this build.
///
/// This is the check that makes the whole apply path safe, so it is worth being exact about what it does
/// *not* do: it does not decide what to write. The value written is `expected`, which came out of the
/// embedded descriptor, whether or not the plan agreed. Comparing is only how a caller finds out that the
/// policy it planned against is not the policy this build enforces, rather than having a descriptor it did
/// not ask for applied silently.
fn require_shipped_descriptor(
    what: &str,
    required: &Value,
    expected: &ExpectedDacl,
    owner_sid: &str,
    policy_version: u64,
) -> Result<(), AclApplyFailure> {
    require_owner_matches(required, owner_sid)?;
    if required.get("policy_version").and_then(Value::as_u64) != Some(policy_version) {
        return Err(AclApplyFailure::DescriptorNotTheShippedPolicy(format!(
            "{what} names a policy_version other than this build's {policy_version}"
        )));
    }
    let planned = expected_dacl_from_plan(required).map_err(|error| {
        AclApplyFailure::PlanShapeInvalid(format!(
            "{what} carries a descriptor this build cannot read: {error}"
        ))
    })?;
    if &planned != expected {
        return Err(AclApplyFailure::DescriptorNotTheShippedPolicy(format!(
            "{what} asks for a descriptor that is not the one this build ships"
        )));
    }
    Ok(())
}

/// The plan's `policy_class` for a workspace root must be the one the authorization recorded.
fn require_matching_class(root_plan: &Value, policy_class: &str) -> Result<(), AclApplyFailure> {
    match root_plan.get("policy_class").and_then(Value::as_str) {
        Some(value) if value == policy_class => Ok(()),
        Some(value) => Err(AclApplyFailure::DescriptorNotTheShippedPolicy(format!(
            "the plan asks for policy_class {value} on a root authorized as {policy_class}"
        ))),
        None => Err(AclApplyFailure::PlanShapeInvalid(
            "a workspace root plan carries no policy_class".to_owned(),
        )),
    }
}

/// Refuses a key a plan has already used.
///
/// A duplicate is not harmless even though the second apply of the same descriptor converges: the coverage
/// count is what bounds this work, and a plan that names one root a thousand times would pass a bound
/// meant to describe a thousand distinct objects.
fn require_first_mention<'plan>(
    seen: &mut Vec<&'plan str>,
    key: &'plan str,
    field: &str,
) -> Result<(), AclApplyFailure> {
    if seen.contains(&key) {
        return Err(AclApplyFailure::PlanShapeInvalid(format!(
            "{field} {key} appears more than once in the plan"
        )));
    }
    seen.push(key);
    Ok(())
}

/// The plan-supplied `required.owner_sid` must match the owner the caller authenticated as;
/// otherwise a plan crafted for one owner could apply/observe descriptors under another
/// owner's authorization.
fn require_owner_matches(required: &Value, owner_sid: &str) -> Result<(), AclApplyFailure> {
    match required.get("owner_sid").and_then(Value::as_str) {
        Some(value) if value == owner_sid => Ok(()),
        _ => Err(AclApplyFailure::PlanShapeInvalid(
            "required.owner_sid does not match the applying owner_sid".to_owned(),
        )),
    }
}

/// `relative_path` is joined onto an authorized workspace root; reject anything that is not a
/// plain relative path made of normal components, so a plan cannot use `..` or an absolute/UNC
/// path to escape the root.
fn require_relative_path_stays_inside_root(relative_path: &str) -> Result<(), AclApplyFailure> {
    let path = Path::new(relative_path);
    let stays_inside = !relative_path.is_empty()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)));
    if stays_inside {
        Ok(())
    } else {
        Err(AclApplyFailure::PlanShapeInvalid(format!(
            "relative_path {relative_path:?} must be a relative path with no '..' or root component"
        )))
    }
}

/// `tier` is joined onto a managed root as a single directory name; reject anything containing
/// a path separator or `..`/`.` so it cannot escape the managed root.
fn require_single_path_segment(value: &str, field: &str) -> Result<(), AclApplyFailure> {
    let is_single_segment =
        !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\']);
    if is_single_segment {
        Ok(())
    } else {
        Err(AclApplyFailure::PlanShapeInvalid(format!(
            "{field} {value:?} must be a single path segment"
        )))
    }
}

/// The authorized workspace roots by `root_id`, each with the path and policy class that were recorded.
fn workspace_root_grants(
    snapshot: &WorkspaceAuthorizationSnapshot,
) -> HashMap<String, (PathBuf, String)> {
    snapshot
        .workspace_roots
        .iter()
        .map(|grant| {
            (
                grant.root_id.clone(),
                (PathBuf::from(&grant.path), grant.policy_class.clone()),
            )
        })
        .collect()
}

fn require_plan_collection_shapes(
    workspace_plans: &[Value],
    managed_plans: &[Value],
) -> Result<(), AclApplyFailure> {
    if workspace_plans.is_empty() {
        return Err(AclApplyFailure::PlanShapeInvalid(
            "workspace_root_plans must contain at least one root".to_owned(),
        ));
    }
    for plan in workspace_plans {
        if plan.get("placeholders").and_then(Value::as_array).is_none() {
            return Err(AclApplyFailure::PlanShapeInvalid(
                "a workspace root plan must carry a placeholders array".to_owned(),
            ));
        }
    }
    for plan in managed_plans {
        if plan
            .get("tier_subtrees")
            .and_then(Value::as_array)
            .is_none()
        {
            return Err(AclApplyFailure::PlanShapeInvalid(
                "a managed root plan must carry a tier_subtrees array".to_owned(),
            ));
        }
        if plan.get("tier_openings").and_then(Value::as_array).is_none() {
            return Err(AclApplyFailure::PlanShapeInvalid(
                "a managed root plan must carry a tier_openings array".to_owned(),
            ));
        }
    }
    Ok(())
}

fn count_planned_objects(workspace_plans: &[Value], managed_plans: &[Value]) -> usize {
    let workspace = workspace_plans.iter().map(|plan| {
        1 + plan
            .get("placeholders")
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0)
    });
    let managed = managed_plans.iter().map(|plan| {
        1 + ["tier_subtrees", "tier_openings"]
            .iter()
            .map(|key| {
                plan.get(*key)
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0)
            })
            .sum::<usize>()
    });
    workspace.chain(managed).sum()
}

// In its own file rather than inline, for the same reason as `security_descriptor::tests`: these tests
// build real directories and read real descriptors, so they run long, and the per-file size limit this
// crate enforces is there to keep a reader's unit of work small.

#[cfg(test)]
mod tests;
