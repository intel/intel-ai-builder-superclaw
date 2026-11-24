//! The unelevated tier-local launcher.
//!
//! # Why this exists
//!
//! The elevated broker cannot launch a role into a tier account with `CreateProcessAsUserW`: an
//! interactive elevated administrator token does not hold `SeAssignPrimaryTokenPrivilege`, so that
//! call fails with Win32 1314. The fix is not to acquire the privilege but to stop needing it, by
//! launching in two hops that each stay inside one account:
//!
//! 1. `--launch-tier` runs unelevated as the owner, creates the role's Job, starts the tier bootstrap
//!    (`native_isolation_tier_bootstrap`) suspended in the owner's tier account with
//!    `CreateProcessWithLogonW`, puts it in that Job, protects it and only then resumes it. The
//!    bootstrap creates the tier's private window station and desktop and starts the supervisor there
//!    with a restricted copy of its own token, and the owner verifies all three, ends the bootstrap and
//!    resumes the supervisor (#3499, #3400; `bootstrap_launch.rs`). The owner holds the Job for the
//!    role's whole life (#3010).
//! 2. `--tier-runner` is the supervisor: it runs as the tier account, restricted, on the private
//!    desktop, and starts the role with plain `CreateProcessW`; the role inherits the owner's Job, the
//!    desktop and the restricted token.
//!
//! # What crosses the hop
//!
//! A pipe id, a tier name, a random per-launch authentication key and the owner SID - nothing else. No
//! executable path, no command line, no shell and no free-form argument appears on a command line or
//! on a pipe; the runner resolves what to launch from the shipped catalog itself, and the bootstrap's one
//! handoff frame carries handle values and a process id the owner verifies (`tier_handoff.rs`). The transport is
//! two one-way named pipes (`pipe.rs`) whose access control names the tier account explicitly
//! (`pipe_acl.rs`), and whose frames are a closed authenticated set (`wire.rs`). No handle crosses the
//! first hop at all, because `CreateProcessWithLogonW` cannot pass one; `logon.rs` explains what that
//! rules out, and `role_job.rs` why the Job stays on this side of it.
//!
//! # What this module is not
//!
//! It is not a second privileged component and not a second lifecycle owner. It is one more artifact
//! of the same Sandbox adapter, and it is deliberately built so that no token or privilege API is
//! reachable from it at all: see `launcher_main.rs`, which declares the binary's entire module
//! closure explicitly rather than linking the broker library. The first hop authenticates with a
//! password against a service, which is why the launcher needs no privilege of its own and must remain
//! unelevated.
//!
//! # What is still temporary here
//!
//! The owner side still reads its one start request from its own standard input; a Sandbox Manager
//! control pipe replaces that in execution plan P7, and nothing about the transport below changes when
//! it does, which is why the two are separable.

mod bootstrap_launch;
mod bootstrap_protection;
mod connector_secret;
mod control_stream;
pub mod logon;
mod logon_attempt;
pub mod owner;
// The start-time DACL readback. In this module chain rather than beside the broker's ACL code because
// it is the unelevated half: it reads with `READ_CONTROL`, decides, and cannot write.
pub mod acl_readback;
pub mod drift;
pub mod pipe;
pub mod pipe_acl;
pub mod process_desktop;
pub mod refusal;
mod role_job;
pub mod runner;
pub mod seclogon;
mod session_named_objects;
mod tier_desktop_adopt;
mod window_station;
pub mod wire;

use crate::catalog_start::{ResolvedCatalogLaunch, resolve_validated_start};
use crate::frame::{AUTH_KEY_BYTES, decode_auth_key};
use crate::launch_catalog::{ValidatedStartRequest, validate_start_request_bytes};
use crate::tier::IsolationTier;
use serde_json::Value;
use std::fs::File;
use std::io;
use std::thread;

const USAGE: &str = "expected exactly `--launch-tier --owner-sid <sid> --tier <tier>`, \
                     `--launch-tier --owner-sid <sid> --tier <tier> --connector-client-handle <decimal>`, \
                     `--tier-runner --tier <tier> --pipe-id <id> --auth-key <hex>`, \
                     `--acl-readback --owner-sid <sid>` (the roots on standard input), \
                     `--wfp-readback --owner-sid <sid>` (the plan on standard input) or \
                     `--tier-loopback-self-test --owner-sid <sid> --tier <tier> --runner-sid <sid>`";

/// The `launch_path` a report carries when the runner was started in the tier account. Part of the
/// report rather than inferred by a reader, so a consumer never has to guess which hop produced it.
pub const TIER_LOGON_LAUNCH_PATH: &str = "tier_logon";

/// The `launch_path` a report carries when the runner was started in the caller's own account by the
/// internal loopback mode. A consumer that treats this as evidence of a cross-account launch is wrong,
/// and this value is what lets it tell.
pub const LOOPBACK_LAUNCH_PATH: &str = "loopback_self_test";

/// Strict, closed argument handling. There is no partial match, no default and no extra flag: an
/// unrecognized command line is refused rather than interpreted.
pub fn run(args: &[String]) -> io::Result<()> {
    match args {
        // The production owner hop. No account name and no tier SID: both are derived from the owner
        // SID and the tier, so there is no argument with which a caller could aim this at an account
        // the owner does not own.
        [mode, owner_flag, owner_sid, tier_flag, tier]
            if mode == "--launch-tier" && owner_flag == "--owner-sid" && tier_flag == "--tier" =>
        {
            owner::launch_tier(owner_sid, parse_tier(tier)?, None)
        }
        [
            mode,
            owner_flag,
            owner_sid,
            tier_flag,
            tier,
            handle_flag,
            handle,
        ] if mode == "--launch-tier"
            && owner_flag == "--owner-sid"
            && tier_flag == "--tier"
            && handle_flag == "--connector-client-handle" =>
        {
            owner::launch_tier(owner_sid, parse_tier(tier)?, Some(parse_handle(handle)?))
        }
        [mode, tier_flag, tier, pipe_flag, pipe_id, key_flag, key_hex]
            if mode == "--tier-runner"
                && tier_flag == "--tier"
                && pipe_flag == "--pipe-id"
                && key_flag == "--auth-key" =>
        {
            runner::run(parse_tier(tier)?, pipe_id, parse_auth_key(key_hex)?)
        }
        // The read-only DACL readback of the roots on standard input, for the isolation report: the
        // start-time check run on demand, printing a path-free verdict per root and repairing nothing.
        [mode, owner_flag, owner_sid]
            if mode == "--acl-readback" && owner_flag == "--owner-sid" =>
        {
            acl_readback::run(owner_sid)
        }
        // The unelevated WFP readback: our sublayer and its filters, read with the owner's own token and
        // compared with the plan on standard input. Nothing is written and no elevation is requested; an
        // engine that refuses the read is a refusal here, which the owner reports as `not_read`.
        [mode, owner_flag, owner_sid]
            if mode == "--wfp-readback" && owner_flag == "--owner-sid" =>
        {
            wfp_readback(owner_sid)
        }
        // A fixed internal mode, in the same sense as the broker's `--self-test` and `--test-child`:
        // it runs the whole orchestration with a same-account runner so the transport is testable
        // without three provisioned tier accounts. No product path reaches it.
        [
            mode,
            owner_flag,
            owner_sid,
            tier_flag,
            tier,
            runner_flag,
            runner_sid,
        ] if mode == "--tier-loopback-self-test"
            && owner_flag == "--owner-sid"
            && tier_flag == "--tier"
            && runner_flag == "--runner-sid" =>
        {
            owner::loopback_self_test(owner_sid, parse_tier(tier)?, runner_sid)
        }
        _ => Err(io::Error::new(io::ErrorKind::InvalidInput, USAGE)),
    }
}

/// The most plan bytes a readback takes from standard input, the same bound a provision's WFP plan has.
const MAX_WFP_READBACK_PLAN_BYTES: u64 = 256 * 1024;

fn wfp_readback(owner_sid: &str) -> io::Result<()> {
    use std::io::{Read, Write};
    let mut plan = Vec::new();
    io::stdin()
        .take(MAX_WFP_READBACK_PLAN_BYTES + 1)
        .read_to_end(&mut plan)?;
    let output = if plan.len() as u64 > MAX_WFP_READBACK_PLAN_BYTES {
        serde_json::json!({"ok": false, "phase": "wfp_readback", "error_code": "wfp_plan_oversized"})
    } else {
        match crate::wfp::read_back_installed(owner_sid, &plan) {
            Ok(mut report) => {
                report["ok"] = Value::Bool(true);
                report["phase"] = Value::from("wfp_readback");
                report
            }
            Err(failure) => serde_json::json!({
                "ok": false,
                "phase": "wfp_readback",
                "error_code": failure.code()
            }),
        }
    };
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &output).map_err(io::Error::other)?;
    stdout.write_all(b"\n")
}

fn parse_tier(value: &str) -> io::Result<IsolationTier> {
    IsolationTier::from_wire(value).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{value:?} is not an isolation tier"),
        )
    })
}

fn parse_auth_key(value: &str) -> io::Result<Vec<u8>> {
    decode_auth_key(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("the authentication key must be {AUTH_KEY_BYTES} bytes of hex"),
        )
    })
}

fn parse_handle(value: &str) -> io::Result<usize> {
    value
        .parse::<usize>()
        .ok()
        .filter(|handle| *handle != 0)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Connector client handle must be non-zero decimal",
            )
        })
}

/// Resolves a start request against the shipped catalog, refusing it outright if the catalog assigns
/// the request a different tier than `tier`, and returns the canonical bytes that were validated.
///
/// Lives here rather than in either hop because both hops call it, with the same request and the same
/// catalog, and both validate the *canonical* serialization rather than whatever byte order they
/// happened to receive. Sharing it is what keeps them from silently disagreeing about which start
/// requests are acceptable if a future change tightens or fixes what one hop refuses without the same
/// change reaching the other.
fn resolve_request_for_tier(
    request: &Value,
    tier: IsolationTier,
) -> io::Result<(Vec<u8>, ValidatedStartRequest, ResolvedCatalogLaunch)> {
    let canonical = wire::canonical_catalog_request(request).map_err(io::Error::from)?;
    let validated = validate_start_request_bytes(&canonical).map_err(|refusal| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "start request refused by the shipped catalog ({}): {}",
                refusal.reason, refusal.detail
            ),
        )
    })?;
    let resolved = resolve_validated_start(&validated)?;
    if resolved.tier != tier {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "requested tier {} does not match the tier {} the catalog assigns to {}",
                tier.as_str(),
                resolved.tier.as_str(),
                resolved.launch_role
            ),
        ));
    }
    Ok((canonical, validated, resolved))
}

/// Reads a pipe to EOF on its own thread and throws the bytes away.
///
/// Discarding is not the point; draining is. A child whose stdout or stderr is never read blocks the
/// moment it fills the pipe buffer, so an unread pipe is a lifetime bug rather than a missing feature.
///
/// Only the owner hop needs this now, and only for the runner's standard output: the runner reports on a
/// named pipe and its standard error is captured rather than discarded. A role's output is not drained at
/// all any more - it is bound to a log file the tier runner opened, so the bytes never reach a pipe this
/// process would have to empty.
fn discard_in_background(mut pipe: File) {
    thread::spawn(move || {
        let _ = io::copy(&mut pipe, &mut io::sink());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_closed_argument_forms_are_accepted() {
        for args in [
            vec!["--launch-tier", "--owner-sid", "S-1-5-21-1-2-3-1001"],
            vec!["--launch-tier", "--tier", "bootstrap"],
            vec![
                "--launch-tier",
                "--owner-sid",
                "S-1-5-21-1-2-3-1001",
                "--tier",
                "Bootstrap",
            ],
            // The owner hop no longer accepts a tier SID: it resolves one. A command line that offers
            // it is refused rather than tolerated, because tolerating it would leave a way to name the
            // account a launch binds its pipes to.
            vec![
                "--launch-tier",
                "--owner-sid",
                "S-1-5-21-1-2-3-1001",
                "--tier",
                "bootstrap",
                "--runner-sid",
                "S-1-5-21-1-2-3-2002",
            ],
            // Nor an account name, for the same reason.
            vec![
                "--launch-tier",
                "--owner-sid",
                "S-1-5-21-1-2-3-1001",
                "--tier",
                "bootstrap",
                "--account-name",
                "SCBBZUMXK5U6MIU7VEA4",
            ],
            vec!["--tier-runner"],
            // The runner without the pipe it is supposed to be listening on.
            vec!["--tier-runner", "--tier", "bootstrap"],
            vec![
                "--tier-runner",
                "--tier",
                "Bootstrap",
                "--pipe-id",
                "abc",
                "--auth-key",
                &"ab".repeat(32),
            ],
            // A key of the wrong length is refused before a pipe is opened.
            vec![
                "--tier-runner",
                "--tier",
                "bootstrap",
                "--pipe-id",
                "abc",
                "--auth-key",
                "ab",
            ],
            vec![
                "--tier-runner",
                "--tier",
                "bootstrap",
                "--pipe-id",
                "abc",
                "--auth-key",
                "not-hex",
            ],
            // The loopback mode still needs every one of its four values.
            vec![
                "--tier-loopback-self-test",
                "--owner-sid",
                "S-1-5-21-1-2-3-1001",
                "--tier",
                "bootstrap",
            ],
            vec![
                "--tier-loopback-self-test",
                "--owner-sid",
                "not-a-sid",
                "--tier",
                "bootstrap",
                "--runner-sid",
                "S-1-5-21-1-2-3-2002",
            ],
            vec![
                "--tier-loopback-self-test",
                "--owner-sid",
                "S-1-5-21-1-2-3-1001",
                "--tier",
                "bootstrap",
                "--runner-sid",
                "not-a-sid",
            ],
            vec!["--launch-start"],
            vec![],
        ] {
            let owned: Vec<String> = args.iter().map(|value| (*value).to_owned()).collect();
            assert_eq!(
                run(&owned)
                    .expect_err("the launcher must refuse anything but its three closed forms")
                    .kind(),
                io::ErrorKind::InvalidInput,
                "accepted {args:?}"
            );
        }
    }

    /// The temporary launcher-to-runner standard input path is gone: the runner's form now names the
    /// pipe it listens on, and there is no form that omits it.
    #[test]
    fn the_runner_cannot_be_asked_to_take_its_request_from_standard_input() {
        assert!(USAGE.contains("--pipe-id"));
        assert!(USAGE.contains("--auth-key"));
        let owned: Vec<String> = ["--tier-runner", "--tier", "bootstrap"]
            .iter()
            .map(|value| (*value).to_owned())
            .collect();
        assert_eq!(
            run(&owned)
                .expect_err("the P1 stdin form must no longer be accepted")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    /// The production form takes no account name and no runner SID, so there is no command line with
    /// which a caller could aim a launch at an account this owner does not own. Asserted against the
    /// usage text as well, because that is what an operator reads.
    #[test]
    fn the_production_owner_hop_names_no_account_it_could_have_derived() {
        assert!(USAGE.contains("`--launch-tier --owner-sid <sid> --tier <tier>`"));
        assert!(
            !USAGE.contains("--account-name"),
            "the account name is derived, never accepted"
        );
        assert_ne!(TIER_LOGON_LAUNCH_PATH, LOOPBACK_LAUNCH_PATH);
    }

    /// Both hops resolve the canonical bytes, so the tier a request is accepted for is a property of
    /// the catalog rather than of which hop happened to look.
    #[test]
    fn a_request_for_the_wrong_tier_is_refused_by_whichever_hop_looks() {
        let request = serde_json::json!({
            "contract_version": 1,
            "manifest_version": 1,
            "manifest_digest": crate::launch_catalog::SHIPPED_CATALOG_DIGEST,
            "launch_role": "test_fixed_sleep_child",
            "workspace_root_id": null,
            "path_bindings": [
                {"placeholder": "payload_root", "path": "C:\\Users\\tester\\SuperClaw\\payload"},
                {"placeholder": "state_logs_root", "path": "C:\\ProgramData\\SuperClaw\\state\\logs"},
                {"placeholder": "isolation_root", "path": "C:\\ProgramData\\SuperClaw\\isolation"}
            ],
            "scalar_bindings": []
        });
        let (canonical, _, resolved) = resolve_request_for_tier(&request, IsolationTier::Bootstrap)
            .expect("the shipped test role is a bootstrap role");
        assert_eq!(resolved.tier, IsolationTier::Bootstrap);
        assert!(
            canonical.starts_with(b"{\"contract_version\""),
            "the validated bytes are the canonical ones, not the caller's ordering"
        );
        assert_eq!(
            resolve_request_for_tier(&request, IsolationTier::FileTool)
                .expect_err("the catalog decides the tier, not the caller")
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}
