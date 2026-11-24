//! The desktop a process was created on, read from its own memory (#3499, #3400).
//!
//! The owner resumes the supervisor only after reading the `DesktopInfo` of its process parameters
//! through the duplicated full-access process handle it has already verified, and requiring it to be
//! exactly the tier's private desktop. The bootstrap that chose `lpDesktop` is the process exposed by the
//! #3713 window, so its choice is checked rather than trusted. The owner reads it only after the bootstrap,
//! which held a full-access handle to the supervisor, has ended.
//!
//! What the check does not cover (#3713): the supervisor's process and primary thread grant the tier and
//! SYSTEM full access by design, so until the owner resumes it a process of the same tier can open both,
//! write its memory - including after this read - and manipulate or resume its thread before the
//! owner's checks finish. The owner refuses an early resume it finds left running, but cannot prevent
//! code having run, under seven of the eight UI limits if it ran before the seal. Whatever that code does
//! runs with the supervisor's restricted token, which keeps the owner's interactive logon SID enabled
//! (#3805), so it can open `WinSta0` and the owner's desktop. This check's purpose is catching a wrong
//! `lpDesktop` from the bootstrap. Closing the rest is a protected supervisor DACL at creation, follow-up
//! work under #3713.
//!
//! The read uses `NtQueryInformationProcess(ProcessBasicInformation)` for the PEB address and
//! `ReadProcessMemory` for the rest, at the 64-bit offsets of `PEB.ProcessParameters` (0x20) and
//! `RTL_USER_PROCESS_PARAMETERS.DesktopInfo` (0xC0), which the public headers leave reserved. Other
//! pointer widths do not build the reader and refuse instead. Every field is validated before it is
//! used, and the whole read is bounded by `MAX_DESKTOP_INFO_BYTES`.

use std::io;
use std::os::windows::io::{AsRawHandle, BorrowedHandle};

/// Well above a `station\desktop` path, whose two parts are each bounded by the 256-unit object name.
pub const MAX_DESKTOP_INFO_BYTES: usize = 2048;

/// A `UNICODE_STRING` as it sits in another process: `Length` and `MaximumLength` in bytes, four bytes
/// of padding, then `Buffer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnicodeStringField {
    pub length: u16,
    pub maximum: u16,
    pub buffer: u64,
}

impl UnicodeStringField {
    /// The 64-bit layout's sixteen bytes.
    pub fn parse(bytes: [u8; 16]) -> Self {
        let mut buffer = [0u8; 8];
        buffer.copy_from_slice(&bytes[8..]);
        Self {
            length: u16::from_le_bytes([bytes[0], bytes[1]]),
            maximum: u16::from_le_bytes([bytes[2], bytes[3]]),
            buffer: u64::from_le_bytes(buffer),
        }
    }

    /// How many bytes to read from `buffer`, once the fields are consistent: an even `Length` no larger
    /// than `MaximumLength` or `MAX_DESKTOP_INFO_BYTES`, and a `Buffer` whenever `Length` is not zero.
    pub fn validated_length(&self) -> io::Result<usize> {
        let length = usize::from(self.length);
        if length % 2 != 0
            || self.length > self.maximum
            || length > MAX_DESKTOP_INFO_BYTES
            || (length > 0 && self.buffer == 0)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "malformed DesktopInfo: Length {}, MaximumLength {}, Buffer {:#x}",
                    self.length, self.maximum, self.buffer
                ),
            ));
        }
        Ok(length)
    }
}

/// Requires the `DesktopInfo` read from the supervisor to be exactly `expected`, the adopted
/// `station\desktop`: byte for byte, so case counts in both parts.
pub fn require_desktop(actual: &str, expected: &str) -> io::Result<()> {
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the supervisor was created on '{actual}', not on {expected}"),
        ));
    }
    Ok(())
}

/// The `DesktopInfo` `process` was created with. The handle needs `PROCESS_QUERY_INFORMATION` and
/// `PROCESS_VM_READ`; the owner's supervisor handle carries all access.
#[cfg(target_pointer_width = "64")]
pub fn desktop_info(process: BorrowedHandle<'_>) -> io::Result<String> {
    use std::ptr::null_mut;
    use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;

    let handle = process.as_raw_handle();
    let read = |address: u64, buffer: &mut [u8]| -> io::Result<()> {
        let mut read = 0usize;
        // SAFETY: The buffer is writable for its whole length; the handle allows reading the process.
        let ok = unsafe {
            ReadProcessMemory(
                handle,
                address as usize as *const _,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut read,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        if read != buffer.len() {
            return Err(io::Error::other(format!(
                "read {read} of {} bytes at {address:#x}",
                buffer.len()
            )));
        }
        Ok(())
    };
    let pointer_at = |address: u64| -> io::Result<u64> {
        let mut bytes = [0u8; 8];
        read(address, &mut bytes)?;
        match u64::from_le_bytes(bytes) {
            0 => Err(io::Error::other(format!("a null pointer at {address:#x}"))),
            pointer => Ok(pointer),
        }
    };
    let offset = |base: u64, by: u64| {
        base.checked_add(by)
            .ok_or_else(|| io::Error::other(format!("{base:#x} + {by:#x} overflows")))
    };

    // `PROCESS_BASIC_INFORMATION` is six pointer-sized fields, and the PEB address is the second.
    let mut basic = [0u64; 6];
    // SAFETY: The output buffer has the size of `PROCESS_BASIC_INFORMATION`, which is what is passed.
    let status = unsafe {
        NtQueryInformationProcess(
            handle,
            ProcessBasicInformation,
            (&raw mut basic).cast(),
            size_of_val(&basic) as u32,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::other(format!(
            "NtQueryInformationProcess(ProcessBasicInformation) failed with {:#x}",
            status as u32
        )));
    }
    if basic[1] == 0 {
        return Err(io::Error::other("the process has no PEB address"));
    }
    let parameters = pointer_at(offset(basic[1], 0x20)?)?;
    let mut field = [0u8; 16];
    read(offset(parameters, 0xC0)?, &mut field)?;
    let field = UnicodeStringField::parse(field);
    let mut text = vec![0u8; field.validated_length()?];
    if !text.is_empty() {
        read(field.buffer, &mut text)?;
    }
    let units: Vec<u16> = text
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "DesktopInfo is not UTF-16"))
}

/// No other layout is known, so no other width can verify a supervisor's desktop.
#[cfg(not(target_pointer_width = "64"))]
pub fn desktop_info(_process: BorrowedHandle<'_>) -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "DesktopInfo is read only from 64-bit processes",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED: &str = r"Service-0x0-6eef81$\SuperClawTier-0123456789abcdef";

    fn field(length: u16, maximum: u16, buffer: u64) -> [u8; 16] {
        let mut bytes = [0u8; 16];
        bytes[..2].copy_from_slice(&length.to_le_bytes());
        bytes[2..4].copy_from_slice(&maximum.to_le_bytes());
        bytes[8..].copy_from_slice(&buffer.to_le_bytes());
        bytes
    }

    #[test]
    fn only_the_exact_private_desktop_is_accepted() {
        require_desktop(EXPECTED, EXPECTED).expect("exact");
        for wrong in [
            r"Service-0x0-6eef81$\SuperClawTier-fedcba9876543210",
            r"Service-0x0-6eef81$\superclawtier-0123456789abcdef",
            r"Service-0x0-6eef82$\SuperClawTier-0123456789abcdef",
            r"WinSta0\Default",
            r"WinSta0\SuperClawTier-0123456789abcdef",
            "SuperClawTier-0123456789abcdef",
            "",
            r"Service-0x0-6eef81$\SuperClawTier-0123456789abcdef ",
        ] {
            let error = require_desktop(wrong, EXPECTED).expect_err(wrong);
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{wrong}");
            assert!(error.to_string().contains(EXPECTED), "{error}");
        }
    }

    #[test]
    fn a_well_formed_field_parses_to_its_length() {
        let parsed = UnicodeStringField::parse(field(98, 100, 0x7ff6_1234_0000));
        assert_eq!(
            parsed,
            UnicodeStringField {
                length: 98,
                maximum: 100,
                buffer: 0x7ff6_1234_0000
            }
        );
        assert_eq!(parsed.validated_length().expect("valid"), 98);
        assert_eq!(
            UnicodeStringField::parse(field(0, 0, 0))
                .validated_length()
                .expect("an empty string needs no buffer"),
            0
        );
    }

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn this_process_s_own_desktop_info_reads_back_within_the_bound() {
        // SAFETY: The current-process pseudo-handle is valid for the whole test.
        let me = unsafe {
            BorrowedHandle::borrow_raw(windows_sys::Win32::System::Threading::GetCurrentProcess())
        };
        let read = desktop_info(me).expect("this process's own DesktopInfo");
        assert!(read.len() * 2 <= MAX_DESKTOP_INFO_BYTES, "{read}");
    }

    #[test]
    fn a_malformed_field_is_refused_before_anything_is_read() {
        let over = (MAX_DESKTOP_INFO_BYTES + 2) as u16;
        for (bytes, why) in [
            (field(99, 100, 0x1000), "odd length"),
            (field(102, 100, 0x1000), "length above maximum"),
            (field(98, 100, 0), "no buffer"),
            (field(over, over, 0x1000), "above the bound"),
        ] {
            assert!(
                UnicodeStringField::parse(bytes).validated_length().is_err(),
                "{why}"
            );
        }
    }
}
