//! Machine-level DCOM launch/activation denial for a tier account (issue #3011).
//!
//! An out-of-proc COM activation runs the server outside the tier's role Job: the DCOM Service
//! Control Manager (`DcomLaunch`) starts it, it does not inherit the caller's Job, and
//! `TerminateJobObject` cannot reach it. It creates **no new logon**, so the minimum-logon-rights
//! change does not touch this path. The one mechanism that does close it is the machine-wide DCOM
//! launch permission: a DENY ACE for the tier SID in
//! `HKLM\SOFTWARE\Microsoft\Ole\MachineLaunchRestriction` (`MachineAccessRestriction` is deliberately
//! left alone; see below).
//!
//! Provisioning merges that DENY ACE in (without overwriting the descriptor), reads it back, and
//! revoke removes it. Because the restriction is machine-wide and per SID, each tier account carries
//! its own ACE. That ACE lives in the registry, not on the account, so revoke removes it explicitly
//! before it deletes the account - deleting an account does not strip a registry-stored descriptor's
//! ACE, which would otherwise leave an orphaned SID behind.
//!
//! The value is a self-relative `SECURITY_DESCRIPTOR` stored as `REG_BINARY`. This module round-trips
//! it through SDDL rather than editing ACE bytes by hand: read the descriptor, insert the DENY ACE
//! string immediately after the `D:` prefix (so it precedes every allow), convert back, write, and
//! read back to confirm. Removal deletes exactly that ACE string.
//!
//! Scope limits the reviewer should know: this is a machine-wide registry object, so unlike the
//! filesystem policy it cannot be applied "on a verified handle" - the value is named by path. The
//! DENY is a local *launch/activation* denial for the SID only. It stops the tier launching an
//! out-of-proc server, so it also stops its WMI and BITS (both are out-of-proc COM). It deliberately
//! does **not** deny access (`COM_RIGHTS_EXECUTE`, `MachineAccessRestriction`): denying that also
//! blocks the tier's COM *calls*, which breaks its script hosts - measured, with the access deny in
//! place tier `powershell.exe`, `cscript.exe` and `mshta.exe` all fail to start, and with it removed
//! they work again. Calling an already-running server is therefore left open, tracked as a residual.
//!
//! Two limits this scope leaves. The DENY covers the **local** launch rights (`CCDCSW`) only. The
//! default `MachineLaunchRestriction` also grants the remote/execute rights (`CCDCLC`, `RP`) to
//! `Administrators`, `Distributed COM Users` (`S-1-5-32-562`) and `Local Users`; the tier is kept out
//! of every one of those groups, and adding it to any of them would grant it the rights this DENY does
//! not cover. The SDDL round trip carries the owner, the group and the DACL only, so it cannot carry a
//! SACL: a value that has one is **refused** rather than written back without it. The default value has
//! no SACL.

use crate::sid_win32::LocalAllocation;
use crate::wide::to_wide;
use std::io;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetSecurityDescriptorControl,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_BINARY, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    RegSetValueExW,
};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

/// The registry subkey that holds the machine-wide DCOM restrictions.
const OLE_SUBKEY: &str = r"SOFTWARE\Microsoft\Ole";
/// The machine-wide value this module edits and the COM-rights mask its DENY ACE uses.
/// `CCDCSW` = COM_RIGHTS_EXECUTE | EXECUTE_LOCAL | ACTIVATE_LOCAL, the launch/activation rights
/// `Everyone` is granted.
///
/// `MachineAccessRestriction` is deliberately **not** touched. Denying the access rights
/// (`COM_RIGHTS_EXECUTE`, `CCDCLC`) for the tier also blocks its COM *calls*, which breaks the tier's
/// script hosts: measured, with the access deny in place tier `powershell.exe`, `cscript.exe` and
/// `mshta.exe` all fail to start, and with it removed they work again. Denying only the launch right
/// stops the tier launching an out-of-proc server (the escape) without breaking calls to
/// already-running or in-proc servers.
const RESTRICTIONS: [(&str, &str); 1] = [("MachineLaunchRestriction", "CCDCSW")];

/// The five SDDL COM-rights letters this module writes; a DENY ACE string is
/// `(D;;<mask>;;;<sid>)`. Kept here so the two copies (write and readback) cannot disagree.
fn deny_ace(mask: &str, account_sid: &str) -> String {
    format!("(D;;{mask};;;{account_sid})")
}

fn io_error(code: u32) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}

struct OleKey(HKEY);

impl Drop for OleKey {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful RegOpenKeyExW.
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

fn open_ole() -> io::Result<OleKey> {
    let subkey = to_wide(OLE_SUBKEY);
    let mut handle: HKEY = std::ptr::null_mut();
    // SAFETY: subkey is NUL-terminated and handle is a writable out-parameter.
    let status = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, subkey.as_ptr(), 0, KEY_READ | KEY_WRITE, &mut handle) };
    if status != ERROR_SUCCESS {
        return Err(io_error(status));
    }
    Ok(OleKey(handle))
}

/// A machine-wide mutex held across the whole read/merge/write/readback of a restriction value, so
/// two concurrent provisions cannot read the same descriptor and drop each other's DENY.
///
/// The name is in the `Global\` namespace so the apply is seen across sessions. Unlike a section
/// object, a mutex there needs no privilege to create, so an unelevated process can pre-create this
/// predictable name and hold it. The wait is therefore bounded: a holder that never releases turns a
/// provision or a revoke into a typed error instead of a hang. (The broker is elevated, so it still
/// opens that object through the inherited `Administrators` ACE; the bound is what keeps a squatter
/// from becoming a denial of service.)
struct MachineLock(HANDLE);

impl MachineLock {
    fn acquire() -> io::Result<Self> {
        let name = to_wide(r"Global\SuperClawDcomRestrictionLock");
        // SAFETY: name is NUL-terminated; a null security descriptor is the default.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: handle came from CreateMutexW.
        // Bounded so a pre-created, never-released mutex cannot hang an elevated provision.
        const LOCK_TIMEOUT_MS: u32 = 30_000;
        let waited = unsafe { WaitForSingleObject(handle, LOCK_TIMEOUT_MS) };
        // WAIT_ABANDONED means a previous owner died without releasing the mutex; the object is still
        // owned by this thread now, so that is a successful acquisition, not a failure.
        if waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED {
            // SAFETY: handle is a valid owned handle.
            unsafe {
                CloseHandle(handle);
            }
            if waited == WAIT_TIMEOUT {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for the machine-wide DCOM restriction lock",
                ));
            }
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }
}

impl Drop for MachineLock {
    fn drop(&mut self) {
        // SAFETY: this thread owns the mutex (acquire waited for it) and the handle is valid.
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

fn read_binary(key: &OleKey, name: &str) -> io::Result<Option<Vec<u8>>> {
    let value = to_wide(name);
    let mut value_type = 0u32;
    let mut length = 0u32;
    // SAFETY: sizing call; value is NUL-terminated and the out-parameters are writable.
    let status = unsafe {
        RegQueryValueExW(key.0, value.as_ptr(), std::ptr::null(), &mut value_type, std::ptr::null_mut(), &mut length)
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(io_error(status));
    }
    if value_type != REG_BINARY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{name} is not REG_BINARY (type {value_type})"),
        ));
    }
    let mut data = vec![0u8; length as usize];
    // SAFETY: data is exactly `length` bytes, the size the preceding call reported.
    let status = unsafe {
        RegQueryValueExW(key.0, value.as_ptr(), std::ptr::null(), &mut value_type, data.as_mut_ptr(), &mut length)
    };
    if status != ERROR_SUCCESS {
        return Err(io_error(status));
    }
    data.truncate(length as usize);
    Ok(Some(data))
}

fn write_binary(key: &OleKey, name: &str, bytes: &[u8]) -> io::Result<()> {
    let value = to_wide(name);
    // SAFETY: value is NUL-terminated and bytes points at `bytes.len()` initialized bytes.
    let status = unsafe {
        RegSetValueExW(key.0, value.as_ptr(), 0, REG_BINARY, bytes.as_ptr(), bytes.len() as u32)
    };
    if status != ERROR_SUCCESS {
        return Err(io_error(status));
    }
    Ok(())
}

/// Renders the descriptor's owner, group and DACL as SDDL.
fn descriptor_to_sddl(bytes: &[u8]) -> io::Result<String> {
    let mut text: *mut u16 = std::ptr::null_mut();
    let mut length = 0u32;
    let info = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    // SAFETY: bytes is a self-relative SECURITY_DESCRIPTOR of the given length, and both out-params
    // are writable.
    let ok = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            bytes.as_ptr() as PSECURITY_DESCRIPTOR,
            SDDL_REVISION_1,
            info,
            &mut text,
            &mut length,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let allocation = LocalAllocation::new(text.cast())?;
    // SAFETY: text points at up to `length` UTF-16 units that this call allocated.
    let slice = unsafe { std::slice::from_raw_parts(text, length as usize) };
    // `length` counts the terminating NUL, which is not part of the SDDL text; leaving it in the
    // String would terminate any later re-parse early.
    let rendered = String::from_utf16_lossy(slice).trim_end_matches('\0').to_owned();
    drop(allocation);
    Ok(rendered)
}

/// Converts an SDDL string back to self-relative descriptor bytes.
fn sddl_to_descriptor(sddl: &str) -> io::Result<Vec<u8>> {
    let wide = to_wide(sddl);
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let mut size = 0u32;
    // SAFETY: wide is NUL-terminated and both out-parameters are writable.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(wide.as_ptr(), SDDL_REVISION_1, &mut descriptor, &mut size)
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let allocation = LocalAllocation::new(descriptor.cast())?;
    // SAFETY: descriptor points at `size` initialized bytes that this call allocated.
    let bytes = unsafe { std::slice::from_raw_parts(descriptor as *const u8, size as usize) }.to_vec();
    drop(allocation);
    Ok(bytes)
}

/// Inserts a DENY ACE for `account_sid` at the front of the DACL in `sddl`, or reports that it is
/// already present. The `D:` prefix is where the DACL text starts; the ACE goes immediately after it
/// so it precedes every allow ACE, which is what makes a DENY win.
fn insert_deny_ace(sddl: &str, mask: &str, account_sid: &str) -> io::Result<String> {
    let ace = deny_ace(mask, account_sid);
    if sddl.contains(&ace) {
        return Ok(sddl.to_owned());
    }
    let dacl_at = sddl.find("D:").ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "restriction descriptor has no DACL to merge into")
    })?;
    // The DACL text may carry flags (`P`, `AI`, `AR`) before its first ACE. The deny goes after the
    // flags and before every ACE; inserting before the flags would build invalid SDDL like
    // `D:(D;...)P(A;...)`.
    let mut insert_at = dacl_at + 2;
    while let Some(flag) = sddl[insert_at..].chars().next() {
        if matches!(flag, 'P' | 'A' | 'I' | 'R') {
            insert_at += flag.len_utf8();
        } else {
            break;
        }
    }
    // A null DACL (`NO_ACCESS_CONTROL`) grants everyone full access. Replacing it with a DENY-only ACE
    // list would deny every account on the machine - owner, SYSTEM and services included - and revoke
    // would leave an empty DACL that still denies everyone, so the original could not be restored.
    // Refuse rather than silently invert a machine-wide permission.
    if sddl[insert_at..].starts_with("NO_ACCESS_CONTROL") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the DCOM restriction value carries a null DACL (NO_ACCESS_CONTROL), which grants everyone; \
             refusing to replace it with a DENY-only DACL",
        ));
    }
    let mut merged = String::with_capacity(sddl.len() + ace.len());
    merged.push_str(&sddl[..insert_at]);
    merged.push_str(&ace);
    merged.push_str(&sddl[insert_at..]);
    Ok(merged)
}

/// Removes exactly the DENY ACE this module writes for `account_sid`, if present.
fn remove_deny_ace(sddl: &str, mask: &str, account_sid: &str) -> String {
    sddl.replace(&deny_ace(mask, account_sid), "")
}

/// Whether the self-relative descriptor carries a SACL.
///
/// The SDDL round trip this module uses carries the owner, the group and the DACL, never a SACL, so
/// writing the merged descriptor back would drop unrelated machine-wide auditing. `edit` refuses such a
/// value instead.
fn has_sacl(bytes: &[u8]) -> bool {
    /// `SE_SACL_PRESENT` in `SECURITY_DESCRIPTOR_CONTROL`.
    const SE_SACL_PRESENT: u16 = 0x0010;
    let mut control: u16 = 0;
    let mut revision: u32 = 0;
    // SAFETY: bytes is a self-relative SECURITY_DESCRIPTOR; both out-parameters are writable.
    let ok = unsafe {
        GetSecurityDescriptorControl(bytes.as_ptr() as PSECURITY_DESCRIPTOR, &mut control, &mut revision)
    };
    ok != 0 && control & SE_SACL_PRESENT != 0
}

fn edit(key: &OleKey, name: &str, mask: &str, account_sid: &str, add: bool) -> io::Result<()> {
    let Some(current) = read_binary(key, name)? else {
        // There is nothing to merge into and no deny to read back. Fail closed on apply rather than
        // report success while leaving the tier's COM launch path unrestricted; removal treats
        // absence as success.
        if add {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("{name} is absent, so the tier deny cannot be merged into it"),
            ));
        }
        return Ok(());
    };
    let sddl = descriptor_to_sddl(&current)?;
    let edited = if add {
        insert_deny_ace(&sddl, mask, account_sid)?
    } else {
        remove_deny_ace(&sddl, mask, account_sid)
    };
    // Nothing to change: an idempotent apply, or a removal whose ACE is absent. No write happens, so no
    // SACL can be dropped and there is nothing to refuse - a revoke of an unapplied value must succeed.
    if edited == sddl {
        return Ok(());
    }
    // A write here would rebuild the descriptor from owner/group/DACL and drop any SACL, so refuse
    // rather than discard machine-wide auditing.
    if has_sacl(&current) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{name} carries a SACL; the SDDL round trip cannot preserve it, so it is refused"),
        ));
    }
    write_binary(key, name, &sddl_to_descriptor(&edited)?)
}

/// The restriction values (of [`RESTRICTIONS`]) that currently carry this module's DENY ACE for the
/// account. The provisioning receipt and the readback self-check both read this.
pub fn tier_dcom_deny(account_sid: &str) -> io::Result<Vec<String>> {
    let key = open_ole()?;
    let mut present = Vec::new();
    for (name, mask) in RESTRICTIONS {
        let Some(current) = read_binary(&key, name)? else {
            continue;
        };
        if descriptor_to_sddl(&current)?.contains(&deny_ace(mask, account_sid)) {
            present.push(name.to_owned());
        }
    }
    Ok(present)
}

/// Merges the DENY ACE into every restriction value and verifies it by reading it back. Idempotent:
/// a value that already carries the ACE is left untouched.
pub fn apply_tier_dcom_deny(account_sid: &str) -> io::Result<()> {
    let account_sid = crate::sid_win32::canonical_sid(account_sid)?;
    let _lock = MachineLock::acquire()?;
    let key = open_ole()?;
    for (name, mask) in RESTRICTIONS {
        edit(&key, name, mask, &account_sid, true)?;
    }
    let present = tier_dcom_deny(&account_sid)?;
    for (name, _) in RESTRICTIONS {
        if !present.iter().any(|value| value == name) {
            return Err(io::Error::other(format!(
                "tier account {account_sid} still lacks the DCOM deny in {name} after apply"
            )));
        }
    }
    Ok(())
}

/// Removes this module's DENY ACE from every restriction value. Absence is success.
pub fn remove_tier_dcom_deny(account_sid: &str) -> io::Result<()> {
    let account_sid = crate::sid_win32::canonical_sid(account_sid)?;
    let _lock = MachineLock::acquire()?;
    let key = open_ole()?;
    for (name, mask) in RESTRICTIONS {
        edit(&key, name, mask, &account_sid, false)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "S-1-5-21-3360894918-1930457704-3311880440-1087";

    #[test]
    fn a_deny_ace_is_inserted_at_the_front_of_the_dacl() {
        let sddl = "O:BAG:BAD:(A;;CCDCSW;;;WD)(A;;CCDCLCSWRP;;;BA)";
        let merged = insert_deny_ace(sddl, "CCDCSW", SID).unwrap();
        assert_eq!(
            merged,
            format!("O:BAG:BAD:{}(A;;CCDCSW;;;WD)(A;;CCDCLCSWRP;;;BA)", deny_ace("CCDCSW", SID))
        );
    }

    #[test]
    fn inserting_is_idempotent() {
        let sddl = "O:BAG:BAD:(A;;CCDCSW;;;WD)";
        let once = insert_deny_ace(sddl, "CCDCSW", SID).unwrap();
        let twice = insert_deny_ace(&once, "CCDCSW", SID).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn removing_takes_out_only_our_ace() {
        let sddl = format!("O:BAG:BAD:{}(A;;CCDCSW;;;WD)", deny_ace("CCDCSW", SID));
        let removed = remove_deny_ace(&sddl, "CCDCSW", SID);
        assert_eq!(removed, "O:BAG:BAD:(A;;CCDCSW;;;WD)");
    }

    #[test]
    fn a_dacl_less_descriptor_is_a_typed_error() {
        assert!(insert_deny_ace("O:BAG:BA", "CCDCSW", SID).is_err());
    }

    #[test]
    fn dacl_flags_are_preserved_and_the_deny_precedes_the_aces() {
        let sddl = "O:BAG:BAD:PAI(A;;CCDCSW;;;WD)(A;;CCDCLCSWRP;;;BA)";
        let merged = insert_deny_ace(sddl, "CCDCSW", SID).unwrap();
        assert_eq!(
            merged,
            format!("O:BAG:BAD:PAI{}(A;;CCDCSW;;;WD)(A;;CCDCLCSWRP;;;BA)", deny_ace("CCDCSW", SID))
        );
    }

    #[test]
    fn a_descriptor_with_a_sacl_is_detected_and_refused() {
        // A SACL cannot survive an owner/group/DACL round trip, so `edit` refuses a value that carries
        // one rather than dropping unrelated auditing.
        let with_sacl = sddl_to_descriptor("O:BAG:BAD:(A;;CCDCSW;;;WD)S:(AU;SA;CCDCSW;;;WD)").unwrap();
        assert!(has_sacl(&with_sacl));
        let without = sddl_to_descriptor("O:BAG:BAD:(A;;CCDCSW;;;WD)").unwrap();
        assert!(!has_sacl(&without));
    }

    #[test]
    fn a_null_dacl_is_refused_rather_than_inverted() {
        // A null DACL grants everyone; replacing it with a DENY-only DACL would deny the whole
        // machine, so it is refused.
        assert!(insert_deny_ace("O:BAG:BAD:NO_ACCESS_CONTROL", "CCDCSW", SID).is_err());
        assert!(insert_deny_ace("O:BAG:BAD:PAINO_ACCESS_CONTROL", "CCDCSW", SID).is_err());
    }

    #[test]
    fn apply_then_remove_restores_the_original_dacl() {
        // The reviewer's required round trip: a merge followed by a removal returns the descriptor the
        // module started from, so revoke is a true backout on the normal (non-null) DACL.
        for sddl in [
            "O:BAG:BAD:(A;;CCDCSW;;;WD)(A;;CCDCLCSWRP;;;BA)",
            "O:BAG:BAD:PAI(A;;CCDCSW;;;WD)(A;;CCDCLCSWRP;;;BA)",
        ] {
            let applied = insert_deny_ace(sddl, "CCDCSW", SID).unwrap();
            assert_ne!(applied, sddl);
            assert_eq!(remove_deny_ace(&applied, "CCDCSW", SID), sddl);
        }
    }

    #[test]
    fn descriptor_round_trips_without_a_trailing_nul() {
        // Exercises the two Win32 conversions: the rendered SDDL must not carry the terminating NUL
        // the length reports, and re-parsing it must be stable.
        let bytes = sddl_to_descriptor("O:BAG:BAD:(A;;CCDCSW;;;WD)").unwrap();
        let rendered = descriptor_to_sddl(&bytes).unwrap();
        assert!(!rendered.contains('\0'), "rendered SDDL must not carry the terminating NUL: {rendered:?}");
        let again = descriptor_to_sddl(&sddl_to_descriptor(&rendered).unwrap()).unwrap();
        assert_eq!(rendered, again);
    }
}
