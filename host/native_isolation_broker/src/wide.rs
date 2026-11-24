//! Shared UTF-16 conversion helper for Win32 wide-string APIs.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

/// Converts a Rust string (or path) to a null-terminated UTF-16 buffer suitable for
/// `PCWSTR`/`PWSTR`.
pub fn to_wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}
