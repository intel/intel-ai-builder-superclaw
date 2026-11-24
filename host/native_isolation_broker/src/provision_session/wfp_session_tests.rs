//! The WFP half of a provision session: a plan arrives after `Applied` and is answered in the same
//! elevated process, and nothing about it can fail the provision or add an elevation.
//!
//! The installer is a stand-in here, so no test opens the filtering engine. The pipe is the real one,
//! created by this process as the owner, as the identity-step tests do.

use super::pipe::ProvisionPipeServer;
use super::*;
use crate::sid_win32::current_process_sid;
use serde_json::json;
use std::cell::RefCell;
use std::thread;

const KEY_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

fn soon() -> Instant {
    Instant::now() + Duration::from_secs(10)
}

fn key() -> Vec<u8> {
    decode_auth_key(KEY_HEX).expect("the test key is 32 bytes of hex")
}

fn plan() -> Value {
    json!({"install_sublayer": true})
}

#[test]
fn an_installed_plan_is_answered_with_its_normalized_digest() {
    let seen = RefCell::new(Vec::new());
    let frame = wfp_reply("S-1-5-21-1-2-3-1001", &plan(), |owner, bytes| {
        seen.borrow_mut().push((owner.to_owned(), bytes.to_vec()));
        Ok(())
    });

    assert_eq!(
        frame,
        ProvisionFrame::WfpInstalled {
            wfp_plan_digest: normalized_digest(&plan()).expect("a digest")
        }
    );
    assert_eq!(
        seen.into_inner(),
        vec![(
            "S-1-5-21-1-2-3-1001".to_owned(),
            normalized_payload(&plan()).expect("bytes")
        )]
    );
}

#[test]
fn every_install_failure_is_one_closed_reason_and_never_a_provision_failure() {
    let cases: [(WfpPlanFailure, WfpInstallRefusal, &str); 5] = [
        (
            WfpPlanFailure::Plan(crate::wfp::plan_refusal_for_tests()),
            WfpInstallRefusal::PlanShapeInvalid,
            "wfp_plan_shape_invalid",
        ),
        (
            WfpPlanFailure::OwnerMismatch,
            WfpInstallRefusal::OwnerMismatch,
            "wfp_plan_owner_mismatch",
        ),
        (
            WfpPlanFailure::ObjectsNotInstallable,
            WfpInstallRefusal::ObjectsNotInstallable,
            "wfp_objects_not_installable",
        ),
        (
            WfpPlanFailure::Engine(io::Error::other("BFE is stopped")),
            WfpInstallRefusal::EngineUnavailable,
            "wfp_engine_unavailable",
        ),
        (
            WfpPlanFailure::Apply(crate::wfp::apply_refusal_for_tests()),
            WfpInstallRefusal::ApplyRefused,
            "wfp_apply_refused",
        ),
    ];
    for (failure, reason, code) in cases {
        let frame = wfp_reply("S-1-5-21-1-2-3-1001", &plan(), |_, _| Err(failure));
        assert_eq!(frame, ProvisionFrame::WfpRefused { reason });
        assert_eq!(reason.code(), code);
    }
}

#[test]
fn a_plan_carrying_an_executable_or_command_line_is_refused_before_the_installer() {
    let frame = wfp_reply(
        "S-1-5-21-1-2-3-1001",
        &json!({"install_sublayer": true, "command_line": "cmd.exe"}),
        |_, _| panic!("the installer ran for a plan with a forbidden field"),
    );
    assert_eq!(
        frame,
        ProvisionFrame::WfpRefused {
            reason: WfpInstallRefusal::PlanShapeInvalid
        }
    );
}

#[test]
fn a_wfp_plan_goes_to_the_broker_and_its_answers_go_to_the_owner() {
    assert_eq!(
        ProvisionFrame::WfpPlan { wfp_plan: plan() }.direction(),
        Direction::ToBroker
    );
    for answer in [
        ProvisionFrame::WfpInstalled {
            wfp_plan_digest: "0".repeat(64),
        },
        ProvisionFrame::WfpRefused {
            reason: WfpInstallRefusal::ApplyRefused,
        },
    ] {
        assert_eq!(answer.direction(), Direction::ToOwner);
    }
}

#[test]
fn an_oversized_wfp_plan_is_refused_on_its_own_bound() {
    let session = ProvisionSession::new(key(), "S-1-5-21-1-2-3-1001");
    let padded = json!({"padding": "x".repeat(wire::MAX_WFP_PLAN_BYTES)});
    assert_eq!(
        session
            .seal(ProvisionFrame::WfpPlan { wfp_plan: padded }, "n".repeat(32))
            .err(),
        Some(ProvisionProtocolError::WfpPlanOversized)
    );
}

/// The exchange over the live pipe: the owner sends a plan after the receipt and hears the answer.
fn exchange(
    owner_sends: Option<Value>,
    install: impl FnOnce(&str, &[u8]) -> Result<(), WfpPlanFailure> + Send + 'static,
) -> (io::Result<()>, Option<ProvisionFrame>) {
    let owner = current_process_sid().expect("this process has a SID");
    let pipe_id = random_hex(16).expect("the system RNG should be available");
    let server = ProvisionPipeServer::create(&pipe_id, &owner).expect("the pipe is creatable");
    let broker = {
        let owner = owner.clone();
        thread::spawn(move || {
            let client = ProvisionPipeClient::connect(&pipe_id, soon())?;
            client.bind_server(&owner)?;
            let mut session = ProvisionSession::new(key(), &owner);
            wfp_exchange(&client, &mut session, &owner, install)
        })
    };
    server.await_client(soon()).expect("the broker connects");
    let mut owner_side = ProvisionSession::new(key(), &owner);
    let answer = match owner_sends {
        Some(wfp_plan) => {
            let body = owner_side
                .seal(
                    ProvisionFrame::WfpPlan { wfp_plan },
                    random_hex(16).expect("rng"),
                )
                .expect("the plan seals");
            server.send(&body, soon()).expect("the owner sends");
            let reply = server
                .receive(soon())
                .expect("the answer arrives")
                .expect("the broker answers");
            Some(
                owner_side
                    .open(&reply, Direction::ToOwner)
                    .expect("the answer authenticates"),
            )
        }
        None => {
            drop(server);
            None
        }
    };
    (broker.join().expect("the broker side must not panic"), answer)
}

#[test]
fn the_owner_hears_the_install_over_the_pipe() {
    let (exit, answer) = exchange(Some(plan()), |_, _| Ok(()));
    assert!(exit.is_ok(), "{exit:?}");
    assert!(matches!(answer, Some(ProvisionFrame::WfpInstalled { .. })));
}

#[test]
fn a_failed_install_is_told_to_the_owner_and_does_not_fail_the_session() {
    let (exit, answer) = exchange(Some(plan()), |_, _| Err(WfpPlanFailure::OwnerMismatch));
    assert!(exit.is_ok(), "a WFP failure must not fail the provision: {exit:?}");
    assert_eq!(
        answer,
        Some(ProvisionFrame::WfpRefused {
            reason: WfpInstallRefusal::OwnerMismatch
        })
    );
}

#[test]
fn an_owner_that_closes_the_pipe_asked_for_no_install() {
    let (exit, answer) = exchange(None, |_, _| panic!("no plan, no install"));
    assert!(exit.is_ok(), "{exit:?}");
    assert_eq!(answer, None);
}

/// The Python side matches on these exact words, so the serialized frame - not `code()` alone - must
/// carry them, and the list is the one both languages share.
#[test]
fn every_refusal_crosses_the_wire_as_its_code_and_matches_the_shared_list() {
    let all = [
        WfpInstallRefusal::PlanShapeInvalid,
        WfpInstallRefusal::OwnerMismatch,
        WfpInstallRefusal::ObjectsNotInstallable,
        WfpInstallRefusal::ApplyRefused,
        WfpInstallRefusal::EngineUnavailable,
    ];
    for reason in all {
        let json = serde_json::to_value(ProvisionFrame::WfpRefused { reason }).expect("a frame");
        assert_eq!(json["reason"], reason.code());
        let back: ProvisionFrame = serde_json::from_value(json).expect("the frame reads back");
        assert_eq!(back, ProvisionFrame::WfpRefused { reason });
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../shared/contracts/test-fixtures/egress-wfp-install-refusals.json");
    let shared: Value = serde_json::from_slice(&std::fs::read(path).expect("the shared list"))
        .expect("the shared list is JSON");
    let mut expected: Vec<&str> = shared["reasons"]
        .as_array()
        .expect("a reasons array")
        .iter()
        .map(|reason| reason.as_str().expect("a string"))
        .collect();
    let mut actual: Vec<&str> = all.iter().map(|reason| reason.code()).collect();
    expected.sort_unstable();
    actual.sort_unstable();
    assert_eq!(actual, expected);
}