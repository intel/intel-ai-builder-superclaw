//! Apply/readback tests for the security-descriptor primitives.
//!
//! These run against real files and real junctions rather than against a mocked kernel, because every
//! claim here is a claim about what Win32 actually did: that a DACL came back byte-for-byte as asked, that
//! a converged apply wrote nothing, that a revoke really removed a SID, and that a handle whose object is
//! not the path that was asked for is refused rather than written to.

use super::*;
use crate::security_descriptor_apply::{
    AclApplyOutcome, apply_sddl_dacl_and_verify, open_path_for_dacl_apply,
    revoke_explicit_sids_from_path,
};
use crate::sid_win32::current_process_sid;
use crate::wide::to_wide;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_READ, FILE_SHARE_WRITE, GetShortPathNameW, OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
};

#[test]
fn handle_dacl_apply_is_exact_verified_and_idempotent() {
    let path = unique_temp_path("acl");
    fs::write(&path, b"acl-test").unwrap();
    let wide_path = to_wide(&path);
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            READ_CONTROL | WRITE_DAC,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    assert_ne!(handle, INVALID_HANDLE_VALUE);
    let owner_sid = current_process_sid().unwrap();
    let expected = format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{owner_sid})");

    assert_eq!(
        apply_sddl_dacl_and_verify(handle, &expected).unwrap(),
        AclApplyOutcome::Applied
    );
    assert_eq!(
        apply_sddl_dacl_and_verify(handle, &expected).unwrap(),
        AclApplyOutcome::AlreadyConverged
    );

    unsafe {
        CloseHandle(handle);
    }
    fs::remove_file(path).unwrap();
}

#[test]
fn handle_dacl_revoke_removes_named_sid_and_verifies_readback() {
    let path = unique_temp_path("acl-revoke");
    fs::write(&path, b"acl-revoke-test").unwrap();
    let handle = open_path_for_dacl_apply(&path, false).unwrap();
    let owner_sid = current_process_sid().unwrap();
    let with_owner = format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{owner_sid})");
    apply_sddl_dacl_and_verify(handle.raw(), &with_owner).unwrap();

    revoke_explicit_sids_from_path(&path, false, std::slice::from_ref(&owner_sid)).unwrap();
    let readback = read_security_descriptor_for_handle(handle.raw()).unwrap();
    assert!(!readback.dacl_sddl().unwrap().contains(&owner_sid));

    apply_sddl_dacl_and_verify(handle.raw(), &with_owner).unwrap();
    drop(handle);
    fs::remove_file(path).unwrap();
}

#[test]
fn handle_dacl_revoke_removes_every_named_sid_in_one_batch() {
    let path = unique_temp_path("acl-revoke-many");
    fs::create_dir(&path).unwrap();
    let handle = open_path_for_dacl_apply(&path, true).unwrap();
    let owner_sid = current_process_sid().unwrap();
    let revoked = vec![
        "S-1-1-0".to_owned(),
        "S-1-5-11".to_owned(),
        "S-1-5-32-545".to_owned(),
    ];
    let with_revoked = format!(
        "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{owner_sid}){}",
        revoked
            .iter()
            .map(|sid| format!("(D;OICI;FA;;;{sid})"))
            .collect::<String>()
    );
    apply_sddl_dacl_and_verify(handle.raw(), &with_revoked).unwrap();

    revoke_explicit_sids_from_path(&path, true, &revoked).unwrap();
    let readback = read_security_descriptor_for_handle(handle.raw()).unwrap();
    let readback = readback.dacl_sddl().unwrap();
    for sid in &revoked {
        assert!(!readback.contains(sid), "{sid} survived revoke: {readback}");
    }

    drop(handle);
    fs::remove_dir(path).unwrap();
}

#[test]
fn plain_handle_verification_rejects_reparse_points_and_wrong_object_types() {
    let target = unique_temp_path("reparse-target");
    let link = unique_temp_path("reparse-link");
    fs::create_dir(&target).unwrap();
    let status = Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .status()
        .unwrap();
    assert!(status.success(), "mklink /J is required for this test");

    let wide_link = to_wide(&link);
    let handle = unsafe {
        CreateFileW(
            wide_link.as_ptr(),
            READ_CONTROL,
            FILE_SHARE_READ,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    assert_ne!(handle, INVALID_HANDLE_VALUE);
    let reparse_error = verify_plain_handle(handle, true).unwrap_err();
    assert_eq!(reparse_error.kind(), io::ErrorKind::PermissionDenied);
    assert!(reparse_error.to_string().contains("reparse point"));
    unsafe {
        CloseHandle(handle);
    }

    // The same helper is what stops a directory being accepted where a file is required.
    let wide_target = to_wide(&target);
    let directory = unsafe {
        CreateFileW(
            wide_target.as_ptr(),
            READ_CONTROL,
            FILE_SHARE_READ,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    assert_ne!(directory, INVALID_HANDLE_VALUE);
    verify_plain_handle(directory, true).unwrap();
    assert_eq!(
        verify_plain_handle(directory, false).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    unsafe {
        CloseHandle(directory);
    }

    fs::remove_dir(&link).unwrap();
    fs::remove_dir(&target).unwrap();
}

/// A `WRITE_DAC` handle must prove which object it holds, not merely that its name looked acceptable.
///
/// The race this closes cannot be staged from inside a test - it needs a rename to land in the window
/// between the chain walk and `CreateFileW` - so the property is exercised through the one case that
/// produces the same mismatch deterministically: an 8.3 short name. It walks clean, it opens the intended
/// object, and the kernel's own normalized answer for the handle is the long name, so a comparison that
/// went by the requested name would accept it and this one refuses it. That refusal is the intended
/// behaviour in its own right: short names are a second spelling of a path this product is supposed to
/// control by exactly one.
#[test]
fn a_dacl_apply_handle_that_does_not_resolve_to_the_requested_path_is_refused() {
    let directory = unique_temp_path("identity longname");
    fs::create_dir(&directory).unwrap();
    let short = short_path_of(&directory);

    match short {
        Some(short) if short != directory => {
            let Err(refusal) = open_path_for_dacl_apply(&short, true) else {
                panic!("a second spelling of the path must not be accepted for a DACL write");
            };
            assert_eq!(refusal.kind(), io::ErrorKind::PermissionDenied);
            assert!(
                refusal
                    .to_string()
                    .contains("not the managed root that was requested"),
                "the refusal should name the identity mismatch, got: {refusal}"
            );
            // The positive half, so the check cannot be passing vacuously.
            open_path_for_dacl_apply(&directory, true)
                .expect("the long name resolves to itself and opens");
        }
        // 8.3 name creation can be disabled per volume, in which case there is no second spelling to
        // present and only the positive half is available here.
        _ => {
            open_path_for_dacl_apply(&directory, true)
                .expect("the long name resolves to itself and opens");
        }
    }

    fs::remove_dir(&directory).unwrap();
}

/// The 8.3 spelling of `path`, or `None` where the volume does not keep one.
fn short_path_of(path: &Path) -> Option<std::path::PathBuf> {
    let wide = to_wide(path);
    let mut buffer = vec![0u16; 512];
    // SAFETY: both pointers address live buffers and the declared length matches `buffer`.
    let written =
        unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) }
            as usize;
    if written == 0 || written >= buffer.len() {
        return None;
    }
    buffer.truncate(written);
    Some(std::path::PathBuf::from(String::from_utf16(&buffer).ok()?))
}
