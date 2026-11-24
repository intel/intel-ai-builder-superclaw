#[cfg(not(windows))]
compile_error!("native_isolation_broker supports Windows only");

// Which objects an ACL plan may name, decided here rather than by the plan. Elevated-only: the
// unelevated launcher never writes an ACL and so has no use for a write authorization rule.
mod account_rights_windows;
mod acl_authorized_root;
mod acl_policy_apply;
// The ACL vocabulary both binaries need and neither may hold privately: the shipped descriptor turned
// into the DACL an object must carry, and the right names turned into bits. Public because the
// unelevated launcher declares the same files through `#[path]` and must compute exactly the masks the
// elevated broker applies; nothing in either module opens a handle or resolves a principal.
#[allow(dead_code)]
pub mod acl_descriptor;
#[allow(dead_code)]
pub mod acl_rights;
mod acl_windows;
#[allow(dead_code)]
pub mod broker_wire;
// What each production role runs: program, argv, working directory, environment, log directory and the
// Connector's stdin line, all composed from validated bindings. Kept beside the dispatcher rather than
// inside it because this is where a launch shape is reviewed.
mod catalog_roles;
mod catalog_runtime;
mod catalog_start;
mod cli_acl;
mod cli_provision;
// The Connector's bootstrap line, including the two symmetric keys it is the only holder of. No caller
// contributes any part of it.
mod connector_bootstrap;
/// Read-only tier-credential surface for callers that hold no privilege.
///
/// This is the whole credential API the unprivileged launcher is allowed to reach: derive the
/// path from `identity_name`, read the blob under the verified owner-read descriptor, unprotect it.
/// Writing a credential, the elevated converging read that repairs a drifted descriptor, managing
/// accounts and applying any other ACL live in `credential_store` and stay unexported, so the
/// launcher cannot link to a privileged operation even by mistake - while both sides still share the
/// one descriptor definition, which is here.
pub mod credential_read;
mod credential_store;
// The closed command lines and the provision refusal vocabulary, pinned to `shared/contracts`.
#[cfg(test)]
mod elevation_contract_tests;
mod frame;
mod grant_store;
pub mod identity_name;
mod identity_windows;
mod dcom_restriction_windows;
mod job;
mod launch_catalog;
mod launch_environment;
mod launch_spec;
mod machine_path;
mod payload_paths;
mod scalar_rules;
// Compiled into the library so its unit tests run here exactly once, and public so the whole launcher
// module chain counts as reachable in this target. The `native_isolation_launcher` binary declares the
// same files through `#[path]`, deliberately without the privileged modules; see `launcher_main.rs`.
//
// The consequence is that the elevated broker links this code as well, with no command line that
// reaches it: `run()` below has no launcher arm, and adding one would make the elevated broker a
// tier-launch path, which is the thing the two-hop design exists to avoid. The closure that is gated is
// the other direction - the launcher must not reach a privileged module - because that is the one whose
// failure would matter; `tests/launcher_closure.rs` enforces it in the source and in the linked bytes.
pub mod launcher;
mod lease;
// Path and DACL inspection that asks for `READ_CONTROL` at most, so the unelevated launcher can prove a
// managed root still carries the descriptor the broker applied without being able to rewrite it.
mod backend_ancestors;
#[allow(dead_code)]
pub mod managed_root_dacl;
#[allow(dead_code)]
pub mod managed_root_path;
// Reading a kernel or window object's descriptor back and comparing it exactly. Shared by both tier hops;
// public so the opt-in tier-account test reads the private station with the same comparison.
pub mod object_descriptor;
// Bounded overlapped frame movement over one named-pipe end, with no protocol of its own. Crate-private
// and shared by both named-pipe boundaries: the launcher's tier pipes and the provision pipe. Nothing
// outside those two module chains has any business issuing a raw overlapped read on a pipe.
mod pipe_io;
mod process;
mod process_same_account;
mod process_win32;
pub mod product;
mod product_acl;
// The one ACE each folder between the user profile and the backend root gets, so Node's realpath can
// lstat its way to a script. Derivation and readback are shared with the launcher; the write is not.
mod profile_ancestor_apply;
mod profile_ancestors;
mod profile_env;
mod protocol;
// The elevated half of provisioning: the only place in the product that records a workspace authorization
// or turns an ACL plan into a DACL write, and the pipe it authenticates its peer over. Deliberately absent
// from `launcher_main.rs`'s module closure, so the unelevated launcher can detect a drifted managed root and
// cannot repair one.
mod provision_session;
mod random;
mod random_bytes;
#[cfg(test)]
mod rename_probe_tests;
// Where a role's log goes and the handle the tier runner opens for it. No caller-supplied string reaches
// it: the file name is this launch's own random pipe id, validated as bounded hex before it is used.
mod role_log;
// The one place that decides what may be said about a bound scalar, including what may be said about a
// bound secret when it is refused.
mod secrets;
mod security_descriptor;
mod security_descriptor_apply;
mod self_test;
mod sid_text;
// Public so the unelevated acceptance tests can name the account they expect on the other end of a
// pipe. Every negative SID case is only meaningful beside the positive one, and the positive one is
// this process's own SID. Nothing here creates a token or changes a privilege; it converts SID text,
// reads a token user with `TOKEN_QUERY`, and resolves an account name to a SID, all of which any
// caller may do.
pub mod sid_win32;
mod state;
mod state_paths;
mod tier;
// The first-hop image of a tier launch (#3499, #3400). Compiled here only so its unit tests run once; the
// `native_isolation_tier_bootstrap` binary declares the same files through `#[path]`, and no command line
// of the broker reaches it. It is the one module in the crate that calls `CreateProcessAsUserW`, with a
// restricted copy of its own token; `tests/launcher_closure.rs` checks that neither the broker nor the
// launcher binary carries that import.
pub mod tier_bootstrap;
// What the tier hops create and how its security must read back, what crosses from the bootstrap, and the
// read-only token questions both hops ask. Public for the opt-in tier-account test.
pub mod tier_desktop_policy;
pub mod tier_handoff;
mod tier_profile;
pub mod token_info;
// The WFP egress filters: the plan checked as caller input, the filters it names, one transaction and a
// readback by key. The provision session installs only the presence anchor through it (our sublayer, zero
// filters) and `--revoke` removes everything in our sublayer; only `wfp/read/` is in `launcher_main.rs`'s
// closure. Plan wire fields parsed only so that a wrong value is refused, and failure details only a test
// reads, are why it allows dead code.
#[allow(dead_code)]
mod wfp;
mod wide;
mod win32;
mod windows;
mod workspace_grant;
mod zeroize;

// `launcher::pipe::TierPipeServer::bind` takes the runner handle its caller already holds, so that one
// type has to be nameable outside the crate. The rest of `process_win32` - the stdio pipe set, the
// attribute list, the suspend guard - stays internal, because nothing outside this crate creates a
// process through it.
pub use process_win32::OwnedHandle;
pub use tier::IsolationTier;

use std::io;
use std::thread;
use std::time::Duration;

pub fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if cli_acl::try_run(&args)? {
        return Ok(());
    }
    if let Some(result) = cli_provision::try_run(&args) {
        return result;
    }
    match args.as_slice() {
        [mode] if mode == "--self-test" => self_test::run(),
        [mode, sleep_flag, sleep_ms]
            if mode == "--test-child" && sleep_flag == "--sleep-ms" && sleep_ms == "60000" =>
        {
            thread::sleep(Duration::from_millis(60_000));
            Ok(())
        }
        [
            mode,
            pipe_flag,
            pipe_id,
            owner_flag,
            owner_sid,
            key_flag,
            key_hex,
        ] if mode == "--test-server"
            && pipe_flag == "--pipe-id"
            && owner_flag == "--owner-sid"
            && key_flag == "--auth-key" =>
        {
            let key = hex::decode(key_hex).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "auth key is not valid hex")
            })?;
            windows::run_server(pipe_id, owner_sid, &key, &std::env::current_exe()?)
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected --self-test, --provision, --provision-session, --provision-identities-and-session, --revoke, --revoke-workspace-authorization, or the fixed internal test-server/test-child mode",
        )),
    }
}

pub fn error_code(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => "invalid_input",
        io::ErrorKind::PermissionDenied => "access_denied",
        io::ErrorKind::TimedOut => "timeout",
        io::ErrorKind::BrokenPipe | io::ErrorKind::UnexpectedEof => "pipe_lost",
        _ => "windows_api_failure",
    }
}
