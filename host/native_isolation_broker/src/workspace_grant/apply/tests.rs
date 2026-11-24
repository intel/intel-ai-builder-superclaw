//! Tests for the two questions the apply path exists to answer: is this the descriptor this build ships,
//! and is this an object this side is willing to write.
//!
//! The apply and readback of a real descriptor onto a real directory is tested once, in `acl_policy_apply`,
//! against the shipped `payload_root` policy. Repeating it here would prove the same Win32 behaviour a
//! second time; what is proved here is the deciding, which is the part a caller controls.

use super::*;
use crate::acl_descriptor::managed_root_tier_expectation;
use crate::acl_rights::{inheritance_from_flags, mask_to_rights};
use crate::grant_store::{
    ConvergedTierState, ConvergenceSkipState, WorkspaceRootGrant,
};

/// The `required` block the planner produces for one shipped DACL.
///
/// A copy of `sandbox_policy.acl_plan._required` in Rust, deliberately: a test that built the plan out of
/// the same `ExpectedDacl` the broker compares against would pass however the fold was broken. Going
/// through the plan's own JSON shape is what makes the comparison mean something.
fn plan_required_for(expected: &ExpectedDacl, owner_sid: &str, policy_version: u64) -> Value {
    let aces: Vec<Value> = expected
        .aces
        .iter()
        .map(|ace| {
            json!({
                "ace_kind": if ace.allow { "allow" } else { "deny" },
                "principal": ace.principal,
                "rights": mask_to_rights(ace.mask),
                "inheritance": inheritance_from_flags(ace.flags),
            })
        })
        .collect();
    json!({
        "owner_sid": owner_sid,
        "policy_version": policy_version,
        "dacl_protected": expected.protected,
        "aces": aces,
    })
}

fn snapshot_for(owner_sid: &str) -> WorkspaceAuthorizationSnapshot {
    WorkspaceAuthorizationSnapshot {
        version: 1,
        owner_sid: owner_sid.to_owned(),
        workspace_roots: Vec::new(),
        managed_roots: HashMap::new(),
        applied_paths: Vec::new(),
        tier_account_sids: Vec::new(),
        profile_ancestor_aces: Vec::new(),
        recorded_at: "1".to_owned(),
    }
}

/// The plan the shipped planner would produce is accepted, and every single-field departure from it is
/// refused as a policy disagreement rather than as a shape error.
///
/// This is the check that stands between an unprivileged caller and an arbitrary ACE, so each departure is
/// exercised separately: one extra entry, one flipped protection bit, one widened right, one substituted
/// principal, one changed inheritance word, one stale policy version.
#[test]
fn a_plan_descriptor_that_is_not_the_shipped_one_is_refused() {
    let owner = "S-1-5-21-1-2-3-1001";
    let version = shipped_policy_version().expect("this build embeds a policy version");
    let expected = managed_root_expectation("payload_root").expect("a shipped expectation");
    let shipped = plan_required_for(&expected, owner, version);

    require_shipped_descriptor("payload_root", &shipped, &expected, owner, version)
        .expect("the descriptor the planner produces must be accepted unchanged");

    let mut extra_ace = shipped.clone();
    extra_ace["aces"].as_array_mut().unwrap().push(json!({
        "ace_kind": "allow",
        "principal": "sandbox_tier_bootstrap",
        "rights": ["WRITE_DAC", "WRITE_OWNER"],
        "inheritance": "this_object_and_children",
    }));

    let mut unprotected = shipped.clone();
    unprotected["dacl_protected"] = json!(false);

    let mut widened = shipped.clone();
    widened["aces"][0]["rights"] = json!(["WRITE_DAC", "WRITE_OWNER", "READ_CONTROL"]);

    let mut substituted = shipped.clone();
    substituted["aces"][0]["principal"] = json!("sandbox_tier_network_connector");

    let mut reinherited = shipped.clone();
    reinherited["aces"][0]["inheritance"] = json!("children_only");

    let mut stale = shipped.clone();
    stale["policy_version"] = json!(version + 1);

    for departure in [
        extra_ace,
        unprotected,
        widened,
        substituted,
        reinherited,
        stale,
    ] {
        let failure =
            require_shipped_descriptor("payload_root", &departure, &expected, owner, version)
                .expect_err("a descriptor that is not the shipped one must be refused");
        assert_eq!(
            failure.reason_code(),
            "descriptor_not_the_shipped_policy",
            "the caller has to be told to replan, not to retry: {departure}"
        );
        assert!(!failure.is_permission_class());
    }
}

/// A plan built against another build's policy is refused before any object is looked at.
#[test]
fn a_plan_for_another_policy_version_is_refused() {
    let version = shipped_policy_version().unwrap();
    let plan = json!({
        "contract_version": 1,
        "policy_version": version + 1,
        "workspace_root_plans": [],
        "managed_root_plans": [],
    });
    let failure = apply_acl_plan("S-1-5-21-1", &plan, 16).unwrap_err();
    assert_eq!(failure.reason_code(), "descriptor_not_the_shipped_policy");
}

#[test]
fn invalid_plan_collections_are_refused_before_authorization_state_is_read() {
    let version = shipped_policy_version().unwrap();
    let invalid = [
        json!({"workspace_root_plans": [], "managed_root_plans": []}),
        json!({"workspace_root_plans": [{}], "managed_root_plans": []}),
        json!({"workspace_root_plans": [{"placeholders": null}], "managed_root_plans": []}),
        json!({"workspace_root_plans": [{"placeholders": {}}], "managed_root_plans": []}),
        json!({"workspace_root_plans": [{"placeholders": []}], "managed_root_plans": [{}]}),
        json!({"workspace_root_plans": [{"placeholders": []}], "managed_root_plans": [{"tier_subtrees": null, "tier_openings": []}]}),
        json!({"workspace_root_plans": [{"placeholders": []}], "managed_root_plans": [{"tier_subtrees": {}, "tier_openings": []}]}),
        json!({"workspace_root_plans": [{"placeholders": []}], "managed_root_plans": [{"tier_subtrees": []}]}),
        json!({"workspace_root_plans": [{"placeholders": []}], "managed_root_plans": [{"tier_subtrees": [], "tier_openings": null}]}),
    ];

    for mut plan in invalid {
        plan["contract_version"] = json!(1);
        plan["policy_version"] = json!(version);
        let failure = apply_acl_plan("S-1-5-21-1-2-3-1001", &plan, 16)
            .expect_err("an invalid collection must be refused before snapshot lookup");
        assert_eq!(failure.reason_code(), "plan_shape_invalid", "{plan}");
    }

    require_plan_collection_shapes(
        &[json!({"placeholders": []})],
        &[json!({"tier_subtrees": [], "tier_openings": []})],
    )
    .expect("the schema permits empty nested collections");
}

#[test]
fn convergence_state_requires_every_planned_subtree_path() {
    let state = ConvergedTierState {
        policy_version: 7,
        tier_account_sids: vec!["S-1-5-21-1".to_owned()],
        paths: vec!["C:\\backend\\bootstrap".to_owned()],
        resume_after: None,
        checkpoints: Vec::new(),
        skip_state: ConvergenceSkipState::default(),
        targets_fingerprint: Some(tier_subtrees::startup_convergence_fingerprint()),
    };
    let sids = vec!["S-1-5-21-1".to_owned()];

    assert!(!descendants_need_converging(
        Some(&state),
        7,
        &sids,
        &["C:\\backend\\bootstrap".to_owned()]
    ));
    assert!(descendants_need_converging(
        Some(&state),
        7,
        &sids,
        &[
            "C:\\backend\\bootstrap".to_owned(),
            "C:\\backend\\file_tool".to_owned()
        ]
    ));
    assert!(descendants_need_converging(
        Some(&state),
        7,
        &["S-1-5-21-2".to_owned()],
        &["C:\\backend\\bootstrap".to_owned()]
    ));
    assert!(descendants_need_converging(
        Some(&state),
        7,
        &sids,
        &["D:\\backend\\bootstrap".to_owned()]
    ));
    let mut state_with_extra_path = state.clone();
    state_with_extra_path
        .paths
        .push("C:\\backend\\retired".to_owned());
    assert!(descendants_need_converging(
        Some(&state_with_extra_path),
        7,
        &sids,
        &["C:\\backend\\bootstrap".to_owned()]
    ));
}

#[test]
fn planned_descendant_paths_rejects_an_invalid_tier_before_joining() {
    let owner = "S-1-5-21-1-2-3-1001";
    let mut snapshot = snapshot_for(owner);
    snapshot
        .managed_roots
        .insert("data_root".to_owned(), r"C:\backend\data".to_owned());
    let error = planned_descendant_paths(
        &[json!({
            "managed_root_scope": "data_root",
            "tier_subtrees": [{"tier": ".."}]
        })],
        &snapshot,
    )
    .expect_err("the tier must be validated before joining or probing its path");
    assert!(matches!(error, AclApplyFailure::PlanShapeInvalid(_)));
}

#[test]
fn convergence_with_skips_is_not_complete() {
    assert!(convergence_has_skips(&json!({
        "tier": "file_tool",
        "convergence": {
            "visited": 3,
            "repaired": 2,
            "skipped": 1,
            "duration_ms": 4,
            "skipped_entries": [{"path": "C:\\backend\\locked", "reason": "acl_write_failed"}],
            "skipped_entries_truncated": false
        }
    })));
    assert!(!convergence_has_skips(&json!({
        "tier": "file_tool",
        "convergence": {
            "visited": 3,
            "repaired": 3,
            "skipped": 0,
            "duration_ms": 4,
            "skipped_entries": [],
            "skipped_entries_truncated": false
        }
    })));
}

#[test]
fn permanent_convergence_skips_do_not_gate_future_starts() {
    let mut observation = json!({
        "convergence": {
            "skipped_entries": [
                {"path": "C:\\deep", "reason": "managed_path_too_deep"},
                {"path": "C:\\linked", "reason": "multiply_linked"},
                {"path": "C:\\locked", "reason": "sharing_violation"}
            ],
            "skipped_entries_truncated": true
        }
    });
    let (_, state) = take_convergence_state(&mut observation);
    assert_eq!(state.retryable, 1);
    assert_eq!(state.structural, 3);
}

/// The two `%ProgramData%` roots are the ones this side derives, whatever the request recorded.
///
/// Only the refusal is asserted for the derived scopes: agreeing would create a directory under
/// `%ProgramData%`, which no unelevated test run can do. The positive case is the manual elevated
/// acceptance, and the derivation itself is pinned in `acl_authorized_root`.
#[test]
fn a_managed_root_recorded_away_from_its_derived_path_is_refused() {
    let owner = "S-1-5-21-1-2-3-1001";
    for scope in ["protected_root", "isolation_root"] {
        let mut snapshot = snapshot_for(owner);
        snapshot.managed_roots.insert(
            scope.to_owned(),
            "C:\\Users\\Public\\somewhere-else".to_owned(),
        );
        let failure = authorized_managed_root_path(scope, owner, &snapshot)
            .expect_err("a derived root may not be moved by a request");
        assert_eq!(failure.reason_code(), "managed_root_not_authorized");
        assert!(!failure.is_permission_class());
    }

    let mut snapshot = snapshot_for(owner);
    snapshot
        .managed_roots
        .insert("data_root".to_owned(), "C:\\Users\\owner\\data".to_owned());
    let (path, ownership) = authorized_managed_root_path("data_root", owner, &snapshot)
        .expect("an owner-owned scope is taken from the recorded authorization");
    assert_eq!(path, PathBuf::from("C:\\Users\\owner\\data"));
    assert_eq!(
        ownership,
        ObjectOwnership::OwnedByRequester,
        "an owner-owned root is authorized by its ownership, checked on the apply handle"
    );
}

/// A scope the request never authorized has no path to be written at.
#[test]
fn a_managed_root_scope_outside_the_authorization_is_refused() {
    let owner = "S-1-5-21-1-2-3-1001";
    let failure = authorized_managed_root_path("data_root", owner, &snapshot_for(owner))
        .expect_err("an unrecorded scope must be refused");
    assert_eq!(failure.reason_code(), "managed_root_not_authorized");
}

/// A placeholder relative path is a key into the descriptor, not a path a plan may choose.
#[test]
fn a_placeholder_the_descriptor_does_not_declare_is_refused() {
    let owner = "S-1-5-21-1-2-3-1001";
    let version = shipped_policy_version().unwrap();
    let resolver = PrincipalResolver::host_only(owner.to_owned());
    let mut snapshot = snapshot_for(owner);
    let expected = workspace_root_expectation("managed_default").unwrap();
    let placeholders = vec![json!({
        "relative_path": "not_a_declared_placeholder",
        "placeholder_kind": "empty_directory",
        "placeholder_role": "protected_mask",
        "required": plan_required_for(&expected, owner, version),
    })];

    let failure = apply_workspace_placeholders(
        Path::new("C:\\Users\\Public\\workspace"),
        "managed_default",
        Some(&placeholders),
        owner,
        version,
        &resolver,
        &mut snapshot,
    )
    .expect_err("a placeholder outside the descriptor must be refused");
    assert_eq!(failure.reason_code(), "descriptor_not_the_shipped_policy");
    assert!(
        snapshot.applied_paths.is_empty(),
        "a refused placeholder must not have been recorded as applied"
    );
}

/// A tier the scope does not have is refused, even when the descriptor asked for is genuinely shipped.
#[test]
fn a_tier_subtree_the_scope_does_not_declare_is_refused() {
    let owner = "S-1-5-21-1-2-3-1001";
    let version = shipped_policy_version().unwrap();
    let resolver = PrincipalResolver::host_only(owner.to_owned());
    let mut snapshot = snapshot_for(owner);
    let borrowed = managed_root_tier_expectation("data_root", "bootstrap").unwrap();
    let subtrees = vec![json!({
        "tier": "bootstrap",
        "required": plan_required_for(&borrowed, owner, version),
    })];

    // `protected_root` has no tier subtrees at all, so this is a plan asking for a grant the shipped policy
    // does not give that root - carrying a descriptor that is the shipped one for a *different* root, which
    // is the form the substitution would actually take.
    let failure = apply_tier_subtrees(
        Path::new("C:\\ProgramData\\SuperClaw\\protected"),
        "protected_root",
        Some(&subtrees),
        owner,
        version,
        &resolver,
        &mut snapshot,
        true,
    )
    .expect_err("a tier the scope does not declare must be refused");
    assert_eq!(failure.reason_code(), "descriptor_not_the_shipped_policy");
    assert!(snapshot.applied_paths.is_empty());
}

/// A placeholder that is not a directory is refused rather than mistranslated into one.
#[test]
fn a_placeholder_kind_this_side_cannot_make_is_refused() {
    require_placeholder_kind(&json!({"placeholder_kind": "empty_directory"}))
        .expect("the one kind the descriptor declares");
    for kind in ["file", "registry_key", ""] {
        let failure = require_placeholder_kind(&json!({"placeholder_kind": kind}))
            .expect_err("an object kind this side does not create must be refused");
        assert_eq!(failure.reason_code(), "plan_shape_invalid");
    }
    require_placeholder_kind(&json!({})).expect_err("a placeholder must say what it is");
}

/// A key repeated in one plan is refused, so the coverage bound counts distinct objects.
#[test]
fn a_plan_that_names_one_object_twice_is_refused() {
    let mut seen = Vec::new();
    require_first_mention(&mut seen, "data_root", "managed_root_scope").expect("first mention");
    require_first_mention(&mut seen, "logs_root", "managed_root_scope").expect("a second scope");
    let failure = require_first_mention(&mut seen, "data_root", "managed_root_scope")
        .expect_err("a repeated key must be refused");
    assert_eq!(failure.reason_code(), "plan_shape_invalid");
}

/// The policy class comes from the recorded authorization, and a plan built for another class is refused.
#[test]
fn a_plan_for_a_policy_class_the_authorization_did_not_record_is_refused() {
    let plan = json!({"policy_class": "user_granted_rw"});
    require_matching_class(&plan, "user_granted_rw").expect("agreement is accepted");
    let failure = require_matching_class(&plan, "managed_default")
        .expect_err("a class other than the recorded one must be refused");
    assert_eq!(failure.reason_code(), "descriptor_not_the_shipped_policy");
    let missing = require_matching_class(&json!({}), "managed_default")
        .expect_err("a plan must say which class it planned for");
    assert_eq!(missing.reason_code(), "plan_shape_invalid");
}

/// A workspace root the request never authorized is refused, and refused as an authorization decision.
#[test]
fn a_workspace_root_outside_the_authorization_is_refused() {
    let owner = "S-1-5-21-1-2-3-1001";
    let version = shipped_policy_version().unwrap();
    let resolver = PrincipalResolver::host_only(owner.to_owned());
    let mut snapshot = snapshot_for(owner);
    snapshot.workspace_roots.push(WorkspaceRootGrant {
        root_id: "authorized".to_owned(),
        path: "C:\\Users\\Public\\workspace".to_owned(),
        policy_class: "managed_default".to_owned(),
    });
    let expected = workspace_root_expectation("managed_default").unwrap();
    let plans = vec![json!({
        "root_id": "some-other-root",
        "policy_class": "managed_default",
        "required": plan_required_for(&expected, owner, version),
        "placeholders": [],
    })];

    let failure =
        apply_workspace_roots(owner, &plans, version, &resolver, &mut snapshot).unwrap_err();
    assert_eq!(failure.reason_code(), "managed_root_not_authorized");
    assert!(!failure.is_permission_class());
}

/// A caller-named path that the apply refuses must not end up in `applied_paths`.
///
/// `applied_paths` is not bookkeeping: `workspace_grant::revoke_applied_acl` reopens every entry with
/// `WRITE_DAC` from an elevated `--revoke`, without re-deciding anything. So an entry recorded before the
/// apply had authorized the object would be a caller-chosen path this side promises to write to later, which
/// is the arbitrary-write this boundary exists to prevent - the refusal of the provision that named it would
/// not take it back.
///
/// The path is a real system directory rather than a made-up name so the refusal is the interesting one:
/// the descriptor is the shipped one and the plan agrees with the recorded authorization, and the only thing
/// wrong is which object was named.
#[test]
fn a_refused_workspace_root_is_not_recorded_as_an_applied_path() {
    let owner = "S-1-5-21-1-2-3-1001";
    let version = shipped_policy_version().unwrap();
    let resolver = PrincipalResolver::host_only(owner.to_owned());
    let system32 = "C:\\Windows\\System32";
    let mut snapshot = snapshot_for(owner);
    snapshot.workspace_roots.push(WorkspaceRootGrant {
        root_id: "w0".to_owned(),
        path: system32.to_owned(),
        policy_class: "managed_default".to_owned(),
    });
    let expected = workspace_root_expectation("managed_default").unwrap();
    let plans = vec![json!({
        "root_id": "w0",
        "policy_class": "managed_default",
        "required": plan_required_for(&expected, owner, version),
        "placeholders": [],
    })];

    let failure = apply_workspace_roots(owner, &plans, version, &resolver, &mut snapshot)
        .expect_err("a directory this owner does not own must be refused");
    // The refusal has to come from the object, not from the plan, or this test would still pass while the
    // ordering it exists to protect went unchecked. Which of the two it is depends on the token: unelevated,
    // `System32` cannot be opened for `WRITE_DAC` at all; elevated, it opens and is owned by someone else.
    assert!(
        matches!(
            failure.reason_code(),
            "win32_permission_denied" | "managed_root_not_authorized"
        ),
        "the plan is the shipped one and agrees with the authorization, so the only thing wrong is which \
         object was named: {failure:?}"
    );
    assert!(
        snapshot.applied_paths.is_empty(),
        "a refused object must leave nothing behind for an elevated revoke to reopen: {:?}",
        snapshot.applied_paths
    );
}

/// A child path is refused if it does not land inside the root it was joined onto.
#[test]
fn a_child_outside_its_authorized_root_is_refused() {
    let root = Path::new("C:\\Users\\Public\\workspace");
    require_inside_root(&root.join("sensitive"), root).expect("a child of the root");
    let failure = require_inside_root(Path::new("C:\\Windows\\System32"), root)
        .expect_err("a path outside the root must be refused");
    assert_eq!(failure.reason_code(), "plan_shape_invalid");
}

/// Refusing on the coverage bound must not read as a permission failure: the caller has to be able to tell
/// "this plan is too large" from "you may not do this", because only one of them is worth retrying.
#[test]
fn coverage_refusal_is_distinct_from_permission_denied() {
    let owner = "S-1-5-21-1";
    let version = shipped_policy_version().unwrap();
    let expected = workspace_root_expectation("managed_default").unwrap();
    let plan = json!({
        "contract_version": 1,
        "policy_version": version,
        "workspace_root_plans": [{
            "root_id": "a",
            "policy_class": "managed_default",
            "required": plan_required_for(&expected, owner, version),
            "placeholders": [],
        }],
        "managed_root_plans": crate::backend_ancestors::SCOPES.map(|scope| json!({
            "managed_root_scope": scope,
            "required": plan_required_for(&managed_root_expectation(scope).unwrap(), owner, version),
            "tier_subtrees": [],
            "tier_openings": [],
        })),
    });
    let failure = apply_acl_plan(owner, &plan, 0).unwrap_err();
    assert_eq!(failure.reason_code(), "coverage_bound_exceeded");
    assert!(!failure.is_permission_class());
}

#[test]
fn missing_backend_parent_policies_are_rejected_before_apply() {
    let plan = json!({
        "contract_version": 1,
        "policy_version": shipped_policy_version().unwrap(),
        "workspace_root_plans": [{
            "root_id": "test-root", "policy_class": "managed_default",
            "required": {}, "placeholders": [],
        }],
        "managed_root_plans": [],
    });
    let failure = apply_acl_plan("S-1-5-21-1", &plan, 100).unwrap_err();
    assert_eq!(failure.reason_code(), "plan_shape_invalid");
    assert!(format!("{failure:?}").contains("backend ancestor"));
}

#[test]
fn owner_mismatch_between_required_and_applying_owner_is_rejected() {
    let required = json!({"owner_sid": "S-1-5-21-1"});
    require_owner_matches(&required, "S-1-5-21-1").expect("matching owner is accepted");
    let failure = require_owner_matches(&required, "S-1-5-21-2")
        .expect_err("mismatched owner must be refused");
    assert_eq!(failure.reason_code(), "plan_shape_invalid");
}

#[test]
fn relative_path_traversal_is_rejected() {
    require_relative_path_stays_inside_root("nested/child").expect("plain relative path");
    for escape in ["../outside", "..", "/absolute", "a/../../b", ""] {
        require_relative_path_stays_inside_root(escape)
            .expect_err("path escaping the workspace root must be refused");
    }
}

#[test]
fn tier_path_segment_is_rejected_when_not_a_single_component() {
    require_single_path_segment("bootstrap", "tier").expect("plain tier name");
    for escape in ["..", ".", "a/b", "a\\b", ""] {
        require_single_path_segment(escape, "tier")
            .expect_err("tier escaping the managed root must be refused");
    }
}

/// A plan refused on a managed root leaves the user's profile folders exactly as they were.
///
/// The positive control applies the same snapshot's ancestors directly and sees all three ACEs, so the
/// refusal leaving none is the ordering at work and not a setup that could never have written.
#[test]
fn a_refused_managed_root_leaves_no_profile_ancestor_ace() {
    let owner = "S-1-5-21-1-2-3-1001";
    let file_tool_sid = "S-1-5-21-1-2-3-7002";
    let version = shipped_policy_version().unwrap();
    let resolver = PrincipalResolver::with_tier_sids(owner, &[("file_tool", file_tool_sid)]);
    let root = crate::security_descriptor::unique_temp_path("refused-managed-root");
    let backend = root.join(r"someone\AppData\Local\SuperClaw\backend");
    std::fs::create_dir_all(&backend).unwrap();
    let ancestors: Vec<PathBuf> = backend
        .ancestors()
        .skip(1)
        .take(3)
        .map(Path::to_path_buf)
        .collect();
    let grant = crate::acl_descriptor::profile_ancestor_grants().unwrap()[0]
        .ace
        .clone();
    let carries =
        |path: &Path| crate::profile_ancestors::carries_grant(path, &grant, file_tool_sid).unwrap();
    let mut snapshot = snapshot_for(owner);
    snapshot
        .managed_roots
        .insert("backend_root".to_owned(), backend.display().to_string());
    let mut required = plan_required_for(
        &managed_root_expectation("backend_root").unwrap(),
        owner,
        version,
    );
    required["policy_version"] = json!(version + 1);
    let managed_plans = vec![json!({
        "managed_root_scope": "backend_root",
        "required": required,
        "tier_subtrees": [],
        "tier_openings": [],
    })];

    let profile = root.join("someone").display().to_string();
    let failure = converge_plan(
        owner,
        &[],
        &managed_plans,
        version,
        &resolver,
        &mut snapshot,
        |_| Ok(Some(profile.clone())),
        true,
    )
    .expect_err("a managed root descriptor that is not the shipped one is refused");
    assert_eq!(failure.reason_code(), "descriptor_not_the_shipped_policy");
    assert!(ancestors.iter().all(|path| !carries(path)), "{ancestors:?}");
    assert!(snapshot.profile_ancestor_aces.is_empty());

    let added = crate::profile_ancestor_apply::apply_from_snapshot(
        &mut snapshot,
        |_| Ok(Some(profile)),
        |principal| resolver.resolve_principal(principal),
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(
        added, 3,
        "positive control: this snapshot does reach the ancestors"
    );
    assert!(ancestors.iter().all(|path| carries(path)));
    crate::profile_ancestor_apply::remove_from_snapshot(&snapshot).unwrap();
    std::fs::remove_dir_all(&root).ok();
}

/// A backend in a profile that is not the owner's is refused before any root is touched.
///
/// The managed root plan here would itself be refused as a descriptor disagreement; getting the
/// owner-profile refusal instead, with nothing recorded, is what shows no root apply ran first.
#[test]
fn a_backend_in_another_profile_is_refused_before_any_root_is_written() {
    let owner = "S-1-5-21-1-2-3-1001";
    let version = shipped_policy_version().unwrap();
    let resolver =
        PrincipalResolver::with_tier_sids(owner, &[("file_tool", "S-1-5-21-1-2-3-7002")]);
    let root = crate::security_descriptor::unique_temp_path("other-profile-backend");
    let backend = root.join(r"someone\AppData\Local\SuperClaw\backend");
    let mut snapshot = snapshot_for(owner);
    snapshot
        .managed_roots
        .insert("backend_root".to_owned(), backend.display().to_string());
    let mut required = plan_required_for(
        &managed_root_expectation("backend_root").unwrap(),
        owner,
        version,
    );
    required["policy_version"] = json!(version + 1);
    let managed_plans = vec![json!({
        "managed_root_scope": "backend_root",
        "required": required,
        "tier_subtrees": [],
        "tier_openings": [],
    })];
    let owners_profile = root.join("owner").display().to_string();

    let failure = converge_plan(
        owner,
        &[],
        &managed_plans,
        version,
        &resolver,
        &mut snapshot,
        |_| Ok(Some(owners_profile.clone())),
        true,
    )
    .expect_err("a backend outside the owner's profile is refused");
    assert_eq!(failure.reason_code(), "managed_root_not_authorized");
    assert!(format!("{failure:?}").contains("rather than the owner's profile"));
    assert!(snapshot.applied_paths.is_empty());
    assert!(snapshot.profile_ancestor_aces.is_empty());
}

#[test]
fn profile_ancestor_failures_keep_their_class() {
    use crate::profile_ancestor_apply::ProfileAncestorFailure;
    let cases = [
        (
            ProfileAncestorFailure::NotOwnersProfile("elsewhere".to_owned()),
            "managed_root_not_authorized",
        ),
        (
            ProfileAncestorFailure::Precondition(io::Error::other("store")),
            "provision_precondition_missing",
        ),
        (
            ProfileAncestorFailure::Dacl(io::Error::other("write")),
            "win32_permission_denied",
        ),
    ];
    for (failure, reason) in cases {
        assert_eq!(ancestor_failure(failure).reason_code(), reason);
    }
}

/// The #2957 walk gate: skip only when the tier SIDs and planned paths match the last fully successful walk.
#[test]
fn descendants_converge_when_the_cached_state_no_longer_matches() {
    let current = [
        "S-1-5-21-1-2-3-1119".to_owned(),
        "S-1-5-21-1-2-3-1120".to_owned(),
    ];
    let revoked = [
        "S-1-5-21-1-2-3-1116".to_owned(),
        "S-1-5-21-1-2-3-1117".to_owned(),
    ];
    let paths = [
        "C:\\backend\\bootstrap".to_owned(),
        "C:\\backend\\file_tool".to_owned(),
    ];
    let converged = ConvergedTierState {
        policy_version: 7,
        tier_account_sids: current.to_vec(),
        paths: paths.to_vec(),
        resume_after: None,
        checkpoints: Vec::new(),
        skip_state: ConvergenceSkipState::default(),
        targets_fingerprint: Some(tier_subtrees::startup_convergence_fingerprint()),
    };
    let partial_state = ConvergedTierState {
        policy_version: 7,
        tier_account_sids: current.to_vec(),
        paths: paths[..1].to_vec(),
        resume_after: Some("C:\\backend\\bootstrap\\z".to_owned()),
        checkpoints: Vec::new(),
        skip_state: ConvergenceSkipState::default(),
        targets_fingerprint: Some(tier_subtrees::startup_convergence_fingerprint()),
    };
    let revoked_state = ConvergedTierState {
        policy_version: 7,
        tier_account_sids: revoked.to_vec(),
        paths: paths.to_vec(),
        resume_after: None,
        checkpoints: Vec::new(),
        skip_state: ConvergenceSkipState::default(),
        targets_fingerprint: Some(tier_subtrees::startup_convergence_fingerprint()),
    };
    let retryable_state = ConvergedTierState {
        policy_version: 7,
        tier_account_sids: current.to_vec(),
        paths: paths.to_vec(),
        resume_after: None,
        checkpoints: vec!["data_root\u{1f}bootstrap\u{1f}C:\\backend\\bootstrap\\z".to_owned()],
        skip_state: ConvergenceSkipState {
            retryable: 1,
            ..ConvergenceSkipState::default()
        },
        targets_fingerprint: Some(tier_subtrees::startup_convergence_fingerprint()),
    };

    assert!(
        descendants_need_converging(None, 7, &current, &paths),
        "no record (first run on this build, or after revoke) must walk"
    );
    assert!(
        descendants_need_converging(Some(&revoked_state), 7, &current, &paths),
        "a re-provision that minted new tier SIDs must walk"
    );
    assert!(
        descendants_need_converging(Some(&partial_state), 7, &current, &paths),
        "a partial persisted walk must not cover a later complete plan"
    );
    assert!(
        descendants_need_converging(Some(&retryable_state), 7, &current, &paths),
        "a retryable skip must force a retry even when a checkpoint exists"
    );
    assert!(
        !can_reuse_convergence_checkpoints(&retryable_state, 7, &current, &paths),
        "a retryable skip must invalidate checkpoint reuse"
    );
    assert!(
        !descendants_need_converging(Some(&converged), 7, &current, &paths),
        "same SIDs and paths as the last successful walk: nothing can have gone stale, skip"
    );
    assert!(
        descendants_need_converging(Some(&converged), 8, &current, &paths),
        "a policy upgrade must walk even when SIDs and paths are unchanged"
    );
}

mod stale_descendant_convergence;
mod tier_openings;
