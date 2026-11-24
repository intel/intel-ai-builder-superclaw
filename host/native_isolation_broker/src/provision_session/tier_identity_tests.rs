//! Where `--provision-identities-and-session` runs its identity step, and what a failure of it does.
//!
//! None of these needs elevation. The identity step is replaced by a counting stand-in, because creating an
//! account needs an administrator. What is under test is everything around it:
//! - the step runs only after the pipe's server binding, the frame's authentication, the forbidden-field
//!   scans and the owner binding have all passed;
//! - its failure stops the session before the authorization is recorded, and the owner hears why on the pipe;
//! - its success hands over to the unchanged session, whose own refusal is then the answer.
//!
//! These cases lean on one fact about `record_path_set_authorization`: it refuses the minimal path sets used
//! here as `path_set_shape_invalid`, from its structural parse and before it writes anything. A session that
//! reached the record before the identity step would answer that word instead of
//! `tier_identity_provision_failed`, so the expected reason is also the proof of order. With a succeeding
//! stand-in, the same word proves the session ran on after the step.
//!
//! A full `Applied` receipt needs elevation (the record writes protected state and the apply needs the tier
//! identities to exist) and is left to the attended first launch.

use super::pipe::ProvisionPipeServer;
use super::*;
use crate::sid_win32::current_process_sid;
use serde_json::json;
use std::cell::Cell;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

const OWNER: &str = "S-1-5-21-1-2-3-1001";
const KEY_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

fn soon() -> Instant {
    Instant::now() + Duration::from_secs(10)
}

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "NetUserAdd was denied")
}

fn minimal_plan() -> Value {
    json!({"contract_version": 1})
}

#[test]
fn a_failed_identity_step_refuses_before_the_authorization_is_recorded() {
    let calls = Cell::new(0);
    let failure = provision(
        OWNER,
        &json!({"owner_sid": OWNER}),
        &minimal_plan(),
        |owner| {
            calls.set(calls.get() + 1);
            assert_eq!(
                owner, OWNER,
                "the step provisions the owner this broker authenticated"
            );
            Err(denied())
        },
    )
    .map(|_| ())
    .expect_err("a failed identity step must refuse the session");

    assert_eq!(calls.get(), 1);
    assert_eq!(
        failure.reason(),
        ProvisionRefusal::TierIdentityProvisionFailed
    );
}

/// The checks that come before the identity step: the owner binding and the forbidden-field scans of both
/// payloads. A request refused by one of them never reaches the stand-in. (Path-set structure, plan shape,
/// policy version and coverage are checked after it, at the record and the apply.)
#[test]
fn a_request_refused_by_a_check_ahead_of_the_step_never_reaches_it() {
    for (path_set, plan, expected) in [
        (
            json!({"owner_sid": "S-1-5-21-9-9-9-500"}),
            minimal_plan(),
            ProvisionRefusal::OwnerBindingInvalid,
        ),
        (
            json!({"owner_sid": OWNER, "executable": "cmd.exe"}),
            minimal_plan(),
            ProvisionRefusal::PathSetShapeInvalid,
        ),
        (
            json!({"owner_sid": OWNER}),
            json!({"contract_version": 1, "command_line": "cmd.exe /c whoami"}),
            ProvisionRefusal::PlanShapeInvalid,
        ),
    ] {
        let failure = provision(OWNER, &path_set, &plan, |_| {
            panic!("the identity step ran for a request refused on its shape")
        })
        .map(|_| ())
        .expect_err("this payload must be refused");
        assert_eq!(failure.reason(), expected);
    }
}

/// A successful identity step hands over to the session, and a refusal from the session is reported in the
/// session's own word, not as an identity failure.
#[test]
fn a_successful_identity_step_hands_over_to_the_session() {
    let calls = Cell::new(0);
    let failure = provision(OWNER, &json!({"owner_sid": OWNER}), &minimal_plan(), |_| {
        calls.set(calls.get() + 1);
        Ok(())
    })
    .map(|_| ())
    .expect_err("the minimal path set is refused by the record step");

    assert_eq!(calls.get(), 1);
    assert_eq!(failure.reason(), ProvisionRefusal::PathSetShapeInvalid);
}

/// What each parsed step actually does. `Skip` touches nothing. `ProvisionOwner` reaches `--provision`'s
/// identity step, which refuses an owner that is not a SID, so a step that silently did nothing would fail
/// here.
#[test]
fn each_identity_step_does_what_its_command_line_asks() {
    IdentityStep::Skip
        .run("not-a-sid")
        .expect("skipping the identity step does nothing and cannot fail");
    IdentityStep::ProvisionOwner
        .run("not-a-sid")
        .expect_err("the identity step validates the owner it provisions");
}

/// The wire gets one word; this process's own exit error keeps the error class and names the step, so an
/// operator reading it is not sent to look at the plan.
#[test]
fn an_identity_failure_keeps_its_error_class_and_names_the_step() {
    let refused = ProvisionFailure::TierIdentities(denied());
    assert!(refused.is_permission_class());
    assert_eq!(
        refused.reason(),
        ProvisionRefusal::TierIdentityProvisionFailed
    );
    let error = refusal_error(&refused, None);
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(
        error.to_string().contains("access_denied")
            && error
                .to_string()
                .contains("tier identities could not be provisioned"),
        "the exit error must name the code and the step: {error}"
    );

    let group = ProvisionFailure::TierIdentities(io::Error::new(
        io::ErrorKind::InvalidInput,
        "the owner SID resolves to a group",
    ));
    assert!(!group.is_permission_class());
    assert_eq!(group.code(), "invalid_input");
    assert_eq!(
        refusal_error(&group, None).kind(),
        io::ErrorKind::InvalidData
    );
}

/// One live session: a pipe this process created as the owner, the elevated side's code on a thread, and a
/// request that passes every shape check. The owner side then reads whatever the broker answered.
struct LiveSession {
    server: ProvisionPipeServer,
    owner: String,
    broker: thread::JoinHandle<io::Result<()>>,
    identity_calls: Arc<AtomicUsize>,
}

impl LiveSession {
    /// `asked_for` is the owner the broker is launched for, which is the pipe creator unless a case says not.
    /// `identity_succeeds` is what the identity stand-in returns.
    fn start(asked_for: Option<&str>, identity_succeeds: bool) -> Self {
        let owner = current_process_sid().expect("this process has a SID");
        let pipe_id = random_hex(16).expect("the system RNG should be available");
        let server =
            ProvisionPipeServer::create(&pipe_id, &owner).expect("the pipe should be creatable");
        let identity_calls = Arc::new(AtomicUsize::new(0));
        let broker = {
            let asked_for = asked_for.unwrap_or(&owner).to_owned();
            let calls = Arc::clone(&identity_calls);
            thread::spawn(move || {
                serve(
                    &asked_for,
                    &pipe_id,
                    KEY_HEX,
                    move |_| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        if identity_succeeds {
                            Ok(())
                        } else {
                            Err(denied())
                        }
                    },
                    |_, _| panic!("a refused session must not install WFP"),
                )
            })
        };
        server
            .await_client(soon())
            .expect("the broker side should connect");
        Self {
            server,
            owner,
            broker,
            identity_calls,
        }
    }

    fn send_request(&self, key: &[u8]) {
        let request = ProvisionSession::new(key.to_vec(), &self.owner)
            .seal(
                ProvisionFrame::Provision {
                    path_set: json!({"owner_sid": self.owner}),
                    acl_plan: minimal_plan(),
                },
                random_hex(16).expect("the system RNG should be available"),
            )
            .expect("the request should seal");
        self.server
            .send(&request, soon())
            .expect("the owner should be able to send");
    }

    fn finish(self) -> (io::Error, usize, ProvisionPipeServer, String) {
        let exit = self
            .broker
            .join()
            .expect("the broker side must not panic")
            .expect_err("every case here ends in a refusal");
        let calls = self.identity_calls.load(Ordering::SeqCst);
        (exit, calls, self.server, self.owner)
    }
}

fn session_key() -> Vec<u8> {
    decode_auth_key(KEY_HEX).expect("the test key is 32 bytes of hex")
}

#[test]
fn the_owner_hears_a_failed_identity_step_as_its_own_refusal() {
    let live = LiveSession::start(None, false);
    live.send_request(&session_key());
    let answer = live
        .server
        .receive(soon())
        .expect("the answer should arrive")
        .expect("the broker answers rather than hanging up");
    let (exit, calls, _server, owner) = live.finish();

    let frame = ProvisionSession::new(session_key(), &owner)
        .open(&answer, Direction::ToOwner)
        .expect("the answer authenticates");
    assert_eq!(
        frame,
        ProvisionFrame::Refused {
            reason: ProvisionRefusal::TierIdentityProvisionFailed
        }
    );
    assert_eq!(calls, 1);
    assert_eq!(
        exit.kind(),
        io::ErrorKind::PermissionDenied,
        "a refused session fails the process with the step's error class: {exit}"
    );
}

/// Over the live pipe: once the identity step succeeds, the session runs on unchanged, and the owner hears
/// the session's own refusal rather than an identity failure.
#[test]
fn the_owner_hears_the_session_after_a_successful_identity_step() {
    let live = LiveSession::start(None, true);
    live.send_request(&session_key());
    let answer = live
        .server
        .receive(soon())
        .expect("the answer should arrive")
        .expect("the broker answers rather than hanging up");
    let (exit, calls, _server, owner) = live.finish();

    let frame = ProvisionSession::new(session_key(), &owner)
        .open(&answer, Direction::ToOwner)
        .expect("the answer authenticates");
    assert_eq!(
        frame,
        ProvisionFrame::Refused {
            reason: ProvisionRefusal::PathSetShapeInvalid
        }
    );
    assert_eq!(calls, 1);
    assert_eq!(
        exit.kind(),
        io::ErrorKind::InvalidData,
        "a shape refusal fails the process as invalid data: {exit}"
    );
}

#[test]
fn an_unauthenticated_request_ends_the_session_before_the_identity_step() {
    let live = LiveSession::start(None, false);
    live.send_request(&[7u8; 32]);
    let (exit, calls, server, _owner) = live.finish();

    assert_eq!(exit.kind(), io::ErrorKind::InvalidData, "{exit}");
    assert_eq!(calls, 0, "no account for a frame that did not authenticate");
    assert_eq!(
        server
            .receive(soon())
            .expect("end of stream is not an error"),
        None,
        "a request that did not authenticate gets no answer at all"
    );
}

#[test]
fn a_pipe_another_account_created_is_refused_before_the_identity_step() {
    let live = LiveSession::start(Some("S-1-5-21-1-2-3-9999"), false);
    let (exit, calls, _server, _owner) = live.finish();

    assert_eq!(exit.kind(), io::ErrorKind::PermissionDenied, "{exit}");
    assert_eq!(calls, 0, "no account for an owner whose pipe this is not");
}
