use crate::lease::{LeaseError, LeaseMachine};
use crate::process::JobChild;
use crate::protocol::{
    Action, AllowlistedTarget, MAX_TEST_FRAME_BYTES, Response, parse_authenticated_request,
};
use crate::sid_win32::canonical_sid;
use crate::win32::PipeServer;
use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_REQUESTS_PER_CONNECTION: usize = 64;

pub fn run_server(
    pipe_id: &str,
    expected_owner_sid: &str,
    key: &[u8],
    executable: &Path,
) -> io::Result<()> {
    if key.len() != 32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "authentication key must be exactly 32 bytes",
        ));
    }
    let owner_sid = canonical_sid(expected_owner_sid)?;
    let pipe = PipeServer::create(pipe_id, &owner_sid)?;
    pipe.connect()?;

    if pipe.client_sid()? != owner_sid {
        let response = rejected(0, "authenticate_client", "owner_sid_mismatch");
        let _ = pipe.write(&response);
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "connected client token SID does not match configured owner SID",
        ));
    }

    let mut lease = LeaseMachine::new();
    let mut child: Option<JobChild> = None;
    let mut nonces = HashSet::new();

    for _ in 0..MAX_REQUESTS_PER_CONNECTION {
        let payload = match pipe.poll_frame(lease.deadline()) {
            Ok(Some(payload)) => payload,
            Ok(None) => {
                if lease.expire_if_due(Instant::now()) {
                    terminate_child(&mut child)?;
                    return Ok(());
                }
                continue;
            }
            Err(error) => {
                terminate_child(&mut child)?;
                if matches!(
                    error.kind(),
                    io::ErrorKind::BrokenPipe | io::ErrorKind::UnexpectedEof
                ) {
                    return Ok(());
                }
                return Err(error);
            }
        };
        let dispatch_now = Instant::now();
        if lease.expire_if_due(dispatch_now) {
            terminate_child(&mut child)?;
            return Ok(());
        }

        let request = match parse_authenticated_request(&payload, key, MAX_TEST_FRAME_BYTES) {
            Ok(request) => request,
            Err(error) => {
                let write_result = pipe.write(&rejected(0, "authenticate_request", error.code()));
                return finish_with_cleanup(&mut child, write_result);
            }
        };
        if request.owner_sid != owner_sid {
            let write_result = pipe.write(&rejected(
                request.request_id,
                "authenticate_request",
                "owner_sid_mismatch",
            ));
            return finish_with_cleanup(&mut child, write_result);
        }
        if !nonces.insert(request.nonce.clone()) {
            let write_result = pipe.write(&rejected(
                request.request_id,
                "authenticate_request",
                "nonce_replayed",
            ));
            return finish_with_cleanup(&mut child, write_result);
        }

        let (response, should_exit) = apply_action(
            request.request_id,
            request.action,
            &mut lease,
            &mut child,
            executable,
            Instant::now(),
        );
        if let Err(error) = pipe.write(&response) {
            terminate_child(&mut child)?;
            return Err(error);
        }
        if should_exit {
            pipe.finish();
            return Ok(());
        }
    }

    terminate_child(&mut child)?;
    let response = rejected(0, "protocol", "request_limit_exceeded");
    let _ = pipe.write(&response);
    Ok(())
}

fn apply_action(
    request_id: u64,
    action: Action,
    lease: &mut LeaseMachine,
    child: &mut Option<JobChild>,
    executable: &Path,
    now: Instant,
) -> (Response, bool) {
    if lease.expire_if_due(now) {
        let cleanup = terminate_child(child);
        return (expiration_response(request_id, cleanup), true);
    }
    match action {
        Action::Acquire {
            lease_id,
            target: AllowlistedTarget::FixedSleepChild,
            timeout_ms,
        } => {
            if lease.is_active() {
                return (
                    rejected(
                        request_id,
                        "acquire",
                        lease_error_code(LeaseError::AlreadyActive),
                    ),
                    false,
                );
            }
            match JobChild::launch_fixed(executable) {
                Ok(launched) => {
                    let pid = launched.pid;
                    if let Err(error) =
                        lease.acquire(lease_id, Duration::from_millis(timeout_ms), now)
                    {
                        return (
                            rejected(request_id, "acquire", lease_error_code(error)),
                            false,
                        );
                    }
                    *child = Some(launched);
                    (
                        Response {
                            request_id,
                            ok: true,
                            phase: "running_verified".to_owned(),
                            error_code: "none".to_owned(),
                            child_pid: Some(pid),
                        },
                        false,
                    )
                }
                Err(_) => (
                    rejected(request_id, "launch_fixed_child", "launch_failed"),
                    false,
                ),
            }
        }
        Action::Renew {
            lease_id,
            timeout_ms,
        } => match lease.renew(&lease_id, Duration::from_millis(timeout_ms), now) {
            Ok(()) => (
                Response {
                    request_id,
                    ok: true,
                    phase: "lease_renewed".to_owned(),
                    error_code: "none".to_owned(),
                    child_pid: child.as_ref().map(|active| active.pid),
                },
                false,
            ),
            Err(error) => (
                rejected(request_id, "renew", lease_error_code(error)),
                false,
            ),
        },
        Action::Release { lease_id } => match lease.release(&lease_id, now) {
            Ok(()) => {
                let pid = child.as_ref().map(|active| active.pid);
                let cleanup = terminate_child(child);
                (cleanup_response(request_id, "released", pid, cleanup), true)
            }
            Err(error) => (
                rejected(request_id, "release", lease_error_code(error)),
                false,
            ),
        },
    }
}

fn terminate_child(child: &mut Option<JobChild>) -> io::Result<()> {
    if let Some(mut active) = child.take() {
        active.terminate()?;
    }
    Ok(())
}

fn finish_with_cleanup(
    child: &mut Option<JobChild>,
    prior_result: io::Result<()>,
) -> io::Result<()> {
    terminate_child(child)?;
    prior_result
}

fn cleanup_response(
    request_id: u64,
    success_phase: &str,
    child_pid: Option<u32>,
    cleanup: io::Result<()>,
) -> Response {
    match (child_pid, cleanup) {
        (Some(pid), Ok(())) => Response {
            request_id,
            ok: true,
            phase: success_phase.to_owned(),
            error_code: "none".to_owned(),
            child_pid: Some(pid),
        },
        (_, Err(error)) => rejected(
            request_id,
            "cleanup",
            if error.kind() == io::ErrorKind::TimedOut {
                "cleanup_timeout"
            } else {
                "cleanup_unconfirmed"
            },
        ),
        (None, Ok(())) => rejected(request_id, "cleanup", "cleanup_unconfirmed"),
    }
}

fn expiration_response(request_id: u64, cleanup: io::Result<()>) -> Response {
    match cleanup {
        Ok(()) => rejected(request_id, "lease", "lease_expired"),
        Err(error) => rejected(
            request_id,
            "cleanup",
            if error.kind() == io::ErrorKind::TimedOut {
                "cleanup_timeout"
            } else {
                "cleanup_unconfirmed"
            },
        ),
    }
}

fn rejected(request_id: u64, phase: &str, error_code: &str) -> Response {
    Response {
        request_id,
        ok: false,
        phase: phase.to_owned(),
        error_code: error_code.to_owned(),
        child_pid: None,
    }
}

const fn lease_error_code(error: LeaseError) -> &'static str {
    match error {
        LeaseError::AlreadyActive => "lease_already_active",
        LeaseError::NotActive => "lease_not_active",
        LeaseError::LeaseMismatch => "lease_mismatch",
        LeaseError::Expired => "lease_expired",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_renew_at_deadline_expires_before_dispatch() {
        let acquired_at = Instant::now();
        let mut lease = LeaseMachine::new();
        lease
            .acquire(
                "lease-a".to_owned(),
                Duration::from_millis(500),
                acquired_at,
            )
            .expect("idle lease should acquire");
        let mut child = None;

        let (response, should_exit) = apply_action(
            9,
            Action::Renew {
                lease_id: "lease-a".to_owned(),
                timeout_ms: 1_000,
            },
            &mut lease,
            &mut child,
            Path::new("unused"),
            acquired_at + Duration::from_millis(500),
        );

        assert!(!response.ok);
        assert_eq!(response.error_code, "lease_expired");
        assert!(should_exit);
        assert!(!lease.is_active());
    }

    #[test]
    fn release_success_requires_confirmed_child_cleanup() {
        let success = cleanup_response(1, "released", Some(42), Ok(()));
        assert!(success.ok);
        assert_eq!(success.phase, "released");

        let failed = cleanup_response(
            2,
            "released",
            Some(42),
            Err(io::Error::other("TerminateJobObject failed")),
        );
        assert!(!failed.ok);
        assert_eq!(failed.phase, "cleanup");
        assert_eq!(failed.error_code, "cleanup_unconfirmed");

        let timed_out = cleanup_response(
            3,
            "released",
            Some(42),
            Err(io::Error::new(io::ErrorKind::TimedOut, "wait timed out")),
        );
        assert!(!timed_out.ok);
        assert_eq!(timed_out.error_code, "cleanup_timeout");
    }
}
