//! Writing tier credential files, and the elevated read that repairs a drifted descriptor.
//!
//! The descriptor these files must carry, the path they live at and the unprivileged read that
//! verifies both are `credential_read`; this module is the half that needs an administrator token.
//! Everything here derives its expected descriptor from `credential_read::credential_dacl_sddl`, so
//! the writer cannot produce a shape the reader would refuse, and the split keeps every DACL write
//! out of the module the unelevated launcher links. See `credential_read`'s header for the
//! descriptor's rationale and for the host-policy dependency the owner read relies on.

use crate::acl_windows::ensure_broker_directory;
use crate::credential_read::{
    DescriptorState, MAX_CREDENTIAL_SIZE, credential_dacl_sddl, descriptor_state, open_credential,
    read_bounded_payload,
};
use crate::identity_windows::verify_owner_sid_names_a_user;
use crate::security_descriptor::{
    OwnedHandle, OwnedSecurityDescriptor, expected_dacl_bytes, verify_plain_handle, write_all,
};
use crate::security_descriptor_apply::{AclApplyOutcome, apply_sddl_dacl_and_verify};
use crate::wide::to_wide;
use std::io;
use std::path::Path;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_ALWAYS, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT,
    FlushFileBuffers, READ_CONTROL, WRITE_DAC,
};

/// Creates or replaces a credential blob, then proves the descriptor by exact readback.
///
/// The descriptor is applied before any payload byte is written, so the blob is never briefly
/// readable under a descriptor the broker has not verified.
pub fn write_credential(path: &Path, owner_sid: &str, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_CREDENTIAL_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "tier credential exceeds its size bound",
        ));
    }
    // The ACE about to be written is a grant, so the owner must resolve to a user and not a group.
    // The check sits at the write rather than only at provision ingress, so a future caller cannot
    // mint an owner ACE without it.
    verify_owner_sid_names_a_user(owner_sid)?;
    let sddl = credential_dacl_sddl(owner_sid)?;
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "tier credential path has no parent",
        )
    })?;
    // The directory stays SYSTEM + Administrators: the owner reads one derived path, never a listing.
    ensure_broker_directory(parent)?;

    let mut descriptor = OwnedSecurityDescriptor::from_sddl(&sddl)?;
    let attributes = descriptor.security_attributes();
    let path_wide = to_wide(path);
    // SAFETY: path_wide is NUL-terminated and attributes outlives the call.
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            GENERIC_WRITE | READ_CONTROL | WRITE_DAC,
            0,
            &attributes,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let handle = OwnedHandle::new(handle);
    verify_plain_handle(handle.raw(), false)?;
    apply_sddl_dacl_and_verify(handle.raw(), &sddl)?;
    write_all(handle.raw(), payload)?;
    // SAFETY: handle is an open, writable file handle owned by this scope.
    if unsafe { FlushFileBuffers(handle.raw()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Reads a credential blob from the elevated broker, converging a drifted descriptor first.
///
/// This is the only path that repairs a credential written under the previous `SY + BA` descriptor:
/// without it, an upgraded broker would read its own state as drift and refuse provision, ACL apply
/// and launch alike, and re-running provision would never fix it.
///
/// Convergence and read share one handle, taken with `WRITE_DAC` up front, rather than repairing
/// through one handle and reading through another. Two reasons, in that order. The descriptor that
/// gets verified then belongs to the object that gets read even across a repair, with no window
/// between the two opens for the path to be swapped underneath. And an elevated read costs one
/// `CreateFileW` plus one `GetSecurityInfo` on a converged blob - the overwhelmingly common case,
/// and one that every ACL apply, status and launch pays - instead of two of each.
///
/// The returned outcome distinguishes the repair from the no-op, which is what lets a caller
/// observe that a converged credential is never rewritten.
///
/// The semantic owner check runs only on the repair branch, because only that branch writes an ACE.
/// A converged blob therefore still costs one `CreateFileW` plus one `GetSecurityInfo` and no name
/// lookup, while a pre-P3 blob whose recorded owner is a group is refused instead of being widened.
pub fn read_credential_converging(
    path: &Path,
    owner_sid: &str,
) -> io::Result<(Vec<u8>, AclApplyOutcome)> {
    let sddl = credential_dacl_sddl(owner_sid)?;
    let expected = expected_dacl_bytes(&sddl)?;
    let handle = open_credential(path, GENERIC_READ | READ_CONTROL | WRITE_DAC)?;
    // `apply_sddl_dacl_and_verify` proves the result by readback under the same predicate
    // `descriptor_state` applies, so a successful apply needs no second verification here.
    let outcome = match descriptor_state(handle.raw(), &expected)? {
        DescriptorState::Converged => AclApplyOutcome::AlreadyConverged,
        DescriptorState::Unprotected | DescriptorState::Mismatched(_) => {
            verify_owner_sid_names_a_user(owner_sid).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "refusing to widen {} to its recorded owner: {error}; revoke this owner's \
                         identities and reprovision instead",
                        path.display()
                    ),
                )
            })?;
            apply_sddl_dacl_and_verify(handle.raw(), &sddl)?
        }
    };
    Ok((read_bounded_payload(handle.raw())?, outcome))
}

/// The cases that put a real descriptor on a real file, which is why they live here rather than in
/// `credential_read`: applying one is this side's privilege. What they assert is mostly about the
/// *reader* - a reader that accepts drift is the failure that matters - so `read_credential_for_owner`
/// appears throughout.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::acl_windows::BROKER_FILE_DACL;
    use crate::credential_read::{credential_path, read_credential_for_owner};
    use crate::security_descriptor::unique_temp_path;
    use crate::security_descriptor_apply::open_path_for_dacl_apply;
    use crate::sid_win32::current_process_sid;
    use std::fs;
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
    use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetSecurityInfo};
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, UNPROTECTED_DACL_SECURITY_INFORMATION,
    };

    /// A well-formed SID for a standard local user that is not in Administrators. It never has to
    /// resolve to a real account: SDDL only requires the SID to be well formed, which is exactly
    /// how a standard-user owner is exercised without provisioning one.
    ///
    /// That it resolves to nothing is load-bearing in one place - it is what makes
    /// `the_converging_read_refuses_to_widen_a_blob_to_an_unvouched_owner` reach the semantic gate -
    /// and harmless everywhere else, because no other test here writes an owner ACE for it.
    const STANDARD_USER_SID: &str = "S-1-5-21-1178594758-1067165089-3282905936-1013";

    /// A temp credential blob plus a handle that already carries `WRITE_DAC`.
    ///
    /// Access is granted at open time, so a handle taken while the file still carries its inherited
    /// "owner has full control" descriptor keeps the right to rewrite that descriptor afterwards.
    /// The detour is necessary because an unelevated owner cannot re-acquire `WRITE_DAC` through
    /// `CreateFileW` once the descriptor stops naming it - measured on this platform, not assumed -
    /// which is the same property that keeps descriptor control with the elevated broker after P3.
    /// Tests that walk one file through several descriptors therefore hold a handle rather than
    /// reopening between steps.
    fn temp_credential_with_dacl_handle(label: &str, payload: &[u8]) -> (PathBuf, OwnedHandle) {
        let path = unique_temp_path(label);
        fs::write(&path, payload).unwrap();
        let handle = open_path_for_dacl_apply(&path, false).unwrap();
        (path, handle)
    }

    /// Puts the credential descriptor on an existing file, as setup rather than as the property under
    /// test. Kept separate from `read_credential_converging` so it also works for a file whose
    /// contents that function would refuse.
    fn seed_credential_descriptor(path: &Path, owner: &str) {
        let handle = open_path_for_dacl_apply(path, false).unwrap();
        apply_sddl_dacl_and_verify(handle.raw(), &credential_dacl_sddl(owner).unwrap()).unwrap();
    }

    #[test]
    fn write_credential_refuses_a_payload_over_the_size_bound() {
        // Checked before any filesystem or Win32 access, so a blob that would defeat the read side's
        // bound never reaches disk in the first place.
        let path = unique_temp_path("credential-oversize");
        let owner = current_process_sid().unwrap();
        let error =
            write_credential(&path, &owner, &vec![0u8; MAX_CREDENTIAL_SIZE + 1]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(!path.exists(), "an over-sized write must leave no file");
    }

    /// The production write path, end to end. This is the P3 elevated acceptance expressed as a test:
    /// run it with `cargo test -- --ignored` on an administrator token.
    ///
    /// It cannot run unelevated, and the reason is the boundary itself: `write_credential` puts the
    /// blob inside a directory it first locks down to `SY + BA`, so creating the file needs
    /// `FILE_ADD_FILE` on a directory that deliberately gives the owner no ACE. Everything an
    /// unelevated owner can prove about this module is proven by the tests above; what is left is
    /// exactly what an administrator token adds.
    #[test]
    #[ignore = "needs an administrator token: the credential's parent directory is SYSTEM + Administrators"]
    fn write_credential_round_trips_under_the_descriptor_it_applies() {
        let state_dir = unique_temp_path("credential-round-trip");
        let owner = current_process_sid().unwrap();
        let path = credential_path(&state_dir, "SCBTESTROUNDTRIP");
        let payload = b"tier-credential-blob".repeat(8);
        write_credential(&path, &owner, &payload).unwrap();

        assert_eq!(read_credential_for_owner(&path, &owner).unwrap(), payload);
        // Born converged, so the elevated read returns the same bytes without rewriting the
        // descriptor it just verified.
        assert_eq!(
            read_credential_converging(&path, &owner).unwrap(),
            (payload.clone(), AclApplyOutcome::AlreadyConverged)
        );
        // The descriptor that landed is owner-specific, asserted against the real file rather than
        // against the SDDL string the writer was handed.
        let wrong_owner = read_credential_for_owner(&path, STANDARD_USER_SID).unwrap_err();
        assert_eq!(wrong_owner.kind(), io::ErrorKind::PermissionDenied);
        assert!(wrong_owner.to_string().contains("does not match"));

        fs::remove_file(&path).unwrap();
        fs::remove_dir(&state_dir).unwrap();
    }

    #[test]
    fn repair_converges_a_legacy_descriptor_onto_the_owner_read_descriptor() {
        // The upgrade case: a credential written by a pre-P3 broker carries `SY + BA`, which the read
        // path refuses as drift. Repair is what makes such a file readable by its owner again.
        let owner = current_process_sid().unwrap();
        let (path, handle) =
            temp_credential_with_dacl_handle("credential-repair", b"legacy-credential");
        apply_sddl_dacl_and_verify(handle.raw(), BROKER_FILE_DACL).unwrap();
        assert!(read_credential_for_owner(&path, &owner).is_err());

        // The production converging read opens the file for `WRITE_DAC`, which only the elevated
        // broker gets once the owner ACE is gone, so the convergence itself is driven through the
        // held handle here. The elevated acceptance covers that open; what is pinned here is the
        // descriptor result.
        assert_eq!(
            apply_sddl_dacl_and_verify(handle.raw(), &credential_dacl_sddl(&owner).unwrap())
                .unwrap(),
            AclApplyOutcome::Applied
        );
        drop(handle);

        assert_eq!(
            read_credential_for_owner(&path, &owner).unwrap(),
            b"legacy-credential"
        );

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_converging_read_applies_the_credential_descriptor_and_then_never_widens_it() {
        let path = unique_temp_path("credential-repair-converged");
        fs::write(&path, b"credential").unwrap();
        let owner = current_process_sid().unwrap();
        assert_eq!(
            read_credential_converging(&path, &owner).unwrap(),
            (b"credential".to_vec(), AclApplyOutcome::Applied)
        );
        // A second converging read needs `WRITE_DAC`, which the owner-read ACE deliberately does not
        // grant. An unelevated owner is refused outright - measured, not assumed: on this platform
        // the implicit `READ_CONTROL | WRITE_DAC` an object owner is usually described as holding is
        // not granted through `CreateFileW` once a protected descriptor stops naming it. An elevated
        // run reaches the file through the Administrators ACE and must report convergence. Asserting
        // both keeps the test meaningful under either token, and neither outcome may be a silent
        // rewrite.
        match read_credential_converging(&path, &owner) {
            Err(error) => assert_eq!(error.kind(), io::ErrorKind::PermissionDenied),
            Ok((payload, outcome)) => {
                assert_eq!(payload, b"credential");
                assert_eq!(outcome, AclApplyOutcome::AlreadyConverged);
            }
        }
        assert_eq!(
            read_credential_for_owner(&path, &owner).unwrap(),
            b"credential"
        );

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_converging_read_refuses_to_widen_a_blob_to_an_unvouched_owner() {
        // Convergence is a grant, so it is gated by the same semantic owner check as provision and
        // `write_credential`. Without this, a pre-P3 credential whose recorded owner is a group - or
        // any SID this machine will not vouch for as a user - would be handed the read ACE on the
        // first elevated read, which is exactly the migration path the structural gate cannot see.
        let path = unique_temp_path("credential-unvouched-owner");
        fs::write(&path, b"credential").unwrap();

        let error = read_credential_converging(&path, STANDARD_USER_SID).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("refusing to widen"), "{error}");
        // Actionable, because the operator's way out is removal rather than a retry.
        assert!(error.to_string().contains("revoke"), "{error}");

        // And the refusal happened before the apply: the file still carries the inherited,
        // unprotected descriptor it was created with, so nothing was widened on the way out.
        let after = read_credential_for_owner(&path, STANDARD_USER_SID).unwrap_err();
        assert_eq!(after.kind(), io::ErrorKind::PermissionDenied);
        assert!(after.to_string().contains("not protected"), "{after}");

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_converging_read_reports_a_missing_credential_as_not_found() {
        // Absence surfaces as `NotFound`, not as a descriptor refusal. Callers decide whether a
        // credential should exist before they read one - `state::credential_exists` is what
        // provision and status classify presence with - so an absent blob reaching here is a real
        // error and must not be reported as a security failure.
        let path = unique_temp_path("credential-absent");
        let owner = current_process_sid().unwrap();
        let error = read_credential_converging(&path, &owner).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn credential_read_refuses_a_descriptor_naming_a_different_owner() {
        let path = unique_temp_path("credential-wrong-owner");
        fs::write(&path, b"credential").unwrap();
        let owner = current_process_sid().unwrap();
        seed_credential_descriptor(&path, &owner);

        let error = read_credential_for_owner(&path, STANDARD_USER_SID).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("does not match"));

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn credential_read_refuses_descriptor_drift() {
        let owner = current_process_sid().unwrap();
        let (path, handle) = temp_credential_with_dacl_handle("credential-drift", b"credential");
        apply_sddl_dacl_and_verify(handle.raw(), &credential_dacl_sddl(&owner).unwrap()).unwrap();
        assert!(read_credential_for_owner(&path, &owner).is_ok());

        // One extra ACE for the same owner is still drift: the check is exact, not "at least". This
        // is the case that matters, because a widening ACE is what an attacker would add.
        let drifted = format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;{owner})(A;;FA;;;{owner})");
        apply_sddl_dacl_and_verify(handle.raw(), &drifted).unwrap();
        let error = read_credential_for_owner(&path, &owner).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("does not match"));

        // A credential still carrying the old SY + BA descriptor is refused too, rather than being
        // silently accepted because it happens to be stricter.
        apply_sddl_dacl_and_verify(handle.raw(), BROKER_FILE_DACL).unwrap();
        assert_eq!(
            read_credential_for_owner(&path, &owner).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );

        drop(handle);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn credential_read_refuses_an_unprotected_dacl() {
        let owner = current_process_sid().unwrap();
        let (path, handle) =
            temp_credential_with_dacl_handle("credential-unprotected", b"credential");

        // The same three ACEs, with inheritance protection deliberately cleared: an unprotected DACL
        // can be widened later by an ACE inherited from the parent, so the read path must refuse it
        // even while the ACEs still look right.
        let descriptor =
            OwnedSecurityDescriptor::from_sddl(&credential_dacl_sddl(&owner).unwrap()).unwrap();
        // SAFETY: the handle carries WRITE_DAC and the DACL pointer is owned by `descriptor`.
        let status = unsafe {
            SetSecurityInfo(
                handle.raw(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                descriptor.dacl().unwrap(),
                null_mut(),
            )
        };
        assert_eq!(status, 0);
        drop(handle);

        let error = read_credential_for_owner(&path, &owner).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("not protected"));

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn credential_read_refuses_a_file_symlink_pointing_at_a_valid_blob() {
        // The case `FILE_FLAG_OPEN_REPARSE_POINT` exists for. The decoy carries the correct
        // descriptor, so an open that followed the link would verify the decoy and hand its bytes
        // back: substituting a path the attacker controls for the one the owner derived. The open
        // must land on the link itself and `verify_plain_handle` must refuse it.
        let decoy = unique_temp_path("credential-symlink-decoy");
        let link = unique_temp_path("credential-symlink");
        let owner = current_process_sid().unwrap();
        fs::write(&decoy, b"decoy-credential").unwrap();
        seed_credential_descriptor(&decoy, &owner);
        assert_eq!(
            read_credential_for_owner(&decoy, &owner).unwrap(),
            b"decoy-credential",
            "the decoy has to be a blob the read path would otherwise accept"
        );

        if std::os::windows::fs::symlink_file(&decoy, &link).is_err() {
            // Creating a file symlink needs `SeCreateSymbolicLinkPrivilege` or Developer Mode. Say so
            // rather than passing quietly: on such a host this case is covered only by the elevated
            // acceptance, and the reparse rejection itself stays covered by
            // `security_descriptor::plain_handle_verification_rejects_reparse_points_and_wrong_object_types`.
            eprintln!(
                "skipping the file-symlink case: this token cannot create a symlink (needs \
                 SeCreateSymbolicLinkPrivilege or Developer Mode)"
            );
            fs::remove_file(&decoy).unwrap();
            return;
        }

        let error = read_credential_for_owner(&link, &owner).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("reparse point"), "{error}");

        fs::remove_file(&link).unwrap();
        fs::remove_file(&decoy).unwrap();
    }

    #[test]
    fn credential_read_refuses_a_directory_junction_in_place_of_the_blob() {
        let target = unique_temp_path("credential-reparse-target");
        let link = unique_temp_path("credential-reparse-link");
        fs::create_dir(&target).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J is required for this test");

        // A junction is refused earlier than a file symlink is, and for a second reason worth
        // pinning: the credential open deliberately omits `FILE_FLAG_BACKUP_SEMANTICS`, so it cannot
        // obtain a handle to a directory at all and never reaches the descriptor comparison.
        // Asserting the concrete refusal keeps this from passing for some third reason later.
        let owner = current_process_sid().unwrap();
        for error in [
            read_credential_for_owner(&link, &owner).unwrap_err(),
            read_credential_converging(&link, &owner).unwrap_err(),
        ] {
            assert_eq!(
                error.raw_os_error(),
                Some(ERROR_ACCESS_DENIED as i32),
                "a junction must be refused at the open, not somewhere later: {error}"
            );
        }

        fs::remove_dir(&link).unwrap();
        fs::remove_dir(&target).unwrap();
    }

    #[test]
    fn credential_read_enforces_its_size_bound() {
        let path = unique_temp_path("credential-oversized");
        fs::write(&path, vec![7u8; MAX_CREDENTIAL_SIZE + 1]).unwrap();
        let owner = current_process_sid().unwrap();
        seed_credential_descriptor(&path, &owner);

        assert_eq!(
            read_credential_for_owner(&path, &owner).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        fs::remove_file(path).unwrap();
    }
}
