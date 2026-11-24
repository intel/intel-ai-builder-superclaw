//! The production launcher-to-tier-runner transport: two one-way named pipes.
//!
//! # Why two pipes and not one
//!
//! A single `PIPE_ACCESS_DUPLEX` pipe cannot serve both directions here. A pending read issued on one
//! handle of a byte-mode pipe blocks a write issued on another handle of the same pipe, so the launcher
//! waiting for a report while the runner waits for a command is a deadlock rather than a conversation.
//! Two pipes also make the access control expressible: each one grants the tier account exactly one
//! data right, which a duplex pipe could not do at all.
//!
//! # What this module does and does not decide
//!
//! It creates the two pipes, decides their access control, proves who is on the other end, and hands
//! bounded frames to `crate::pipe_io`, which is where every wait is made overlapped and bounded. It does
//! not parse a frame, does not know what a `Start` is, and does not hold the authentication key; that is
//! `wire.rs`. Nothing here treats a runner's bytes as trustworthy, because the runner shares an account
//! with the role it launches.

use super::pipe_acl::{
    Ace, PipeRole, pipe_name, pipe_sddl, read_dacl, security_descriptor_from_sddl, verify_pipe_dacl,
};
use super::wire::MAX_TIER_FRAME_BYTES;
use crate::frame::FRAME_PREFIX_BYTES;
use crate::pipe_io::Endpoint;
use crate::process_win32::{OwnedHandle, wide_null};
use crate::sid_win32::{canonical_sid, token_sid_for_owned_process};
use crate::token_info::token_user;
use std::io;
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_PIPE_CONNECTED, GetLastError, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::{RevertToSelf, SECURITY_ATTRIBUTES, TOKEN_QUERY};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
    OPEN_EXISTING, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, ImpersonateNamedPipeClient,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT, WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{GetCurrentThread, OpenThreadToken};

/// Both pipe buffers hold exactly one maximum frame, so a peer can hand off a whole frame without the
/// other peer having read a byte yet, and cannot queue a second one behind it.
const TIER_PIPE_BUFFER_BYTES: u32 = (MAX_TIER_FRAME_BYTES + FRAME_PREFIX_BYTES) as u32;
pub const MAX_CONNECTOR_SECRET_BYTES: usize = 8 * 1024;

/// How long each retry of a client connect attempt waits on the pipe before trying again.
const CONNECT_POLL_MS: u32 = 50;

/// The runner's security quality of service on every pipe it opens: identification level, with static
/// tracking, so its security context is captured when it opens the pipe. Without that the context is
/// captured only with data the server reads, and the control pipe carries none to the owner, so the
/// owner could not read the restricted supervisor's token from its connection before sending `Start`
/// (measured: 1368, `ERROR_CANT_IMPERSONATE_UNTIL_DATA_READ`). Identification is enough to read a token
/// and lets the owner do nothing as the tier.
const RUNNER_PIPE_SECURITY: u32 = SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION;

/// The launcher's end of one pipe: it creates the pipe, so it decides the ACL and learns who connected.
pub struct TierPipeServer {
    endpoint: Endpoint,
    role: PipeRole,
}

impl TierPipeServer {
    /// Creates one pipe and refuses to return it unless its stored DACL is exactly what was asked for.
    ///
    /// `FILE_FLAG_FIRST_PIPE_INSTANCE` with `nMaxInstances = 1` is what makes a squatter detectable
    /// rather than invisible: if the name already exists, creation fails instead of joining an
    /// existing pipe, and no second instance can be created afterwards.
    pub fn create(
        pipe_id: &str,
        role: PipeRole,
        owner_sid: &str,
        tier_sid: &str,
    ) -> io::Result<Self> {
        let name = wide_null(&pipe_name(pipe_id, role)?);
        let descriptor = security_descriptor_from_sddl(&pipe_sddl(owner_sid, tier_sid, role)?)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.pointer(),
            bInheritHandle: 0,
        };
        let access = match role {
            PipeRole::Control => PIPE_ACCESS_OUTBOUND,
            PipeRole::Report | PipeRole::ConnectorSecret | PipeRole::Handoff => PIPE_ACCESS_INBOUND,
        };
        // SAFETY: The name and the security attributes stay alive across the call, and handle
        // inheritance is disabled so the runner cannot receive this handle by accident.
        let handle = OwnedHandle::new(unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                access | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                TIER_PIPE_BUFFER_BYTES,
                TIER_PIPE_BUFFER_BYTES,
                0,
                &attributes,
            )
        })?;
        let endpoint = Endpoint::adopt(handle)?;
        verify_pipe_dacl(endpoint.raw(), owner_sid, tier_sid, role)?;
        Ok(Self { endpoint, role })
    }

    pub const fn role(&self) -> PipeRole {
        self.role
    }

    /// The DACL the kernel actually stored on this pipe, as `(protected, entries)`.
    ///
    /// `create` already refuses a pipe whose DACL is not exactly the expected one, so this is not part
    /// of the transport's own safety. It exists because the acceptance criterion is that the rights are
    /// *read back* and compared entry by entry, and a check that can only fail inside the constructor
    /// is a check nobody can point at.
    pub fn dacl(&self) -> io::Result<(bool, Vec<Ace>)> {
        read_dacl(self.endpoint.raw())
    }

    /// Waits for the one client this pipe will ever have, up to `deadline`.
    pub fn await_client(&self, deadline: Instant) -> io::Result<()> {
        let mut overlapped = self.endpoint.arm()?;
        // SAFETY: The pipe is a valid overlapped server handle with no client yet, and the OVERLAPPED
        // is released by `finish` before this frame is popped.
        let started = unsafe { ConnectNamedPipe(self.endpoint.raw(), &mut overlapped) };
        match self
            .endpoint
            .finish(&mut overlapped, started, Some(deadline), "connection")
        {
            Ok(_) => Ok(()),
            // A client that connected between creation and this call is connected, not an error.
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// Binds this connection to one process and one account, and refuses it otherwise.
    ///
    /// `runner` is the handle the creation call returned for `expected_pid`, and it carries both halves
    /// of what makes a process id usable as an identity here. While it is open the kernel cannot recycle
    /// the id, so the `GetNamedPipeClientProcessId` comparison below is against this exact process
    /// object; and the token SID is read *through it* rather than by reopening the id, which is what lets
    /// the check work across the first hop at all. `CreateProcessWithLogonW` gives the new process a
    /// security descriptor derived from the tier account's own token, which need not admit the unelevated
    /// owner that created it, so an `OpenProcess` on the id can be refused with `ERROR_ACCESS_DENIED` on
    /// exactly the launch this binding exists to check. The returned handle keeps full access rights
    /// whatever that descriptor says, so it is the one source of the peer's SID that cannot be locked
    /// out.
    pub fn bind(
        &self,
        expected_pid: u32,
        runner: &OwnedHandle,
        expected_sid: &str,
    ) -> io::Result<()> {
        self.require_client_pid(expected_pid)?;
        let actual = token_sid_for_owned_process(runner)?;
        let expected = canonical_sid(expected_sid)?;
        if actual != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "the {} pipe's client runs as {actual}, not the expected tier account {expected}",
                    self.role.suffix()
                ),
            ));
        }
        Ok(())
    }

    /// Binds this connection to `expected_pid` and reads the client's token by impersonating it, for a
    /// client whose token the owner cannot open through a process handle: the restricted supervisor,
    /// whose token grants only the tier account and SYSTEM (#3499). Confirms it runs as `expected_sid`.
    ///
    /// The token is opened while impersonating and checked against the client's own identity
    /// (`OpenAsSelf` false), which is the access its DACL grants. The thread reverts before anything is
    /// judged, and a thread that cannot revert ends the process: continuing would run the owner hop as
    /// the tier.
    pub fn bind_impersonating(&self, expected_pid: u32, expected_sid: &str) -> io::Result<()> {
        self.require_client_pid(expected_pid)?;
        // SAFETY: The pipe is connected; impersonation is undone below before this function returns.
        if unsafe { ImpersonateNamedPipeClient(self.endpoint.raw()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let read = (|| {
            let mut token = null_mut();
            // SAFETY: The calling thread is impersonating; the token handle is owned below.
            if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 0, &mut token) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let token = OwnedHandle::new(token)?;
            token_user(&token)
        })();
        // SAFETY: Ends this thread's impersonation.
        if unsafe { RevertToSelf() } == 0 {
            eprintln!(
                "native_isolation_launcher: could not stop impersonating the {} pipe's client: {}",
                self.role.suffix(),
                io::Error::last_os_error()
            );
            std::process::abort();
        }
        let actual = read?;
        let expected = canonical_sid(expected_sid)?;
        if actual != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "the {} pipe's client runs as {actual}, not the expected tier account {expected}",
                    self.role.suffix()
                ),
            ));
        }
        Ok(())
    }

    fn require_client_pid(&self, expected_pid: u32) -> io::Result<()> {
        let mut pid = 0;
        // SAFETY: The pipe is connected and the output is writable.
        if unsafe { GetNamedPipeClientProcessId(self.endpoint.raw(), &mut pid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if pid != expected_pid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "the {} pipe was connected by process {pid}, not the tier runner {expected_pid} \
                     this launcher created",
                    self.role.suffix()
                ),
            ));
        }
        Ok(())
    }

    /// Sends one frame. Only the control pipe carries launcher-to-runner traffic.
    pub fn send(&self, body: &[u8], deadline: Instant) -> io::Result<()> {
        self.expect(PipeRole::Control, "send")?;
        self.endpoint
            .write_frame(body, MAX_TIER_FRAME_BYTES, Some(deadline))
    }

    /// Receives one frame, or `None` at EOF. Only the report pipe carries runner-to-launcher traffic.
    pub fn receive(&self, deadline: Instant) -> io::Result<Option<Vec<u8>>> {
        self.expect(PipeRole::Report, "receive")?;
        self.endpoint
            .read_frame(MAX_TIER_FRAME_BYTES, Some(deadline))
    }

    pub fn receive_connector_secret(&self, deadline: Instant) -> io::Result<Option<Vec<u8>>> {
        self.expect(PipeRole::ConnectorSecret, "receive Connector secret")?;
        self.endpoint
            .read_frame(MAX_CONNECTOR_SECRET_BYTES, Some(deadline))
    }

    /// Receives the tier bootstrap's one handoff frame, under the handoff boundary's own bound.
    pub fn receive_handoff(&self, deadline: Instant) -> io::Result<Option<Vec<u8>>> {
        self.expect(PipeRole::Handoff, "receive a handoff")?;
        self.endpoint
            .read_frame(crate::tier_handoff::MAX_HANDOFF_FRAME_BYTES, Some(deadline))
    }

    // There is deliberately no `disconnect`. Closing the handle - by dropping this server, or by the
    // launcher exiting - is what gives a still-reading runner its EOF, and it does so without ever
    // returning the pipe's single instance to the namespace. `DisconnectNamedPipe` would: it frees the
    // instance for a new client, which is how a pipe that has already been bound to one process id could
    // acquire a second, unbound client. That is the window `nMaxInstances = 1` plus
    // `FILE_FLAG_FIRST_PIPE_INSTANCE` exists to close, so the absence of that call is load-bearing.

    fn expect(&self, role: PipeRole, operation: &str) -> io::Result<()> {
        if self.role == role {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the {} pipe is one-way and cannot {operation}",
                    self.role.suffix()
                ),
            ))
        }
    }
}

/// The runner's end of one pipe. It opens the pipe by name with exactly the one right its direction
/// needs, which is also the proof that the launcher's minimal grant is sufficient.
pub struct TierPipeClient {
    endpoint: Endpoint,
    role: PipeRole,
}

impl TierPipeClient {
    pub fn connect(pipe_id: &str, role: PipeRole, deadline: Instant) -> io::Result<Self> {
        let wide = wide_null(&pipe_name(pipe_id, role)?);
        loop {
            // SAFETY: The name is NUL-terminated UTF-16, no handles are inherited, and the requested
            // access is exactly the one right the pipe's DACL grants this account.
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    role.tier_rights(),
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED | RUNNER_PIPE_SECURITY,
                    null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
                return Ok(Self {
                    endpoint: Endpoint::adopt(OwnedHandle::new(handle)?)?,
                    role,
                });
            }
            // SAFETY: GetLastError immediately follows the failed open.
            let code = unsafe { GetLastError() };
            // Waiting out a refusal would turn a decided answer into a timeout. The launcher's ACL
            // does not change while the pipe exists, so a denial now is a denial for good.
            if code == ERROR_ACCESS_DENIED {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "this account is not permitted to open the {} pipe",
                        role.suffix()
                    ),
                ));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            // SAFETY: The name remains valid for this call; the return value is advisory.
            unsafe {
                WaitNamedPipeW(wide.as_ptr(), CONNECT_POLL_MS);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub const fn role(&self) -> PipeRole {
        self.role
    }

    /// Sends one frame on the report pipe.
    pub fn send(&self, body: &[u8], deadline: Instant) -> io::Result<()> {
        self.expect(PipeRole::Report, "send")?;
        self.endpoint
            .write_frame(body, MAX_TIER_FRAME_BYTES, Some(deadline))
    }

    pub fn send_connector_secret(&self, body: &[u8], deadline: Instant) -> io::Result<()> {
        self.expect(PipeRole::ConnectorSecret, "send Connector secret")?;
        self.endpoint
            .write_frame(body, MAX_CONNECTOR_SECRET_BYTES, Some(deadline))
    }

    /// Receives one frame on the control pipe, or `None` at EOF.
    ///
    /// `deadline` is `None` for the wait that spans the role's lifetime. That is the single unbounded
    /// wait in this transport, and it is bounded in practice by the launcher's own exit: when the
    /// launcher dies the pipe closes and the read returns EOF, which the runner treats as `Stop`.
    pub fn receive(&self, deadline: Option<Instant>) -> io::Result<Option<Vec<u8>>> {
        self.expect(PipeRole::Control, "receive")?;
        self.endpoint.read_frame(MAX_TIER_FRAME_BYTES, deadline)
    }

    fn expect(&self, role: PipeRole, operation: &str) -> io::Result<()> {
        if self.role == role {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the {} pipe is one-way and cannot {operation}",
                    self.role.suffix()
                ),
            ))
        }
    }
}

#[cfg(test)]
mod tests;
