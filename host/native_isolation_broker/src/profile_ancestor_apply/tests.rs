use super::*;
use crate::security_descriptor::unique_temp_path;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;
use windows_sys::Win32::Security::Authorization::SetSecurityInfo;
use windows_sys::Win32::Security::UNPROTECTED_DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Storage::FileSystem::{FILE_READ_ATTRIBUTES, FILE_READ_DATA, SYNCHRONIZE};

/// A stand-in tier SID: no tier identity is provisioned in an unelevated run, and an ACE may name
/// any well-formed SID whether or not it maps to an account.
const FILE_TOOL_SID: &str = "S-1-5-21-1-2-3-7002";
const NEW_FILE_TOOL_SID: &str = "S-1-5-21-1-2-3-8002";
const OTHER_TIER_SID: &str = "S-1-5-21-1-2-3-7001";
const STALE_SID: &str = "S-1-5-21-1-2-3-7999";

fn file_tool_ace() -> ExpectedAce {
    ExpectedAce {
        allow: true,
        principal: "sandbox_tier_file_tool".to_owned(),
        mask: FILE_READ_ATTRIBUTES,
        flags: 0,
    }
}

fn aces_of(path: &Path) -> (u16, Vec<Vec<u8>>) {
    let handle = open_path_for_dacl_apply_preserving_owner(path, path.is_dir())
        .unwrap_or_else(|error| panic!("{} should open: {error}", path.display()));
    let (control, _, aces) = read_aces(handle.raw()).expect("the DACL reads");
    (control & PRESERVED_CONTROL, aces)
}

fn snapshot_for(backend: &Path) -> WorkspaceAuthorizationSnapshot {
    WorkspaceAuthorizationSnapshot {
        version: 1,
        owner_sid: "S-1-5-21-1-2-3-1001".to_owned(),
        workspace_roots: Vec::new(),
        managed_roots: HashMap::from([("backend_root".to_owned(), backend.display().to_string())]),
        applied_paths: Vec::new(),
        tier_account_sids: vec![OTHER_TIER_SID.to_owned(), FILE_TOOL_SID.to_owned()],
        profile_ancestor_aces: Vec::new(),
        recorded_at: String::new(),
    }
}

fn resolve(principal: &str) -> io::Result<String> {
    assert_eq!(principal, "sandbox_tier_file_tool");
    Ok(FILE_TOOL_SID.to_owned())
}

struct ProfileTree {
    root: PathBuf,
    profile: PathBuf,
    backend: PathBuf,
}

impl ProfileTree {
    fn new(label: &str) -> Self {
        let root = unique_temp_path(label);
        let profile = root.join("someone");
        let backend = profile.join(r"AppData\Local\SuperClaw\backend");
        fs::create_dir_all(&backend).expect("the profile tree is creatable");
        Self {
            root,
            profile,
            backend,
        }
    }

    fn ancestors(&self) -> [PathBuf; 3] {
        [
            self.profile.join("AppData"),
            self.profile.join(r"AppData\Local"),
            self.profile.join(r"AppData\Local\SuperClaw"),
        ]
    }
}

impl Drop for ProfileTree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).ok();
    }
}

/// The profile folder above a test backend, standing in for the owner's own profile.
fn own_profile(snapshot: &WorkspaceAuthorizationSnapshot) -> Option<String> {
    Path::new(&snapshot.managed_roots["backend_root"])
        .ancestors()
        .nth(4)
        .map(|profile| profile.display().to_string())
}

/// `apply_from_snapshot` with the test tree's profile reported as the owner's.
fn apply(
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    resolve: impl Fn(&str) -> io::Result<String>,
    persist: impl FnOnce(&WorkspaceAuthorizationSnapshot) -> io::Result<()>,
) -> Result<usize, ProfileAncestorFailure> {
    let profile = own_profile(snapshot);
    apply_from_snapshot(snapshot, |_| Ok(profile), resolve, persist)
}

/// Owning `backend_root` proves nothing about its parents: a profile-shaped tree that is not the
/// owner's own profile, or an owner with no recorded profile, is refused before any DACL is opened.
#[test]
fn a_profile_shaped_backend_outside_the_owners_profile_is_refused() {
    let tree = ProfileTree::new("not-owners-profile");
    let before: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();
    let elsewhere = tree.root.join("someone-else").display().to_string();
    for reported in [Some(elsewhere), None] {
        let mut snapshot = snapshot_for(&tree.backend);
        let mut asked = None;
        let failure = apply_from_snapshot(
            &mut snapshot,
            |owner| {
                asked = Some(owner.to_owned());
                Ok(reported)
            },
            |_| panic!("a refused backend resolves no tier"),
            |_| panic!("a refused backend persists nothing"),
        )
        .unwrap_err();
        assert!(
            matches!(failure, ProfileAncestorFailure::NotOwnersProfile(_)),
            "{failure:?}"
        );
        assert_eq!(asked.as_deref(), Some(snapshot.owner_sid.as_str()));
        assert!(snapshot.profile_ancestor_aces.is_empty());
    }
    let after: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();
    assert_eq!(after, before);
}

fn records(paths: &[PathBuf], sid: &str) -> Vec<ProfileAncestorAce> {
    paths
        .iter()
        .map(|path| ProfileAncestorAce {
            path: path.to_string_lossy().into_owned(),
            sid: sid.to_owned(),
        })
        .collect()
}

#[test]
fn adds_exactly_one_ace_per_ancestor_and_removes_exactly_that_ace() {
    let tree = ProfileTree::new("profile-ancestors");
    let mut snapshot = snapshot_for(&tree.backend);
    let untouched = [tree.profile.clone(), tree.backend.clone()];
    let before: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();
    let untouched_before: Vec<_> = untouched.iter().map(|path| aces_of(path)).collect();
    let wanted = ace_bytes(&file_tool_ace(), FILE_TOOL_SID).unwrap();

    assert_eq!(apply(&mut snapshot, resolve, |_| Ok(())).unwrap(), 3);
    assert_eq!(
        snapshot.profile_ancestor_aces,
        records(&tree.ancestors(), FILE_TOOL_SID)
    );
    for (path, (control, aces)) in tree.ancestors().iter().zip(&before) {
        let (control_after, aces_after) = aces_of(path);
        assert_eq!(
            control_after,
            *control,
            "{}: inheritance state changed",
            path.display()
        );
        let at = aces_after
            .iter()
            .position(|ace| *ace == wanted)
            .expect("the ACE was added");
        let mut without = aces_after.clone();
        without.remove(at);
        assert_eq!(&without, aces, "{}: another ACE changed", path.display());
        assert!(
            crate::profile_ancestors::carries_grant(path, &file_tool_ace(), FILE_TOOL_SID).unwrap(),
            "the unelevated readback sees what provision wrote"
        );
    }
    assert_eq!(
        apply(&mut snapshot, resolve, |_| Ok(())).unwrap(),
        0,
        "a converged ancestor is not written again"
    );
    assert_eq!(
        snapshot.profile_ancestor_aces,
        records(&tree.ancestors(), FILE_TOOL_SID),
        "a converged apply keeps its own records"
    );

    assert_eq!(remove_from_snapshot(&snapshot).unwrap(), 3);
    let after: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();
    assert_eq!(after, before, "removal restores every ancestor exactly");
    let untouched_after: Vec<_> = untouched.iter().map(|path| aces_of(path)).collect();
    assert_eq!(
        untouched_after, untouched_before,
        "the profile root and backend are not touched"
    );
    assert_eq!(remove_from_snapshot(&snapshot).unwrap(), 0);
}

#[test]
fn a_backend_outside_the_profile_shape_gets_no_grant() {
    let root = unique_temp_path("not-a-profile");
    let backend = root.join("backend");
    fs::create_dir_all(&backend).unwrap();
    let before = aces_of(&root);
    let mut snapshot = snapshot_for(&backend);
    assert_eq!(apply(&mut snapshot, resolve, |_| Ok(())).unwrap(), 0);
    assert_eq!(aces_of(&root), before);
    assert!(snapshot.profile_ancestor_aces.is_empty());
    fs::remove_dir_all(&root).ok();
}

/// Provenance: an identical ACE this side did not add is neither recorded nor revoked.
#[test]
fn a_pre_existing_identical_ace_is_not_recorded_and_survives_revoke() {
    let tree = ProfileTree::new("pre-existing");
    let [first, second, third] = tree.ancestors();
    assert!(add_ace(&first, &file_tool_ace(), FILE_TOOL_SID).unwrap());
    let wanted = ace_bytes(&file_tool_ace(), FILE_TOOL_SID).unwrap();
    let mut snapshot = snapshot_for(&tree.backend);

    assert_eq!(apply(&mut snapshot, resolve, |_| Ok(())).unwrap(), 2);
    assert_eq!(
        snapshot.profile_ancestor_aces,
        records(&[second.clone(), third.clone()], FILE_TOOL_SID)
    );

    assert_eq!(remove_from_snapshot(&snapshot).unwrap(), 2);
    assert!(
        aces_of(&first).1.contains(&wanted),
        "the ACE that was already there is not this side's to remove"
    );
    for path in [second, third] {
        assert!(!aces_of(&path).1.contains(&wanted), "{}", path.display());
    }
}

/// Revoke reads only the records: an unrecorded ancestor, or the same folder under another SID, is
/// left exactly as it is, and no record means nothing is derived and removed.
#[test]
fn revoke_removes_only_recorded_path_and_sid_pairs() {
    let tree = ProfileTree::new("recorded-only");
    let mut snapshot = snapshot_for(&tree.backend);
    apply(&mut snapshot, resolve, |_| Ok(())).unwrap();
    let ancestors = tree.ancestors();
    assert!(add_ace(&ancestors[1], &file_tool_ace(), OTHER_TIER_SID).unwrap());
    let granted: Vec<_> = ancestors.iter().map(|path| aces_of(path)).collect();

    let unrecorded = WorkspaceAuthorizationSnapshot {
        profile_ancestor_aces: Vec::new(),
        ..snapshot.clone()
    };
    assert_eq!(remove_from_snapshot(&unrecorded).unwrap(), 0);
    let after: Vec<_> = ancestors.iter().map(|path| aces_of(path)).collect();
    assert_eq!(after, granted, "folders are never derived for removal");

    let only_first = WorkspaceAuthorizationSnapshot {
        profile_ancestor_aces: records(&ancestors[..1], FILE_TOOL_SID),
        ..snapshot.clone()
    };
    assert_eq!(remove_from_snapshot(&only_first).unwrap(), 1);
    let file_tool = ace_bytes(&file_tool_ace(), FILE_TOOL_SID).unwrap();
    let other = ace_bytes(&file_tool_ace(), OTHER_TIER_SID).unwrap();
    assert!(!aces_of(&ancestors[0]).1.contains(&file_tool));
    for path in &ancestors[1..] {
        assert!(aces_of(path).1.contains(&file_tool), "{}", path.display());
    }
    assert!(
        aces_of(&ancestors[1]).1.contains(&other),
        "a tier SID the snapshot knows but never recorded here is not removed"
    );
}

#[test]
fn rotation_removes_the_recorded_old_sid_only() {
    let tree = ProfileTree::new("sid-rotation");
    let mut snapshot = snapshot_for(&tree.backend);
    let before: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();
    apply(&mut snapshot, resolve, |_| Ok(())).unwrap();
    let folder = &tree.ancestors()[0];
    assert!(add_ace(folder, &file_tool_ace(), OTHER_TIER_SID).unwrap());

    snapshot.tier_account_sids = vec![OTHER_TIER_SID.to_owned(), NEW_FILE_TOOL_SID.to_owned()];
    assert_eq!(
        apply(
            &mut snapshot,
            |principal| {
                assert_eq!(principal, "sandbox_tier_file_tool");
                Ok(NEW_FILE_TOOL_SID.to_owned())
            },
            |_| Ok(())
        )
        .unwrap(),
        3
    );
    assert_eq!(
        snapshot.profile_ancestor_aces,
        records(&tree.ancestors(), NEW_FILE_TOOL_SID),
        "the old SID's records are gone and the new SID's are recorded"
    );

    let old = ace_bytes(&file_tool_ace(), FILE_TOOL_SID).unwrap();
    let new = ace_bytes(&file_tool_ace(), NEW_FILE_TOOL_SID).unwrap();
    let kept = ace_bytes(&file_tool_ace(), OTHER_TIER_SID).unwrap();
    for path in tree.ancestors() {
        let aces = aces_of(&path).1;
        assert!(
            !aces.contains(&old),
            "{} retained the old SID",
            path.display()
        );
        assert!(aces.contains(&new), "{} lacks the new SID", path.display());
    }
    assert!(
        aces_of(folder).1.contains(&kept),
        "an unrecorded same-shape ACE for another SID is not rotation's to remove"
    );

    assert!(remove_ace(folder, &file_tool_ace(), &[OTHER_TIER_SID.to_owned()]).unwrap());
    assert_eq!(remove_from_snapshot(&snapshot).unwrap(), 3);
    let after: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();
    assert_eq!(after, before);
}

#[test]
fn a_later_write_failure_rolls_back_every_earlier_ancestor() {
    let tree = ProfileTree::new("apply-rollback");
    let mut snapshot = snapshot_for(&tree.backend);
    let before: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();

    let profile = own_profile(&snapshot);
    let failure = apply_from_snapshot_with(
        &mut snapshot,
        |_| Ok(profile),
        resolve,
        |_| panic!("a failed apply must not persist"),
        |index, _| {
            if index == 1 {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected second-ancestor failure",
                ))
            } else {
                Ok(())
            }
        },
    )
    .unwrap_err();

    let ProfileAncestorFailure::Dacl(error) = failure else {
        panic!("a write failure is a DACL failure: {failure:?}");
    };
    assert!(
        error
            .to_string()
            .contains("injected second-ancestor failure")
    );
    let after: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();
    assert_eq!(after, before, "the first ancestor write was rolled back");
    assert!(snapshot.profile_ancestor_aces.is_empty());
}

#[test]
fn a_failed_persist_is_a_precondition_and_rolls_back_every_ancestor() {
    let tree = ProfileTree::new("persist-rollback");
    let mut snapshot = snapshot_for(&tree.backend);
    let before: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();

    let failure = apply(&mut snapshot, resolve, |_| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "injected store failure",
        ))
    })
    .unwrap_err();

    assert!(
        matches!(failure, ProfileAncestorFailure::Precondition(_)),
        "{failure:?}"
    );
    let after: Vec<_> = tree.ancestors().iter().map(|path| aces_of(path)).collect();
    assert_eq!(after, before);
    assert!(snapshot.profile_ancestor_aces.is_empty());
}

#[test]
fn a_missing_ancestor_is_a_precondition_and_nothing_is_written() {
    let root = unique_temp_path("missing-ancestor");
    let app_data = root.join(r"someone\AppData");
    fs::create_dir_all(&app_data).unwrap();
    let before = aces_of(&app_data);
    let mut snapshot = snapshot_for(&app_data.join(r"Local\SuperClaw\backend"));

    let failure = apply(&mut snapshot, resolve, |_| {
        panic!("a refused apply must not persist")
    })
    .unwrap_err();

    assert!(
        matches!(&failure, ProfileAncestorFailure::Precondition(error) if error.kind() == io::ErrorKind::NotFound),
        "{failure:?}"
    );
    assert_eq!(aces_of(&app_data), before);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn revoke_attempts_every_ancestor_after_a_failure() {
    let tree = ProfileTree::new("revoke-best-effort");
    let mut snapshot = snapshot_for(&tree.backend);
    apply(&mut snapshot, resolve, |_| Ok(())).unwrap();
    let wanted = ace_bytes(&file_tool_ace(), FILE_TOOL_SID).unwrap();
    let first = tree.ancestors()[0].clone();

    let error = remove_from_snapshot_with(&snapshot, |path, ace, sids| {
        if path == first {
            Err(io::Error::other("injected first-ancestor failure"))
        } else {
            remove_ace(path, ace, sids)
        }
    })
    .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("injected first-ancestor failure")
    );
    assert!(aces_of(&first).1.contains(&wanted));
    for path in &tree.ancestors()[1..] {
        assert!(
            !aces_of(path).1.contains(&wanted),
            "{} was not attempted",
            path.display()
        );
    }
}

/// A profile folder is not ours: a foreign ACE the reader cannot decode does not hide the grant,
/// while the managed-root reader still refuses the same DACL.
#[test]
fn an_undecodable_foreign_ace_does_not_hide_the_grant() {
    const ACCESS_ALLOWED_CALLBACK_ACE_TYPE: u8 = 9;
    let tree = ProfileTree::new("callback-ace");
    let folder = &tree.ancestors()[0];
    let mut callback = ace_bytes(&file_tool_ace(), OTHER_TIER_SID).unwrap();
    callback[0] = ACCESS_ALLOWED_CALLBACK_ACE_TYPE;
    assert!(
        rewrite_dacl(folder, |aces| {
            let mut revised = aces.to_vec();
            revised.insert(0, callback.clone());
            Some(revised)
        })
        .unwrap()
    );
    assert!(add_ace(folder, &file_tool_ace(), FILE_TOOL_SID).unwrap());

    let handle = crate::managed_root_path::open_managed_root_for_read_control(folder).unwrap();
    assert!(matches!(
        crate::managed_root_dacl::read_dacl(&handle),
        Err(crate::managed_root_dacl::DaclDrift::UndecodableAce { index: 0, ace_type: ACCESS_ALLOWED_CALLBACK_ACE_TYPE })
    ));
    assert!(
        crate::profile_ancestors::carries_grant(folder, &file_tool_ace(), FILE_TOOL_SID).unwrap()
    );
    assert!(
        !crate::profile_ancestors::carries_grant(folder, &file_tool_ace(), STALE_SID).unwrap()
    );
}

#[test]
fn removal_leaves_a_look_alike_ace_alone() {
    let tree = ProfileTree::new("look-alike");
    let folder = &tree.ancestors()[0];
    let look_alike = ExpectedAce {
        mask: FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        ..file_tool_ace()
    };
    assert!(add_ace(folder, &look_alike, FILE_TOOL_SID).unwrap());
    assert!(add_ace(folder, &file_tool_ace(), OTHER_TIER_SID).unwrap());
    let with_both = aces_of(folder);
    assert!(add_ace(folder, &file_tool_ace(), FILE_TOOL_SID).unwrap());

    assert!(remove_ace(folder, &file_tool_ace(), &[FILE_TOOL_SID.to_owned()]).unwrap());
    assert_eq!(
        aces_of(folder),
        with_both,
        "a wider ACE for the same SID and the same ACE for another SID both survive"
    );
}

/// The apply must not walk children. A child carrying an "inherited" ACE its parent does not
/// actually offer is the sentinel: any re-propagation recomputes the child's inherited ACEs from the
/// parent and drops it. The positive control re-propagates with `SetSecurityInfo` and shows the
/// sentinel really does disappear, so its survival above is evidence and not a test that cannot fail.
#[test]
fn adding_the_ace_does_not_repropagate_inheritance_to_children() {
    let tree = ProfileTree::new("no-propagation");
    let parent = &tree.ancestors()[2];
    let nested = parent.join("nested");
    let deeper = nested.join("deeper");
    fs::create_dir_all(&deeper).unwrap();
    for index in 0..1000 {
        fs::write(parent.join(format!("child-{index}.txt")), b"x").unwrap();
    }
    let sentinel_holders = [nested, deeper];
    let stale = ExpectedAce {
        flags: INHERITED_ACE_FLAG,
        mask: FILE_READ_DATA,
        ..file_tool_ace()
    };
    let stale_bytes = ace_bytes(&stale, STALE_SID).unwrap();
    for holder in &sentinel_holders {
        assert!(
            rewrite_dacl(holder, |aces| {
                let mut revised = aces.to_vec();
                revised.push(stale_bytes.clone());
                Some(revised)
            })
            .unwrap()
        );
    }
    let children_before: Vec<_> = sentinel_holders.iter().map(|path| aces_of(path)).collect();

    let started = Instant::now();
    assert!(add_ace(parent, &file_tool_ace(), FILE_TOOL_SID).unwrap());
    let low_level = started.elapsed();
    let children_after: Vec<_> = sentinel_holders.iter().map(|path| aces_of(path)).collect();
    assert_eq!(
        children_after, children_before,
        "a child descriptor changed"
    );

    let handle = open_path_for_dacl_apply_preserving_owner(parent, true).unwrap();
    let (_, revision, aces) = read_aces(handle.raw()).unwrap();
    let size = size_of::<ACL>() + aces.iter().map(Vec::len).sum::<usize>();
    let mut acl = vec![0u32; size.div_ceil(4)];
    let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
    unsafe {
        assert_ne!(InitializeAcl(acl_ptr, size as u32, u32::from(revision)), 0);
        for ace in &aces {
            assert_ne!(
                AddAce(
                    acl_ptr,
                    u32::from(revision),
                    u32::MAX,
                    ace.as_ptr().cast(),
                    ace.len() as u32
                ),
                0
            );
        }
    }
    let started = Instant::now();
    let status = unsafe {
        SetSecurityInfo(
            handle.raw(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl_ptr,
            null_mut(),
        )
    };
    let propagating = started.elapsed();
    assert_eq!(status, 0);
    eprintln!(
        "profile ancestor apply over 1000 files and two nested folders: \
         SetKernelObjectSecurity {low_level:?}, \
         SetSecurityInfo {propagating:?}"
    );
    for holder in &sentinel_holders {
        assert!(
            !aces_of(holder).1.contains(&stale_bytes),
            "positive control: SetSecurityInfo should have re-propagated over {}",
            holder.display()
        );
    }
}
