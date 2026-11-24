//! The tier bootstrap (#3499, #3400): the first-hop image, which creates the tier's private window station
//! and desktop and starts the restricted supervisor there.
//!
//! # Why a bootstrap at all
//!
//! The owner's `CreateProcessWithLogonW` must leave `lpDesktop` null, because that is the only way the
//! new tier logon can initialize `user32` at all, and Secondary Logon then gives it the owner's
//! interactive logon SID, which `WinSta0` and its desktop grant (#3400). So the first hop necessarily
//! runs on `WinSta0`. This image is what runs there: launcher code only, briefly, never a role, with its
//! process and primary thread re-protected by the owner before it resumes and its loader threads by its
//! own first instructions (`tier_desktop_policy.rs`). By default those DACLs grant SYSTEM and the tier
//! account; under #3838 they grant SYSTEM and the owner logon SID, which flagged roles hold deny-only.
//! A mixed-mode flag-off role still holds that SID enabled. From `CreateProcessWithLogonW` until those
//! instructions complete, the same tier, and any flag-off role through the shared logon SID, can open the
//! process and primary thread (until the owner's replacement) or a thread the loader creates after resume
//! (until the bootstrap's own protection) with the read and execute access the tier token's default DACL
//! gives that logon SID, and keeps that handle; that window is open residual risk (#3713).
//!
//! # The order
//!
//! 1. Inspect only whether the owner-built command line ends in the exact #3838 switch, so the selected
//!    protection runs before general parsing. No ambient tier environment decides the switch.
//! 2. Protect it: its token's default DACL (set and read back), then every thread it already has
//!    (`self_protection.rs`), then its error mode. The owner already replaced the process and
//!    primary-thread DACLs before resuming it.
//! 3. Parse and validate the complete closed argument set.
//! 4. Only then `user32`, loaded rather than imported (`station.rs`), and the unnamed window station of its
//!    own fresh logon session, created with `CWF_CREATE_ONLY` and never joined, then the per-launch desktop
//!    `SuperClawTier-<pipe_id>`. Both get their whole security at creation (`tier_desktop_policy.rs`).
//! 5. A restricted copy of its own token, its logon SID enabled by default or deny-only under #3838,
//!    and its default DACL the tier account and SYSTEM; the supervisor starts suspended on that desktop
//!    with it (`restricted_launch.rs`).
//! 6. One handoff frame to the owner: the four handle values and the supervisor's process id. The owner
//!    duplicates and verifies what they denote, then ends this process; nothing here resumes the
//!    supervisor, and a bootstrap the owner does not release in time exits and takes the supervisor down.
//!
//! A failure at any step exits with that step's code (`tier_handoff::BootstrapStep`), which is how the
//! owner's refusal names it. Nothing here retries, falls back to another desktop, or keeps going.

pub mod restricted_launch;
pub mod self_protection;
pub mod station;

use crate::frame::decode_auth_key;
use crate::launch_environment::{current_process_environment, resolve_cross_account_environment};
use crate::pipe_io::Endpoint;
use crate::process_win32::{OwnedHandle, wide_null};
use crate::random_bytes::random_hex;
use crate::tier_desktop_policy::{
    DesktopTrustees, desktop_name, desktop_path, desktop_sddl, station_sddl,
};
use crate::tier_handoff::{
    BootstrapStep, HANDOFF_CLIENT_RIGHTS, Handoff, LAUNCHER_IMAGE, MAX_HANDOFF_FRAME_BYTES,
    bootstrap_role_desktop_boundary, handoff_pipe_name, parse_bootstrap_args_after_boundary_check,
    runner_command_line, seal,
};
use crate::token_info::current_process_token;
use restricted_launch::{SupervisorSpec, restricted_token, start_supervisor};
use self_protection::protect_self;
use station::{User32, create_desktop, create_station};
use std::convert::Infallible;
use std::io;
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::{
    TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

/// How long the handoff pipe is given to open and take the frame. The owner created it before this
/// process existed, so this covers scheduling only.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the bootstrap waits, holding the station, the desktop and the suspended supervisor, for the
/// owner to duplicate them and end it. Past this it exits and its supervisor dies with it.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(30);

/// Bytes of randomness in the frame's nonce, as in the other tier frames.
const NONCE_BYTES: usize = 16;

/// How long each wait for the handoff pipe lasts before another open is tried.
const CONNECT_POLL_MS: u32 = 50;

/// Runs the bootstrap and returns the process exit code. There is no success code: the owner ends a
/// bootstrap that succeeded, and every other ending is the code of the step it stopped at.
pub fn run(args: &[String]) -> u32 {
    match bootstrap(args) {
        Ok(never) => match never {},
        Err((step, _)) => step.exit_code(),
    }
}

fn bootstrap(args: &[String]) -> Result<Infallible, (BootstrapStep, io::Error)> {
    let at = |step: BootstrapStep| move |error: io::Error| (step, error);
    let role_desktop_boundary = bootstrap_role_desktop_boundary(args);
    let me = protect_self(role_desktop_boundary)?;
    let args = parse_bootstrap_args_after_boundary_check(args, role_desktop_boundary)
        .map_err(at(BootstrapStep::Arguments))?;
    let key = decode_auth_key(&args.key_hex)
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
        .map_err(at(BootstrapStep::Arguments))?;

    let user32 = User32::load().map_err(at(BootstrapStep::LoadUser32))?;
    let trustees = DesktopTrustees {
        owner_sid: &args.owner_sid,
        tier_sid: &me.tier_sid,
    };
    let station =
        create_station(&user32, &station_sddl(&trustees)).map_err(at(BootstrapStep::Station))?;
    let station_name = user32
        .object_name(station.raw())
        .map_err(at(BootstrapStep::Station))?;
    let desktop_name = desktop_name(&args.pipe_id);
    let desktop = create_desktop(&user32, &station, &desktop_name, &desktop_sddl(&trustees))
        .map_err(at(BootstrapStep::Desktop))?;

    let own = current_process_token(
        TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
    )
    .map_err(at(BootstrapStep::RestrictedToken))?;
    let token = restricted_token(
        &own,
        &me.tier_sid,
        &me.logon_sid,
        args.role_desktop_boundary,
    )
    .map_err(at(BootstrapStep::RestrictedToken))?;
    drop(own);

    let image = std::env::current_exe()
        .map_err(at(BootstrapStep::Supervisor))?
        .with_file_name(LAUNCHER_IMAGE);
    let directory = image
        .parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))
        .map_err(at(BootstrapStep::Supervisor))?
        .to_owned();
    let command = runner_command_line(&image, args.tier.as_str(), &args.pipe_id, &args.key_hex);
    let environment = current_process_environment()
        .and_then(|source| resolve_cross_account_environment(source.into_iter(), &[]))
        .map_err(at(BootstrapStep::Supervisor))?;
    let supervisor = start_supervisor(
        &token,
        &SupervisorSpec {
            image: &image,
            command: &command,
            current_directory: &directory,
            environment: &environment,
            desktop: &desktop_path(&station_name, &desktop_name),
        },
    )
    .map_err(at(BootstrapStep::Supervisor))?;
    drop(token);

    let handoff = Handoff {
        station_handle: station.raw() as u64,
        desktop_handle: desktop.raw() as u64,
        supervisor_pid: supervisor.pid,
        supervisor_process_handle: supervisor.process.raw() as u64,
        supervisor_thread_handle: supervisor.thread.raw() as u64,
    };
    let deadline = Instant::now() + HANDOFF_TIMEOUT;
    let pipe =
        connect_handoff(&args.pipe_id, deadline).map_err(at(BootstrapStep::HandoffConnect))?;
    let nonce = random_hex(NONCE_BYTES).map_err(at(BootstrapStep::HandoffSend))?;
    let body = seal(&handoff, args.tier.as_str(), nonce, &key)
        .map_err(io::Error::from)
        .map_err(at(BootstrapStep::HandoffSend))?;
    pipe.write_frame(&body, MAX_HANDOFF_FRAME_BYTES, Some(deadline))
        .map_err(at(BootstrapStep::HandoffSend))?;

    // Everything the frame named stays alive here until the owner ends this process. Returning drops
    // the supervisor guard, which terminates the supervisor, and closes the station and the desktop.
    thread::sleep(RELEASE_TIMEOUT);
    drop((pipe, supervisor, desktop, station));
    Err((
        BootstrapStep::Release,
        io::Error::from(io::ErrorKind::TimedOut),
    ))
}

/// Opens the launch's handoff pipe as its one client, with its one write right. A refusal is final; an
/// absent or busy pipe is retried until `deadline`.
pub(crate) fn connect_handoff(pipe_id: &str, deadline: Instant) -> io::Result<Endpoint> {
    let name = wide_null(&handoff_pipe_name(pipe_id)?);
    loop {
        // SAFETY: NUL-terminated name, nothing inherited, and exactly the one right the pipe grants.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                HANDOFF_CLIENT_RIGHTS,
                0,
                null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
            return Endpoint::adopt(OwnedHandle::new(handle)?);
        }
        // SAFETY: Read immediately after the failed open.
        let code = unsafe { GetLastError() };
        if code == ERROR_ACCESS_DENIED {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "this account may not open the handoff pipe",
            ));
        }
        if Instant::now() >= deadline {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        // SAFETY: The name stays valid for the call; the result is advisory.
        unsafe { WaitNamedPipeW(name.as_ptr(), CONNECT_POLL_MS) };
        thread::sleep(Duration::from_millis(10));
    }
}
