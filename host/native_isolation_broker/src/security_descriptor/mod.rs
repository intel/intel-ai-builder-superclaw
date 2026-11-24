//! Win32 security-descriptor primitives: protected-DACL readback, handle-level object-type checks,
//! bounded handle reads and writes, and the owned wrappers those need.
//!
//! This module knows nothing about which descriptor any particular broker file deserves. The
//! broker-wide `SY + BA` state descriptor lives in `acl_windows`, the widened tier-credential
//! descriptor lives in `credential_read`, and product ACL plans live in `acl_policy_apply`; all
//! three come here for the readback machinery so there is one implementation of "what descriptor
//! does this object really have".
//!
//! Nothing here writes a security descriptor. Applying one - `SetSecurityInfo`, convergence,
//! revocation - is `security_descriptor_apply`, which the unelevated launcher does not declare. The
//! division is what lets the launcher read a credential under a verified descriptor without linking
//! a single DACL write; see `security_descriptor_apply`'s header for the whole argument.

use crate::wide::to_wide;
use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
    GetSecurityDescriptorOwner, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    SE_DACL_PROTECTED, SECURITY_ATTRIBUTES,
};
// Only `dacl_ace_entries` walks individual ACEs, and only tests need to: production code compares
// whole DACL byte images rather than reasoning about one ACE at a time.
#[cfg(test)]
use windows_sys::Win32::Security::{ACCESS_ALLOWED_ACE, ACCESS_DENIED_ACE, ACE_HEADER, GetAce};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FileAttributeTagInfo, GetFileInformationByHandleEx, ReadFile, WriteFile,
};

/// Canonical DACL bytes for `sddl`, for callers that compare the two halves themselves so they can
/// report exactly which check failed.
pub fn expected_dacl_bytes(sddl: &str) -> io::Result<Vec<u8>> {
    OwnedSecurityDescriptor::from_sddl(sddl)?.dacl_bytes()
}

pub fn read_security_descriptor_for_handle(handle: HANDLE) -> io::Result<OwnedSecurityDescriptor> {
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
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
    OwnedSecurityDescriptor::new(descriptor)
}

pub struct OwnedSecurityDescriptor(PSECURITY_DESCRIPTOR);

impl OwnedSecurityDescriptor {
    fn new(descriptor: PSECURITY_DESCRIPTOR) -> io::Result<Self> {
        if descriptor.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(descriptor))
        }
    }

    pub fn from_sddl(sddl: &str) -> io::Result<Self> {
        let sddl = to_wide(sddl);
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Self::new(descriptor)
    }

    pub fn dacl(&self) -> io::Result<*mut ACL> {
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = null_mut();
        if unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        if present == 0 || dacl.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "security descriptor has no DACL",
            ));
        }
        Ok(dacl)
    }

    pub fn dacl_bytes(&self) -> io::Result<Vec<u8>> {
        let dacl = self.dacl()?;
        Ok(
            unsafe { std::slice::from_raw_parts(dacl.cast::<u8>(), (*dacl).AclSize as usize) }
                .to_vec(),
        )
    }

    pub fn owner_sid_ptr(&self) -> io::Result<Option<*mut c_void>> {
        let mut owner = null_mut();
        let mut defaulted = 0;
        if unsafe { GetSecurityDescriptorOwner(self.0, &mut owner, &mut defaulted) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(if owner.is_null() { None } else { Some(owner) })
    }

    pub fn owner_sid_string(&self) -> io::Result<Option<String>> {
        let Some(owner) = self.owner_sid_ptr()? else {
            return Ok(None);
        };
        sid_to_string(owner).map(Some)
    }

    pub fn dacl_is_protected(&self) -> io::Result<bool> {
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(self.0, &mut control, &mut revision) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(control & SE_DACL_PROTECTED != 0)
    }

    pub fn dacl_sddl(&self) -> io::Result<String> {
        let mut value = null_mut();
        let mut length = 0;
        if unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                self.0,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut value,
                &mut length,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let value_owner = OwnedLocal(value.cast());
        let units = unsafe { std::slice::from_raw_parts(value, length as usize) };
        let text_end = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        let result = String::from_utf16(&units[..text_end])
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "DACL SDDL is invalid UTF-16"));
        drop(value_owner);
        result
    }

    /// Every DACL ACE as `(ace_type, ace_flags, access_mask, trustee_sid)`, for tests that must
    /// assert on exact principals and rights rather than on an SDDL string.
    #[cfg(test)]
    pub fn dacl_ace_entries(&self) -> io::Result<Vec<(u8, u8, u32, String)>> {
        let dacl = self.dacl()?;
        let mut entries = Vec::new();
        for index in 0..unsafe { (*dacl).AceCount } {
            let mut ace: *mut c_void = null_mut();
            if unsafe { GetAce(dacl, u32::from(index), &mut ace) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let header = unsafe { *ace.cast::<ACE_HEADER>() };
            let (mask, sid) = match header.AceType {
                0 => unsafe {
                    (
                        (*ace.cast::<ACCESS_ALLOWED_ACE>()).Mask,
                        std::ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart).cast(),
                    )
                },
                1 => unsafe {
                    (
                        (*ace.cast::<ACCESS_DENIED_ACE>()).Mask,
                        std::ptr::addr_of_mut!((*ace.cast::<ACCESS_DENIED_ACE>()).SidStart).cast(),
                    )
                },
                other => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("unexpected ACE type {other}"),
                    ));
                }
            };
            entries.push((header.AceType, header.AceFlags, mask, sid_to_string(sid)?));
        }
        Ok(entries)
    }

    pub fn security_attributes(&mut self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}

impl Drop for OwnedSecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub fn sid_to_string(sid: *mut c_void) -> io::Result<String> {
    let mut value = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut value) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let value_owner = OwnedLocal(value.cast());
    let mut length = 0usize;
    while unsafe { *value.add(length) } != 0 {
        length += 1;
    }
    let units = unsafe { std::slice::from_raw_parts(value, length) };
    let text = String::from_utf16(units)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "SID is invalid UTF-16"));
    drop(value_owner);
    text
}

pub(crate) struct OwnedLocal(pub(crate) *mut c_void);

impl Drop for OwnedLocal {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    pub const fn new(handle: HANDLE) -> Self {
        Self(handle)
    }

    pub const fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub fn write_all(handle: HANDLE, payload: &[u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < payload.len() {
        let mut written = 0;
        if unsafe {
            WriteFile(
                handle,
                payload[offset..].as_ptr(),
                (payload.len() - offset) as u32,
                &mut written,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "broker state file accepted zero bytes",
            ));
        }
        offset += written as usize;
    }
    Ok(())
}

pub fn read_exact(handle: HANDLE, payload: &mut [u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < payload.len() {
        let mut read = 0;
        if unsafe {
            ReadFile(
                handle,
                payload[offset..].as_mut_ptr(),
                (payload.len() - offset) as u32,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "broker state file ended before its declared size",
            ));
        }
        offset += read as usize;
    }
    Ok(())
}

/// Rejects reparse points and wrong object types on an already-open handle, so the decision is made
/// against the object the handle really refers to rather than against a path that can change.
pub fn verify_plain_handle(handle: HANDLE, expected_directory: bool) -> io::Result<()> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "broker state path is a reparse point",
        ));
    }
    let is_directory = info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if is_directory != expected_directory {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "broker state path has the wrong object type",
        ));
    }
    Ok(())
}

/// Collision-free temporary path for descriptor tests across this crate's modules.
#[cfg(test)]
pub fn unique_temp_path(label: &str) -> std::path::PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "superclaw-broker-{label}-{}-{unique}",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod legacy_tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        OPEN_EXISTING, READ_CONTROL,
    };

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
}
