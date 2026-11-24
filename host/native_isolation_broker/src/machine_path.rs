//! The machine-scoped `PATH`, read from the registry rather than from this process's environment.
//!
//! The process environment's `PATH` is the owner's merged value, and its per-user half names
//! directories under the owner's profile that a tier account cannot open. The machine half is the
//! one every account shares, and it lives in exactly one place.

use crate::wide::to_wide;
use std::io;
use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};

const ENVIRONMENT_KEY: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

/// The machine `PATH` value with its `REG_EXPAND_SZ` references expanded.
///
/// `RRF_RT_REG_SZ` without `RRF_NOEXPAND` is what makes `RegGetValueW` expand the stored
/// `%SystemRoot%\System32` form: a child does not expand the variables in its own `PATH`, so an
/// unexpanded entry names nothing. A reference to a variable this process does not carry is left
/// as written, which is why callers still filter the entries.
pub fn machine_path() -> io::Result<String> {
    let key = to_wide(ENVIRONMENT_KEY);
    let name = to_wide("Path");
    let mut buffer: Vec<u16> = Vec::new();
    loop {
        let mut bytes = u32::try_from(buffer.len() * 2)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "machine PATH is too large"))?;
        // SAFETY: `key` and `name` are NUL-terminated UTF-16 buffers that outlive the call.
        // `buffer` is valid for `bytes` bytes, and a null data pointer with zero bytes is the
        // documented sizing call.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                if buffer.is_empty() {
                    std::ptr::null_mut()
                } else {
                    buffer.as_mut_ptr().cast()
                },
                &mut bytes,
            )
        };
        match status {
            ERROR_SUCCESS if !buffer.is_empty() => {
                let length = (bytes as usize / 2).min(buffer.len());
                let text = &buffer[..length];
                let end = text
                    .iter()
                    .position(|&unit| unit == 0)
                    .unwrap_or(text.len());
                return String::from_utf16(&text[..end]).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "machine PATH is not UTF-16")
                });
            }
            // The expanded value can outgrow the size the previous call reported, so size again.
            ERROR_SUCCESS | ERROR_MORE_DATA => buffer.resize((bytes as usize).div_ceil(2) + 1, 0),
            error => {
                return Err(io::Error::from_raw_os_error(error as i32));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_machine_path_names_the_system_directory_expanded() {
        let system_root = std::env::var("SYSTEMROOT").expect("SYSTEMROOT is set on Windows");
        let path = machine_path()
            .expect("the machine PATH is readable")
            .to_ascii_lowercase();
        assert!(
            path.contains(&format!(r"{}\system32", system_root.to_ascii_lowercase())),
            "{path}"
        );
        assert!(!path.contains("%systemroot%"), "{path}");
    }
}
