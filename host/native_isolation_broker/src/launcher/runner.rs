//! `--tier-runner`: the second hop, which starts the role inside the owner-held Job.
//!
//! In production this process is the restricted supervisor (#3499, #3400): the tier bootstrap started it
//! on the tier's private desktop with a restricted copy of its own token, and the owner resumed it. Its
//! role inherits that desktop and that token because the role launch names no desktop and no token.
//!
//! The runner re-validates the start request against the shipped catalog itself. It does not trust
//! the owner side's resolution, because the two hops are in different accounts and the request has
//! crossed a boundary; validating the same canonical bytes twice against the same catalog is what
//! makes that boundary cheap to reason about.
//!
//! # Why the runner holds no Job
//!
//! The owner created the role's Job, put this process in it while it was still suspended, and resumed
//! it only after checking (#3010). The role this runner starts inherits that Job from its first
//! instruction, and so does everything the role starts. No Job handle exists in this account, so a
//! hostile role sharing it cannot duplicate one to keep the tree alive past a stop or to loosen its
//! limits, and nothing about stopping depends on this process: the owner terminates the Job.
//!
//! What remains here is what the tier must do itself - open the role's log, start it, deliver its
//! payload, report it - and then wait. The control pipe closing means the owner has gone or is ending
//! the Job; either way there is nothing for the runner to clean up.

use super::pipe::TierPipeClient;
use super::pipe_acl::PipeRole;
use super::wire::{Direction, TierFrame, TierSession};
use crate::connector_bootstrap::connector_bootstrap_bundle;
use crate::launch_environment::environment_names;
use crate::launch_spec::RoleStdin;
use crate::process_same_account::{SameAccountChild, launch_catalog_same_account};
use crate::random_bytes::random_hex;
use crate::role_log::{LaunchId, RoleLogTarget};
use crate::tier::IsolationTier;
use std::io;
use std::io::Write;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// How long the runner waits for both of its pipes to exist. The launcher creates them before it
/// creates the runner, so this only covers scheduling.
const PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the runner waits for the one `Start` frame. A launcher that connected and then said
/// nothing is a failure, not a launcher that is still thinking.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// How long one report write is given before the launcher is treated as gone.
const REPORT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the role is given to accept its bounded standard-input payload.
///
/// Generous, because it covers only the kernel accepting bytes into a pipe buffer and, for a payload
/// larger than that buffer, the role reading them. It is a bound rather than a budget: what it exists to
/// prevent is a role that never reads at all holding the runner open forever.
const STDIN_DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

const LIFECYCLE_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Bytes of randomness in a frame nonce, matching the owner side's.
const NONCE_BYTES: usize = 16;

pub fn run(tier: IsolationTier, pipe_id: &str, key: Vec<u8>) -> io::Result<()> {
    // The launch identifier is this launch's own pipe id, narrowed to the log-name grammar before
    // anything is opened. The pipe-name check upstream accepts sixty-four characters of a wider
    // alphabet, so this is a real narrowing and not a restatement of it: what may name a pipe is not
    // what may name a file.
    let launch_id = LaunchId::from_pipe_id(pipe_id)?;
    let connect_by = Instant::now() + PIPE_CONNECT_TIMEOUT;
    let control = TierPipeClient::connect(pipe_id, PipeRole::Control, connect_by)?;
    let report = TierPipeClient::connect(pipe_id, PipeRole::Report, connect_by)?;
    let mut control_session = TierSession::new(key.clone(), tier.as_str());
    let report_session = TierSession::new(key.clone(), tier.as_str());

    let request = match receive(
        &control,
        &mut control_session,
        Some(Instant::now() + START_TIMEOUT),
    )? {
        Some(TierFrame::Start { request }) => request,
        Some(other) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "the first frame on the control pipe was {}, not start",
                    other.op()
                ),
            ));
        }
        None => {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the control pipe closed before a start request arrived",
            ));
        }
    };
    // The runner re-resolves the same bytes but deliberately does not repeat the owner hop's DACL
    // readback: the tier account holds no `READ_CONTROL` on most managed roots, so it could not read
    // what the owner just verified, and a check that failed for lack of access would be worse than none.
    let (_, _, resolved) = super::resolve_request_for_tier(&request, tier)?;
    let connector_secret = if resolved.launch_role == "connector_service" {
        Some(TierPipeClient::connect(
            pipe_id,
            PipeRole::ConnectorSecret,
            connect_by,
        )?)
    } else {
        None
    };

    supervise(
        RunnerChannels {
            report: &report,
            control,
            control_session,
            report_session: &report_session,
            connector_secret: connector_secret.as_ref(),
            key: &key,
        },
        &resolved,
        &launch_id,
    )
}

/// Starts the role, reports it, and waits until the owner closes the control pipe or the role exits.
///
/// A failure before the report drops the role, which terminates the role process itself; anything it
/// already started is in the owner's Job, and the owner ends that Job when it sees this runner exit.
struct RunnerChannels<'a> {
    report: &'a TierPipeClient,
    control: TierPipeClient,
    control_session: TierSession,
    report_session: &'a TierSession,
    connector_secret: Option<&'a TierPipeClient>,
    key: &'a [u8],
}

fn supervise(
    channels: RunnerChannels<'_>,
    resolved: &crate::catalog_start::ResolvedCatalogLaunch,
    launch_id: &LaunchId,
) -> io::Result<()> {
    let RunnerChannels {
        report,
        control,
        mut control_session,
        report_session,
        connector_secret,
        key,
    } = channels;
    // The one file this launch may write, composed from the tier log directory the resolution derived
    // and this launch's own identifier. Opened here, by the tier, with `CREATE_NEW`: a launch whose
    // identifier somehow repeated fails rather than appending to another launch's log, and the directory
    // is one P5 pre-created, because the tier holds no right to add a directory here.
    let log = RoleLogTarget::new(&resolved.spec.log_directory, launch_id).create_for_role()?;
    // No Job named: this process is in the owner's, and the role inherits it at creation.
    let mut role = launch_catalog_same_account(&resolved.spec, None, log)?;
    // Standard input is the role's only inbound channel and it is closed as soon as it has been used.
    // A role with no payload gets end-of-file immediately, which is the honest answer and keeps a role
    // that reads its input from blocking on bytes that are never coming. Nothing drains the output
    // streams any more: they are bound to the log file directly, so there is no pipe to fill and no
    // thread copying a role's bytes through this process.
    //
    // The payload is generated here rather than during resolution, because resolution runs in both hops
    // and the Connector's bootstrap carries keys the owner hop must never hold a copy of.
    deliver_stdin(&mut role, &resolved.spec.stdin, connector_secret, key)?;

    send(
        report,
        report_session,
        TierFrame::Started {
            tier: resolved.tier.as_str().to_owned(),
            launch_role: resolved.launch_role.clone(),
            role_pid: role.pid(),
            role_environment_names: environment_names(role.environment()),
        },
    )?;

    eprintln!(
        "native_role_lifecycle stage=monitor event=begin role={} role_pid={}",
        resolved.launch_role,
        role.pid(),
    );
    let (control_sender, control_receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = receive(&control, &mut control_session, None);
        let _ = control_sender.send(result);
    });
    loop {
        match control_receiver.try_recv() {
            Ok(Ok(Some(other))) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "the control pipe carried {} after the role had started, and nothing follows a start",
                        other.op()
                    ),
                ));
            }
            Ok(Ok(None)) => {
                eprintln!(
                    "native_role_lifecycle stage=monitor event=control_closed role={}",
                    resolved.launch_role,
                );
                return Ok(());
            }
            Ok(Err(error)) => return Err(error),
            Err(mpsc::TryRecvError::Disconnected) => {
                return Err(io::Error::other(
                    "the control reader ended without reporting",
                ));
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match role.wait(LIFECYCLE_POLL_INTERVAL) {
            Ok(code) => {
                eprintln!(
                    "native_role_lifecycle stage=monitor event=role_exited role={} code={code}",
                    resolved.launch_role,
                );
                return Err(io::Error::other(format!(
                    "the role exited before stop: role={} code={code}",
                    resolved.launch_role,
                )));
            }
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {}
            Err(error) => return Err(error),
        }
    }
}

/// Generates what the role's standard input carries, delivers it, and closes the writer.
///
/// The payload is minted here and nowhere else. Resolution only names it, because both hops resolve the
/// same request and the Connector's bootstrap carries two symmetric keys: a resolution that generated one
/// would mint a live key pair in the owner process as well and then discard it.
///
/// # Why the write happens on its own thread
///
/// A write to a pipe blocks when the pipe's buffer is full, and the buffer `CreatePipe` gives us is the
/// system default - around 4 KiB, which is smaller than the payload bound. A role that never reads its
/// standard input would therefore be able to block this function forever, and an unbounded wait is
/// exactly what this component does not allow itself (see `AGENTS.md`): the runner would report nothing
/// until its peer gave up on it.
///
/// So the write runs on a thread and the wait on it is bounded. A timeout is a launch failure, and the
/// thread it leaves behind is not a leak: the runner exits, the owner terminates the Job, the role dies,
/// its read end closes, and the blocked write fails and returns.
///
/// # Why the failure path needs no cleanup of its own
///
/// A payload that is half written is a role that will read a truncated request, so a partial write has to
/// end the launch. It does: this returns an error, `supervise` drops the role, and the runner exits
/// before reporting a start. The owner sees that exit and terminates its Job, so nothing the role
/// started survives either, and that is a property of who holds the Job rather than of anything here.
///
/// `write_all` is what handles a short write: it loops until the buffer is gone or the pipe fails, and a
/// pipe that accepted zero bytes with no error is an `ErrorKind::WriteZero` rather than a silent success.
///
/// # What is not in the error
///
/// Not the payload, not its length, and not any part of its content. The refusal a launcher reports may
/// end up in a log or a support bundle, and the one payload this delivers carries two symmetric keys.
fn deliver_stdin(
    role: &mut SameAccountChild,
    stdin: &RoleStdin,
    connector_secret: Option<&TierPipeClient>,
    key: &[u8],
) -> io::Result<()> {
    let writer = role.take_stdin_writer()?;
    let payload = match stdin {
        // Dropping the writer is what gives the role end-of-file.
        RoleStdin::Eof => return Ok(()),
        RoleStdin::ConnectorBootstrap {
            search_module,
            endpoint,
        } => {
            let bundle = connector_bootstrap_bundle(search_module, endpoint)?;
            let secret = connector_secret.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Connector secret channel is missing",
                )
            })?;
            let sealed = super::connector_secret::seal(
                bundle.client_config.as_slice(),
                random_hex(NONCE_BYTES)?,
                key,
            )
            .map_err(super::connector_secret::io_error)?;
            secret.send_connector_secret(&sealed, Instant::now() + STDIN_DELIVERY_TIMEOUT)?;
            bundle.role_stdin
        }
    };

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut writer = writer;
        let outcome = writer
            .write_all(payload.as_slice())
            .and_then(|()| writer.flush());
        // Both are dropped here: the writer, which is what ends the single line the peer is reading, and
        // the payload, whose buffer is wiped on the way out.
        drop(writer);
        drop(payload);
        let _ = sender.send(outcome.map_err(|error| error.kind()));
    });

    match receiver.recv_timeout(STDIN_DELIVERY_TIMEOUT) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(kind)) => Err(io::Error::new(
            kind,
            "the role's bootstrap payload could not be delivered to its standard input",
        )),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "the role did not accept its bootstrap payload within the delivery budget",
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(io::Error::other(
            "the thread delivering the role's bootstrap payload ended without reporting",
        )),
    }
}

fn send(report: &TierPipeClient, session: &TierSession, frame: TierFrame) -> io::Result<()> {
    let nonce = random_hex(NONCE_BYTES)?;
    let sealed = session.seal(frame, nonce).map_err(io::Error::from)?;
    report.send(&sealed, Instant::now() + REPORT_WRITE_TIMEOUT)
}

/// Reads and authenticates one control frame, or `None` when the launcher has closed the pipe.
fn receive(
    control: &TierPipeClient,
    session: &mut TierSession,
    deadline: Option<Instant>,
) -> io::Result<Option<TierFrame>> {
    match control.receive(deadline)? {
        None => Ok(None),
        Some(body) => session
            .open(&body, Direction::ToRunner)
            .map(Some)
            .map_err(io::Error::from),
    }
}
