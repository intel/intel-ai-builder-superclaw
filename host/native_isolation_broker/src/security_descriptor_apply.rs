//! Exact SDDL apply, protected-DACL convergence and explicit-SID revocation.
//!
//! This is the half of the security-descriptor surface that *writes*: everything here ends in a
//! `SetSecurityInfo` call. The reading half - owned descriptor wrappers, readback, handle-level
//! object-type checks - is in `security_descriptor`, and this module builds on it.
//!
//! The split is a linkage boundary, not a filing convenience. The unelevated launcher reads a
//! credential through `credential_read`, which needs the readback primitives; it must not be able to
//! reach a DACL write even by mistake, and the only reliable way to state that is for the write
//! surface to live in a file the launcher does not declare. See `launcher_main.rs` and
//! `tests/launcher_closure.rs`.

use crate::managed_root_path::{verify_handle_is_path, verify_managed_path_chain};
use crate::security_descriptor::{
    read_security_descriptor_for_handle, verify_plain_handle, OwnedHandle, OwnedLocal,
    OwnedSecurityDescriptor,
};
use crate::sid_win32::{lookup_account_sid, sid_to_string};
use crate::wide::to_wide;
#[cfg(test)]
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::io;
use std::path::Path;
use std::ptr::null_mut;
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_NONE_MAPPED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSidToSidW, SetSecurityInfo, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AddAce, EqualSid, GetAce, InitializeAcl, LookupAccountSidW, SidTypeDomain, ACCESS_ALLOWED_ACE,
    ACCESS_DENIED_ACE, ACE_HEADER, ACL, ACL_REVISION, DACL_SECURITY_INFORMATION, INHERITED_ACE,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID, SID_NAME_USE,
    UNPROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileStandardInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_NORMAL,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_STANDARD_INFO, OPEN_EXISTING, READ_CONTROL, WRITE_DAC, WRITE_OWNER,
};
use windows_sys::Win32::System::SystemInformation::{ComputerNameNetBIOS, GetComputerNameExW};

#[cfg(test)]
thread_local! {
    static DACL_WRITES: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
fn record_dacl_write() {
    DACL_WRITES.with(|writes| writes.set(writes.get() + 1));
}

/// How many `SetSecurityInfo` DACL writes this thread has performed, for asserting that a converged
/// apply performs none.
///
/// Thread-local rather than a process-wide counter, on purpose. `cargo test` runs the whole suite in
/// one process on many threads, and several tests apply descriptors, so a global count mixes in
/// other tests' writes: the idempotence assertion failed intermittently for exactly that reason.
/// Each `#[test]` gets its own thread, and an apply is counted on the thread that made it.
#[cfg(test)]
pub fn dacl_writes_on_this_thread() -> usize {
    DACL_WRITES.with(Cell::get)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AclApplyOutcome {
    AlreadyConverged,
    Applied,
}

pub fn open_path_for_dacl_apply(path: &Path, directory: bool) -> io::Result<OwnedHandle> {
    open_path_for_dacl_apply_with_access(path, directory, READ_CONTROL | WRITE_DAC | WRITE_OWNER)
}

pub fn open_path_for_dacl_apply_with_file_attributes(
    path: &Path,
    directory: bool,
) -> io::Result<OwnedHandle> {
    open_path_for_dacl_apply_with_access(
        path,
        directory,
        READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES,
    )
}

/// How many names (hard links) the file behind `handle` has. Every name shares one security
/// descriptor, so writing through one name rewrites the permissions of all of them.
pub fn file_link_count(handle: HANDLE) -> io::Result<u32> {
    let mut info = FILE_STANDARD_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            (&raw mut info).cast(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(info.NumberOfLinks)
}

/// Same as [`open_path_for_dacl_apply`], without `WRITE_OWNER`.
///
/// For an apply that will not write an owner - `ObjectOwnership::OwnedByRequester` in
/// `acl_policy_apply` - requesting `WRITE_OWNER` anyway asks the kernel to authorize a right this call
/// never exercises. An owner-owned object's owner holds `READ_CONTROL` and `WRITE_DAC` implicitly,
/// whatever its DACL says, but not `WRITE_OWNER`: that bit still has to come from the DACL or from a
/// privilege. Requesting it unconditionally could therefore refuse a legitimate apply over a right it
/// was never going to use.
pub fn open_path_for_dacl_apply_preserving_owner(
    path: &Path,
    directory: bool,
) -> io::Result<OwnedHandle> {
    open_path_for_dacl_apply_with_access(path, directory, READ_CONTROL | WRITE_DAC)
}

fn open_path_for_dacl_apply_with_access(
    path: &Path,
    directory: bool,
    access: u32,
) -> io::Result<OwnedHandle> {
    verify_managed_path_chain(path)?;
    let original = path;
    let path = to_wide(path);
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            0,
            null_mut(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // Own the handle before validation so every refusal below closes it.
    let owned = OwnedHandle::new(handle);
    verify_plain_handle(owned.raw(), directory)?;
    verify_handle_is_path(owned.raw(), original)?;
    Ok(owned)
}

pub fn apply_sddl_security_descriptor_and_verify(
    handle: HANDLE,
    expected_sddl: &str,
) -> io::Result<AclApplyOutcome> {
    let expected = OwnedSecurityDescriptor::from_sddl(expected_sddl)?;
    let expected_dacl = expected.dacl()?;
    let expected_canonical = expected.dacl_sddl()?;
    let expected_owner = expected.owner_sid_ptr()?;
    let expected_protected = expected.dacl_is_protected()?;
    let owner_converged = match expected_owner {
        Some(owner) => owner_matches(handle, owner)?,
        None => true,
    };

    if dacl_matches_descriptor(handle, &expected)? && owner_converged {
        return Ok(AclApplyOutcome::AlreadyConverged);
    }

    #[cfg(test)]
    record_dacl_write();

    let protection = if expected_protected {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    let mut security_info = DACL_SECURITY_INFORMATION | protection;
    if expected_owner.is_some() {
        security_info |= OWNER_SECURITY_INFORMATION;
    }
    let status = unsafe {
        SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            security_info,
            expected_owner.unwrap_or(null_mut()),
            null_mut(),
            expected_dacl,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }

    if !dacl_matches_descriptor(handle, &expected)? {
        let observed = read_security_descriptor_for_handle(handle)?;
        let observed_sddl = observed.dacl_sddl()?;
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "DACL readback mismatch: expected {expected_canonical}, observed {observed_sddl}"
            ),
        ));
    }
    let owner_readback_matches = match expected_owner {
        Some(owner) => owner_matches(handle, owner)?,
        None => true,
    };
    if !owner_readback_matches {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "owner readback mismatch after SetSecurityInfo",
        ));
    }
    Ok(AclApplyOutcome::Applied)
}

pub fn apply_sddl_dacl_and_verify(
    handle: HANDLE,
    expected_sddl: &str,
) -> io::Result<AclApplyOutcome> {
    let expected = OwnedSecurityDescriptor::from_sddl(expected_sddl)?;
    let expected_dacl = expected.dacl()?;
    let expected_canonical = expected.dacl_sddl()?;
    let expected_protected = expected.dacl_is_protected()?;

    if dacl_matches_descriptor(handle, &expected)? {
        return Ok(AclApplyOutcome::AlreadyConverged);
    }

    #[cfg(test)]
    record_dacl_write();

    let status = unsafe {
        SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION
                | if expected_protected {
                    PROTECTED_DACL_SECURITY_INFORMATION
                } else {
                    UNPROTECTED_DACL_SECURITY_INFORMATION
                },
            null_mut(),
            null_mut(),
            expected_dacl,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }

    if !dacl_matches_descriptor(handle, &expected)? {
        let observed = read_security_descriptor_for_handle(handle)?;
        let observed_sddl = observed.dacl_sddl()?;
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "DACL readback mismatch: expected {expected_canonical}, observed {observed_sddl}"
            ),
        ));
    }
    Ok(AclApplyOutcome::Applied)
}

pub fn revoke_explicit_sids_from_path(
    path: &Path,
    directory: bool,
    sid_values: &[String],
) -> io::Result<()> {
    if sid_values.is_empty() {
        return Ok(());
    }
    let handle = open_path_for_dacl_apply(path, directory)?;
    let observed = read_security_descriptor_for_handle(handle.raw())?;
    let existing_dacl = observed.dacl()?;
    let dacl_is_protected = observed.dacl_is_protected()?;

    let mut sids = Vec::with_capacity(sid_values.len());
    for value in sid_values {
        let wide = to_wide(value);
        let mut sid = null_mut();
        if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        sids.push(OwnedLocal(sid));
    }
    let mut revised_dacl = dacl_without_sids(existing_dacl, &sids)?;
    let revised_dacl = revised_dacl.as_mut_ptr().cast::<ACL>();
    let mut security_info = DACL_SECURITY_INFORMATION;
    if dacl_is_protected {
        security_info |= PROTECTED_DACL_SECURITY_INFORMATION;
    }
    let status = unsafe {
        SetSecurityInfo(
            handle.raw(),
            SE_FILE_OBJECT,
            security_info,
            null_mut(),
            null_mut(),
            revised_dacl,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }

    let readback = read_security_descriptor_for_handle(handle.raw())?;
    if let Some(index) = dacl_matching_sid_index(readback.dacl()?, &sids)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "DACL readback for {} still contains revoked tier SID {}",
                path.display(),
                sid_values[index]
            ),
        ));
    }
    Ok(())
}

fn dacl_without_sids(dacl: *mut ACL, sids: &[OwnedLocal]) -> io::Result<Vec<u32>> {
    let byte_capacity = u32::from(unsafe { (*dacl).AclSize });
    let mut revised = vec![0u32; byte_capacity.div_ceil(4) as usize];
    let revised_dacl = revised.as_mut_ptr().cast::<ACL>();
    if unsafe { InitializeAcl(revised_dacl, byte_capacity, ACL_REVISION) } == 0 {
        return Err(io::Error::last_os_error());
    }

    for index in 0..unsafe { (*dacl).AceCount } {
        let mut ace: *mut c_void = null_mut();
        if unsafe { GetAce(dacl, u32::from(index), &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        let sid = match header.AceType {
            0 => unsafe {
                Some(std::ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart).cast())
            },
            1 => unsafe {
                Some(std::ptr::addr_of_mut!((*ace.cast::<ACCESS_DENIED_ACE>()).SidStart).cast())
            },
            _ => None,
        };
        let should_remove = sid.is_some_and(|sid| {
            sids.iter()
                .any(|candidate| unsafe { EqualSid(sid, candidate.0) } != 0)
        });
        if !should_remove
            && unsafe {
                AddAce(
                    revised_dacl,
                    ACL_REVISION,
                    u32::MAX,
                    ace,
                    u32::from(header.AceSize),
                )
            } == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(revised)
}

fn dacl_matching_sid_index(dacl: *mut ACL, sids: &[OwnedLocal]) -> io::Result<Option<usize>> {
    for index in 0..unsafe { (*dacl).AceCount } {
        let mut ace: *mut c_void = null_mut();
        if unsafe { GetAce(dacl, u32::from(index), &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        let sid = match header.AceType {
            0 => unsafe {
                std::ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart).cast()
            },
            1 => unsafe {
                std::ptr::addr_of_mut!((*ace.cast::<ACCESS_DENIED_ACE>()).SidStart).cast()
            },
            _ => continue,
        };
        if let Some(index) = sids
            .iter()
            .position(|candidate| unsafe { EqualSid(sid, candidate.0) } != 0)
        {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

pub fn dacl_matches(handle: HANDLE, expected_sddl: &str) -> io::Result<bool> {
    let expected = OwnedSecurityDescriptor::from_sddl(expected_sddl)?;
    dacl_matches_descriptor(handle, &expected)
}

fn owner_matches(handle: HANDLE, expected_owner: *mut c_void) -> io::Result<bool> {
    let observed = read_security_descriptor_for_handle(handle)?;
    let observed_owner = observed.owner_sid_ptr()?;
    Ok(match (observed_owner, Some(expected_owner)) {
        (Some(left), Some(right)) => unsafe { EqualSid(left, right) != 0 },
        (None, None) => true,
        _ => false,
    })
}

fn dacl_matches_descriptor(handle: HANDLE, expected: &OwnedSecurityDescriptor) -> io::Result<bool> {
    let observed = read_security_descriptor_for_handle(handle)?;
    let expected_protected = expected.dacl_is_protected()?;
    if observed.dacl_is_protected()? != expected_protected {
        return Ok(false);
    }
    if expected_protected {
        return Ok(observed.dacl_bytes()? == expected.dacl_bytes()?);
    }
    unprotected_dacl_matches(observed.dacl()?, expected.dacl()?)
}

fn unprotected_dacl_matches(observed: *mut ACL, expected: *mut ACL) -> io::Result<bool> {
    if observed.is_null() || expected.is_null() {
        return Ok(observed == expected);
    }
    let expected_count = unsafe { (*expected).AceCount };
    let observed_count = unsafe { (*observed).AceCount };
    if observed_count < expected_count {
        return Ok(false);
    }
    for index in 0..expected_count {
        let mut observed_ace: *mut c_void = null_mut();
        let mut expected_ace: *mut c_void = null_mut();
        if unsafe { GetAce(observed, u32::from(index), &mut observed_ace) } == 0
            || unsafe { GetAce(expected, u32::from(index), &mut expected_ace) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let observed_header = unsafe { &*observed_ace.cast::<ACE_HEADER>() };
        let expected_header = unsafe { &*expected_ace.cast::<ACE_HEADER>() };
        if observed_header.AceSize != expected_header.AceSize {
            return Ok(false);
        }
        let size = usize::from(expected_header.AceSize);
        let observed_bytes = unsafe { std::slice::from_raw_parts(observed_ace.cast::<u8>(), size) };
        let expected_bytes = unsafe { std::slice::from_raw_parts(expected_ace.cast::<u8>(), size) };
        if observed_bytes != expected_bytes {
            return Ok(false);
        }
    }
    for index in expected_count..observed_count {
        let mut ace: *mut c_void = null_mut();
        if unsafe { GetAce(observed, u32::from(index), &mut ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceFlags & INHERITED_ACE as u8 == 0
            || !(inherited_ace_matches_expected(ace, expected)?
                || ace_names_deleted_local_account(ace)?)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn inherited_ace_matches_expected(ace: *mut c_void, expected: *mut ACL) -> io::Result<bool> {
    let observed_header = unsafe { &*ace.cast::<ACE_HEADER>() };
    let observed_bytes = normalized_ace_bytes(ace, observed_header.AceSize);
    let expected_count = unsafe { (*expected).AceCount };
    for index in 0..expected_count {
        let mut expected_ace: *mut c_void = null_mut();
        if unsafe { GetAce(expected, u32::from(index), &mut expected_ace) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let expected_header = unsafe { &*expected_ace.cast::<ACE_HEADER>() };
        if expected_header.AceSize == observed_header.AceSize
            && observed_bytes == normalized_ace_bytes(expected_ace, expected_header.AceSize)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether an inherited ACE names a local account that no longer exists.
///
/// A descendant written before its ancestors are rewritten still inherits their ACEs for the tier
/// accounts a previous install deleted. Such an ACE grants nothing, because a local RID is never
/// reissued, so it must not fail the readback. Only this machine's own account domain counts: the
/// local SAM answers "no such account" with authority there, whereas a domain SID that does not
/// resolve may be a group whose controller is unreachable.
fn ace_names_deleted_local_account(ace: *mut c_void) -> io::Result<bool> {
    let header = unsafe { &*ace.cast::<ACE_HEADER>() };
    let sid: PSID = match header.AceType {
        0 => unsafe { std::ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart).cast() },
        1 => unsafe { std::ptr::addr_of_mut!((*ace.cast::<ACCESS_DENIED_ACE>()).SidStart).cast() },
        _ => return Ok(false),
    };
    let text = sid_to_string(sid)?;
    let Some((domain, _rid)) = text.rsplit_once('-') else {
        return Ok(false);
    };
    if domain != local_account_domain_sid()? {
        return Ok(false);
    }
    if let Some(deleted) = DELETED_LOCAL_SIDS.with(|cache| cache.borrow().get(&text).copied()) {
        return Ok(deleted);
    }
    let deleted = sid_is_unmapped(sid)?;
    DELETED_LOCAL_SIDS.with(|cache| cache.borrow_mut().insert(text, deleted));
    Ok(deleted)
}

thread_local! {
    static DELETED_LOCAL_SIDS: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
}

/// This machine's account domain SID, which every local SAM account SID extends by one RID.
fn local_account_domain_sid() -> io::Result<&'static str> {
    static DOMAIN: OnceLock<String> = OnceLock::new();
    if let Some(domain) = DOMAIN.get() {
        return Ok(domain);
    }
    let mut length = 0u32;
    unsafe { GetComputerNameExW(ComputerNameNetBIOS, null_mut(), &mut length) };
    let mut name = vec![0u16; length.max(1) as usize];
    if unsafe { GetComputerNameExW(ComputerNameNetBIOS, name.as_mut_ptr(), &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let name = String::from_utf16_lossy(&name[..length as usize]);
    let (sid, sid_use) = lookup_account_sid(&name)?;
    if sid_use != SidTypeDomain {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("computer name {name} does not resolve to the local account domain"),
        ));
    }
    Ok(DOMAIN.get_or_init(|| sid))
}

/// Whether the local SAM answers that no account carries `sid`. Any other lookup failure is returned,
/// so an unexpected error fails the readback rather than excusing the ACE.
fn sid_is_unmapped(sid: PSID) -> io::Result<bool> {
    let mut name_length = 0;
    let mut domain_length = 0;
    let mut sid_use: SID_NAME_USE = 0;
    // SAFETY: sizing call; the SID is valid and every out-parameter is writable.
    unsafe {
        LookupAccountSidW(
            null_mut(),
            sid,
            null_mut(),
            &mut name_length,
            null_mut(),
            &mut domain_length,
            &mut sid_use,
        );
    }
    match unsafe { GetLastError() } {
        ERROR_INSUFFICIENT_BUFFER => Ok(false),
        ERROR_NONE_MAPPED => Ok(true),
        error => Err(io::Error::from_raw_os_error(error as i32)),
    }
}

fn normalized_ace_bytes(ace: *mut c_void, size: u16) -> Vec<u8> {
    let mut bytes =
        unsafe { std::slice::from_raw_parts(ace.cast::<u8>(), usize::from(size)) }.to_vec();
    bytes[1] &= !(INHERITED_ACE as u8);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security_descriptor::unique_temp_path;
    use crate::sid_win32::current_process_sid;
    use std::fs;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    fn unprotected_matches(observed_sddl: &str, expected_sddl: &str) -> bool {
        let observed = OwnedSecurityDescriptor::from_sddl(observed_sddl).unwrap();
        let expected = OwnedSecurityDescriptor::from_sddl(expected_sddl).unwrap();
        unprotected_dacl_matches(observed.dacl().unwrap(), expected.dacl().unwrap()).unwrap()
    }

    #[test]
    fn inherited_ace_for_a_deleted_local_account_does_not_fail_readback() {
        let deleted = format!("{}-999999", local_account_domain_sid().unwrap());
        assert!(unprotected_matches(
            &format!("D:AI(A;;FA;;;SY)(A;ID;FA;;;SY)(A;ID;0x1301bf;;;{deleted})"),
            "D:(A;;FA;;;SY)",
        ));
    }

    #[test]
    fn inherited_ace_for_an_existing_or_well_known_principal_still_fails_readback() {
        let current = current_process_sid().unwrap();
        assert!(!unprotected_matches(
            &format!("D:AI(A;;FA;;;SY)(A;ID;0x1301bf;;;{current})"),
            "D:(A;;FA;;;SY)",
        ));
        assert!(!unprotected_matches(
            "D:AI(A;;FA;;;SY)(A;ID;FA;;;WD)",
            "D:(A;;FA;;;SY)"
        ));
    }

    #[test]
    fn unresolvable_sid_outside_the_local_account_domain_still_fails_readback() {
        assert!(!unprotected_matches(
            "D:AI(A;;FA;;;SY)(A;ID;FA;;;S-1-5-21-1-2-3-999999)",
            "D:(A;;FA;;;SY)",
        ));
    }

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
}
