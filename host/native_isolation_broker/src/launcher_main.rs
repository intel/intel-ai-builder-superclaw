//! Entry point for `native_isolation_launcher`, the unelevated artifact of the Sandbox adapter.
//!
//! # Why this file declares modules instead of using the library
//!
//! The gate on this binary is that it must contain no privilege or token-launch surface at all: not
//! `CreateProcessAsUserW`, not `AdjustTokenPrivileges`, not `SeAssignPrimaryTokenPrivilege`, and no
//! `requireAdministrator` manifest. Linking `native_isolation_broker` as a library would put that
//! decision in the linker's hands, because an unreferenced import can still survive into the import
//! table. Declaring the module closure explicitly here makes it a compile-time property instead: a
//! module that is not listed below is not compiled into this binary, so the symbol cannot appear.
//!
//! The cost is this list, which must be kept minimal and reviewed when it grows. Adding
//! `process.rs`, `cli_acl.rs`, `workspace_grant.rs` or `profile_env.rs` here would defeat the whole arrangement; `tests/launcher_closure.rs` fails the
//! build if it happens.
//!
//! # The credential half of the list
//!
//! The launcher reads one credential file and decrypts it, so `credential_read.rs`, `secrets.rs`,
//! `security_descriptor.rs`, `state_paths.rs` and `zeroize.rs` are here. Their write-side counterparts
//! are not, and the asymmetry is the point: `credential_store.rs` creates and protects credentials,
//! `identity_windows.rs` creates accounts, `random.rs` generates passwords, and none of the three is
//! reachable from this binary. An unelevated launcher that could rewrite the credential it reads would
//! be able to lock the owner out of their own tier accounts, so the closure gives it no way to try.
//!
//! Every module is also compiled into the library, which is where its unit tests run. This binary
//! sets `test = false` precisely so those tests are not compiled and executed twice.

#[cfg(not(windows))]
compile_error!("native_isolation_launcher supports Windows only");

// The shipped ACL policy descriptor and the right-name table it is written in. Pure data plus a total
// function from contract vocabulary to bits: the launcher needs both to know which DACL a managed root
// must carry, and sharing them with the elevated broker is what keeps the two sides from computing
// different masks from the same words.
#[path = "acl_descriptor.rs"]
#[allow(dead_code)]
mod acl_descriptor;
#[path = "acl_rights.rs"]
#[allow(dead_code)]
mod acl_rights;
#[path = "broker_wire.rs"]
#[allow(dead_code)]
// The placeholder enums share a `Root` postfix that matches the wire contract. Clippy flags that only
// when they are compiled into a binary, where `pub` is effectively private; renaming them would change
// the contract, so the lint is answered rather than obeyed.
#[allow(clippy::enum_variant_names)]
mod broker_wire;
// What each production role runs, composed from validated bindings. Pure assembly apart from the
// runtime's one read of the machine `PATH`: it reads no file and resolves no principal, and the launcher
// needs it because both hops resolve the same request independently rather than trusting a spec sent
// over a pipe.
#[path = "catalog_roles/mod.rs"]
#[allow(dead_code)]
mod catalog_roles;
#[path = "catalog_runtime.rs"]
#[allow(dead_code)]
mod catalog_runtime;
#[path = "catalog_start.rs"]
#[allow(dead_code)]
mod catalog_start;
// The Connector's bootstrap line. It has to be here rather than upstream because the keys must not
// cross a process boundary before the role that uses them: the tier runner generates the line and
// writes it straight to the role's standard input.
#[path = "connector_bootstrap.rs"]
#[allow(dead_code)]
mod connector_bootstrap;
// The read-only credential facade: open one exact path, require the descriptor the broker wrote, read a
// bounded payload. It cannot create, rewrite or reprotect a credential, and `credential_store.rs` -
// which can - is deliberately absent.
#[path = "credential_read.rs"]
#[allow(dead_code)]
mod credential_read;
// Framing, HMAC and nonce primitives with no I/O and no Win32 surface at all. Shared with the test
// protocol in `protocol.rs`, which is *not* here: only the primitives are common, and the test
// protocol's lease actions have no place in this binary.
#[path = "frame.rs"]
#[allow(dead_code)]
mod frame;
// The one definition of the tier account naming algorithm, so the launcher derives the same name the
// elevated provisioner created rather than a second name that agrees by coincidence. Pure: no Win32
// surface, no I/O.
#[path = "identity_name.rs"]
#[allow(dead_code)]
mod identity_name;
#[path = "job.rs"]
#[allow(dead_code)]
mod job;
#[path = "launch_catalog.rs"]
#[allow(dead_code)]
mod launch_catalog;
#[path = "launch_environment.rs"]
#[allow(dead_code)]
mod launch_environment;
#[path = "launch_spec.rs"]
#[allow(dead_code)]
mod launch_spec;
#[path = "launcher/mod.rs"]
#[allow(dead_code)]
mod launcher;
#[path = "machine_path.rs"]
mod machine_path;
// Reading a managed root's DACL and comparing it with the descriptor, plus the whole-chain reparse and
// object-type guards that make the path being read the path that was meant. Deliberately not
// `security_descriptor.rs`, which is the same job with `WRITE_DAC`: these two ask for `READ_CONTROL` at
// most, so this binary can detect drift and cannot repair it.
#[path = "backend_ancestors.rs"]
mod backend_ancestors;
#[path = "managed_root_dacl.rs"]
#[allow(dead_code)]
mod managed_root_dacl;
#[path = "managed_root_path.rs"]
#[allow(dead_code)]
mod managed_root_path;
// Reading a descriptor back and comparing it exactly, which is how the owner verifies the bootstrap it
// protected and the station and desktop the bootstrap created. It writes nothing.
#[path = "object_descriptor.rs"]
#[allow(dead_code)]
mod object_descriptor;
#[path = "payload_paths.rs"]
#[allow(dead_code)]
mod payload_paths;
// Which profile folders sit above the backend root and whether each carries its one ACE, read with
// `READ_CONTROL`. Not `profile_ancestor_apply.rs`, which adds and removes that ACE.
#[path = "profile_ancestors.rs"]
mod profile_ancestors;
// Bounded overlapped byte movement over one pipe end. No Win32 surface beyond `ReadFile`, `WriteFile`
// and the overlapped machinery that bounds them, and no protocol: the tier pipes and the elevated
// provision pipe both sit on it, and neither is visible from the other.
#[path = "pipe_io.rs"]
#[allow(dead_code)]
mod pipe_io;
#[path = "process_same_account.rs"]
#[allow(dead_code)]
mod process_same_account;
#[path = "process_win32.rs"]
#[allow(dead_code)]
mod process_win32;
// `BCryptGenRandom` only, so the launcher can draw a pipe id, an authentication key and frame nonces.
// Deliberately not `random.rs`, which generates account passwords and has no business being reachable
// from an unelevated binary that never touches an account.
#[path = "random_bytes.rs"]
#[allow(dead_code)]
mod random_bytes;
// Where a role's log goes and the handle the runner opens for it. One `CreateFileW` with `CREATE_NEW`
// against a directory P5 pre-created: it cannot create a parent, cannot enumerate anything and cannot
// name a file the caller chose.
#[path = "role_log.rs"]
#[allow(dead_code)]
mod role_log;
// Range-checking a bound scalar against the shipped rule table, including the length and charset that
// are the whole of what can be asserted about a bound secret. Pure comparison, no I/O.
#[path = "scalar_rules.rs"]
#[allow(dead_code)]
mod scalar_rules;
// DPAPI unprotect. `CryptProtectData` is in here too and is unused by this binary, which is safe in a
// way the account and password modules are not: protecting a blob nobody stores changes nothing.
#[path = "secrets.rs"]
#[allow(dead_code)]
mod secrets;
// Reading and comparing a security descriptor, which is how the credential facade decides a file is the
// one the broker wrote. Not `security_descriptor_apply.rs`, which writes one.
#[path = "security_descriptor/mod.rs"]
#[allow(dead_code)]
mod security_descriptor;
#[path = "sid_text.rs"]
#[allow(dead_code)]
mod sid_text;
// Textual SID conversion, `LookupAccountNameW` name resolution and read-only `TOKEN_QUERY` token-user
// lookup: how the launcher turns a derived account name into a SID, and how both peers of a pipe say
// who connected. Deliberately not `identity_windows.rs` or `win32.rs`: nothing here creates or deletes
// an account, creates a token, or changes a privilege.
#[path = "sid_win32.rs"]
#[allow(dead_code)]
mod sid_win32;
// Where the credential directory is, so the launcher and the broker agree on one location.
#[path = "state_paths.rs"]
#[allow(dead_code)]
mod state_paths;
#[path = "tier.rs"]
#[allow(dead_code)]
mod tier;
// What the tier bootstrap creates and must read back as, the bootstrap's command line and handoff frame,
// and read-only token questions (#3499). Not `tier_bootstrap/`, which is the bootstrap's own image and the
// one place `CreateProcessAsUserW` appears: this binary never reaches it.
#[path = "tier_desktop_policy.rs"]
#[allow(dead_code)]
mod tier_desktop_policy;
#[path = "tier_handoff.rs"]
#[allow(dead_code)]
mod tier_handoff;
#[path = "token_info.rs"]
#[allow(dead_code)]
mod token_info;
// Our WFP sublayer read back against a plan, with the owner's own token. Only the read tree: no applier,
// no write engine and no revoke, so no write call is compiled into this binary. Its one entry is
// `--wfp-readback`.
#[path = "wfp/read/mod.rs"]
#[allow(dead_code)]
mod wfp;
#[path = "wide.rs"]
#[allow(dead_code)]
mod wide;
// The containers that make every plaintext representation of a password wipe itself on the way out.
#[path = "zeroize.rs"]
#[allow(dead_code)]
mod zeroize;

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match launcher::run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("native_isolation_launcher: {error}");
            ExitCode::FAILURE
        }
    }
}
