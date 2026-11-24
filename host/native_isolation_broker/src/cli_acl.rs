//! Elevated CLI for revoking a workspace authorization.
//!
//! # Why there is nothing here but a revoke
//!
//! This file used to carry two more arms: `--record-workspace-authorization --path-set-file` and
//! `--apply-acl-stdin`. Both were reachable from the start path, which meant starting a sandbox could
//! write DACLs, which meant the start path needed an elevated component within reach of it.
//!
//! Recording an authorization and applying a plan now happen only inside a provision session, over the
//! closed pipe in `provision_session`, in a process launched for that one purpose. The difference is not
//! only where the code lives. `--path-set-file` took a path set from a *file path on a command line* and
//! `--apply-acl-stdin` took a plan from *inherited standard input*, and neither is a transport an elevated
//! process can bind to a peer: a file can be swapped between the caller writing it and the broker reading
//! it, and an inherited handle says nothing about who filled it. The provision pipe can be bound to one,
//! which is the whole reason it exists.
//!
//! Revoking is the exception that stays, and it stays because it needs no payload at all. It takes one
//! owner SID and removes that owner's snapshot: there is no plan to validate, no path that could be
//! redirected, and nothing gained by causing it to happen. That is also what lets the installer call it
//! while remaining revoke-only.

use crate::product_acl::revoke_workspace_authorization;
use std::io::{self, Write};

/// The owner SID of a `--revoke-workspace-authorization` command line, recognized by flags and arity alone.
pub(crate) fn parse(args: &[String]) -> Option<&str> {
    match args {
        [flag, owner_flag, owner_sid]
            if flag == "--revoke-workspace-authorization" && owner_flag == "--owner-sid" =>
        {
            Some(owner_sid)
        }
        _ => None,
    }
}

pub fn try_run(args: &[String]) -> io::Result<bool> {
    let Some(owner_sid) = parse(args) else {
        return Ok(false);
    };
    revoke_workspace_authorization(owner_sid)?;
    writeln_acl_ok("revoke_workspace_authorization")?;
    Ok(true)
}

fn writeln_acl_ok(phase: &str) -> io::Result<()> {
    writeln!(io::stdout(), "{{\"ok\":true,\"phase\":\"{phase}\"}}")?;
    Ok(())
}
