use super::*;
use crate::random_bytes::random_hex;
use crate::sid_win32::current_process_sid;
use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

/// A synthetic owner, so the tier trustee can be this test process's own account. That is the same
/// shape the integration tests use: the launcher holds a full-access handle from creating the pipe,
/// so the owner ACE does not have to name a principal that exists on the machine.
const SYNTHETIC_OWNER: &str = "S-1-5-21-1-2-3-1001";

fn fresh_id() -> String {
    random_hex(16).expect("the system RNG should be available")
}

fn soon() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

/// An owned, query-capable handle to this test process, standing in for the one a launch holds on
/// the runner it created. A test is the only caller that has to open its own: both hops hand the
/// real launch a handle, which is the whole point of taking one here.
fn own_process_handle() -> OwnedHandle {
    // SAFETY: OpenProcess takes a numeric pid, and the handle is owned by the returned value.
    OwnedHandle::new(unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, std::process::id())
    })
    .expect("this process can open itself for query")
}

/// Creates a server, connects a client to it from this same process, and binds the connection.
///
/// The client opens first and on this thread. A named pipe instance is listening from the moment
/// `CreateNamedPipeW` returns, so `CreateFileW` succeeds without the server having called
/// `ConnectNamedPipe` yet, and `await_client` then reports the already-connected client. Doing it in
/// this order means a client that is *refused* surfaces its own error here instead of appearing as
/// the server's connection timeout, which says nothing about why nobody arrived.
fn connected(role: PipeRole) -> (TierPipeServer, TierPipeClient, String) {
    let tier = current_process_sid().expect("this process has a SID");
    let id = fresh_id();
    let server = TierPipeServer::create(&id, role, SYNTHETIC_OWNER, &tier)
        .expect("the pipe should be creatable");
    let client = TierPipeClient::connect(&id, role, soon()).expect("the client should open");
    server
        .await_client(soon())
        .expect("the client should already be connected");
    server
        .bind(std::process::id(), &own_process_handle(), &tier)
        .expect("this process is the client");
    (server, client, id)
}

#[test]
fn the_control_pipe_carries_a_frame_from_the_launcher_to_the_runner() {
    let (server, client, _) = connected(PipeRole::Control);
    server.send(b"{\"op\":\"stop\"}", soon()).expect("send");
    assert_eq!(
        client.receive(Some(soon())).expect("receive").as_deref(),
        Some(&b"{\"op\":\"stop\"}"[..])
    );
}

#[test]
fn the_report_pipe_carries_a_frame_from_the_runner_to_the_launcher() {
    let (server, client, _) = connected(PipeRole::Report);
    client.send(b"{\"op\":\"started\"}", soon()).expect("send");
    assert_eq!(
        server.receive(soon()).expect("receive").as_deref(),
        Some(&b"{\"op\":\"started\"}"[..])
    );
}

/// The role guard, which is this crate refusing to *ask* for the wrong direction. It is not the
/// proof that the wrong direction is impossible: that is the kernel's, and it is checked against a
/// real `CreateFileW` in `tests/tier_pipe.rs`, which would still fail if this guard were deleted.
#[test]
fn the_role_guard_refuses_the_direction_a_pipe_does_not_serve() {
    let (control_server, control_client, _) = connected(PipeRole::Control);
    assert_eq!(
        control_server
            .receive(soon())
            .expect_err("the control pipe never carries reports")
            .kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        control_client
            .send(b"x", soon())
            .expect_err("a runner cannot answer on the control pipe")
            .kind(),
        io::ErrorKind::InvalidInput
    );

    let (report_server, report_client, _) = connected(PipeRole::Report);
    assert_eq!(
        report_server
            .send(b"x", soon())
            .expect_err("the report pipe never carries commands")
            .kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        report_client
            .receive(Some(soon()))
            .expect_err("a runner cannot listen on the report pipe")
            .kind(),
        io::ErrorKind::InvalidInput
    );
}

/// The runner's stop signal. Dropping the server end must surface as EOF, not as a fault, because
/// that is what tells the runner to terminate its Job.
#[test]
fn a_dropped_launcher_end_reads_back_as_end_of_stream() {
    let (server, client, _) = connected(PipeRole::Control);
    drop(server);
    assert_eq!(
        client
            .receive(Some(soon()))
            .expect("a closed peer is end-of-stream, not an error"),
        None
    );
}

/// The launcher's side of the same event: a runner that dies without reporting must not hang the
/// launcher, and must not look like a successful empty report either.
#[test]
fn a_dropped_runner_end_reads_back_as_end_of_stream() {
    let (server, client, _) = connected(PipeRole::Report);
    drop(client);
    assert_eq!(server.receive(soon()).expect("end-of-stream"), None);
}

#[test]
fn a_write_after_the_peer_is_gone_fails_instead_of_being_swallowed() {
    let (server, client, _) = connected(PipeRole::Report);
    drop(server);
    assert!(
        client.send(b"{\"op\":\"exited\"}", soon()).is_err(),
        "a report written into a closed pipe must be reported as a failure"
    );
}

/// The bound on a crashed or silent peer. Without a deadline this read would never return.
#[test]
fn a_silent_peer_produces_a_timeout_rather_than_a_hang() {
    let (server, _client, _) = connected(PipeRole::Report);
    let started = Instant::now();
    let error = server
        .receive(Instant::now() + Duration::from_millis(200))
        .expect_err("a silent runner must not be waited on forever");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the deadline was exceeded by too much: {:?}",
        started.elapsed()
    );
}

/// Cancelling a timed-out read has to leave the endpoint usable, or the launcher's first timeout
/// would poison every later read on the same pipe.
#[test]
fn a_pipe_still_works_after_one_read_has_timed_out() {
    let (server, client, _) = connected(PipeRole::Report);
    assert!(server.receive(Instant::now()).is_err());
    client.send(b"{\"op\":\"late\"}", soon()).expect("send");
    assert_eq!(
        server.receive(soon()).expect("receive").as_deref(),
        Some(&b"{\"op\":\"late\"}"[..])
    );
}

/// The other half of the timeout story: a timeout that lands *inside* a frame retires the endpoint.
///
/// Four bytes of length are already out of the pipe and no later read can know where the next frame
/// starts, so every later read refuses rather than taking a body byte for a length. Every caller in
/// this crate tears the launch down on a timeout anyway; this is the transport not depending on that.
#[test]
fn a_timeout_inside_a_frame_retires_the_endpoint() {
    let (server, client, _) = connected(PipeRole::Report);
    client
        .endpoint
        .write_unframed(&64u32.to_le_bytes(), Some(soon()))
        .expect("a bare length prefix should be writable");
    assert_eq!(
        server
            .receive(Instant::now() + Duration::from_millis(200))
            .expect_err("a body that never arrives must time out")
            .kind(),
        io::ErrorKind::TimedOut
    );

    client.send(b"{\"op\":\"late\"}", soon()).expect("send");
    assert_eq!(
        server
            .receive(soon())
            .expect_err("the endpoint no longer knows where a frame starts and must refuse")
            .kind(),
        io::ErrorKind::BrokenPipe,
        "a desynchronized endpoint must not read the next frame length out of somebody's body"
    );
}

/// A declared length of zero is a framing violation, not an empty frame. The writer refuses to
/// produce one, so the reader must refuse to deliver one; otherwise a peer can spend a frame from the
/// per-connection budget on a body that cannot parse.
#[test]
fn a_frame_declaring_zero_bytes_is_refused_as_a_framing_violation() {
    let (server, client, _) = connected(PipeRole::Report);
    client
        .endpoint
        .write_unframed(&0u32.to_le_bytes(), Some(soon()))
        .expect("a zero prefix should be writable");
    let error = server
        .receive(soon())
        .expect_err("a zero-length declaration must not read back as an empty frame");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error.to_string().contains("invalid_field"),
        "the refusal must name the framing rule it broke: {error}"
    );
}

#[test]
fn the_pipe_name_can_only_be_created_once() {
    let tier = current_process_sid().expect("this process has a SID");
    let id = fresh_id();
    let first = TierPipeServer::create(&id, PipeRole::Control, SYNTHETIC_OWNER, &tier)
        .expect("the first instance should be creatable");
    let error = TierPipeServer::create(&id, PipeRole::Control, SYNTHETIC_OWNER, &tier)
        .map(|_| ())
        .expect_err("a second instance of the same name must be refused");
    // Measured, not assumed: `FILE_FLAG_FIRST_PIPE_INSTANCE` is what makes the squat fail rather
    // than join, but which code the kernel returns for that failure has been observed to differ
    // by Windows build - `ERROR_ACCESS_DENIED` on some, `ERROR_PIPE_BUSY` on others. Either is a
    // refusal; only a success, or an unrelated error, would be wrong here.
    let code = error.raw_os_error();
    assert!(
        code == Some(ERROR_ACCESS_DENIED as i32) || code == Some(ERROR_PIPE_BUSY as i32),
        "FILE_FLAG_FIRST_PIPE_INSTANCE is what makes a squatted name fail rather than join: {error:?}"
    );
    drop(first);
}

/// The two roles are separate pipes with separate names, so one connection can never be mistaken
/// for the other even under the same id.
#[test]
fn the_two_roles_are_distinct_objects_under_one_id() {
    let tier = current_process_sid().expect("this process has a SID");
    let id = fresh_id();
    let control = TierPipeServer::create(&id, PipeRole::Control, SYNTHETIC_OWNER, &tier)
        .expect("control should be creatable");
    let report = TierPipeServer::create(&id, PipeRole::Report, SYNTHETIC_OWNER, &tier)
        .expect("report should be creatable under the same id");
    assert_eq!(control.role(), PipeRole::Control);
    assert_eq!(report.role(), PipeRole::Report);
}

#[test]
fn a_connection_from_another_process_is_refused_by_pid() {
    let (server, _client, _) = connected(PipeRole::Report);
    let error = server
        .bind(std::process::id() + 1, &own_process_handle(), "S-1-5-18")
        .expect_err("a client that is not the created runner must be refused");
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(
        error.to_string().contains("not the tier runner"),
        "the refusal must name the mismatch it found: {error}"
    );
}

/// The SID check is not redundant with the PID check: it is the claim that survives P4, where the
/// runner runs in an account of its own.
#[test]
fn a_connection_from_the_wrong_account_is_refused_by_sid() {
    let (server, _client, _) = connected(PipeRole::Report);
    for wrong in ["S-1-5-18", "S-1-5-21-1-2-3-9999"] {
        let error = server
            .bind(std::process::id(), &own_process_handle(), wrong)
            .expect_err("a client whose token SID differs must be refused");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            error.to_string().contains("expected tier account"),
            "the refusal must name the account mismatch: {error}"
        );
    }
}

/// The impersonating binding reads the client's own token, refuses a wrong process or account, and
/// leaves the calling thread no longer impersonating.
#[test]
fn an_impersonating_bind_reads_the_client_s_token_and_reverts() {
    use windows_sys::Win32::Foundation::ERROR_NO_TOKEN;
    let (server, _client, _) = connected(PipeRole::Report);
    let tier = current_process_sid().expect("sid");
    server
        .bind_impersonating(std::process::id(), &tier)
        .expect("this process is the client");
    assert_eq!(
        server
            .bind_impersonating(std::process::id() + 1, &tier)
            .expect_err("another process")
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        server
            .bind_impersonating(std::process::id(), "S-1-5-21-1-2-3-9999")
            .expect_err("another account")
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    let mut token = null_mut();
    // SAFETY: Asks for this thread's impersonation token, which must no longer exist.
    let opened = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) };
    assert_eq!(opened, 0, "the thread is still impersonating");
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(ERROR_NO_TOKEN as i32)
    );
}

#[test]
fn a_malformed_expected_sid_is_refused_rather_than_ignored() {
    let (server, _client, _) = connected(PipeRole::Report);
    assert_eq!(
        server
            .bind(std::process::id(), &own_process_handle(), "not-a-sid")
            .expect_err("an unparseable expectation must not pass by default")
            .kind(),
        io::ErrorKind::InvalidInput
    );
}

#[test]
fn a_frame_at_the_maximum_size_round_trips_and_one_byte_more_does_not() {
    let (server, client, _) = connected(PipeRole::Control);
    let largest = vec![b'x'; MAX_TIER_FRAME_BYTES];
    server.send(&largest, soon()).expect("the cap is inclusive");
    assert_eq!(
        client.receive(Some(soon())).expect("receive"),
        Some(largest)
    );

    assert_eq!(
        server
            .send(&vec![b'x'; MAX_TIER_FRAME_BYTES + 1], soon())
            .expect_err("one byte over the cap must be refused before it is written")
            .kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        server
            .send(b"", soon())
            .expect_err("an empty frame is not a frame")
            .kind(),
        io::ErrorKind::InvalidInput
    );
}

/// The handoff pipe carries one frame from the bootstrap's own client, under its own bound, and
/// refuses the other directions' operations.
#[test]
fn the_handoff_pipe_carries_the_bootstrap_s_frame_under_its_own_bound() {
    use crate::tier_handoff::MAX_HANDOFF_FRAME_BYTES;
    let tier = current_process_sid().expect("this process has a SID");
    let id = fresh_id();
    let server = TierPipeServer::create(&id, PipeRole::Handoff, SYNTHETIC_OWNER, &tier)
        .expect("the handoff pipe should be creatable");
    let client = crate::tier_bootstrap::connect_handoff(&id, soon())
        .expect("the bootstrap's client opens with its one right");
    server.await_client(soon()).expect("connected");
    server
        .bind(std::process::id(), &own_process_handle(), &tier)
        .expect("this process is the client");
    assert_eq!(
        client
            .write_frame(
                &vec![b'x'; MAX_HANDOFF_FRAME_BYTES + 1],
                MAX_HANDOFF_FRAME_BYTES,
                Some(soon())
            )
            .expect_err("the bootstrap's side refuses past the bound")
            .kind(),
        io::ErrorKind::InvalidInput
    );
    client
        .write_frame(b"{\"handoff\":1}", MAX_HANDOFF_FRAME_BYTES, Some(soon()))
        .expect("the bootstrap's client sends");
    assert_eq!(
        server.receive_handoff(soon()).expect("receive").as_deref(),
        Some(&b"{\"handoff\":1}"[..])
    );
    assert_eq!(
        server
            .receive(soon())
            .expect_err("not a report pipe")
            .kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        server
            .send(b"x", soon())
            .expect_err("the handoff pipe carries nothing to the bootstrap")
            .kind(),
        io::ErrorKind::InvalidInput
    );
}

/// A declared length over the handoff bound is refused before its body is read.
#[test]
fn the_handoff_pipe_refuses_a_frame_declared_past_its_bound() {
    use crate::tier_handoff::MAX_HANDOFF_FRAME_BYTES;
    let tier = current_process_sid().expect("this process has a SID");
    let id = fresh_id();
    let server =
        TierPipeServer::create(&id, PipeRole::Handoff, SYNTHETIC_OWNER, &tier).expect("create");
    let client = crate::tier_bootstrap::connect_handoff(&id, soon()).expect("open");
    server.await_client(soon()).expect("connected");
    client
        .write_unframed(
            &((MAX_HANDOFF_FRAME_BYTES + 1) as u32).to_le_bytes(),
            Some(soon()),
        )
        .expect("a bare prefix is writable");
    assert_eq!(
        server
            .receive_handoff(soon())
            .expect_err("over the bound")
            .kind(),
        io::ErrorKind::InvalidData
    );
}

/// Frames are read one at a time rather than as whatever happened to arrive, so a peer cannot
/// smuggle a second command inside the first read.
#[test]
fn two_queued_frames_are_read_as_two_frames() {
    let (server, client, _) = connected(PipeRole::Report);
    client.send(b"first", soon()).expect("send");
    client.send(b"second", soon()).expect("send");
    assert_eq!(
        server.receive(soon()).expect("receive").as_deref(),
        Some(&b"first"[..])
    );
    assert_eq!(
        server.receive(soon()).expect("receive").as_deref(),
        Some(&b"second"[..])
    );
}
