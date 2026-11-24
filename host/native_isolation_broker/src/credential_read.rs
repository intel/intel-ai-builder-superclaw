//! The read-only tier-credential surface, and the single definition of the descriptor a credential
//! file must carry.
//!
//! The owner-read credential policy widens **only this file
//! class** from the broker-wide `SY + BA` state descriptor to `SY + BA + owner read`, because the
//! unprivileged launcher's first hop needs the tier password and cannot get it from an elevated
//! broker without a UAC prompt per start. Identity records, the workspace grant store, ACL records
//! and every directory - including the identity directory these files live in - stay on
//! `acl_windows::BROKER_FILE_DACL` / `BROKER_DIRECTORY_DACL`. The owner can therefore read a
//! credential whose exact path it derives itself (`identity_name`), but still cannot enumerate the
//! directory or read any protected identity state.
//!
//! The tier accounts get no ACE at all. That is deliberately expressed as an omission from a
//! protected (`P`) DACL rather than as an explicit DENY ACE: with no inheritance to override, "no
//! ACE" cannot be got wrong by ordering, whereas a DENY ACE placed after an ALLOW ACE silently
//! stops denying. `owner` is written as an explicit SID ACE and never left to `BA` to cover, because
//! the owner may be a standard user who elevated with another administrator's credentials.
//!
//! This module is what the unelevated launcher links: deriving the path, verifying the descriptor
//! and reading the bytes, with no way to write one. Provisioning a credential and the elevated
//! converging read that repairs a drifted descriptor are `credential_store`, which builds its
//! expected descriptor from the definition here, so the writer cannot produce a shape the reader
//! would refuse. The difference between the two callers is their token, not their rules.
//!
//! Host-policy dependency: opening a credential by full path from an unprivileged owner relies on
//! "Bypass traverse checking" (`SeChangeNotifyPrivilege`, granted to Everyone by default), because
//! the parent directory gives the owner no ACE. A hardened image that removes that privilege needs
//! an additional traverse-only ACE on the directory; that is a host-policy prerequisite rather
//! than assumed here.

use crate::security_descriptor::{
    OwnedHandle, expected_dacl_bytes, read_exact, read_security_descriptor_for_handle,
    verify_plain_handle,
};
use crate::sid_win32::canonical_owner_sid;
use crate::wide::to_wide;
use std::io;
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    GetFileSizeEx, OPEN_EXISTING, READ_CONTROL,
};

/// Upper bound on a stored DPAPI credential blob. Enforced before any allocation or unprotect.
pub const MAX_CREDENTIAL_SIZE: usize = 16 * 1024;

/// SYSTEM and Administrators keep full control; the owner SID is appended with read-only rights.
const CREDENTIAL_DACL_PREFIX: &str = "D:P(A;;FA;;;SY)(A;;FA;;;BA)";
/// `FR` is `FILE_GENERIC_READ`: read data, attributes and EAs, plus `READ_CONTROL` and
/// `SYNCHRONIZE`. Spelled as the file-specific right rather than generic `GR` so the ACE mask that
/// lands on disk is exactly the mask compared on readback. It grants no write, no `WRITE_DAC` and
/// no `DELETE`.
const OWNER_READ_RIGHTS: &str = "FR";

/// Full path of the credential blob for `account_name` inside an identity state directory.
pub fn credential_path(state_dir: &Path, account_name: &str) -> PathBuf {
    state_dir.join(crate::identity_name::credential_file_name(account_name))
}

/// The descriptor a tier credential file must carry, parameterized by owner.
///
/// `canonical_owner_sid` round-trips the value through `ConvertStringSidToSidW`, so the interpolated
/// text is always a Win32-canonical `S-1-...` string and cannot smuggle extra SDDL syntax or an ACE
/// flag, and it refuses any SID that is not an account. The second half is what stops this ACE being
/// turned inside out: `ConvertStringSidToSidW` alone would canonicalize `WD` to `S-1-1-0`, and read
/// access for Everyone on a credential blob hands the tier accounts their own passwords. The writer
/// and the reader both build the expected descriptor here, so neither can accept a principal the
/// other would refuse.
pub fn credential_dacl_sddl(owner_sid: &str) -> io::Result<String> {
    let owner = canonical_owner_sid(owner_sid)?;
    Ok(format!(
        "{CREDENTIAL_DACL_PREFIX}(A;;{OWNER_READ_RIGHTS};;;{owner})"
    ))
}

/// A credential blob's DACL, relative to the descriptor its owner requires.
///
/// Protection is part of the same answer as the ACEs, because an unprotected DACL whose ACEs are
/// byte-identical is still drift: an ACE inherited from the parent can widen it later. The two are
/// kept distinguishable only so the read path can say which one it refused on.
pub(crate) enum DescriptorState {
    Converged,
    Unprotected,
    /// Carries the observed DACL in SDDL form, for the refusal message.
    Mismatched(String),
}

/// Classifies the DACL on an open credential handle: one `GetSecurityInfo`, no decision taken.
///
/// The converged predicate is deliberately the same one `apply_sddl_dacl_and_verify` uses to decide
/// whether a write is needed, so a descriptor this function calls drift is a descriptor that
/// function will rewrite, and there is no shape that is refused by the reader and reported as
/// already converged by the repair.
pub(crate) fn descriptor_state(
    handle: HANDLE,
    expected_dacl: &[u8],
) -> io::Result<DescriptorState> {
    let observed = read_security_descriptor_for_handle(handle)?;
    if !observed.dacl_is_protected()? {
        return Ok(DescriptorState::Unprotected);
    }
    if observed.dacl_bytes()? != expected_dacl {
        return Ok(DescriptorState::Mismatched(observed.dacl_sddl()?));
    }
    Ok(DescriptorState::Converged)
}

pub(crate) fn refuse_unless_converged(state: DescriptorState) -> io::Result<()> {
    match state {
        DescriptorState::Converged => Ok(()),
        DescriptorState::Unprotected => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "tier credential DACL is not protected against inheritance",
        )),
        DescriptorState::Mismatched(observed) => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "tier credential DACL does not match the owner-read descriptor: observed {observed}"
            ),
        )),
    }
}

/// Opens an existing credential blob as the exact named object, or fails.
///
/// `FILE_FLAG_OPEN_REPARSE_POINT` is what makes the type check meaningful: the open never follows a
/// link, so the descriptor that gets verified belongs to the object that gets read. Omitting
/// `FILE_FLAG_BACKUP_SEMANTICS` means a directory junction planted in place of the blob cannot
/// produce a handle at all, so it is refused at the open rather than somewhere later.
pub(crate) fn open_credential(path: &Path, access: u32) -> io::Result<OwnedHandle> {
    let path_wide = to_wide(path);
    // SAFETY: path_wide is NUL-terminated; the returned handle is owned below.
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            access,
            FILE_SHARE_READ,
            null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let handle = OwnedHandle::new(handle);
    verify_plain_handle(handle.raw(), false)?;
    Ok(handle)
}

/// Reads the whole blob from a handle whose descriptor the caller has already verified.
pub(crate) fn read_bounded_payload(handle: HANDLE) -> io::Result<Vec<u8>> {
    let mut length = 0i64;
    // SAFETY: handle is open and length is a writable out-parameter.
    if unsafe { GetFileSizeEx(handle, &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if length < 0 || length as u128 > MAX_CREDENTIAL_SIZE as u128 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "tier credential exceeds its size bound",
        ));
    }
    let mut payload = vec![0u8; length as usize];
    read_exact(handle, &mut payload)?;
    Ok(payload)
}

/// Reads a credential blob as the owner, refusing anything that is not the exact expected object.
///
/// Checks, in order, all before the caller may DPAPI-unprotect the result: the handle refers to a
/// regular file and not a reparse point; its DACL is protected; its DACL is byte-for-byte the
/// descriptor `credential_dacl_sddl(owner_sid)` produces; its size is within
/// `MAX_CREDENTIAL_SIZE`. A blob whose descriptor names a different owner, has an extra ACE, or has
/// lost its protected state is refused rather than decrypted, so DPAPI's machine scope is never the
/// only thing standing between a caller and a tier password.
///
/// This is the unprivileged path: it asks for read access only, so it is the one the launcher can
/// use, and it refuses drift instead of repairing it because an owner token cannot rewrite a
/// descriptor anyway. The elevated broker uses `credential_store::read_credential_converging`.
///
/// One call is one atomic read of one object: a single `CreateFileW`, then every check and the read
/// itself against that one handle. That is what makes the launcher's "reread the credential and retry the
/// logon once" sound - a retry re-reads whatever the file says *now*, and cannot mix the descriptor
/// of one object with the bytes of another.
pub fn read_credential_for_owner(path: &Path, owner_sid: &str) -> io::Result<Vec<u8>> {
    let sddl = credential_dacl_sddl(owner_sid)?;
    let expected = expected_dacl_bytes(&sddl)?;
    let handle = open_credential(path, GENERIC_READ | READ_CONTROL)?;
    refuse_unless_converged(descriptor_state(handle.raw(), &expected)?)?;
    read_bounded_payload(handle.raw())
}

/// Tests here are the ones that need no descriptor *write*, so this module stays free of any
/// `cfg(test)` dependency on `security_descriptor_apply` - which the launcher does not link, and
/// which `cargo test` would otherwise drag into the launcher binary's own test build. The cases that
/// walk a real file through several descriptors live in `credential_store`, beside the code that is
/// allowed to apply one.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::security_descriptor::OwnedSecurityDescriptor;
    use crate::sid_win32::current_process_sid;
    use std::collections::BTreeSet;

    /// A well-formed SID for a standard local user that is not in Administrators. It never has to
    /// resolve to a real account: SDDL only requires the SID to be well formed, which is exactly
    /// how a standard-user owner is exercised without provisioning one.
    const STANDARD_USER_SID: &str = "S-1-5-21-1178594758-1067165089-3282905936-1013";
    const SYSTEM_SID: &str = "S-1-5-18";
    const ADMINISTRATORS_SID: &str = "S-1-5-32-544";
    const FILE_ALL_ACCESS_MASK: u32 = 0x001f_01ff;
    const FILE_GENERIC_READ_MASK: u32 = 0x0012_0089;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    fn credential_ace_entries(sddl: &str) -> Vec<(u8, u8, u32, String)> {
        OwnedSecurityDescriptor::from_sddl(sddl)
            .unwrap()
            .dacl_ace_entries()
            .unwrap()
    }

    #[test]
    fn credential_dacl_names_exactly_system_administrators_and_the_owner_read_only() {
        let sddl = credential_dacl_sddl(STANDARD_USER_SID).unwrap();
        assert_eq!(
            sddl,
            format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;{STANDARD_USER_SID})")
        );
        assert_eq!(
            credential_ace_entries(&sddl),
            vec![
                (
                    ACCESS_ALLOWED_ACE_TYPE,
                    0,
                    FILE_ALL_ACCESS_MASK,
                    SYSTEM_SID.to_owned()
                ),
                (
                    ACCESS_ALLOWED_ACE_TYPE,
                    0,
                    FILE_ALL_ACCESS_MASK,
                    ADMINISTRATORS_SID.to_owned()
                ),
                (
                    ACCESS_ALLOWED_ACE_TYPE,
                    0,
                    FILE_GENERIC_READ_MASK,
                    STANDARD_USER_SID.to_owned()
                ),
            ]
        );
        assert!(
            OwnedSecurityDescriptor::from_sddl(&sddl)
                .unwrap()
                .dacl_is_protected()
                .unwrap()
        );
    }

    #[test]
    fn owner_read_ace_grants_no_write_delete_or_dacl_control() {
        const FILE_WRITE_DATA: u32 = 0x0002;
        const FILE_APPEND_DATA: u32 = 0x0004;
        const DELETE: u32 = 0x0001_0000;
        const WRITE_DAC_RIGHT: u32 = 0x0004_0000;
        const WRITE_OWNER_RIGHT: u32 = 0x0008_0000;
        let sddl = credential_dacl_sddl(STANDARD_USER_SID).unwrap();
        let owner_ace = credential_ace_entries(&sddl).pop().unwrap();
        assert_eq!(owner_ace.3, STANDARD_USER_SID);
        for forbidden in [
            FILE_WRITE_DATA,
            FILE_APPEND_DATA,
            DELETE,
            WRITE_DAC_RIGHT,
            WRITE_OWNER_RIGHT,
        ] {
            assert_eq!(owner_ace.2 & forbidden, 0, "mask {:#x}", owner_ace.2);
        }
    }

    #[test]
    fn a_credential_dacl_names_exactly_three_principals_whatever_the_owner_is() {
        // Set equality, not a spot check: this is the assertion a tier account has to defeat to gain
        // access, and it fails on any extra ACE as well as on a missing one.
        for owner in [STANDARD_USER_SID, &current_process_sid().unwrap()] {
            let sddl = credential_dacl_sddl(owner).unwrap();
            let principals: BTreeSet<String> = credential_ace_entries(&sddl)
                .into_iter()
                .map(|entry| entry.3)
                .collect();
            assert_eq!(
                principals,
                BTreeSet::from([
                    SYSTEM_SID.to_owned(),
                    ADMINISTRATORS_SID.to_owned(),
                    owner.to_owned(),
                ]),
                "owner {owner}"
            );
        }
    }

    #[test]
    fn a_credential_dacl_refuses_every_owner_sid_that_is_not_an_account() {
        // The other way a tier account could end up with read access, and the only one that does not
        // require an extra ACE: name a principal that already covers it. `ConvertStringSidToSidW`
        // canonicalizes `WD` to `S-1-1-0`, so `--owner-sid WD` would otherwise produce a perfectly
        // well-formed descriptor granting every local user - every tier included - read access
        // to every tier password. The refusal has to live in the descriptor builder, because both the
        // writer and the reader derive the expected bytes from it.
        for rejected in [
            "WD",
            "S-1-1-0", // Everyone
            "BU",
            "S-1-5-32-545", // Users
            "AU",
            "S-1-5-11", // Authenticated Users
            "BA",
            "S-1-5-32-544", // Administrators
            "SY",
            "S-1-5-18", // SYSTEM
            "CO",
            "S-1-3-0", // Creator Owner
            "IU",
            "S-1-5-4", // Interactive
        ] {
            let error = credential_dacl_sddl(rejected).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{rejected}");
        }
        // Local and domain accounts, and Entra ID accounts, are still accepted.
        credential_dacl_sddl(STANDARD_USER_SID).unwrap();
        credential_dacl_sddl("S-1-12-1-1-2-3-4").unwrap();
    }

    #[test]
    fn credential_path_is_derived_from_the_account_name_alone() {
        let state_dir = Path::new(r"C:\ProgramData\SuperClaw\isolation\identities");
        assert_eq!(
            credential_path(state_dir, "SCBABCDEFGHIJKLMNOP"),
            state_dir.join("credential-SCBABCDEFGHIJKLMNOP.bin")
        );
    }

    #[test]
    fn a_missing_credential_is_reported_as_not_found_rather_than_as_a_refusal() {
        // Absence surfaces as `NotFound`, not as a descriptor refusal, so the launcher can map "this
        // owner has no credential yet" to `provision_required` and keep every other failure class
        // distinguishable from it.
        let error = read_credential_for_owner(
            &crate::security_descriptor::unique_temp_path("credential-read-absent"),
            &current_process_sid().unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
