//! The elevated broker's end of the provision pipe.
//!
//! # Why only the client end ships
//!
//! The pipe is created by the *unprivileged* owner and connected to by the *elevated* broker, which is the
//! reverse of the launcher's tier pipes. That inversion is the point: the owner has to be the one that
//! names the object and holds the first instance of it, because the owner is the party whose word about a
//! pipe id can be trusted before anyone is authenticated - the owner drew the id, and no other unprivileged
//! process knows it. If the elevated broker created the pipe instead, it would be publishing a privileged
//! endpoint into a namespace where any process can attempt an open, and would have nothing better than an
//! ACL to keep them out.
//!
//! So this module holds a client and no server. There is no `CreateNamedPipeW` in the elevated broker's
//! production code at all, which is a stronger statement than any check on one could be: the server side
//! is `broker_client`'s Python, and the only server here is the `#[cfg(test)]` one below.
//!
//! # One duplex pipe, not two one-way ones
//!
//! `launcher::pipe` uses two pipes because a pending read on one handle of a byte-mode pipe blocks a write
//! on another handle of the same pipe, and its two peers each wait on the other indefinitely. This
//! conversation is strictly alternating - the broker reads one request, then answers it - so that deadlock
//! has no shape to take, and one pipe means one object to name, one instance to hold and one identity to
//! prove instead of two.
//!
//! # What proves who is on each end
//!
//! Two facts, one per side, neither of them a frame:
//!
//! - The owner accepts only the process id of the elevated broker it launched, and holds that process
//!   handle open for the whole conversation so the id cannot be recycled underneath it. That is done on the
//!   Python side, where the `ShellExecuteExW` that produced the id is.
//! - The broker accepts only a pipe whose *server* process runs as the owner SID it was told to provision
//!   for. That is [`ProvisionPipeClient::bind_server`], below.
//!
//! The HMAC in `wire.rs` sits on top of both and binds frames to one attempt; it is not what establishes
//! either identity, because the key travels on a command line the owner's own account can read.

use crate::pipe_io::Endpoint;
use crate::process_win32::{OwnedHandle, wide_null};
use crate::provision_session::wire::MAX_PROVISION_FRAME_BYTES;
use crate::sid_win32::{canonical_sid, token_sid_for_pid};
use std::io;
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};

/// The provision pipe's own namespace prefix, distinct from the tier runner's and from the test
/// transport's, so no two of the three can ever be reached by one name.
pub const PROVISION_PIPE_PREFIX: &str = r"\\.\pipe\SuperClawProvision-";

/// `SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_READ_DATA | FILE_WRITE_DATA`.
///
/// The first two are the floor NPFS imposes on any client open regardless of what is requested - see the
/// same constant's derivation in `launcher::pipe_acl` - and the last two are the duplex conversation. No
/// `FILE_WRITE_ATTRIBUTES`, no `WRITE_DAC`, no `FILE_CREATE_PIPE_INSTANCE`: the elevated side is a
/// participant on this pipe, not its owner, and asking for more than it uses would make that untrue.
pub const PROVISION_CLIENT_RIGHTS: u32 = 0x0010_0083;

/// How long each retry of a connect attempt waits on the pipe before trying again.
const CONNECT_POLL_MS: u32 = 50;

/// Validates a pipe id and builds the pipe's full name.
///
/// The character set is closed for the same reason the tier pipe's is: this id arrives on a command line,
/// and an id that could carry a path separator or a namespace escape would be an id that names an object
/// other than the one the caller meant. The elevated broker is exactly the process where that must not be
/// possible.
pub fn provision_pipe_name(pipe_id: &str) -> io::Result<String> {
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
    Ok(format!("{PROVISION_PIPE_PREFIX}{pipe_id}"))
}

/// The elevated broker's connection to one provision pipe.
pub struct ProvisionPipeClient {
    endpoint: Endpoint,
}

impl ProvisionPipeClient {
    /// Opens the pipe by name, retrying until `deadline` because the owner may not have created it yet.
    ///
    /// A refusal is final rather than retried: the owner sets the pipe's DACL once, at creation, so an
    /// `ERROR_ACCESS_DENIED` now is an `ERROR_ACCESS_DENIED` for as long as the pipe exists, and waiting
    /// it out would report a decided answer as a timeout.
    pub fn connect(pipe_id: &str, deadline: Instant) -> io::Result<Self> {
        let wide = wide_null(&provision_pipe_name(pipe_id)?);
        loop {
            // SAFETY: The name is NUL-terminated UTF-16, no handles are inherited, and the requested
            // access is exactly the four bits this conversation uses.
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    PROVISION_CLIENT_RIGHTS,
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
                    null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
                return Ok(Self {
                    endpoint: Endpoint::adopt(OwnedHandle::new(handle)?)?,
                });
            }
            // SAFETY: GetLastError immediately follows the failed open.
            let code = unsafe { GetLastError() };
            if code == ERROR_ACCESS_DENIED {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "this account is not permitted to open the provision pipe",
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

    /// Refuses this pipe unless the process that created it runs as `expected_owner_sid`.
    ///
    /// This is the elevated side's whole authentication of its peer, and it is deliberately a check on the
    /// *token* rather than on anything the peer says. A process that merely guessed the pipe id still has
    /// to be running as the owner to have created the object the id names.
    ///
    /// # On the reported process id
    ///
    /// The kernel reports the process that created this pipe instance. That process cannot have exited
    /// while the instance is connected without closing its handle and breaking the connection, so the id is
    /// live in the ordinary case. It could in principle name a recycled id - the instance's handle could
    /// have been inherited by a child that outlived its parent - and unlike the launcher's PID binding
    /// there is no earlier moment at which this side could have taken a reference to keep it from being
    /// reused. That residue is not an escalation: for a recycled id to pass this check it would have to
    /// resolve to the owner's own SID, and a process already running as the owner is the party this whole
    /// exchange exists to serve. What the check excludes is every account that is *not* the owner, which is
    /// the claim that matters, and it excludes them without a timing assumption.
    ///
    /// Returns the bound server process id, so a caller can report it without asking the kernel twice.
    pub fn bind_server(&self, expected_owner_sid: &str) -> io::Result<u32> {
        let expected = canonical_sid(expected_owner_sid)?;
        let mut pid = 0;
        // SAFETY: The handle is a connected client end of a named pipe and the output is writable.
        if unsafe { GetNamedPipeServerProcessId(self.endpoint.raw(), &mut pid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let actual = token_sid_for_pid(pid)?;
        if actual != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "the provision pipe was created by process {pid} running as {actual}, not by the \
                     owner {expected} this broker was asked to provision for"
                ),
            ));
        }
        Ok(pid)
    }

    /// Sends one frame.
    pub fn send(&self, body: &[u8], deadline: Instant) -> io::Result<()> {
        self.endpoint
            .write_frame(body, MAX_PROVISION_FRAME_BYTES, Some(deadline))
    }

    /// Receives one frame, or `None` at end of stream.
    pub fn receive(&self, deadline: Instant) -> io::Result<Option<Vec<u8>>> {
        self.endpoint
            .read_frame(MAX_PROVISION_FRAME_BYTES, Some(deadline))
    }
}

/// The owner's end of a provision pipe, for tests only.
///
/// In production this side is `broker_client`'s `provision_pipe.py`, and the properties asserted here are
/// the specification that implementation has to meet: one instance, first instance, no remote clients, a
/// protected DACL, and a buffer that holds exactly one maximum frame. It is compiled only under `cfg(test)`
/// so that the shipped elevated broker contains no way to create a provision pipe at all.
#[cfg(test)]
pub struct ProvisionPipeServer {
    endpoint: Endpoint,
}

#[cfg(test)]
mod server {
    use super::*;
    use crate::frame::FRAME_PREFIX_BYTES;
    use crate::launcher::pipe_acl::{FULL_PIPE_RIGHTS, security_descriptor_from_sddl};
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::ERROR_PIPE_CONNECTED;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    /// The buffer holds exactly one maximum frame in each direction, so a peer can hand off a whole frame
    /// before the other has read a byte and cannot queue a second one behind it.
    const PROVISION_PIPE_BUFFER_BYTES: u32 =
        (MAX_PROVISION_FRAME_BYTES + FRAME_PREFIX_BYTES) as u32;

    const LOCAL_SYSTEM_SID: &str = "S-1-5-18";
    const BUILTIN_ADMINISTRATORS_SID: &str = "S-1-5-32-544";

    /// The protected DACL the owner must create the pipe with: full access for SYSTEM, for the local
    /// Administrators group and for the owner, and nothing for anyone else.
    ///
    /// Administrators is not decoration. Under an alternate-administrator UAC prompt the elevated broker
    /// runs as a *different account* than the owner, so the owner ACE alone would leave the broker unable
    /// to open the very pipe it was launched to answer.
    pub fn provision_pipe_sddl(owner_sid: &str) -> io::Result<String> {
        let owner = canonical_sid(owner_sid)?;
        Ok(format!(
            "D:P(A;;0x{FULL_PIPE_RIGHTS:08x};;;{LOCAL_SYSTEM_SID})\
             (A;;0x{FULL_PIPE_RIGHTS:08x};;;{BUILTIN_ADMINISTRATORS_SID})\
             (A;;0x{FULL_PIPE_RIGHTS:08x};;;{owner})"
        ))
    }

    impl ProvisionPipeServer {
        pub fn create(pipe_id: &str, owner_sid: &str) -> io::Result<Self> {
            let name = wide_null(&provision_pipe_name(pipe_id)?);
            let descriptor = security_descriptor_from_sddl(&provision_pipe_sddl(owner_sid)?)?;
            let attributes = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.pointer(),
                bInheritHandle: 0,
            };
            // SAFETY: The name and the security attributes stay alive across the call, and handle
            // inheritance is disabled so no child receives this handle by accident.
            let handle = OwnedHandle::new(unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    PROVISION_PIPE_BUFFER_BYTES,
                    PROVISION_PIPE_BUFFER_BYTES,
                    0,
                    &attributes,
                )
            })?;
            Ok(Self {
                endpoint: Endpoint::adopt(handle)?,
            })
        }

        pub fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
            self.endpoint.raw()
        }

        pub fn await_client(&self, deadline: Instant) -> io::Result<()> {
            let mut overlapped = self.endpoint.arm()?;
            // SAFETY: The pipe is a valid overlapped server handle, and the OVERLAPPED is released by
            // `finish` before this frame is popped.
            let started = unsafe { ConnectNamedPipe(self.endpoint.raw(), &mut overlapped) };
            match self
                .endpoint
                .finish(&mut overlapped, started, Some(deadline), "connection")
            {
                Ok(_) => Ok(()),
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) => Ok(()),
                Err(error) => Err(error),
            }
        }

        pub fn send(&self, body: &[u8], deadline: Instant) -> io::Result<()> {
            self.endpoint
                .write_frame(body, MAX_PROVISION_FRAME_BYTES, Some(deadline))
        }

        pub fn receive(&self, deadline: Instant) -> io::Result<Option<Vec<u8>>> {
            self.endpoint
                .read_frame(MAX_PROVISION_FRAME_BYTES, Some(deadline))
        }

        // As in `launcher::pipe`, there is deliberately no `disconnect`. Returning the single instance to
        // the namespace is how a pipe that has already been bound to one process could acquire a second,
        // unbound peer.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher::pipe_acl::{Ace, FULL_PIPE_RIGHTS, read_dacl};
    use crate::random_bytes::random_hex;
    use crate::sid_win32::current_process_sid;
    use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;

    fn fresh_id() -> String {
        random_hex(16).expect("the system RNG should be available")
    }

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(5)
    }

    /// A connected pair inside this one process, where this process plays both the owner that created the
    /// pipe and the elevated broker that connected to it.
    ///
    /// The client opens before `await_client` for the same reason the tier pipe's helper does: an instance
    /// is listening from the moment `CreateNamedPipeW` returns, so a client that is *refused* reports its
    /// own error here rather than showing up as the server's connection timeout.
    fn connected() -> (ProvisionPipeServer, ProvisionPipeClient, String) {
        let owner = current_process_sid().expect("this process has a SID");
        let id = fresh_id();
        let server =
            ProvisionPipeServer::create(&id, &owner).expect("the pipe should be creatable");
        let client = ProvisionPipeClient::connect(&id, soon()).expect("the client should open");
        server
            .await_client(soon())
            .expect("the client should already be connected");
        (server, client, id)
    }

    #[test]
    fn a_request_and_its_answer_cross_the_same_pipe_in_turn() {
        let (server, client, _) = connected();
        server
            .send(b"{\"op\":\"provision\"}", soon())
            .expect("the owner should be able to send a request");
        assert_eq!(
            client.receive(soon()).expect("receive").as_deref(),
            Some(&b"{\"op\":\"provision\"}"[..])
        );
        client
            .send(b"{\"op\":\"applied\"}", soon())
            .expect("the broker should be able to answer on the same pipe");
        assert_eq!(
            server.receive(soon()).expect("receive").as_deref(),
            Some(&b"{\"op\":\"applied\"}"[..])
        );
    }

    /// The elevated side's authentication of its peer, in the case where it holds.
    #[test]
    fn the_broker_accepts_a_pipe_whose_server_runs_as_the_requested_owner() {
        let owner = current_process_sid().expect("this process has a SID");
        let (_server, client, _) = connected();
        assert_eq!(
            client
                .bind_server(&owner)
                .expect("this process created the pipe and is the owner"),
            std::process::id()
        );
    }

    /// The same check in the case that matters: a pipe created by somebody who is not the owner the
    /// broker was launched for is refused before a single frame is read.
    #[test]
    fn the_broker_refuses_a_pipe_whose_server_runs_as_another_account() {
        let (_server, client, _) = connected();
        for wrong in ["S-1-5-18", "S-1-5-21-1-2-3-9999"] {
            let error = client
                .bind_server(wrong)
                .expect_err("a server process in another account must be refused");
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert!(
                error.to_string().contains("this broker was asked to"),
                "the refusal must name the owner mismatch it found: {error}"
            );
        }
    }

    #[test]
    fn a_malformed_owner_sid_is_refused_rather_than_ignored() {
        let (_server, client, _) = connected();
        assert_eq!(
            client
                .bind_server("not-a-sid")
                .expect_err("an unparseable expectation must not pass by default")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    /// First-instance behaviour: a second creation of the same name fails rather than joining, so a
    /// squatter is detectable instead of invisible.
    #[test]
    fn the_pipe_name_can_only_be_created_once() {
        let owner = current_process_sid().expect("this process has a SID");
        let id = fresh_id();
        let first = ProvisionPipeServer::create(&id, &owner).expect("the first instance");
        let error = ProvisionPipeServer::create(&id, &owner)
            .map(|_| ())
            .expect_err("a second instance of the same name must be refused");
        // Which code the kernel picks for the refusal has been observed to differ by Windows build;
        // either is a refusal, and only a success would be wrong here.
        let code = error.raw_os_error();
        assert!(
            code == Some(ERROR_ACCESS_DENIED as i32) || code == Some(ERROR_PIPE_BUSY as i32),
            "FILE_FLAG_FIRST_PIPE_INSTANCE is what makes a squatted name fail rather than join: {error:?}"
        );
        drop(first);
    }

    /// The DACL the Python owner-side server has to reproduce, read back from the kernel entry by entry
    /// rather than compared against the SDDL string that produced it.
    #[test]
    fn the_created_pipe_carries_a_protected_dacl_of_exactly_three_full_access_entries() {
        let owner = current_process_sid().expect("this process has a SID");
        let (server, _client, _) = connected();
        let (protected, entries) = read_dacl(server.raw()).expect("the DACL should be readable");
        assert!(protected, "an inheritable DACL is not a decided DACL");
        assert_eq!(
            entries,
            vec![
                Ace {
                    allow: true,
                    sid: "S-1-5-18".to_owned(),
                    mask: FULL_PIPE_RIGHTS,
                    flags: 0,
                },
                Ace {
                    allow: true,
                    sid: "S-1-5-32-544".to_owned(),
                    mask: FULL_PIPE_RIGHTS,
                    flags: 0,
                },
                Ace {
                    allow: true,
                    sid: owner,
                    mask: FULL_PIPE_RIGHTS,
                    flags: 0,
                },
            ]
        );
    }

    #[test]
    fn a_pipe_id_that_could_name_another_object_is_refused() {
        for bad in ["", "../evil", "a/b", "a\\b", &"x".repeat(65)] {
            assert_eq!(
                provision_pipe_name(bad)
                    .expect_err("an id outside the closed character set must be refused")
                    .kind(),
                io::ErrorKind::InvalidInput
            );
        }
        assert_eq!(
            provision_pipe_name("ab-CD_09").expect("a legal id"),
            format!("{PROVISION_PIPE_PREFIX}ab-CD_09")
        );
    }

    /// A connect against a name nobody created must end in a bounded failure, not a wait for an owner
    /// that will never appear.
    #[test]
    fn connecting_to_a_pipe_that_does_not_exist_times_out_rather_than_hanging() {
        let started = Instant::now();
        ProvisionPipeClient::connect(&fresh_id(), Instant::now() + Duration::from_millis(200))
            .map(|_| ())
            .expect_err("there is no server on a freshly drawn id");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the deadline was exceeded by too much: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_silent_peer_produces_a_timeout_rather_than_a_hang() {
        let (_server, client, _) = connected();
        assert_eq!(
            client
                .receive(Instant::now() + Duration::from_millis(200))
                .expect_err("a silent owner must not be waited on forever")
                .kind(),
            io::ErrorKind::TimedOut
        );
    }

    #[test]
    fn a_dropped_owner_end_reads_back_as_end_of_stream() {
        let (server, client, _) = connected();
        drop(server);
        assert_eq!(
            client
                .receive(soon())
                .expect("a closed peer is end-of-stream, not an error"),
            None
        );
    }

    #[test]
    fn a_frame_at_the_maximum_size_round_trips_and_one_byte_more_does_not() {
        let (server, client, _) = connected();
        let largest = vec![b'x'; MAX_PROVISION_FRAME_BYTES];
        server.send(&largest, soon()).expect("the cap is inclusive");
        assert_eq!(client.receive(soon()).expect("receive"), Some(largest));

        assert_eq!(
            client
                .send(&vec![b'x'; MAX_PROVISION_FRAME_BYTES + 1], soon())
                .expect_err("one byte over the cap must be refused before it is written")
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            client
                .send(b"", soon())
                .expect_err("an empty frame is not a frame")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
