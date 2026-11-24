//! The owner hop: one framed start request in, one tier runner started and conversed with, one report
//! out.
//!
//! # The shape of one launch
//!
//! The order below is the design, not an implementation detail, and two of the steps are ordered for
//! reasons a reader has to know before changing them.
//!
//! 1. Validate the start request against the shipped catalog. **Before** any account, credential or
//!    logon work, so a malformed request is refused as a malformed request and never as a permission
//!    problem; `tests/tier_wire_contract.rs` pins that ordering, because a caller that cannot tell the
//!    two apart cannot tell a bug from an attack.
//! 2. Derive the tier account name from the canonical owner SID and the tier. Derived, never passed in:
//!    the naming algorithm has exactly one definition (`identity_name`), and a launcher that accepted
//!    an account name would accept a launch into an account the owner does not own. Then refuse unless
//!    this process runs on `WinSta0` (`window_station.rs`), before any root, account or credential.
//! 3. Resolve that name to a SID with `LookupAccountNameW` and require it to be a local user account.
//!    The name is what the logon uses and the SID is what both pipes are bound to, so they have to be
//!    two views of one account rather than two independent inputs.
//! 4. Create the pipes - control, report, the handoff pipe and, for a Connector, the secret pipe - and
//!    the role's Job, before any tier process exists, so `FILE_FLAG_FIRST_PIPE_INSTANCE` is protecting a
//!    name that was never unclaimed and the Job is ready. The Job holds seven of its eight UI limits.
//! 5. Read the credential, unprotect it, log on, and zero every representation of the password. One
//!    retry against a freshly reread credential if the failure is one a rotation would explain. What the
//!    logon starts is the tier bootstrap, suspended (`logon_attempt.rs`).
//! 6. Hand off (`bootstrap_launch.rs`): Job, protect, resume the bootstrap, take its one frame, apply the
//!    eighth UI limit, verify the private station, desktop and restricted supervisor it reports, end it,
//!    and only then resume the supervisor, which is the runner from here on (#3499, #3400).
//! 7. Bind both pipes to the runner identity, check its report against the Job, and on stop terminate
//!    the Job here: the runner is a member, so nothing about stopping waits on it.
//!
//! # Two runner-start primitives, one orchestration
//!
//! `--launch-tier` starts the runner in the tier account: the tier bootstrap, through
//! `CreateProcessWithLogonW`, starts it restricted on the tier's private desktop.
//! `--tier-loopback-self-test` starts it in the caller's own account with `CreateProcessW`, on the
//! caller's desktop. Everything else - argument handling, catalog validation, pipe creation, binding,
//! framing, verification and reporting - is this one module, shared, so the two cannot drift.
//!
//! The loopback mode exists because the cross-account path cannot be exercised without three
//! provisioned tier accounts and therefore cannot run in an unelevated suite, while the transport it
//! carries can be, and was, before P4. Keeping it is what stops the P1-P3 coverage in
//! `tests/tier_launcher.rs` from being deleted along with the same-account launch it used to test. It
//! is a fixed internal mode in the same sense as the broker's `--self-test`, `--test-server` and
//! `--test-child`: no product path reaches it, and it takes no free-form argument. It has no bootstrap
//! and no private station: a same-account runner shares the caller's logon session, whose station
//! already exists with a descriptor nobody here chose. The private-station path is covered by the
//! bootstrap's and the owner's unit tests and, with real tier accounts, by `tests/tier_desktop.rs`.
//!
//! # Host prerequisites this hop assumes
//!
//! The tier account must be able to read and execute the launcher and the bootstrap images and traverse
//! their directory, because they are the supervisor's and the bootstrap's own executables. On a default
//! install under `Program Files` that follows from the `Users` ACE Windows puts there. Making it explicit for a hardened image is the ACL work of
//! execution plan P5 and deliberately not done here.

use super::bootstrap_launch::{HandoffLaunch, SupervisorChild, hand_off};
use super::control_stream::{
    StartedReport, read_start_request, wait_for_stop, write_started_report,
};
use super::drift::require_provisioned_roots;
use super::logon::tier_runner_command;
use super::logon_attempt::start_with_logon;
use super::pipe::TierPipeServer;
use super::pipe_acl::PipeRole;
use super::refusal::{RefusalContext, TierLaunchRefusal, TierLaunchRefusalReason, refuse};
use super::role_job::{RoleJob, verify_runner_outcome};
use super::window_station::require_interactive_window_station;
use super::wire::{
    Direction, LAUNCHER_CONTRACT_VERSION, MAX_REPORT_BYTES, OwnerJobEvidence, RUNNER_SELF_REPORT,
    TierFrame, TierLaunchReport, TierProtocolError, TierSession,
};
use super::{
    LOOPBACK_LAUNCH_PATH, TIER_LOGON_LAUNCH_PATH, discard_in_background, parse_auth_key,
    resolve_request_for_tier,
};
use crate::broker_wire::BrokerPathPlaceholder;
use crate::catalog_start::ResolvedCatalogLaunch;
use crate::credential_read::credential_path;
use crate::frame::AUTH_KEY_BYTES;
use crate::identity_name::account_name_for;
use crate::launch_environment::{current_process_environment, resolve_cross_account_environment};
use crate::process_same_account::{
    RoleStdio, SameAccountChild, SameAccountSpawn, spawn_same_account,
};
use crate::process_win32::OwnedHandle;
use crate::random_bytes::random_hex;
use crate::sid_text::validate_sid_text;
use crate::sid_win32::{local_user_account_sid, require_current_process_owner_sid};
use crate::state_paths::default_state_dir;
use crate::tier::IsolationTier;
use crate::tier_handoff::ROLE_DESKTOP_BOUNDARY_ENV;
use crate::tier_handoff::{BOOTSTRAP_IMAGE, BootstrapArgs, bootstrap_command_line};
use crate::token_info::{current_process_token, enabled_logon_sid};
use serde_json::Value;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::ERROR_NONE_MAPPED;
use windows_sys::Win32::Security::TOKEN_QUERY;

/// Bytes of randomness in a production pipe id. A name an unprivileged process cannot guess is not a
/// security control on its own - the ACL and `FILE_FLAG_FIRST_PIPE_INSTANCE` are - but it removes the
/// only way a same-account process could race the runner to a predictable name.
///
/// `pub(crate)` because it is also the length of a launch identifier: `role_log.rs` names a role's log
/// file after this launch's pipe id, and asserts the contract's published grammar against this number
/// rather than restating it.
pub(crate) const PIPE_ID_BYTES: usize = 16;

/// Bytes of randomness in a frame nonce. Well above the point where two draws in one launch could
/// collide, and well under `NONCE_MAX_LEN` once hex-encoded.
const NONCE_BYTES: usize = 16;

/// How long both pipes are given to be connected and bound by the runner the launcher just created.
/// The budget covers a cross-account creation, which goes through the Secondary Logon service and is
/// therefore slower to first instruction than a same-account one.
const RUNNER_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// How long one frame write is given. A write that cannot complete in this long means the runner has
/// stopped reading, which is a failure rather than slowness.
const FRAME_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the runner is given to report the role started. It covers the role's stdin delivery.
const STARTED_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the owner side waits for the runner process itself to exit once its Job is terminated.
const RUNNER_EXIT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the owner side waits for the drained diagnostics after the runner has exited. The write
/// end is gone by then, so this only covers the reader thread finishing its last read.
const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(5);
const LIFECYCLE_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Runs the production owner hop, starting the runner in this owner's tier account.
pub fn launch_tier(
    owner_sid: &str,
    tier: IsolationTier,
    connector_client_handle: Option<usize>,
) -> io::Result<()> {
    // Refused here rather than deeper down: the owner SID is the input every derived value comes
    // from, and the same rule that governs which principals may own a credential governs which may
    // own a tier account.
    let resolved = validate_request_for(tier)?;
    let owner_sid = require_current_process_owner_sid(owner_sid)?;
    let account_name = account_name_for(&owner_sid, tier);
    let context = RefusalContext {
        tier,
        owner_sid: &owner_sid,
        account_name: &account_name,
    };
    require_interactive_window_station(&context)?;
    require_provisioned_roots(&resolved.validated.paths, tier, &owner_sid)?;
    let runner_sid = resolve_tier_account(&context)?;
    let role_desktop_boundary =
        std::env::var_os(ROLE_DESKTOP_BOUNDARY_ENV).as_deref() == Some(std::ffi::OsStr::new("1"));
    let owner_logon_sid = if role_desktop_boundary {
        let token = current_process_token(TOKEN_QUERY).map_err(|error| {
            boundary_refusal(&context, "owner_logon_token_unavailable", error)
        })?;
        Some(enabled_logon_sid(&token).map_err(|error| {
            boundary_refusal(&context, "owner_logon_sid_unavailable", error)
        })?)
    } else {
        None
    };
    if role_desktop_boundary {
        let backend_root = resolved
            .validated
            .paths
            .get(&BrokerPathPlaceholder::PayloadRoot)
            .and_then(|payload| Path::new(payload).parent())
            .and_then(Path::parent)
            .ok_or_else(|| {
                boundary_refusal(
                    &context,
                    "owner_backend_root_unavailable",
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the validated payload root has no backend-root ancestor",
                    ),
                )
            })?;
        super::session_named_objects::ensure_tier_grant(&runner_sid, backend_root).map_err(
            |error| boundary_refusal(&context, "session_named_object_grant_failed", error),
        )?;
    }
    let credential = credential_path(&default_state_dir()?, &account_name);

    let connector = resolved.resolved.launch_role == "connector_service";
    if connector != connector_client_handle.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Connector client handle presence does not match the requested role",
        ));
    }
    let plan = LaunchPlan::new(tier, &owner_sid, &runner_sid, connector)?;
    let handoff =
        TierPipeServer::create(&plan.pipe_id, PipeRole::Handoff, &owner_sid, &runner_sid)?;
    let mut role_job = RoleJob::create_deferring_desktop_limit(resolved.resolved.spec.job_profile)?;
    let environment = resolve_cross_account_environment(
        current_process_environment()?.into_iter(),
        // No declared overlay: neither the bootstrap nor the supervisor is a catalog role. What they
        // need to reach the catalog and start one is the machine-scoped base, and the role's own
        // variables are resolved on the far side from the catalog entry.
        &[],
    )?;
    let bootstrap_image = plan.launcher.with_file_name(BOOTSTRAP_IMAGE);
    let bootstrap_command = bootstrap_command_line(
        &bootstrap_image,
        &BootstrapArgs {
            tier,
            pipe_id: plan.pipe_id.clone(),
            key_hex: plan.key_hex.clone(),
            owner_sid: owner_sid.clone(),
            role_desktop_boundary,
        },
    );
    let logon_started = Instant::now();
    let bootstrap = start_with_logon(
        &context,
        &credential,
        &bootstrap_image,
        &bootstrap_command,
        &environment,
    )?;
    eprintln!(
        "native_launcher_lifecycle stage=logon event=bootstrap_created role={} bootstrap_pid={} \
         elapsed_ms={} role_desktop_boundary={}",
        resolved.resolved.launch_role,
        bootstrap.pid(),
        logon_started.elapsed().as_millis(),
        if role_desktop_boundary { "on" } else { "off" },
    );
    let supervisor = hand_off(
        &context,
        HandoffLaunch {
            bootstrap,
            role_job: &mut role_job,
            pipe: &handoff,
            key: &plan.key,
            tier,
            pipe_id: &plan.pipe_id,
            owner_sid: &owner_sid,
            tier_sid: &runner_sid,
            launcher: &plan.launcher,
            launch_role: &resolved.resolved.launch_role,
            role_desktop_boundary,
            owner_logon_sid: owner_logon_sid.as_deref(),
        },
    )?;
    drop(handoff);

    plan.complete(
        StartedRunner::Supervisor(supervisor),
        role_job,
        TIER_LOGON_LAUNCH_PATH,
        &owner_sid,
        &runner_sid,
        resolved,
        connector_client_handle,
    )
}

/// Runs the same orchestration with a same-account runner, for the unelevated test suite.
///
/// `runner_sid` is injected rather than derived, and must not equal `owner_sid`: the pipe DACL grants
/// the owner full access and the runner one direction-specific right, and `pipe_sddl` refuses the same
/// SID in both places rather than union them into full access. That is why this mode takes a synthetic
/// owner SID beside the real process SID, and why the check must not be relaxed to make the pair equal
/// - the check is what keeps the tier's grant direction-specific in production.
pub fn loopback_self_test(
    owner_sid: &str,
    tier: IsolationTier,
    runner_sid: &str,
) -> io::Result<()> {
    validate_sid_text(owner_sid)?;
    validate_sid_text(runner_sid)?;
    let resolved = validate_request_for(tier)?;
    require_provisioned_roots(&resolved.validated.paths, tier, owner_sid)?;
    let connector = resolved.resolved.launch_role == "connector_service";
    let plan = LaunchPlan::new(tier, owner_sid, runner_sid, connector)?;
    let mut role_job = RoleJob::create(resolved.resolved.spec.job_profile)?;
    let mut child = spawn_same_account(SameAccountSpawn {
        executable: &plan.launcher,
        command: &plan.command,
        // This binary, in its own directory: a runner is not a role, so no role decides where it starts.
        current_directory: plan.launcher.parent().ok_or(io::ErrorKind::InvalidInput)?,
        declared_environment: &[],
        job: Some(role_job.job()),
        // Pipes rather than a log: a runner's standard error is this hop's own diagnostic channel, and a
        // log is what the tier opens for a *role*. Both data channels are still the named pipes, so the
        // stdio ends below are closed or drained rather than left to fill.
        stdio: RoleStdio::Pipes,
    })?;
    role_job.note_verified_at_creation(child.job_membership_verified_before_resume());
    drop(child.take_stdin_writer()?);
    discard_in_background(child.take_stdout_reader()?);
    let diagnostics = capture_in_background(child.take_stderr_reader()?);

    plan.complete(
        StartedRunner::Loopback { child, diagnostics },
        role_job,
        LOOPBACK_LAUNCH_PATH,
        owner_sid,
        runner_sid,
        resolved,
        None,
    )
}

/// Reads and validates the one start request, before anything touches an account or a credential.
fn validate_request_for(tier: IsolationTier) -> io::Result<ValidatedRequest> {
    let request = read_start_request(&mut io::stdin().lock())?;
    let (_, validated, resolved) = resolve_request_for_tier(&request, tier)?;
    Ok(ValidatedRequest {
        request,
        validated,
        resolved,
    })
}

struct ValidatedRequest {
    request: Value,
    validated: crate::launch_catalog::ValidatedStartRequest,
    resolved: ResolvedCatalogLaunch,
}

/// Everything that is the same for both runner-start primitives: the pipes, the per-launch secrets and
/// the command line the runner is given.
struct LaunchPlan {
    tier: IsolationTier,
    launcher: PathBuf,
    command: String,
    pipe_id: String,
    key: Vec<u8>,
    key_hex: String,
    control: TierPipeServer,
    report: TierPipeServer,
    connector_secret: Option<TierPipeServer>,
}

impl LaunchPlan {
    fn new(
        tier: IsolationTier,
        owner_sid: &str,
        runner_sid: &str,
        connector: bool,
    ) -> io::Result<Self> {
        let pipe_id = random_hex(PIPE_ID_BYTES)?;
        let key_hex = random_hex(AUTH_KEY_BYTES)?;
        let key = parse_auth_key(&key_hex)?;
        // Both pipes exist before the runner does. Creating them afterwards would leave a window in
        // which the name is unclaimed, and `FILE_FLAG_FIRST_PIPE_INSTANCE` would then be protecting
        // nothing.
        let control = TierPipeServer::create(&pipe_id, PipeRole::Control, owner_sid, runner_sid)?;
        let report = TierPipeServer::create(&pipe_id, PipeRole::Report, owner_sid, runner_sid)?;
        let connector_secret =
            super::connector_secret::create_server(connector, &pipe_id, owner_sid, runner_sid)?;
        let launcher = std::env::current_exe()?;
        let command = tier_runner_command(&launcher, tier.as_str(), &pipe_id, &key_hex);
        Ok(Self {
            tier,
            launcher,
            command,
            pipe_id,
            key,
            key_hex,
            control,
            report,
            connector_secret,
        })
    }

    /// Binds, converses, reaps and reports. Consumes the runner and the Job, so the runner's kill-on-drop
    /// guard and the Job's kill-on-close cover every failure below without a caller having to remember.
    #[allow(clippy::too_many_arguments)]
    fn complete(
        self,
        mut runner: StartedRunner,
        mut role_job: RoleJob,
        launch_path: &str,
        owner_sid: &str,
        runner_sid: &str,
        request: ValidatedRequest,
        connector_client_handle: Option<usize>,
    ) -> io::Result<()> {
        let outcome = converse(
            OwnerConversation {
                control: &self.control,
                report: &self.report,
                connector_secret: self.connector_secret.as_ref(),
                runner: runner.identity(),
                role_job: &mut role_job,
                tier: self.tier,
                runner_sid,
                key: self.key,
                launch_path,
                owner_sid,
                launch_role: &request.resolved.launch_role,
                connector_client_handle,
            },
            request.request,
        );
        let (frames, owner_job) = runner.attach_diagnostics(outcome)?;
        let waited = runner.wait(RUNNER_EXIT_TIMEOUT);
        let runner_exit_code = runner.attach_diagnostics(waited)?;
        runner.attach_diagnostics(verify_runner_outcome(runner_exit_code, &frames, &owner_job))?;

        let report = TierLaunchReport {
            contract_version: LAUNCHER_CONTRACT_VERSION,
            event: "tier_launch_completed".to_owned(),
            launch_path: launch_path.to_owned(),
            tier: self.tier.as_str().to_owned(),
            owner_sid: owner_sid.to_owned(),
            runner_sid: runner_sid.to_owned(),
            launch_role: request.resolved.launch_role,
            runner_pid: runner.pid(),
            runner_exit_code,
            evidence_source: RUNNER_SELF_REPORT.to_owned(),
            runner_frames: frames,
            owner_job,
        };
        let line = serde_json::to_string(&report).map_err(|error| {
            io::Error::other(format!("launch report does not serialize: {error}"))
        })?;
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "{line}")?;
        stdout.flush()
    }
}

/// The runner as the pipe binding needs to see it: the process id the creation call returned, and the
/// handle that is still open on that exact process.
///
/// The two travel together so no call site can pair an id with a handle to a different process. The
/// handle is what keeps the id from being recycled, and on the loopback path the way the runner's token
/// is read. The production runner's restricted token does not admit the owner through that handle, so
/// `restricted` is set for it and every binding reads the token by impersonating the connection and
/// requires it run as the tier account.
struct RunnerIdentity<'a> {
    pid: u32,
    process: &'a OwnedHandle,
    restricted: bool,
}

impl RunnerIdentity<'_> {
    /// Binds one pipe connection to this runner. `since` is when the runner was released to connect, for
    /// the lifecycle line a production binding prints once the token has been verified.
    fn bind(&self, pipe: &TierPipeServer, runner_sid: &str, since: Instant) -> io::Result<()> {
        if !self.restricted {
            return pipe.bind(self.pid, self.process, runner_sid);
        }
        pipe.bind_impersonating(self.pid, runner_sid)?;
        eprintln!(
            "native_launcher_lifecycle stage=bind event=token_verified pipe={} \
             runner_pid={} elapsed_ms={}",
            pipe.role().suffix(),
            self.pid,
            since.elapsed().as_millis(),
        );
        Ok(())
    }
}

/// A started runner, whichever primitive started it.
enum StartedRunner {
    /// The production runner: the restricted supervisor the tier bootstrap started, held through handles
    /// the owner duplicated together with its station and desktop. No standard stream crossed either
    /// hop, so there is nothing to attach: its account of itself is the authenticated report frames.
    Supervisor(SupervisorChild),
    /// The internal loopback mode, which keeps its captured standard error.
    Loopback {
        child: SameAccountChild,
        diagnostics: mpsc::Receiver<String>,
    },
}

impl StartedRunner {
    fn pid(&self) -> u32 {
        match self {
            Self::Supervisor(child) => child.pid(),
            Self::Loopback { child, .. } => child.pid(),
        }
    }

    /// The id and the handle together, which is the only form the pipe binding accepts.
    fn identity(&self) -> RunnerIdentity<'_> {
        match self {
            Self::Supervisor(child) => RunnerIdentity {
                pid: child.pid(),
                process: child.process(),
                restricted: true,
            },
            Self::Loopback { child, .. } => RunnerIdentity {
                pid: child.pid(),
                process: child.process(),
                restricted: false,
            },
        }
    }

    fn wait(&mut self, timeout: Duration) -> io::Result<u32> {
        match self {
            Self::Supervisor(child) => child.wait(timeout),
            Self::Loopback { child, .. } => child.wait(timeout),
        }
    }

    /// Appends whatever the runner said on its standard error to a failure, so a refusal the runner
    /// made for its own reasons is visible in the launcher's own error rather than lost with the child.
    ///
    /// The production hop has no such stream and returns the failure unchanged. That is honest rather
    /// than lossy: the runner's reasons arrive as authenticated frames on the report pipe, and inventing
    /// an empty diagnostics clause would only suggest the runner had said nothing.
    fn attach_diagnostics<T>(&self, outcome: io::Result<T>) -> io::Result<T> {
        let Self::Loopback { diagnostics, .. } = self else {
            return outcome;
        };
        outcome.map_err(|error| {
            let text = diagnostics
                .recv_timeout(DIAGNOSTICS_TIMEOUT)
                .unwrap_or_default();
            io::Error::new(
                error.kind(),
                format!("{error}; tier runner diagnostics: {}", text.trim()),
            )
        })
    }
}

fn boundary_refusal(
    context: &RefusalContext<'_>,
    failure: &str,
    error: io::Error,
) -> io::Error {
    refuse(
        context,
        TierLaunchRefusal::new(
            TierLaunchRefusalReason::WindowsApiFailure,
            format!("role_desktop_boundary_{failure}: {error}"),
        ),
    )
}

/// Resolves the derived account name to the SID both pipes will be bound to.
///
/// Every way this can fail is a way the account is not what provisioning leaves behind, so all of them
/// are `provision_required` except a Win32 fault with no account meaning. That includes the name
/// resolving to something that is not a local user account: re-provisioning is still the action,
/// because a launcher that proceeded would bind its pipes to a principal it did not create.
fn resolve_tier_account(context: &RefusalContext<'_>) -> io::Result<String> {
    match local_user_account_sid(context.account_name) {
        Ok(sid) => Ok(sid),
        Err(error) if error.raw_os_error() == Some(ERROR_NONE_MAPPED as i32) => Err(refuse(
            context,
            TierLaunchRefusal::new(
                TierLaunchRefusalReason::ProvisionRequired,
                "no local account of this name exists on this machine",
            ),
        )),
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => Err(refuse(
            context,
            TierLaunchRefusal::new(
                TierLaunchRefusalReason::ProvisionRequired,
                format!("the name resolves to something this launch cannot use ({error})"),
            ),
        )),
        Err(error) => Err(refuse(
            context,
            TierLaunchRefusal::new(
                TierLaunchRefusalReason::WindowsApiFailure,
                format!("the tier account name could not be resolved ({error})"),
            ),
        )),
    }
}

/// Binds both pipes to the runner and runs the whole four-frame exchange.
///
/// `runner` carries the id from the creation call together with the handle the caller still holds on
/// that process, which is what keeps the id from being recycled underneath the checks below and what the
/// binding reads the runner's token SID through.
struct OwnerConversation<'a> {
    control: &'a TierPipeServer,
    report: &'a TierPipeServer,
    connector_secret: Option<&'a TierPipeServer>,
    runner: RunnerIdentity<'a>,
    role_job: &'a mut RoleJob,
    tier: IsolationTier,
    runner_sid: &'a str,
    key: Vec<u8>,
    launch_path: &'a str,
    owner_sid: &'a str,
    launch_role: &'a str,
    connector_client_handle: Option<usize>,
}

fn converse(
    context: OwnerConversation<'_>,
    request: Value,
) -> io::Result<(Vec<TierFrame>, OwnerJobEvidence)> {
    let OwnerConversation {
        control,
        report,
        connector_secret,
        runner,
        role_job,
        tier,
        runner_sid,
        key,
        launch_path,
        owner_sid,
        launch_role,
        connector_client_handle,
    } = context;
    let connect_by = Instant::now() + RUNNER_CONNECT_TIMEOUT;
    control.await_client(connect_by)?;
    report.await_client(connect_by)?;
    // Both connections, not one: a peer that could satisfy the check on one pipe and hand the other to
    // a different process would otherwise be reporting on a channel nobody verified.
    let released = connect_by - RUNNER_CONNECT_TIMEOUT;
    runner.bind(control, runner_sid, released)?;
    runner.bind(report, runner_sid, released)?;

    let mut session = TierSession::new(key.clone(), tier.as_str());
    let start_sent = Instant::now();
    send(control, &mut session, TierFrame::Start { request })?;
    if let Some(secret) = connector_secret {
        let config = super::connector_secret::receive_from_runner(
            secret,
            |pipe| runner.bind(pipe, runner_sid, released),
            &key,
            connect_by,
            Instant::now() + STARTED_TIMEOUT,
        )?;
        super::control_stream::write_connector_client_config(
            connector_client_handle.ok_or(io::ErrorKind::InvalidInput)?,
            config.as_slice(),
        )?;
    }
    let started = receive(report, &mut session, "started", STARTED_TIMEOUT)?;
    let started_ms = start_sent.elapsed().as_millis();
    if let TierFrame::Started { role_pid, .. } = &started {
        role_job.verify_started(runner.pid, *role_pid)?;
    }
    write_started_report(
        StartedReport {
            launch_path,
            tier,
            owner_sid,
            runner_sid,
            launch_role,
            runner_pid: runner.pid,
        },
        &started,
    )?;
    eprintln!(
        "native_launcher_lifecycle stage=monitor event=begin role={} runner_pid={} \
         start_to_started_ms={started_ms} start_to_settled_ms={}",
        launch_role,
        runner.pid,
        start_sent.elapsed().as_millis(),
    );
    let (stop_sender, stop_receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = wait_for_stop(&mut io::stdin().lock());
        let _ = stop_sender.send((result, Instant::now()));
    });
    let (stop_request, stop_requested_at): (io::Result<()>, Instant) = loop {
        match stop_receiver.try_recv() {
            Ok(arrived) => break arrived,
            Err(mpsc::TryRecvError::Disconnected) => {
                break (
                    Err(io::Error::other(
                        "the launcher control reader ended without reporting",
                    )),
                    Instant::now(),
                );
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match runner.process.wait(LIFECYCLE_POLL_INTERVAL) {
            Ok(()) => {
                eprintln!(
                    "native_launcher_lifecycle stage=monitor event=runner_exited role={launch_role} runner_pid={}",
                    runner.pid,
                );
                return Err(io::Error::other(format!(
                    "the tier runner exited before stop: role={launch_role}"
                )));
            }
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {}
            Err(error) => return Err(error),
        }
    };
    // Terminated before the stop request is judged: a malformed frame still ends the role.
    let owner_job = role_job.terminate(stop_requested_at)?;
    eprintln!(
        "native_launcher_lifecycle stage=stop event=drained role={launch_role} runner_pid={} \
         elapsed_ms={}",
        runner.pid, owner_job.cleanup_elapsed_ms,
    );
    stop_request?;
    Ok((vec![started], owner_job))
}

fn send(control: &TierPipeServer, session: &mut TierSession, frame: TierFrame) -> io::Result<()> {
    let nonce = random_hex(NONCE_BYTES)?;
    let sealed = session.seal(frame, nonce).map_err(io::Error::from)?;
    control.send(&sealed, Instant::now() + FRAME_WRITE_TIMEOUT)
}

/// Reads one authenticated frame and refuses anything but the one the sequence calls for.
///
/// A closed pipe here is `UnexpectedEof` rather than a timeout, because a runner that died is a
/// different failure from a runner that went quiet, and the caller reports which one happened.
fn receive(
    report: &TierPipeServer,
    session: &mut TierSession,
    expected_op: &str,
    budget: Duration,
) -> io::Result<TierFrame> {
    let body = report.receive(Instant::now() + budget)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!("the tier runner closed its report pipe before reporting {expected_op}"),
        )
    })?;
    let frame = session
        .open(&body, Direction::ToLauncher)
        .map_err(io::Error::from)?;
    if frame.op() != expected_op {
        return Err(io::Error::from(TierProtocolError::UnexpectedFrame));
    }
    Ok(frame)
}

/// Reads a pipe to EOF on its own thread, keeping at most `MAX_REPORT_BYTES` of it as text.
///
/// The cap bounds memory, but the loop keeps draining past it: a reader that stopped reading would
/// leave the writer blocked on a full pipe buffer, which is the deadlock this function exists to
/// prevent rather than cause.
fn capture_in_background(mut pipe: File) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = MAX_REPORT_BYTES.saturating_sub(kept.len());
                    kept.extend_from_slice(&buffer[..read.min(room)]);
                }
            }
        }
        let _ = sender.send(String::from_utf8_lossy(&kept).into_owned());
    });
    receiver
}

#[cfg(test)]
mod tests;
