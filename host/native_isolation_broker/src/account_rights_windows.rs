//! Minimum logon rights on a tier account (issue #3011).
//!
//! A tier account that keeps the default logon rights can get code run outside its role Job through
//! a system service: a Task Scheduler task that runs "whether or not the user is logged on", a WMI
//! `Win32_Process.Create` request, an out-of-process COM activation, or a BITS success/failure
//! notify command line. The role Job only holds the processes the owner-side launcher creates, so a
//! process a service hosts is not in it and `TerminateJobObject` cannot reach it. §3.3 / A.5.2 of
//! `2026-09-29_native_windows_sandbx_design_revised` therefore requires every such entry point to be
//! denied for the tier SID or brought under the same trusted lifecycle before it runs; the logon
//! rights below remove the ones those services need.
//!
//! # Why these four and not the interactive right
//!
//! - `SeDenyBatchLogonRight`: Task Scheduler runs a "whether or not logged on" task with a batch
//!   logon.
//! - `SeDenyServiceLogonRight`: nothing in this product runs the tier as a service.
//! - `SeDenyNetworkLogonRight`: inbound network authentication (SMB, remote WMI) must not succeed.
//! - `SeDenyRemoteInteractiveLogonRight`: no RDP session.
//!
//! `SeDenyInteractiveLogonRight` is deliberately **not** set. Every hop that starts or profiles the
//! account performs an interactive logon: `CreateProcessWithLogonW` in the launcher and
//! `LogonUserW(..., LOGON32_LOGON_INTERACTIVE, ...)` in `profile_env::initialize_profile`. Denying
//! interactive would stop the product from launching or provisioning its own roles, so the one
//! right the launch path needs stays.
//!
//! # Where it runs
//!
//! The account already exists when this is called (`NetUserAdd` runs first), so this is the second
//! half of provisioning and lives in the same elevated, one-operation, rollback-protected step.
//!
//! Deleting the account does **not** take its rights with it: a right is stored in the local security
//! policy keyed by SID, so a deleted account leaves its `SeDeny*` entries behind as orphaned SIDs, one
//! set per provision/revoke cycle. Revocation therefore calls [`remove_minimum_logon_rights`] while the
//! account still resolves, before deleting it.
//!
//! `LsaAddAccountRights` returning success is not evidence the account now has the rights, so this
//! module reads them back, both as the required provisioning evidence and as a self-check before
//! `apply_minimum_logon_rights` returns.

use crate::sid_win32::LocalAllocation;
use crate::wide::to_wide;
use std::io;
use std::mem::size_of;
use std::ptr::null;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{STATUS_OBJECT_NAME_NOT_FOUND, STATUS_SUCCESS};
use windows_sys::Win32::Security::Authentication::Identity::{
    LSA_HANDLE, LSA_OBJECT_ATTRIBUTES, LSA_UNICODE_STRING, LsaAddAccountRights, LsaClose,
    LsaEnumerateAccountRights, LsaFreeMemory, LsaNtStatusToWinError, LsaOpenPolicy,
    LsaRemoveAccountRights, POLICY_CREATE_ACCOUNT, POLICY_LOOKUP_NAMES,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::PSID;

/// The logon rights removed from every tier account. See the module docs for why each is here and
/// why `SeDenyInteractiveLogonRight` is absent.
pub const DENIED_LOGON_RIGHTS: [&str; 4] = [
    "SeDenyBatchLogonRight",
    "SeDenyServiceLogonRight",
    "SeDenyNetworkLogonRight",
    "SeDenyRemoteInteractiveLogonRight",
];

/// An `LsaOpenPolicy` handle, closed exactly once on drop.
struct PolicyHandle(LSA_HANDLE);

impl Drop for PolicyHandle {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful LsaOpenPolicy and is closed once here.
        unsafe {
            LsaClose(self.0);
        }
    }
}

fn ntstatus_error(status: i32) -> io::Error {
    // LsaNtStatusToWinError maps an NTSTATUS to the Win32 error the rest of the crate already
    // reports, so a failure here reads like every other Win32 failure.
    let win32 = unsafe { LsaNtStatusToWinError(status) };
    io::Error::from_raw_os_error(win32 as i32)
}

fn open_policy() -> io::Result<PolicyHandle> {
    let mut attributes = LSA_OBJECT_ATTRIBUTES::default();
    attributes.Length = size_of::<LSA_OBJECT_ATTRIBUTES>() as u32;
    let mut handle: LSA_HANDLE = 0;
    // SAFETY: a null system name selects the local machine; attributes is initialized; handle is a
    // writable out-parameter.
    let status = unsafe {
        LsaOpenPolicy(
            null(),
            &attributes,
            (POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES) as u32,
            &mut handle,
        )
    };
    if status != STATUS_SUCCESS {
        return Err(ntstatus_error(status));
    }
    Ok(PolicyHandle(handle))
}

/// Builds an `LSA_UNICODE_STRING` over a NUL-terminated UTF-16 buffer. LSA measures in bytes and
/// excludes the terminator from `Length` but includes it in `MaximumLength`.
fn lsa_string(buffer: &mut [u16]) -> LSA_UNICODE_STRING {
    let terminated = buffer.len().saturating_sub(1);
    LSA_UNICODE_STRING {
        Length: (terminated * 2) as u16,
        MaximumLength: (buffer.len() * 2) as u16,
        Buffer: buffer.as_mut_ptr(),
    }
}

/// Converts the account's canonical SID text to the `PSID` LSA takes. The returned allocation owns
/// the SID bytes and must outlive every call that uses the pointer.
fn account_psid(account_sid: &str) -> io::Result<(LocalAllocation, PSID)> {
    let wide = to_wide(account_sid);
    let mut psid: PSID = null_mut();
    // SAFETY: wide is NUL-terminated and psid is a writable out-parameter.
    if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut psid) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("tier account SID {account_sid} is not valid"),
        ));
    }
    Ok((LocalAllocation::new(psid)?, psid))
}

fn read_rights_with(policy: &PolicyHandle, psid: PSID) -> io::Result<Vec<String>> {
    let mut buffer: *mut LSA_UNICODE_STRING = null_mut();
    let mut count: u32 = 0;
    // SAFETY: psid is valid; buffer and count are writable out-parameters.
    let status = unsafe { LsaEnumerateAccountRights(policy.0, psid, &mut buffer, &mut count) };
    if status != STATUS_SUCCESS {
        // An account with no explicitly assigned rights - the state right after `NetUserAdd` - has
        // nothing to enumerate. That is an observation, not a failure.
        if status == STATUS_OBJECT_NAME_NOT_FOUND {
            return Ok(Vec::new());
        }
        return Err(ntstatus_error(status));
    }
    // SAFETY: on success buffer points at count LSA-owned LSA_UNICODE_STRING entries.
    let entries = unsafe { std::slice::from_raw_parts(buffer, count as usize) };
    let mut rights = Vec::with_capacity(entries.len());
    for entry in entries {
        // SAFETY: entry.Buffer points at entry.Length bytes of UTF-16.
        let text = unsafe { std::slice::from_raw_parts(entry.Buffer, (entry.Length / 2) as usize) };
        rights.push(String::from_utf16_lossy(text));
    }
    // SAFETY: buffer came from LsaEnumerateAccountRights and is freed exactly once.
    unsafe {
        LsaFreeMemory(buffer.cast());
    }
    Ok(rights)
}

/// The rights (allow or deny) explicitly assigned to this account, read from the local security
/// policy. Used as provisioning evidence and by the revocation readback.
pub fn read_account_rights(account_sid: &str) -> io::Result<Vec<String>> {
    let policy = open_policy()?;
    let (_sid_owner, psid) = account_psid(account_sid)?;
    read_rights_with(&policy, psid)
}

/// Adds every right in [`DENIED_LOGON_RIGHTS`] to the account and verifies the write by reading the
/// account's rights back. Idempotent: LSA stores rights as a set, so a re-run adds nothing.
pub fn apply_minimum_logon_rights(account_sid: &str) -> io::Result<()> {
    let policy = open_policy()?;
    let (_sid_owner, psid) = account_psid(account_sid)?;

    // Every UTF-16 buffer stays alive until after the call; the LSA_UNICODE_STRING views borrow
    // them.
    let mut buffers: Vec<Vec<u16>> = DENIED_LOGON_RIGHTS.iter().map(|right| to_wide(right)).collect();
    let rights: Vec<LSA_UNICODE_STRING> =
        buffers.iter_mut().map(|buffer| lsa_string(buffer)).collect();

    // SAFETY: psid is a valid SID; rights points at rights.len() initialized entries whose backing
    // buffers outlive the call.
    let status = unsafe { LsaAddAccountRights(policy.0, psid, rights.as_ptr(), rights.len() as u32) };
    if status != STATUS_SUCCESS {
        return Err(ntstatus_error(status));
    }

    let present = read_rights_with(&policy, psid)?;
    let missing = DENIED_LOGON_RIGHTS
        .iter()
        .copied()
        .filter(|right| !present.iter().any(|held| held.eq_ignore_ascii_case(right)))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(io::Error::other(format!(
            "tier account {account_sid} is still missing denied logon rights after apply: {}",
            missing.join(", ")
        )));
    }
    Ok(())
}

/// Removes every right in [`DENIED_LOGON_RIGHTS`] from the account and verifies the removal by reading
/// the account's rights back. Idempotent: removing a right the account does not hold is not an error.
///
/// Revocation must call this **before** the account is deleted. A right lives in the local security
/// policy keyed by SID, so deleting the account would leave these four entries behind as orphaned SIDs
/// that no readback would ever clean up.
pub fn remove_minimum_logon_rights(account_sid: &str) -> io::Result<()> {
    let policy = open_policy()?;
    let (_sid_owner, psid) = account_psid(account_sid)?;

    // Every UTF-16 buffer stays alive until after the call; the LSA_UNICODE_STRING views borrow them.
    let mut buffers: Vec<Vec<u16>> = DENIED_LOGON_RIGHTS.iter().map(|right| to_wide(right)).collect();
    let rights: Vec<LSA_UNICODE_STRING> =
        buffers.iter_mut().map(|buffer| lsa_string(buffer)).collect();

    // SAFETY: psid is a valid SID; rights points at rights.len() initialized entries whose backing
    // buffers outlive the call. `all_rights = false` removes only the rights named here, not the
    // account's other holdings.
    let status =
        unsafe { LsaRemoveAccountRights(policy.0, psid, false, rights.as_ptr(), rights.len() as u32) };
    // An account with no rights entry at all - provisioned before these rights existed, or a failure
    // before they were applied - returns STATUS_OBJECT_NAME_NOT_FOUND. Removing nothing is success, and
    // treating it as an error would stop revoke before deleting the account and fail the rollback.
    if status != STATUS_SUCCESS && status != STATUS_OBJECT_NAME_NOT_FOUND {
        return Err(ntstatus_error(status));
    }

    let present = read_rights_with(&policy, psid)?;
    let remaining = DENIED_LOGON_RIGHTS
        .iter()
        .copied()
        .filter(|right| present.iter().any(|held| held.eq_ignore_ascii_case(right)))
        .collect::<Vec<_>>();
    if !remaining.is_empty() {
        return Err(io::Error::other(format!(
            "tier account {account_sid} still holds denied logon rights after removal: {}",
            remaining.join(", ")
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsa_string_measures_bytes_without_the_terminator() {
        let mut buffer = to_wide("SeDenyBatchLogonRight");
        let text = lsa_string(&mut buffer);
        // 21 characters, 42 bytes, terminator included only in MaximumLength.
        assert_eq!(text.Length, 42);
        assert_eq!(text.MaximumLength, 44);
    }

    #[test]
    fn every_denied_right_is_a_real_logon_right() {
        // The names are the LSA spelling; a typo would make LsaAddAccountRights fail at provision,
        // but the set is also part of the provisioning contract and should not silently shrink.
        assert_eq!(DENIED_LOGON_RIGHTS.len(), 4);
        assert!(DENIED_LOGON_RIGHTS.iter().all(|right| right.starts_with("SeDeny")));
        assert!(!DENIED_LOGON_RIGHTS.contains(&"SeDenyInteractiveLogonRight"));
    }
}
