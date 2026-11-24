//! Where broker isolation state lives on disk, rooted in the machine's trusted shell location.
//!
//! Split out of `state` so both sides of the two-hop launch can agree on the layout without
//! agreeing on anything else: `state` reaches `acl_windows` and `credential_store`, which the
//! unelevated launcher must not link, but the launcher still has to derive the exact credential path
//! it is allowed to read (execution plan P4). Nothing here touches the filesystem, so a caller that
//! only needs to know *where* a file would be does not need permission to look.

use std::io;
use std::path::PathBuf;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::MAX_PATH;
use windows_sys::Win32::UI::Shell::{CSIDL_COMMON_APPDATA, SHGetFolderPathW};

/// The identity directory: tier credential blobs and identity records.
pub fn default_state_dir() -> io::Result<PathBuf> {
    Ok(isolation_data_dir()?.join("identities"))
}

pub fn isolation_data_dir() -> io::Result<PathBuf> {
    Ok(program_data_dir()?.join("SuperClaw").join("isolation"))
}

/// Resolves the machine's common application-data directory without trusting the caller's environment.
pub fn program_data_dir() -> io::Result<PathBuf> {
    let mut buffer = [0u16; MAX_PATH as usize];
    // SAFETY: `buffer` has the size required by the API and both optional handles are null.
    let result = unsafe {
        SHGetFolderPathW(
            null_mut(),
            CSIDL_COMMON_APPDATA as i32,
            null_mut(),
            0,
            buffer.as_mut_ptr(),
        )
    };
    if result != 0 {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("the common application data folder could not be resolved: {result:#x}"),
        ));
    }
    let length = buffer.iter().position(|unit| *unit == 0).unwrap_or(0);
    if length == 0 {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "the common application data folder resolved to an empty path",
        ));
    }
    let text = String::from_utf16(&buffer[..length]).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the common application data folder is not valid UTF-16",
        )
    })?;
    Ok(PathBuf::from(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_identity_directory_sits_under_the_isolation_data_directory() {
        // Both halves of the launch derive a credential path from this, so the two must not be able
        // to drift apart: the elevated broker writes where the unelevated launcher reads.
        assert_eq!(
            default_state_dir().unwrap(),
            isolation_data_dir().unwrap().join("identities")
        );
        assert!(
            isolation_data_dir()
                .unwrap()
                .ends_with(std::path::Path::new("SuperClaw").join("isolation"))
        );
    }
}
