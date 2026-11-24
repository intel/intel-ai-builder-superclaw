use super::*;
use std::collections::HashMap;

/// Re-authorizing a workspace must not lose the evidence a revoke needs.
///
/// The snapshot a new path set produces knows nothing about what was already applied, so a plain overwrite
/// would leave the product unable to take back the grants it had made.
#[test]
fn reauthorization_preserves_acl_revoke_evidence() {
    let mut current = WorkspaceAuthorizationSnapshot {
        version: 1,
        owner_sid: "S-1-5-21-1".to_owned(),
        workspace_roots: Vec::new(),
        managed_roots: HashMap::new(),
        applied_paths: Vec::new(),
        tier_account_sids: Vec::new(),
        profile_ancestor_aces: Vec::new(),
        recorded_at: "2".to_owned(),
    };
    let previous = WorkspaceAuthorizationSnapshot {
        version: 1,
        owner_sid: current.owner_sid.clone(),
        workspace_roots: Vec::new(),
        managed_roots: HashMap::new(),
        applied_paths: vec!["C:\\previous".to_owned()],
        tier_account_sids: vec!["S-1-5-21-2".to_owned()],
        profile_ancestor_aces: vec![crate::grant_store::ProfileAncestorAce {
            path: "C:\\Users\\owner\\AppData".to_owned(),
            sid: "S-1-5-21-2".to_owned(),
        }],
        recorded_at: "1".to_owned(),
    };

    let previous_aces = previous.profile_ancestor_aces.clone();

    preserve_revoke_evidence(&mut current, previous);

    assert_eq!(current.applied_paths, ["C:\\previous"]);
    assert_eq!(current.tier_account_sids, ["S-1-5-21-2"]);
    assert_eq!(current.profile_ancestor_aces, previous_aces);
}

/// A provision interrupted before any ACL was applied leaves a snapshot with no revoke evidence;
/// revoke must treat it as nothing to undo rather than refuse, or clean can never clear it.
#[test]
fn revoke_accepts_a_snapshot_from_an_interrupted_provision() {
    let missing = std::env::temp_dir().join("superclaw-revoke-missing-applied-path");
    for (applied_paths, tier_account_sids) in [
        (Vec::new(), Vec::new()),
        (Vec::new(), vec!["S-1-5-21-2".to_owned(); 3]),
        (vec![missing.display().to_string()], Vec::new()),
    ] {
        let snapshot = WorkspaceAuthorizationSnapshot {
            version: 1,
            owner_sid: "S-1-5-21-1".to_owned(),
            workspace_roots: Vec::new(),
            managed_roots: HashMap::new(),
            applied_paths,
            tier_account_sids,
            profile_ancestor_aces: Vec::new(),
            recorded_at: "1".to_owned(),
        };
        revoke_snapshot_acl(&snapshot).expect("a partial snapshot must not block revoke");
    }
}

fn tier_sids(count: usize) -> Vec<String> {
    (1..=count)
        .map(|n| format!("S-1-5-21-1-2-3-700{n}"))
        .collect()
}

/// The shipped policy grants every tier, the channel tier included, so three provisioned accounts are no
/// longer enough to apply it.
#[test]
fn apply_needs_an_account_for_every_tier_including_channel() {
    assert!(names_every_tier(&tier_sids(4)));
    assert!(!names_every_tier(&tier_sids(3)));
}
