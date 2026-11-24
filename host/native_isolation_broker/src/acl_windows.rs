//! The broker-wide `SYSTEM + Administrators` state descriptor and the file/directory I/O that
//! enforces it.
//!
//! Everything the broker owns under `%ProgramData%\SuperClaw\isolation` carries this descriptor:
//! identity records, the workspace grant store, ACL records and every directory. The one exception
//! is the tier credential blob, which `credential_store` widens with a read-only owner ACE; that
//! file class deliberately does not come through `write_broker_file` / `read_broker_file`, so an
//! owner-readable descriptor can never reach a file that is supposed to stay unreadable, and a
//! credential can never be accepted under the narrower descriptor either.
//!
//! The descriptor-level machinery lives in `security_descriptor` (protected-DACL readback, handle
//! type checks, bounded handle I/O) and `security_descriptor_apply` (exact apply).

use crate::security_descriptor::{
    OwnedHandle, OwnedSecurityDescriptor, read_exact, verify_plain_handle, write_all,
};
use crate::security_descriptor_apply::{AclApplyOutcome, apply_sddl_dacl_and_verify, dacl_matches};
use crate::wide::to_wide;
use std::io;
use std::path::Path;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_ALWAYS, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_NORMAL,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FlushFileBuffers, GetFileSizeEx,
    OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
};

pub const BROKER_FILE_DACL: &str = "D:P(A;;FA;;;SY)(A;;FA;;;BA)";
pub const BROKER_DIRECTORY_DACL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

pub fn protect_broker_path(path: &Path, directory: bool) -> io::Result<AclApplyOutcome> {
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
            READ_CONTROL | WRITE_DAC,
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
    let owned = OwnedHandle::new(handle);
    verify_plain_handle(owned.raw(), directory)?;
    apply_sddl_dacl_and_verify(
        owned.raw(),
        if directory {
            BROKER_DIRECTORY_DACL
        } else {
            BROKER_FILE_DACL
        },
    )
}

pub fn ensure_broker_directory(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut descriptor = OwnedSecurityDescriptor::from_sddl(BROKER_DIRECTORY_DACL)?;
    let attributes = descriptor.security_attributes();
    let path_wide = to_wide(path);
    if unsafe { CreateDirectoryW(path_wide.as_ptr(), &attributes) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
            return Err(error);
        }
    }
    protect_broker_path(path, true)?;
    Ok(())
}

pub fn write_broker_file(path: &Path, payload: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "broker state file has no parent",
        )
    })?;
    ensure_broker_directory(parent)?;
    let mut descriptor = OwnedSecurityDescriptor::from_sddl(BROKER_FILE_DACL)?;
    let attributes = descriptor.security_attributes();
    let path_wide = to_wide(path);
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
    apply_sddl_dacl_and_verify(handle.raw(), BROKER_FILE_DACL)?;
    write_all(handle.raw(), payload)?;
    if unsafe { FlushFileBuffers(handle.raw()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn read_broker_file(path: &Path, max_size: usize) -> io::Result<Vec<u8>> {
    let path_wide = to_wide(path);
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            GENERIC_READ | READ_CONTROL,
            0,
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
    if !dacl_matches(handle.raw(), BROKER_FILE_DACL)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "broker state file DACL does not match the protected descriptor",
        ));
    }

    let mut length = 0i64;
    if unsafe { GetFileSizeEx(handle.raw(), &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if length < 0 || length as u128 > max_size as u128 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "broker state file exceeds its size bound",
        ));
    }
    let mut payload = vec![0u8; length as usize];
    read_exact(handle.raw(), &mut payload)?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_state_dacl_names_only_system_and_administrators() {
        let descriptor = OwnedSecurityDescriptor::from_sddl(BROKER_FILE_DACL).unwrap();
        assert_eq!(descriptor.dacl_sddl().unwrap(), BROKER_FILE_DACL);
        assert!(descriptor.dacl_is_protected().unwrap());
    }

    #[test]
    fn broker_state_dacl_never_names_an_owner() {
        // Guards the P3 boundary from the other side: only `credential_store` may widen a file
        // class, and it does so with its own descriptor rather than by editing these constants.
        for sddl in [BROKER_FILE_DACL, BROKER_DIRECTORY_DACL] {
            let principals: Vec<_> = OwnedSecurityDescriptor::from_sddl(sddl)
                .unwrap()
                .dacl_ace_entries()
                .unwrap()
                .into_iter()
                .map(|entry| entry.3)
                .collect();
            assert_eq!(principals, vec!["S-1-5-18", "S-1-5-32-544"]);
        }
    }
}
