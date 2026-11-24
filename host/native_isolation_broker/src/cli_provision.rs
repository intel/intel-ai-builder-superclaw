//! Elevated broker CLI for owner-by-tier identity lifecycle and for opening one provision session.
//!
//! The command lines are the closed shapes `BROKER_ELEVATED_OPERATIONS` publishes in `shared/contracts`, and
//! `elevation_contract_tests` parses that contract's golden fixture with [`parse`] below.
//!
//! # The three arguments a provision session takes, and why it is only three
//!
//! `--provision-session` is the command line the unprivileged client hands to `ShellExecuteExW` with
//! `runas`, so it is the one command line in this product that a UAC prompt is shown for. Everything on it
//! is therefore either unforgeable or useless:
//!
//! - an owner SID, which names *whose* authorization is being recorded and is checked against the account
//!   that created the pipe rather than believed;
//! - a random pipe id, which names the object to connect to and confers nothing - knowing it does not let
//!   a caller be the pipe's server, and being the server is what this side requires;
//! - a hex authentication key, which binds frames to this one attempt.
//!
//! No path, no file, no plan and no root appears here. The path set and the ACL plan arrive over the pipe,
//! from a peer whose account has been checked, and they are re-validated from scratch on arrival. That is
//! the difference between this and the `--path-set-file` and `--apply-acl-stdin` arms it replaced: those
//! took their payload from a mutable file or an inherited handle, neither of which can be attributed to
//! anyone.
//!
//! `--provision-identities-and-session` takes the same three and nothing more. It is `--provision`'s identity
//! step and then the same session, in one elevated process, so a first start costs one UAC prompt.

use crate::product::{IdentityReceipt, broker_authorization, provision_owner, revoke_owner};
use crate::provision_session::IdentityStep;
use std::io::{self, Write};

/// One recognized command line, borrowing its values from the arguments.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProvisionCommand<'a> {
    Provision {
        owner_sid: &'a str,
    },
    /// Both session operations; `identity` is the only thing that tells them apart.
    Session {
        owner_sid: &'a str,
        pipe_id: &'a str,
        auth_key: &'a str,
        identity: IdentityStep,
    },
    Revoke {
        owner_sid: &'a str,
    },
}

/// Recognizes a command line by its flags and arity alone; every value is validated by the operation.
///
/// Fixed arity, fixed order, fixed flag names: seven arguments and nothing else open a provision session.
/// There is no optional argument to omit and no extra one to append, so the elevated process cannot be
/// steered by adding to its command line - only by replacing it entirely, which is a different UAC prompt.
pub(crate) fn parse(args: &[String]) -> Option<ProvisionCommand<'_>> {
    match args {
        [flag, owner_flag, owner_sid] if flag == "--provision" && owner_flag == "--owner-sid" => {
            Some(ProvisionCommand::Provision { owner_sid })
        }
        [
            flag,
            owner_flag,
            owner_sid,
            pipe_flag,
            pipe_id,
            key_flag,
            auth_key,
        ] if owner_flag == "--owner-sid"
            && pipe_flag == "--pipe-id"
            && key_flag == "--auth-key" =>
        {
            let identity = match flag.as_str() {
                "--provision-session" => IdentityStep::Skip,
                "--provision-identities-and-session" => IdentityStep::ProvisionOwner,
                _ => return None,
            };
            Some(ProvisionCommand::Session {
                owner_sid,
                pipe_id,
                auth_key,
                identity,
            })
        }
        [flag, owner_flag, owner_sid] if flag == "--revoke" && owner_flag == "--owner-sid" => {
            Some(ProvisionCommand::Revoke { owner_sid })
        }
        _ => None,
    }
}

pub fn try_run(args: &[String]) -> Option<io::Result<()>> {
    // Nothing is written to standard output by either session form. The receipt goes on the pipe, because
    // a process started through `runas` has no standard output its caller can read, and inventing a second
    // reporting channel would mean two places that could disagree about whether a plan was applied.
    Some(match parse(args)? {
        ProvisionCommand::Provision { owner_sid } => run_provision(owner_sid),
        ProvisionCommand::Session {
            owner_sid,
            pipe_id,
            auth_key,
            identity,
        } => crate::provision_session::run(owner_sid, pipe_id, auth_key, identity),
        ProvisionCommand::Revoke { owner_sid } => run_revoke(owner_sid),
    })
}

fn run_provision(owner_sid: &str) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    run_provision_with_writer(owner_sid, &mut stdout)
}

fn run_provision_with_writer(owner_sid: &str, writer: &mut impl Write) -> io::Result<()> {
    let authorization = broker_authorization();
    match provision_owner(&authorization, owner_sid) {
        Ok(receipts) => write_success(writer, receipts),
        Err(error) => write_refusal(writer, owner_sid, &error),
    }
}

fn run_revoke(owner_sid: &str) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    run_revoke_with_writer(owner_sid, &mut stdout)
}

fn run_revoke_with_writer(owner_sid: &str, writer: &mut impl Write) -> io::Result<()> {
    let authorization = broker_authorization();
    match revoke_owner(&authorization, owner_sid) {
        Ok(()) => write_revoke_success(writer),
        Err(error) => write_revoke_refusal(writer, owner_sid, &error),
    }
}

fn write_success(writer: &mut impl Write, receipts: Vec<IdentityReceipt>) -> io::Result<()> {
    let output = serde_json::json!({
        "ok": true,
        "phase": "provision_owner",
        "identities": receipts,
    });
    serde_json::to_writer(&mut *writer, &output)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    writer.write_all(b"\n")
}

fn write_refusal(writer: &mut impl Write, owner_sid: &str, error: &io::Error) -> io::Result<()> {
    let output = serde_json::json!({
        "ok": false,
        "phase": "provision_owner",
        "owner_sid": owner_sid,
        "reason": crate::error_code(error),
        "detail": error.to_string(),
    });
    serde_json::to_writer(&mut *writer, &output)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    writer.write_all(b"\n")?;
    Err(io::Error::new(
        error.kind(),
        format!("provision_owner refused: {error}"),
    ))
}

fn write_revoke_success(writer: &mut impl Write) -> io::Result<()> {
    let output = serde_json::json!({
        "ok": true,
        "phase": "revoke_owner",
    });
    serde_json::to_writer(&mut *writer, &output)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    writer.write_all(b"\n")
}

fn write_revoke_refusal(
    writer: &mut impl Write,
    owner_sid: &str,
    error: &io::Error,
) -> io::Result<()> {
    let output = serde_json::json!({
        "ok": false,
        "phase": "revoke_owner",
        "owner_sid": owner_sid,
        "reason": crate::error_code(error),
        "detail": error.to_string(),
    });
    serde_json::to_writer(&mut *writer, &output)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    writer.write_all(b"\n")?;
    Err(io::Error::new(
        error.kind(),
        format!("revoke_owner refused: {error}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_owner_sid_emits_json_refusal() {
        let mut output = Vec::new();
        let result = run_provision_with_writer("not-a-sid", &mut output);
        assert!(result.is_err());
        let value: serde_json::Value = serde_json::from_slice(&output).expect("refusal json");
        assert_eq!(value["ok"], false);
        assert_eq!(value["phase"], "provision_owner");
        assert!(value["detail"].is_string());
    }

    #[test]
    fn revoke_invalid_owner_sid_emits_json_refusal() {
        let mut output = Vec::new();
        let result = run_revoke_with_writer("not-a-sid", &mut output);
        assert!(result.is_err());
        let value: serde_json::Value = serde_json::from_slice(&output).expect("refusal json");
        assert_eq!(value["ok"], false);
        assert_eq!(value["phase"], "revoke_owner");
        assert!(value["detail"].is_string());
    }
}
