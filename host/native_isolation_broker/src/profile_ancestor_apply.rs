//! Adding and removing the one ACE the descriptor puts on each profile ancestor, at provision and
//! revoke, without re-propagating inheritance.
//!
//! # Why not `SetSecurityInfo`
//!
//! `SetSecurityInfo` and `SetNamedSecurityInfo` recompute the inherited ACEs of every object below the
//! one they write. On `AppData` that walk took about four minutes, for an ACE that is not inheritable
//! and so changes nothing below it. `SetKernelObjectSecurity` on the verified handle writes this one
//! object's descriptor and touches no child. That is only correct because the DACL written back is the
//! DACL read, byte for byte, plus or minus exactly one non-inheriting ACE, with the protection and
//! auto-inherit bits copied across: there is nothing for a child to inherit that it did not have.
//!
//! # What is never changed
//!
//! These folders belong to the user profile. Their DACL is not replaced, not protected and not
//! canonicalised, their owner is not written, and an ACE this side did not add is never removed, even
//! one that looks like it.

use crate::acl_descriptor::{ExpectedAce, ProfileAncestorGrant, profile_ancestor_grants};
use crate::acl_rights::INHERITED_ACE_FLAG;
use crate::grant_store::{ProfileAncestorAce, WorkspaceAuthorizationSnapshot};
use crate::managed_root_path::same_managed_path;
use crate::profile_ancestors::derive;
use crate::security_descriptor::{OwnedHandle, OwnedLocal};
use crate::security_descriptor_apply::open_path_for_dacl_apply_preserving_owner;
use crate::wide::to_wide;
use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSidToSidW, GetSecurityInfo, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    ACE_HEADER, ACL, AddAce, DACL_SECURITY_INFORMATION, GetAce, GetLengthSid,
    GetSecurityDescriptorControl, GetSecurityDescriptorDacl, InitializeAcl,
    InitializeSecurityDescriptor, PSECURITY_DESCRIPTOR, SE_DACL_AUTO_INHERIT_REQ,
    SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED, SECURITY_DESCRIPTOR, SetKernelObjectSecurity,
    SetSecurityDescriptorControl, SetSecurityDescriptorDacl,
};

const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
const PRESERVED_CONTROL: u16 = SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED;

struct PlannedDaclChange {
    path: PathBuf,
    handle: OwnedHandle,
    control: u16,
    revision: u8,
    original: Vec<Vec<u8>>,
    revised: Vec<Vec<u8>>,
}

struct AncestorPlan {
    path: PathBuf,
    remove_sids: Vec<String>,
    add_sid: Option<String>,
}

/// Why an apply did not converge, split the way `AclApplyFailure` splits it.
#[derive(Debug)]
pub enum ProfileAncestorFailure {
    /// The descriptor, a tier identity, an ancestor folder or the snapshot store is not in place.
    Precondition(io::Error),
    /// A profile ancestor DACL could not be read or written.
    Dacl(io::Error),
    /// The backend sits in a profile-shaped tree that is not the requesting owner's own profile.
    NotOwnersProfile(String),
}

/// Converges every profile ancestor onto the current grant and records exactly the ACEs it inserted.
///
/// A recorded ACE that is no longer wanted - an old tier SID after rotation, or a folder the backend
/// has moved away from - is removed, and only that one. A wanted ACE already on the folder that no
/// record covers was put there by someone else: it is left alone and never recorded, so revoke cannot
/// take it away. All paths are opened and read before the first write. A failed write or failed
/// persistence restores every earlier DACL byte-for-byte and the previous records before returning.
///
/// A backend outside the fixed profile shape has no profile ancestors, so nothing is added. A backend
/// in that shape is only accepted when the folder above the chain is the owner's own profile, as
/// `owner_profile` reports it for `snapshot.owner_sid`: owning `backend_root` proves nothing about its
/// parents, so the derived folders are bound to the owner rather than to the shape alone.
pub fn apply_from_snapshot(
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    owner_profile: impl FnOnce(&str) -> io::Result<Option<String>>,
    resolve: impl Fn(&str) -> io::Result<String>,
    persist: impl FnOnce(&WorkspaceAuthorizationSnapshot) -> io::Result<()>,
) -> Result<usize, ProfileAncestorFailure> {
    apply_from_snapshot_with(snapshot, owner_profile, resolve, persist, |_, _| Ok(()))
}

fn apply_from_snapshot_with(
    snapshot: &mut WorkspaceAuthorizationSnapshot,
    owner_profile: impl FnOnce(&str) -> io::Result<Option<String>>,
    resolve: impl Fn(&str) -> io::Result<String>,
    persist: impl FnOnce(&WorkspaceAuthorizationSnapshot) -> io::Result<()>,
    mut before_write: impl FnMut(usize, &Path) -> io::Result<()>,
) -> Result<usize, ProfileAncestorFailure> {
    use ProfileAncestorFailure::{Dacl, Precondition};
    let grants = profile_ancestor_grants().map_err(Precondition)?;
    let ace = ace_shape(&grants).map_err(Precondition)?;
    let target_paths = authorized_targets(snapshot, &grants, owner_profile)?;
    let mut targets = Vec::new();
    for (path, grant) in target_paths.iter().zip(&grants) {
        targets.push(ProfileAncestorAce {
            path: path.to_string_lossy().into_owned(),
            sid: resolve(&grant.ace.principal).map_err(Precondition)?,
        });
    }
    let is_target = |record: &ProfileAncestorAce| targets.iter().any(|t| same_record(t, record));

    let mut plans: Vec<AncestorPlan> = Vec::new();
    for record in &snapshot.profile_ancestor_aces {
        if !is_target(record) {
            plan_for(&mut plans, Path::new(&record.path))
                .remove_sids
                .push(record.sid.clone());
        }
    }
    for target in &targets {
        plan_for(&mut plans, Path::new(&target.path)).add_sid = Some(target.sid.clone());
    }

    let mut records: Vec<ProfileAncestorAce> = snapshot
        .profile_ancestor_aces
        .iter()
        .filter(|record| is_target(record))
        .cloned()
        .collect();
    let mut changes = Vec::new();
    for plan in plans {
        if !plan.path.exists() {
            if plan.add_sid.is_some() {
                return Err(Precondition(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("profile ancestor does not exist: {}", plan.path.display()),
                )));
            }
            continue;
        }
        let handle = open_path_for_dacl_apply_preserving_owner(&plan.path, true).map_err(Dacl)?;
        let (control, revision, original) = read_aces(handle.raw()).map_err(Dacl)?;
        let revised = revise_aces(&original, &ace, &plan.remove_sids, plan.add_sid.as_deref())
            .map_err(Dacl)?;
        if let Some(sid) = &plan.add_sid {
            let inserted = !original.contains(&ace_bytes(&ace, sid).map_err(Dacl)?);
            let record = ProfileAncestorAce {
                path: plan.path.to_string_lossy().into_owned(),
                sid: sid.clone(),
            };
            if inserted && !records.iter().any(|kept| same_record(kept, &record)) {
                records.push(record);
            }
        }
        if revised != original {
            changes.push(PlannedDaclChange {
                path: plan.path,
                handle,
                control,
                revision,
                original,
                revised,
            });
        }
    }

    let mut written = 0;
    for (index, change) in changes.iter().enumerate() {
        if let Err(error) = before_write(index, &change.path) {
            return Err(Dacl(rollback_after(error, &changes[..written])));
        }
        if let Err(error) = write_and_verify(change, &change.revised) {
            return Err(Dacl(rollback_after(error, &changes[..=index])));
        }
        written += 1;
    }

    let previous_records = std::mem::replace(&mut snapshot.profile_ancestor_aces, records);
    if let Err(error) = persist(snapshot) {
        snapshot.profile_ancestor_aces = previous_records;
        return Err(Precondition(rollback_after(error, &changes[..written])));
    }
    Ok(written)
}

/// Refuses a backend in a profile-shaped tree that is not the owner's own profile, writing nothing.
///
/// The ACL apply calls this before it converges any root, so this refusal has no ACL side effects;
/// `apply_from_snapshot` checks it again itself.
pub fn authorize_owner_profile(
    snapshot: &WorkspaceAuthorizationSnapshot,
    owner_profile: impl FnOnce(&str) -> io::Result<Option<String>>,
) -> Result<(), ProfileAncestorFailure> {
    let grants = profile_ancestor_grants().map_err(ProfileAncestorFailure::Precondition)?;
    authorized_targets(snapshot, &grants, owner_profile).map(|_| ())
}

fn authorized_targets(
    snapshot: &WorkspaceAuthorizationSnapshot,
    grants: &[ProfileAncestorGrant],
    owner_profile: impl FnOnce(&str) -> io::Result<Option<String>>,
) -> Result<Vec<PathBuf>, ProfileAncestorFailure> {
    use ProfileAncestorFailure::{NotOwnersProfile, Precondition};
    let target_paths = snapshot
        .managed_roots
        .get("backend_root")
        .and_then(|backend| derive(Path::new(backend), grants))
        .unwrap_or_default();
    if let Some(profile) = target_paths.first().and_then(|first| first.parent()) {
        match owner_profile(&snapshot.owner_sid).map_err(Precondition)? {
            Some(owned) if same_managed_path(profile, Path::new(&owned)) => {}
            Some(owned) => {
                return Err(NotOwnersProfile(format!(
                    "backend_root is under {} rather than the owner's profile {owned}",
                    profile.display()
                )));
            }
            None => {
                return Err(NotOwnersProfile(
                    "the owner has no recorded profile to bind profile ancestors to".to_owned(),
                ));
            }
        }
    }
    Ok(target_paths)
}

/// Removes each recorded profile ancestor ACE - that folder, that SID - and nothing else.
///
/// Matched by every byte - type, flags, mask and SID - so an ACE someone else added for the same
/// account with any other shape survives, and so does an identical ACE no record covers. A folder that
/// no longer exists has nothing to remove. Best effort: every record is attempted and the first failure
/// is returned afterwards.
pub fn remove_from_snapshot(snapshot: &WorkspaceAuthorizationSnapshot) -> io::Result<usize> {
    remove_from_snapshot_with(snapshot, remove_ace)
}

fn remove_from_snapshot_with(
    snapshot: &WorkspaceAuthorizationSnapshot,
    mut remove: impl FnMut(&Path, &ExpectedAce, &[String]) -> io::Result<bool>,
) -> io::Result<usize> {
    if snapshot.profile_ancestor_aces.is_empty() {
        return Ok(0);
    }
    let ace = ace_shape(&profile_ancestor_grants()?)?;
    let mut written = 0;
    let mut first_error = None;
    for record in &snapshot.profile_ancestor_aces {
        let path = Path::new(&record.path);
        if !path.exists() {
            continue;
        }
        match remove(path, &ace, std::slice::from_ref(&record.sid)) {
            Ok(true) => written += 1,
            Ok(false) => {}
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    first_error.map_or(Ok(written), Err)
}

/// The one ACE shape every profile ancestor grant uses; the principal is whatever SID was recorded.
///
/// The contract refuses any grant but allow `FILE_READ_ATTRIBUTES` on the folder itself, so a record's
/// folder and SID are enough to rebuild the exact ACE to remove, whichever grant it came from.
fn ace_shape(grants: &[ProfileAncestorGrant]) -> io::Result<ExpectedAce> {
    let invalid = |message: &str| io::Error::new(io::ErrorKind::InvalidData, message.to_owned());
    let first = &grants
        .first()
        .ok_or_else(|| invalid("the ACL policy descriptor declares no profile ancestor grants"))?
        .ace;
    if grants.iter().any(|grant| {
        grant.ace.allow != first.allow
            || grant.ace.mask != first.mask
            || grant.ace.flags != first.flags
    }) {
        return Err(invalid(
            "the profile ancestor grants disagree on the shape of the ACE they add",
        ));
    }
    Ok(first.clone())
}

fn plan_for<'plans>(plans: &'plans mut Vec<AncestorPlan>, path: &Path) -> &'plans mut AncestorPlan {
    let index = match plans.iter().position(|plan| same_path(&plan.path, path)) {
        Some(index) => index,
        None => {
            plans.push(AncestorPlan {
                path: path.to_owned(),
                remove_sids: Vec::new(),
                add_sid: None,
            });
            plans.len() - 1
        }
    };
    &mut plans[index]
}

fn same_record(left: &ProfileAncestorAce, right: &ProfileAncestorAce) -> bool {
    left.sid.eq_ignore_ascii_case(&right.sid)
        && same_path(Path::new(&left.path), Path::new(&right.path))
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn revise_aces(
    aces: &[Vec<u8>],
    ace: &ExpectedAce,
    remove_sids: &[String],
    add_sid: Option<&str>,
) -> io::Result<Vec<Vec<u8>>> {
    let unwanted = remove_sids
        .iter()
        .map(|sid| ace_bytes(ace, sid))
        .collect::<io::Result<Vec<_>>>()?;
    let mut revised: Vec<Vec<u8>> = aces
        .iter()
        .filter(|existing| !unwanted.contains(existing))
        .cloned()
        .collect();
    if let Some(sid) = add_sid {
        let wanted = ace_bytes(ace, sid)?;
        if !revised.contains(&wanted) {
            let at = revised
                .iter()
                .position(|existing| existing[1] & INHERITED_ACE_FLAG != 0)
                .unwrap_or(revised.len());
            revised.insert(at, wanted);
        }
    }
    Ok(revised)
}

fn write_and_verify(change: &PlannedDaclChange, aces: &[Vec<u8>]) -> io::Result<()> {
    write_aces(change.handle.raw(), change.control, change.revision, aces)?;
    let (control_after, _, readback) = read_aces(change.handle.raw())?;
    if readback != aces || control_after & PRESERVED_CONTROL != change.control & PRESERVED_CONTROL {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "profile ancestor DACL readback for {} is not the DACL written",
                change.path.display()
            ),
        ));
    }
    Ok(())
}

fn rollback_after(primary: io::Error, applied: &[PlannedDaclChange]) -> io::Error {
    let mut rollback_errors = Vec::new();
    for change in applied.iter().rev() {
        if let Err(error) = write_and_verify(change, &change.original) {
            rollback_errors.push(format!("{}: {error}", change.path.display()));
        }
    }
    if rollback_errors.is_empty() {
        primary
    } else {
        io::Error::new(
            primary.kind(),
            format!(
                "{primary}; profile ancestor rollback also failed: {}",
                rollback_errors.join("; ")
            ),
        )
    }
}

/// Adds `ace` naming `sid` to the folder unless it is already there. Returns whether it wrote.
///
/// The ACE goes after the last explicit ACE, before the inherited ones, which is where a canonical
/// DACL keeps an explicit allow.
#[cfg(test)]
pub fn add_ace(path: &Path, ace: &ExpectedAce, sid: &str) -> io::Result<bool> {
    let wanted = ace_bytes(ace, sid)?;
    rewrite_dacl(path, |aces| {
        if aces.contains(&wanted) {
            return None;
        }
        let at = aces
            .iter()
            .position(|existing| existing[1] & INHERITED_ACE_FLAG != 0)
            .unwrap_or(aces.len());
        let mut revised = aces.to_vec();
        revised.insert(at, wanted.clone());
        Some(revised)
    })
}

/// Removes `ace` naming any of `sids` from the folder. Returns whether it wrote.
pub fn remove_ace(path: &Path, ace: &ExpectedAce, sids: &[String]) -> io::Result<bool> {
    let unwanted = sids
        .iter()
        .map(|sid| ace_bytes(ace, sid))
        .collect::<io::Result<Vec<_>>>()?;
    rewrite_dacl(path, |aces| {
        let revised: Vec<Vec<u8>> = aces
            .iter()
            .filter(|existing| !unwanted.contains(existing))
            .cloned()
            .collect();
        (revised.len() != aces.len()).then_some(revised)
    })
}

/// One folder's DACL, read and written through a single verified handle.
///
/// `edit` returns `None` when the folder is already converged, which writes nothing. After a write the
/// DACL is read back off the same handle and must be exactly what was written, with the protection and
/// auto-inherit bits as they were.
pub(crate) fn rewrite_dacl(
    path: &Path,
    edit: impl FnOnce(&[Vec<u8>]) -> Option<Vec<Vec<u8>>>,
) -> io::Result<bool> {
    let handle = open_path_for_dacl_apply_preserving_owner(path, true)?;
    let (control, revision, aces) = read_aces(handle.raw())?;
    let Some(revised) = edit(&aces) else {
        return Ok(false);
    };
    write_aces(handle.raw(), control, revision, &revised)?;
    let (control_after, _, readback) = read_aces(handle.raw())?;
    if readback != revised || control_after & PRESERVED_CONTROL != control & PRESERVED_CONTROL {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "profile ancestor DACL readback for {} is not the DACL written",
                path.display()
            ),
        ));
    }
    Ok(true)
}

/// The descriptor control word, the ACL revision and every ACE as raw bytes, in order.
fn read_aces(handle: HANDLE) -> io::Result<(u16, u8, Vec<Vec<u8>>)> {
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: The handle is live with READ_CONTROL; unused outputs are optional and the descriptor
    // receives LocalAlloc memory owned below.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let descriptor = OwnedLocal(descriptor);
    let (mut control, mut sd_revision) = (0u16, 0u32);
    // SAFETY: The descriptor is valid and both outputs are writable.
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut sd_revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let (mut present, mut defaulted, mut dacl) = (0, 0, null_mut::<ACL>());
    // SAFETY: The descriptor is valid and all three outputs are writable.
    if unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    if present == 0 || dacl.is_null() {
        // A NULL DACL grants everyone everything; adding one ACE would take that away.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "a profile ancestor has no DACL, so adding an ACE would narrow it",
        ));
    }
    // SAFETY: The DACL is interior to the descriptor, which is alive for this whole block.
    let (revision, count) = unsafe { ((*dacl).AclRevision, (*dacl).AceCount) };
    let mut aces = Vec::with_capacity(usize::from(count));
    for index in 0..count {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: index is below AceCount and ace receives an interior pointer.
        if unsafe { GetAce(dacl, u32::from(index), &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetAce returned a well-formed ACE whose AceSize bytes lie within the DACL.
        let bytes = unsafe {
            let size = usize::from((*ace.cast::<ACE_HEADER>()).AceSize);
            std::slice::from_raw_parts(ace.cast::<u8>(), size).to_vec()
        };
        aces.push(bytes);
    }
    Ok((control, revision, aces))
}

/// Writes `aces` as this object's whole DACL with `SetKernelObjectSecurity`, which does not walk
/// children.
fn write_aces(handle: HANDLE, control: u16, revision: u8, aces: &[Vec<u8>]) -> io::Result<()> {
    let size = size_of::<ACL>() + aces.iter().map(Vec::len).sum::<usize>();
    let size = u32::try_from(size)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "DACL too large"))?;
    let mut acl = vec![0u32; (size as usize).div_ceil(4)];
    let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
    // SAFETY: The buffer is at least `size` bytes and DWORD-aligned.
    if unsafe { InitializeAcl(acl_ptr, size, u32::from(revision)) } == 0 {
        return Err(io::Error::last_os_error());
    }
    for ace in aces {
        // SAFETY: Each entry is one complete ACE read off a DACL or built by `ace_bytes`.
        if unsafe {
            AddAce(
                acl_ptr,
                u32::from(revision),
                u32::MAX,
                ace.as_ptr().cast(),
                ace.len() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    // The kernel clears SE_DACL_AUTO_INHERITED on a low-level write unless the request asks to keep
    // auto-inheritance. That request is honoured on this object alone; only SetSecurityInfo walks
    // children.
    let requested = if control & SE_DACL_AUTO_INHERITED != 0 {
        control & PRESERVED_CONTROL | SE_DACL_AUTO_INHERIT_REQ
    } else {
        control & PRESERVED_CONTROL
    };
    // SAFETY: An all-zero SECURITY_DESCRIPTOR is valid storage for InitializeSecurityDescriptor.
    let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let descriptor_ptr = std::ptr::addr_of_mut!(descriptor).cast::<c_void>();
    // SAFETY: The descriptor and ACL outlive every call below; the ACL is absolute, not self-relative.
    unsafe {
        if InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) == 0
            || SetSecurityDescriptorDacl(descriptor_ptr, 1, acl_ptr, 0) == 0
            || SetSecurityDescriptorControl(
                descriptor_ptr,
                PRESERVED_CONTROL | SE_DACL_AUTO_INHERIT_REQ,
                requested,
            ) == 0
            || SetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION, descriptor_ptr) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// The exact bytes of `ace` naming `sid`: header, mask, then the SID inline.
fn ace_bytes(ace: &ExpectedAce, sid: &str) -> io::Result<Vec<u8>> {
    let wide = to_wide(sid);
    let mut sid_ptr = null_mut();
    // SAFETY: The input is NUL-terminated and the output receives LocalAlloc memory owned below.
    if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid_ptr) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let sid_owner = OwnedLocal(sid_ptr);
    // SAFETY: ConvertStringSidToSidW returned a valid SID of GetLengthSid bytes.
    let sid_bytes = unsafe {
        std::slice::from_raw_parts(sid_owner.0.cast::<u8>(), GetLengthSid(sid_owner.0) as usize)
    };
    let size = u16::try_from(8 + sid_bytes.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "ACE too large"))?;
    let mut bytes = vec![u8::from(!ace.allow), ace.flags];
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.extend_from_slice(&ace.mask.to_le_bytes());
    bytes.extend_from_slice(sid_bytes);
    Ok(bytes)
}

#[cfg(test)]
mod tests;
