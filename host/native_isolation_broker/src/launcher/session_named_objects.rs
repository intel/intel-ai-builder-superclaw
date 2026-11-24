//! Flagged, owner-side grant on this session's `BaseNamedObjects` directory (#3838).
//!
//! A supervisor whose owner logon SID is deny-only cannot use that SID's directory grant. Before the
//! supervisor is resumed, the owner adds one non-inheriting ACE for the stable tier SID matching
//! KernelBase's directory open: query, traverse, create-object, create-subdirectory and read-control.
//! The global directory is never opened or changed. Writers take a bounded byte-range lock on a file
//! directly under the owner-created backend root. Tier grants on that root are non-inheriting and do
//! not include create, so a tier cannot pre-create, open or hold this serialization primitive.

use crate::object_descriptor::{
    DaclEntry, ObjectDescriptor, ObjectKind, dacl_of, read_descriptor, require_exact,
    security_descriptor,
};
use crate::process_win32::OwnedHandle;
use crate::sid_win32::canonical_sid;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Win32::Foundation::{
    ERROR_LOCK_VIOLATION, HANDLE, UNICODE_STRING,
};
use windows_sys::Win32::Security::Authorization::{SE_KERNEL_OBJECT, SetSecurityInfo};
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Storage::FileSystem::{
    LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx, UnlockFileEx,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::IO::OVERLAPPED;
use windows_sys::Win32::System::Threading::GetCurrentProcessId;

const DIRECTORY_QUERY: u32 = 0x0001;
const DIRECTORY_TRAVERSE: u32 = 0x0002;
const DIRECTORY_CREATE_OBJECT: u32 = 0x0004;
const DIRECTORY_CREATE_SUBDIRECTORY: u32 = 0x0008;
const READ_CONTROL: u32 = 0x0002_0000;
const WRITE_DAC: u32 = 0x0004_0000;
pub(super) const TIER_DIRECTORY_RIGHTS: u32 = DIRECTORY_QUERY
    | DIRECTORY_TRAVERSE
    | DIRECTORY_CREATE_OBJECT
    | DIRECTORY_CREATE_SUBDIRECTORY
    | READ_CONTROL;
const OBJ_CASE_INSENSITIVE: u32 = 0x40;
const SERIAL_LOCK_FILE_NAME: &str = "native-role-desktop-boundary.lock";
const SERIAL_TIMEOUT: Duration = Duration::from_secs(15);
const SERIAL_POLL: Duration = Duration::from_millis(25);

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtOpenDirectoryObject(
        directory: *mut HANDLE,
        desired_access: u32,
        attributes: *const OBJECT_ATTRIBUTES,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

pub(super) fn ensure_tier_grant(tier_sid: &str, owner_backend_root: &Path) -> io::Result<()> {
    let tier_sid = canonical_sid(tier_sid)?;
    let file = open_serial_lock_file(owner_backend_root)?;
    let _guard = lock_file(&file)?;
    let directory = open_session_base_named_objects()?;
    ensure_on_handle(&directory, &tier_sid)
}

fn serial_lock_path(owner_backend_root: &Path) -> PathBuf {
    owner_backend_root.join(SERIAL_LOCK_FILE_NAME)
}

fn open_serial_lock_file(owner_backend_root: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(serial_lock_path(owner_backend_root))
}

struct FileLock<'a> {
    file: &'a File,
    overlapped: OVERLAPPED,
}

impl Drop for FileLock<'_> {
    fn drop(&mut self) {
        // SAFETY: This file and OVERLAPPED pair acquired exactly this byte-range lock.
        unsafe {
            UnlockFileEx(
                self.file.as_raw_handle() as HANDLE,
                0,
                1,
                0,
                &mut self.overlapped,
            )
        };
    }
}

fn lock_file(file: &File) -> io::Result<FileLock<'_>> {
    let deadline = Instant::now() + SERIAL_TIMEOUT;
    let mut overlapped = OVERLAPPED::default();
    loop {
        // SAFETY: The file and OVERLAPPED remain live for the synchronous non-waiting call.
        if unsafe {
            LockFileEx(
                file.as_raw_handle() as HANDLE,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        } != 0
        {
            return Ok(FileLock { file, overlapped });
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_LOCK_VIOLATION as i32) {
            return Err(error);
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out serializing the session BaseNamedObjects grant",
            ));
        }
        thread::sleep(SERIAL_POLL);
    }
}

fn open_session_base_named_objects() -> io::Result<OwnedHandle> {
    let mut session = 0;
    // SAFETY: `session` is writable.
    if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut name: Vec<u16> = format!(r"\Sessions\{session}\BaseNamedObjects")
        .encode_utf16()
        .collect();
    let name_bytes = name
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|bytes| u16::try_from(bytes).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "object path is too long"))?;
    let unicode = UNICODE_STRING {
        Length: name_bytes,
        MaximumLength: name_bytes,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: null_mut(),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut handle = null_mut();
    // SAFETY: The object attributes and string remain live for the call; `handle` is writable.
    let status =
        unsafe { NtOpenDirectoryObject(&mut handle, READ_CONTROL | WRITE_DAC, &attributes) };
    if status < 0 {
        // SAFETY: Conversion is total for an NTSTATUS.
        let error = unsafe { RtlNtStatusToDosError(status) };
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    OwnedHandle::new(handle)
}

fn ensure_on_handle(directory: &OwnedHandle, tier_sid: &str) -> io::Result<()> {
    let actual = read_descriptor(directory.raw(), ObjectKind::Kernel, false)?;
    let Some(expected) = plan_entries(&actual, tier_sid)? else {
        return Ok(());
    };
    let sddl = dacl_sddl(&expected.entries);
    let descriptor = security_descriptor(&sddl)?;
    // SAFETY: The handle carries WRITE_DAC; the ACL lives inside `descriptor` for the call.
    let status = unsafe {
        SetSecurityInfo(
            directory.raw(),
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl_of(&descriptor)?,
            null_mut(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    require_exact(
        "the session BaseNamedObjects directory",
        &read_descriptor(directory.raw(), ObjectKind::Kernel, false)?,
        &expected,
    )
}

fn plan_entries(actual: &ObjectDescriptor, tier_sid: &str) -> io::Result<Option<ObjectDescriptor>> {
    let tier_sid = canonical_sid(tier_sid)?;
    let matching: Vec<&DaclEntry> = actual
        .entries
        .iter()
        .filter(|entry| entry.sid == tier_sid)
        .collect();
    match matching.as_slice() {
        [] => {
            let mut expected = actual.clone();
            expected
                .entries
                .push(DaclEntry::allow(&tier_sid, TIER_DIRECTORY_RIGHTS)?);
            Ok(Some(expected))
        }
        [only] if only.allow && only.mask == TIER_DIRECTORY_RIGHTS && only.flags == 0 => Ok(None),
        [only] if only.allow && only.mask == 0x7 && only.flags == 0 => {
            let mut expected = actual.clone();
            let entry = expected
                .entries
                .iter_mut()
                .find(|entry| entry.sid == tier_sid)
                .expect("the matching entry exists");
            entry.mask = TIER_DIRECTORY_RIGHTS;
            Ok(Some(expected))
        }
        _ => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "the session BaseNamedObjects directory has a conflicting tier ACE: {matching:?}"
            ),
        )),
    }
}

fn dacl_sddl(entries: &[DaclEntry]) -> String {
    let mut sddl = String::from("D:");
    for entry in entries {
        let kind = if entry.allow { 'A' } else { 'D' };
        let flags = ace_flags_sddl(entry.flags);
        sddl.push_str(&format!(
            "({kind};{flags};0x{:08x};;;{})",
            entry.mask, entry.sid
        ));
    }
    sddl
}

fn ace_flags_sddl(flags: u8) -> String {
    [
        (0x01, "OI"),
        (0x02, "CI"),
        (0x04, "NP"),
        (0x08, "IO"),
        (0x10, "ID"),
        (0x40, "SA"),
        (0x80, "FA"),
    ]
    .into_iter()
    .filter_map(|(bit, text)| (flags & bit != 0).then_some(text))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIER: &str = "S-1-5-21-1-2-3-2002";

    fn descriptor(entries: Vec<DaclEntry>) -> ObjectDescriptor {
        ObjectDescriptor {
            owner: None,
            protected: false,
            entries,
        }
    }

    #[test]
    fn the_plan_appends_one_exact_non_inheriting_ace() {
        let original = descriptor(vec![
            DaclEntry::allow("S-1-5-18", 0x000F_000F).expect("SYSTEM"),
            DaclEntry {
                allow: true,
                sid: "S-1-1-0".to_owned(),
                mask: 0x0C,
                flags: 0x02,
            },
        ]);
        let planned = plan_entries(&original, TIER).expect("plan").expect("write");
        assert_eq!(&planned.entries[..original.entries.len()], original.entries);
        assert_eq!(
            planned.entries.last(),
            Some(&DaclEntry::allow(TIER, 0x0002_000f).expect("tier"))
        );
    }

    #[test]
    fn the_plan_is_idempotent_and_refuses_conflicts() {
        let exact = descriptor(vec![DaclEntry::allow(TIER, 0x0002_000f).expect("tier")]);
        assert_eq!(plan_entries(&exact, TIER).expect("plan"), None);
        for entry in [
            DaclEntry::allow(TIER, 0x000f).expect("narrow"),
            DaclEntry::allow(TIER, 0x0006_000f).expect("wide"),
            DaclEntry {
                allow: true,
                sid: TIER.to_owned(),
                mask: 0x0002_000f,
                flags: 0x2,
            },
        ] {
            assert_eq!(
                plan_entries(&descriptor(vec![entry]), TIER)
                    .expect_err("conflict")
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }

    #[test]
    fn the_plan_upgrades_the_previous_spike_ace() {
        let legacy = descriptor(vec![DaclEntry::allow(TIER, 0x7).expect("tier")]);
        let planned = plan_entries(&legacy, TIER).expect("plan").expect("write");
        assert_eq!(
            planned.entries,
            vec![DaclEntry::allow(TIER, TIER_DIRECTORY_RIGHTS).expect("tier")]
        );
    }

    #[test]
    fn existing_ace_flags_round_trip_into_sddl() {
        let entries = vec![
            DaclEntry {
                allow: true,
                sid: "S-1-5-18".to_owned(),
                mask: 0x1000_0000,
                flags: 0x0B,
            },
            DaclEntry::allow(TIER, 0x0002_000f).expect("tier"),
        ];
        assert_eq!(
            dacl_sddl(&entries),
            format!("D:(A;OICIIO;0x10000000;;;S-1-5-18)(A;;0x0002000f;;;{TIER})")
        );
    }

    #[test]
    fn serialization_uses_the_owner_backend_root_not_a_named_object() {
        let root = Path::new(r"C:\owner\AppData\Local\SuperClaw\backend");
        assert_eq!(
            serial_lock_path(root),
            root.join("native-role-desktop-boundary.lock")
        );
        for namespace in [r"Local\", r"Global\", r"\BaseNamedObjects"] {
            assert!(!SERIAL_LOCK_FILE_NAME.starts_with(namespace));
        }
    }
}
