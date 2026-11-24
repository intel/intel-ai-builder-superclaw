//! The test-boundary named-pipe transport.
//!
//! Every limit this module enforces is `protocol.rs`'s own 16 KiB test budget, passed explicitly at
//! each call so the value is visible here rather than inherited from a crate-wide constant. The
//! production launcher transport is a separate module (`launcher/pipe.rs`) with its own budget and its
//! own directional ACLs; this one is deliberately unreachable from the launcher's module closure.

use crate::frame::FRAME_PREFIX_BYTES;
use crate::protocol::{
    MAX_TEST_FRAME_BYTES, ProtocolError, Response, declared_frame_len, encode_frame,
};
use crate::sid_win32::{LocalAllocation, token_sid_for_pid};
use std::io;
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE,
    GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE, FlushFileBuffers,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT, PeekNamedPipe,
    WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const PIPE_PREFIX: &str = r"\\.\pipe\SuperClawNativeIsolationTest-";
const PIPE_BUFFER_SIZE: u32 = (MAX_TEST_FRAME_BYTES + FRAME_PREFIX_BYTES) as u32;

#[derive(Debug)]
struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE) -> io::Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    const fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: OwnedHandle is the sole owner of a valid, non-pseudo HANDLE.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub struct PipeClient {
    handle: OwnedHandle,
}

impl PipeClient {
    pub fn connect(pipe_id: &str, timeout: Duration) -> io::Result<Self> {
        let name = pipe_name(pipe_id)?;
        let wide = wide_null(&name);
        let deadline = Instant::now() + timeout;
        loop {
            // SAFETY: The UTF-16 string is NUL terminated, and no handles are inherited.
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(Self {
                    handle: OwnedHandle::new(handle)?,
                });
            }
            if Instant::now() >= deadline {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: The UTF-16 string remains valid for this call.
            unsafe {
                WaitNamedPipeW(wide.as_ptr(), 50);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn exchange<T: serde::Serialize>(&self, request: &T) -> io::Result<Response> {
        write_all(
            self.handle.raw(),
            &encode_frame(request, MAX_TEST_FRAME_BYTES).map_err(protocol_io_error)?,
        )?;
        let payload = read_frame_blocking(self.handle.raw())?;
        serde_json::from_slice(&payload)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }
}

pub struct PipeServer {
    handle: OwnedHandle,
}

impl PipeServer {
    pub fn create(pipe_id: &str, owner_sid: &str) -> io::Result<Self> {
        let name = wide_null(&pipe_name(pipe_id)?);
        let sddl = wide_null(&format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{owner_sid})"));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: Inputs are valid NUL-terminated UTF-16 and output receives LocalAlloc memory.
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
        let descriptor_owner = LocalAllocation::new(descriptor)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor_owner.pointer(),
            bInheritHandle: 0,
        };
        // SAFETY: Name and security attributes remain valid; handle inheritance is disabled.
        let handle = OwnedHandle::new(unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                PIPE_BUFFER_SIZE,
                PIPE_BUFFER_SIZE,
                0,
                &attributes,
            )
        })?;
        Ok(Self { handle })
    }

    pub fn connect(&self) -> io::Result<()> {
        // SAFETY: The pipe is a valid server handle; synchronous connection uses no OVERLAPPED.
        if unsafe { ConnectNamedPipe(self.handle.raw(), null_mut()) } != 0 {
            return Ok(());
        }
        // SAFETY: GetLastError immediately follows the failed API call.
        if unsafe { GetLastError() } == ERROR_PIPE_CONNECTED {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub fn client_sid(&self) -> io::Result<String> {
        let mut pid = 0;
        // SAFETY: The pipe is connected and pid points to writable storage.
        if unsafe { GetNamedPipeClientProcessId(self.handle.raw(), &mut pid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        token_sid_for_pid(pid)
    }

    pub fn poll_frame(&self, deadline: Option<Instant>) -> io::Result<Option<Vec<u8>>> {
        loop {
            if deadline.is_some_and(|value| Instant::now() >= value) {
                return Ok(None);
            }
            let mut available = 0;
            // SAFETY: The pipe is connected and only the availability output is requested.
            if unsafe {
                PeekNamedPipe(
                    self.handle.raw(),
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            } == 0
            {
                let code = unsafe { GetLastError() };
                if code == ERROR_BROKEN_PIPE {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "named-pipe client disconnected",
                    ));
                }
                return Err(io::Error::last_os_error());
            }
            if deadline.is_some_and(|value| Instant::now() >= value) {
                return Ok(None);
            }
            if available >= 4 {
                let mut prefix = [0u8; 4];
                read_exact(self.handle.raw(), &mut prefix)?;
                let length =
                    declared_frame_len(prefix, MAX_TEST_FRAME_BYTES).map_err(protocol_io_error)?;
                return read_payload_when_available(self.handle.raw(), length, deadline).map(Some);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn write<T: serde::Serialize>(&self, value: &T) -> io::Result<()> {
        write_all(
            self.handle.raw(),
            &encode_frame(value, MAX_TEST_FRAME_BYTES).map_err(protocol_io_error)?,
        )
    }

    pub fn finish(&self) {
        // SAFETY: The connected server pipe handle is valid.
        unsafe {
            FlushFileBuffers(self.handle.raw());
            DisconnectNamedPipe(self.handle.raw());
        }
    }
}

pub struct ProcessWitness {
    process: OwnedHandle,
}

impl ProcessWitness {
    pub fn open(pid: u32) -> io::Result<Self> {
        // SAFETY: OpenProcess is called with a numeric PID and non-inheritable handle.
        let process = OwnedHandle::new(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) })?;
        Ok(Self { process })
    }

    pub fn has_exited(&self, timeout: Duration) -> bool {
        // SAFETY: The retained process handle is valid for synchronization.
        unsafe {
            WaitForSingleObject(
                self.process.raw(),
                timeout.as_millis().min(u32::MAX as u128) as u32,
            ) == WAIT_OBJECT_0
        }
    }
}

fn read_payload_when_available(
    pipe: HANDLE,
    length: usize,
    deadline: Option<Instant>,
) -> io::Result<Vec<u8>> {
    loop {
        if deadline.is_some_and(|value| Instant::now() >= value) {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "lease expired during partial request",
            ));
        }
        let mut available = 0;
        // SAFETY: The pipe is connected and only availability is requested.
        if unsafe { PeekNamedPipe(pipe, null_mut(), 0, null_mut(), &mut available, null_mut()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        if deadline.is_some_and(|value| Instant::now() >= value) {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "lease expired during partial request",
            ));
        }
        if available as usize >= length {
            let mut payload = vec![0; length];
            read_exact(pipe, &mut payload)?;
            return Ok(payload);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn read_frame_blocking(pipe: HANDLE) -> io::Result<Vec<u8>> {
    let mut prefix = [0u8; 4];
    read_exact(pipe, &mut prefix)?;
    let length = declared_frame_len(prefix, MAX_TEST_FRAME_BYTES).map_err(protocol_io_error)?;
    let mut payload = vec![0; length];
    read_exact(pipe, &mut payload)?;
    Ok(payload)
}

fn read_exact(handle: HANDLE, buffer: &mut [u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < buffer.len() {
        let mut read = 0;
        // SAFETY: The handle is readable and the remaining buffer is writable.
        if unsafe {
            ReadFile(
                handle,
                buffer[offset..].as_mut_ptr(),
                (buffer.len() - offset) as u32,
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
                "pipe closed during frame",
            ));
        }
        offset += read as usize;
    }
    Ok(())
}

fn write_all(handle: HANDLE, buffer: &[u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < buffer.len() {
        let mut written = 0;
        // SAFETY: The handle is writable and the remaining buffer is readable.
        if unsafe {
            WriteFile(
                handle,
                buffer[offset..].as_ptr(),
                (buffer.len() - offset) as u32,
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
                "pipe accepted zero bytes",
            ));
        }
        offset += written as usize;
    }
    Ok(())
}

fn pipe_name(pipe_id: &str) -> io::Result<String> {
    if pipe_id.is_empty()
        || pipe_id.len() > 64
        || !pipe_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pipe ID must be 1-64 ASCII letters, digits, '-' or '_'",
        ));
    }
    Ok(format!("{PIPE_PREFIX}{pipe_id}"))
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn protocol_io_error(error: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.code())
}
