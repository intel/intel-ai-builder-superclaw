//! What each production role actually runs, assembled from validated bindings.
//!
//! # The rule this module exists to keep
//!
//! A caller binds typed placeholders - roots and numbers - and nothing else. Everything a role is
//! launched with is composed here: the program, every argument, the working directory, every environment
//! variable, the log directory, and for the Connector a bounded stdin line. There is no request field a
//! caller could set that becomes an argument, so there is nothing to sanitize at the boundary.
//!
//! # Where the shapes come from
//!
//! Nothing here is invented. The supervisor's arguments and variables are the `opencode` agent-runtime
//! descriptor's own `argv_groups` and `env_template` (`shared/contracts/src/agent-runtime-descriptor.ts`);
//! the runtime's are the `opencode serve` form the product already uses; the Connector's are its own CLI
//! and bootstrap contract (`host/sandbox_manager/src/sandbox_manager/connector.py`). Per-tier locations
//! are `<root>\<tier>`, which is the layout the shipped ACL policy provisions - see
//! `workspace_grant::apply::apply_tier_subtrees`, where a tier subtree's object path is exactly
//! `managed_root.join(tier)`.
//!
//! The tier is taken from the caller of these functions, which resolved it from the catalog entry's
//! `identity_id`, rather than written out per role here. One fact, one place: a role whose catalog tier
//! changed would move its config, data, temp and log locations with it.
//!
//! # What role assembly deliberately does not assemble
//!
//! This records role assembly's original scope, now partly superseded: credentials, the runtime's Basic
//! password among them, reach roles as owner-minted opaque scalars in the environment, never in
//! argv. The consequence is stated rather than hidden: these are complete command lines, and the
//! processes they start will not yet find each other. Making them find each other is product wiring,
//! and it will be a catalog change with a digest re-pin, which is the reviewable form that belongs in.
//!
//! "Complete" is deliberately not "startable", and the manual gate has now measured which is which. Two
//! roles start and stay up long enough to report: `openwork-server`, which reaches "listening" and
//! enumerates the workspace, and `opencode-router`, which reaches "Bridge running" and creates its media
//! directory under the workspace. Two exit immediately. The Connector names a runtime config file that
//! nothing in this build writes at that path and that its own CLI requires before it reads anything - see
//! `resolve_connector`. The supervisor exits because the environment assembled here carries no
//! `SUPERCLAW_RUNTIME_DEPLOYMENT_B64`, which its own argument check demands before it does anything else;
//! that value is a product input rather than a path or a port, so supplying it is product wiring and not a
//! placeholder this module may invent.
//!
//! A role that exits during startup is a launch *failure* rather than a fast success: the runner's settle
//! check refuses a Job whose active-process count reaches zero, so the owner side reports a closed report
//! pipe and the role's own log is the only place the reason appears.

use crate::broker_wire::{BrokerPathPlaceholder, BrokerScalarPlaceholder};
use crate::job::JobLimitProfile;
use crate::launch_catalog::{ValidatedStartRequest, scalar_label};
use crate::launch_spec::{CatalogLaunchSpec, RoleStdin, command_line};
use crate::payload_paths::{
    agent_python_directory, github_cli_directory, readers_directory, readers_venv,
    venv_launcher_directory,
};
use crate::role_log::tier_log_directory;
use crate::tier::IsolationTier;
use std::io;
use std::path::{Path, PathBuf};

mod connector;
pub use connector::resolve_connector;
mod egress_proxy;
pub use egress_proxy::resolve_egress_proxy;
mod proxy_environment;
use proxy_environment::local_proxy_environment;
mod hdr;
pub use hdr::resolve_hdr_sidecar;
use hdr::{HDR_RUN_BUDGET_S, binary_flag};
mod opencode_router;
pub use opencode_router::resolve_opencode_router;

mod runtime;
pub use runtime::resolve_runtime;
mod intent_classifier_auth;
use intent_classifier_auth::intent_classifier_auth_environment;
mod runtime_auth;
use runtime_auth::{RuntimeAuthReader, runtime_auth_environment};

/// The only host a loopback placeholder may name.
///
/// The wire check bounds a text scalar's length and nothing else, so without this a bound
/// `loopback_host` would be the one caller-chosen string that reaches a command line. An allowlist is
/// possible here precisely because the placeholder means loopback: the product binds `127.0.0.1`
/// everywhere, and the Connector's own CLI refuses anything else outright.
///
/// `localhost` is excluded because it is a name that needs resolving, and `::1` because the Connector
/// would refuse it - a value only some of the roles could accept is worse than one bound host.
/// Widening this is a contract decision, and the Connector's check is what it has to be argued against.
const LOOPBACK_HOST: &str = "127.0.0.1";

/// `openwork.exe serve`, the process that owns a workspace session.
pub fn resolve_supervisor(
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
) -> io::Result<CatalogLaunchSpec> {
    let payload_root = path(validated, BrokerPathPlaceholder::PayloadRoot)?;
    let workspace_root = path(validated, BrokerPathPlaceholder::WorkspaceRoot)?;
    let config = tier_directory(validated, BrokerPathPlaceholder::StateConfigRoot, tier)?;
    let data = tier_directory(validated, BrokerPathPlaceholder::StateDataRoot, tier)?;
    let temp = tier_directory(validated, BrokerPathPlaceholder::StateTempRoot, tier)?;
    let loopback = loopback_host(validated)?;
    let supervisor_port = port(validated, BrokerScalarPlaceholder::SupervisorPort)?;
    let runtime_port = port(validated, BrokerScalarPlaceholder::RuntimePort)?;
    let router_health_port = port(validated, BrokerScalarPlaceholder::RouterHealthPort)?;
    let host_token = scalar(validated, BrokerScalarPlaceholder::HostToken)?;
    let openwork_token = scalar(validated, BrokerScalarPlaceholder::OpenworkToken)?;
    let hdr_enabled = binary_flag(
        validated,
        BrokerScalarPlaceholder::HdrEnabled,
        "HDR enabled",
    )?;
    let hdr_port = port(validated, BrokerScalarPlaceholder::HdrPort)?;
    let hdr_ready_token = scalar(validated, BrokerScalarPlaceholder::HdrReadyToken)?;
    let llmrouter_port = port(validated, BrokerScalarPlaceholder::LlmrouterPort)?;
    let lrm_api_key = scalar(validated, BrokerScalarPlaceholder::LrmApiKey)?;
    let runtime_deployment_b64 = runtime_deployment_b64(validated)?;
    let runtime_desired_fingerprint = fixed_hex_scalar(
        validated,
        BrokerScalarPlaceholder::RuntimeDesiredFingerprint,
        "runtime desired fingerprint",
        64,
    )?;
    let runtime_instance_id = prefixed_hex_scalar(
        validated,
        BrokerScalarPlaceholder::RuntimeInstanceId,
        "runtime instance id",
        "runtime-instance-",
        32,
    )?;
    let runtime_launch_attempt_id = prefixed_hex_scalar(
        validated,
        BrokerScalarPlaceholder::RuntimeLaunchAttemptId,
        "runtime launch attempt id",
        "runtime-attempt-",
        32,
    )?;

    let executable = payload_root.join("openwork.exe");
    // The descriptor's argument groups, minus `--opencode-bin` and plus `--external-opencode`.
    //
    // `--opencode-bin` would hand a bootstrap-tier process the path it uses to execute the runtime, and
    // the runtime is a file_tool-tier role with its own catalog entry and its own account: a supervisor
    // that launched it itself would put file_tool work inside the bootstrap tier and contradict the
    // isolation baseline.
    //
    // Omitting the flag is not enough on its own, which is why `--external-opencode` is here rather than
    // being left implicit. The supervisor's own bin resolution falls back to a bundled binary, then a
    // downloaded one, then bare `opencode` on `PATH`, so a supervisor given no `--opencode-bin` still
    // spawns the runtime - with the workspace as its working directory, which the bootstrap tier cannot
    // open. The switch is what turns the omission into "connect to the runtime the owner already
    // launched".
    //
    // `--opencode-auth` without `--opencode-password`: a supervisor that no longer spawns the runtime
    // no longer mints its credential either. The owner mints one per role-set start and binds it to
    // every role that calls the runtime, this one included, and `runtime_auth` is where it reaches
    // each role's environment.
    //
    // `--opencode-router-bin` is passed unconditionally rather than only when the file exists, because
    // both hops resolve the same request independently and a filesystem probe would let their two
    // command lines diverge; the descriptor requires the router in any verified payload, so the
    // conditional case is an unverified development tree, which is not what this catalog starts.
    let mut arguments = vec![
        "serve".to_owned(),
        "--workspace".to_owned(),
        text(workspace_root)?,
        "--opencode-directory".to_owned(),
        text(workspace_root)?,
        "--openwork-host".to_owned(),
        loopback.to_owned(),
        "--openwork-port".to_owned(),
        supervisor_port.to_owned(),
        "--opencode-host".to_owned(),
        loopback.to_owned(),
        "--opencode-port".to_owned(),
        runtime_port.to_owned(),
        "--external-opencode".to_owned(),
        "--opencode-auth".to_owned(),
        "--connect-host".to_owned(),
        loopback.to_owned(),
        "--approval".to_owned(),
        "auto".to_owned(),
        "--allow-external".to_owned(),
        "--external-openwork-server".to_owned(),
        "--external-opencode-router".to_owned(),
        // Stated rather than left to the supervisor to choose. An external router is already listening,
        // so the supervisor must be told the port instead of probing for a free one - probing would find
        // this one taken and pick another, then health-check nothing.
        "--opencode-router-health-port".to_owned(),
        router_health_port.to_owned(),
    ];
    if hdr_enabled {
        arguments.extend([
            "--external-hybrid-dr".to_owned(),
            "--hybrid-dr-port".to_owned(),
            hdr_port.to_owned(),
        ]);
    }

    let runtime_generation_root = config.join("runtime-generations");
    let opencode_config = runtime_generation_root
        .join(runtime_instance_id)
        .join("opencode");
    let mut environment = declared(&[
        ("OPENWORK_DEV_MODE", "0".to_owned()),
        ("OPENWORK_ALLOW_EXTERNAL", "1".to_owned()),
        ("OPENWORK_PORT", supervisor_port.to_owned()),
        // The one carrier for the host token: an environment variable on a role the owner launched,
        // never an argument. A command line is readable by anything that can enumerate processes, while
        // a process environment needs `PROCESS_VM_READ` on that process, which under this design means
        // the same account. See `BROKER_OPAQUE_SCALARS` in `shared/contracts` for the redaction
        // obligation that comes with binding one of these.
        ("OPENWORK_HOST_TOKEN", host_token.to_owned()),
        ("OPENWORK_TOKEN", openwork_token.to_owned()),
        (
            "SUPERCLAW_RUNTIME_DEPLOYMENT_B64",
            runtime_deployment_b64.to_owned(),
        ),
        (
            "SC_RUNTIME_DESIRED_FINGERPRINT",
            runtime_desired_fingerprint.to_owned(),
        ),
        ("SC_RUNTIME_INSTANCE_ID", runtime_instance_id.to_owned()),
        (
            "SC_RUNTIME_LAUNCH_ATTEMPT_ID",
            runtime_launch_attempt_id.to_owned(),
        ),
        ("OPENCODE_CONFIG_DIR", text(&opencode_config)?),
        (
            "SC_RUNTIME_GENERATION_ROOT",
            text(&runtime_generation_root)?,
        ),
        ("SC_RUNTIME_CONFIG_DIR", text(&data.join("runtime"))?),
        (
            "SC_PRODUCT_PROFILE_SOURCE_ROOT",
            text(&config.join("product-profiles"))?,
        ),
        ("SC_OPENCODE_DEPS_ROOT", text(&config_source(payload_root))?),
        (
            "OPENWORK_OPENCODE_CONFIG_SOURCE_DIR",
            text(&opencode_config)?,
        ),
        (
            "OPENWORK_DATA_DIR",
            text(&data.join("openwork-orchestrator"))?,
        ),
        // `OPENWORK_TOKEN_STORE` is deliberately not here. Only openwork-server reads it, and
        // openwork-server now runs in file_tool with a config subtree of its own; declaring it here
        // would point the store at the bootstrap tier's config root, where the process that uses it
        // has no access at all. It is declared on `token_service_executable` instead.
        ("LOGDIR", text(&data.join("opencode").join("logs"))?),
        ("OPENCODE_DIRECTORY", text(workspace_root)?),
        ("OPENCODE_DEFAULTS", text(&config_source(payload_root))?),
        // The intent classifier remains Supervisor-owned. HDR does not: in Native managed mode it is
        // an independent broker role, so no HDR executable or interpreter reaches this environment.
        (
            "CLASSIFIER_PYTHON_BIN",
            text(
                &payload_root
                    .join("py")
                    .join("classifier-venv")
                    .join("Scripts")
                    .join("python.exe"),
            )?,
        ),
        (
            "CLASSIFIER_SERVER_SCRIPT",
            text(
                &payload_root
                    .join("intent-classifier")
                    .join("intent_classifier_server.py"),
            )?,
        ),
        // Read by the classifier, which inherits this environment. Opaque scalar, so it carries the
        // redaction obligation in `BROKER_OPAQUE_SCALARS`.
        (
            "LRM_API_BASE_URL",
            format!("http://{loopback}:{llmrouter_port}"),
        ),
        ("LRM_API_KEY", lrm_api_key.to_owned()),
        // The tier's own scratch location. Declared because a cross-account launch carries no
        // `TEMP` at all - the owner's would describe the owner and point somewhere the tier cannot
        // open - and a process with no writable temporary directory fails in ways that read like
        // anything but a missing declaration.
        ("TEMP", text(&temp)?),
        ("TMP", text(&temp)?),
    ]);
    environment.extend(runtime_auth_environment(validated, RuntimeAuthReader::Openwork)?);
    environment.extend(intent_classifier_auth_environment(validated)?);
    if hdr_enabled {
        environment.extend(declared(&[
            ("HYBRID_DR_PORT", hdr_port.to_owned()),
            ("HYBRID_DR_NATIVE_MANAGED", "1".to_owned()),
            ("HYBRID_DR_READY_TOKEN", hdr_ready_token.to_owned()),
        ]));
    }

    Ok(CatalogLaunchSpec {
        command: command_line(&executable, &arguments)?,
        executable,
        // The tier's own scratch subtree, deliberately not the workspace. A working directory is not a
        // path a process may merely name: `CreateProcessW` opens it, so it has to be a directory the
        // launching tier can traverse. The bootstrap tier has no workspace grant at all - every
        // workspace-root policy class in the shipped descriptor is `dacl_protected` and names
        // `sandbox_tier_file_tool` as its only sandbox principal, which expresses
        // "no persistent project access" for this tier as a DACL. A workspace
        // working directory would therefore fail the launch outright rather than isolate anything.
        //
        // The temp subtree is used rather than the payload root because a working directory that some
        // library writes a relative file into should be scratch, and this is the one location the tier
        // both traverses and writes.
        //
        // The supervisor's *project* access is answered rather than deferred, and the answer is that it
        // has none. It still binds `workspace_root`, because it has to be told the path: it passes it to
        // the two file_tool roles that do open the workspace, and derives a per-workspace identifier
        // from it. Naming a path is not opening one, and the owner scaffolds the workspace before any
        // role starts, so nothing in the bootstrap tier needs to create it.
        current_directory: temp,
        job_profile: JobLimitProfile::for_tier(tier),
        environment,
        stdin: RoleStdin::Eof,
        log_directory: log_directory(validated, tier)?,
    })
}

/// `openwork-server.exe`, the process that serves the product API and owns real project content.
///
/// In file_tool rather than bootstrap because that is where the work is: it reads and writes skills, MCP
/// configuration, inbox and outbox and AgentLab state, all of them under the workspace. The role name is
/// the descriptor's historical one; see the vocabulary comment in `shared/contracts`.
///
/// Deliberately absent: `--token` and `--host-token`. openwork-server accepts either an argument or an
/// environment variable for each, and the environment variable is the one used here, because a command
/// line is readable by anything that can enumerate processes.
pub fn resolve_openwork_server(
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
) -> io::Result<CatalogLaunchSpec> {
    let payload_root = path(validated, BrokerPathPlaceholder::PayloadRoot)?;
    let workspace_root = path(validated, BrokerPathPlaceholder::WorkspaceRoot)?;
    let data = tier_directory(validated, BrokerPathPlaceholder::StateDataRoot, tier)?;
    let temp = tier_directory(validated, BrokerPathPlaceholder::StateTempRoot, tier)?;
    let loopback = loopback_host(validated)?;
    let supervisor_port = port(validated, BrokerScalarPlaceholder::SupervisorPort)?;
    let runtime_port = port(validated, BrokerScalarPlaceholder::RuntimePort)?;
    let router_health_port = port(validated, BrokerScalarPlaceholder::RouterHealthPort)?;
    let host_token_sha256 = prefixed_hex_scalar(
        validated,
        BrokerScalarPlaceholder::HostTokenSha256,
        "host token hash",
        "",
        64,
    )?;
    let openwork_token = scalar(validated, BrokerScalarPlaceholder::OpenworkToken)?;
    let router_scoped_token = scalar(validated, BrokerScalarPlaceholder::RouterScopedToken)?;
    let privacy_api_key = scalar(validated, BrokerScalarPlaceholder::PrivacyApiKey)?;
    let hdr_enabled = binary_flag(
        validated,
        BrokerScalarPlaceholder::HdrEnabled,
        "HDR enabled",
    )?;
    let hdr_port = port(validated, BrokerScalarPlaceholder::HdrPort)?;
    let hdr_api_token = scalar(validated, BrokerScalarPlaceholder::HdrApiToken)?;
    let runtime_instance_id = prefixed_hex_scalar(
        validated,
        BrokerScalarPlaceholder::RuntimeInstanceId,
        "runtime instance id",
        "runtime-instance-",
        32,
    )?;
    // The same directory `runtime_executable` is given as OPENCODE_CONFIG_DIR: the published
    // generation, owned by the bootstrap tier and readable by file_tool.
    let opencode_config_source = path(validated, BrokerPathPlaceholder::StateConfigRoot)?
        .join("bootstrap")
        .join("runtime-generations")
        .join(runtime_instance_id)
        .join("opencode");

    let executable = payload_root.join("openwork-server.exe");
    // No `--opencode-username` or `--opencode-password`: the runtime credential this process forwards
    // travels in the environment only, as the two tokens do. See `runtime_auth`.
    //
    // No `--approval-timeout` and no `--read-only`: openwork-server has its own defaults for both, and a
    // catalog that restated them would be a second place for the same value to be wrong.
    let arguments = vec![
        "--host".to_owned(),
        loopback.to_owned(),
        "--port".to_owned(),
        supervisor_port.to_owned(),
        "--workspace".to_owned(),
        text(workspace_root)?,
        "--approval".to_owned(),
        "auto".to_owned(),
        "--cors".to_owned(),
        "*".to_owned(),
        "--opencode-base-url".to_owned(),
        format!("http://{loopback}:{runtime_port}"),
        "--opencode-directory".to_owned(),
        text(workspace_root)?,
        "--log-format".to_owned(),
        "json".to_owned(),
    ];

    let mut environment = declared(&[
        ("OPENWORK_TOKEN", openwork_token.to_owned()),
        // The hash, never the plaintext (#3498): agent shell code runs as this account and can read this
        // environment and the tier runner's memory, and the plaintext approves permission requests and
        // mints owner tokens. The owner hashes it, so the plaintext is never in a file_tool request.
        ("OPENWORK_HOST_TOKEN_HASH", host_token_sha256.to_owned()),
        // This trusted adapter restores protected-file responses for display; keep the credential
        // in the server's environment rather than its command line.
        ("PRIVACY_API_KEY", privacy_api_key.to_owned()),
        // Shuts this process's own direct paths, such as the Gmail sign-in, as it does the runtime's.
        ("SUPERCLAW_CONNECTOR_REQUIRED", "1".to_owned()),
        // Token creation/revocation writes this store. It is tier-local data,
        // not config: the shipped file_tool config policy is deliberately read-only.
        (
            "OPENWORK_TOKEN_STORE",
            text(&data.join("openwork").join("tokens.json"))?,
        ),
        // Where Settings saves the Tavily API key, and the only copy of it: this is the
        // process that serves `PATCH /workspace/:id/runtime-settings`. Undeclared, the
        // cross-account launch left Node on the container default baked into
        // `runtime-settings.ts` - `/data/superclaw/runtime` - which on Windows resolves
        // against the current drive. The key landed in `C:\data\superclaw\runtime`, a path
        // nothing reads, and every web search silently used the DuckDuckGo fallback while
        // Settings still reported the key as configured, because this process round-tripped
        // its own stray file. The host reads it back from the path named here to seal the
        // Connector's provider configuration (`native_backend.py::_start_broker_roles`).
        //
        // Data and not config, for the same reason as the token store above: Settings writes
        // this file, and the shipped file_tool config subtree is read-only.
        (
            "SC_RUNTIME_CONFIG_DIR",
            text(&runtime_settings_directory(&data))?,
        ),
        ("OPENCODE_ROUTER_HEALTH_PORT", router_health_port.to_owned()),
        // The outbox opening: this tier writes a file the agent wants delivered here, and the channel tier
        // (which has no other view of the workspace) reads it.
        (
            "OPENCODE_ROUTER_OUTBOX_DIR",
            text(&path(validated, BrokerPathPlaceholder::StateDataRoot)?.join("channel").join("outbox"))?,
        ),
        // The router's scoped bearer: status reads and the scheduler's notification send. It can write
        // no binding and cannot send to a new conversation unapproved. The control token is not here:
        // this tier runs the agent (EG2-7).
        (
            "OPENCODE_ROUTER_SCOPED_TOKEN",
            router_scoped_token.to_owned(),
        ),
        (
            "OPENWORK_OPENCODE_BASE_URL",
            format!("http://{loopback}:{runtime_port}"),
        ),
        ("OPENWORK_OPENCODE_DIRECTORY", text(workspace_root)?),
        // Where the custom-agent creator's tool and skill catalog is read from (#2985). Read-only,
        // and deliberately not OPENCODE_CONFIG_DIR: the Gmail credential routes write under that
        // variable, and this directory is read-only for the tier.
        (
            "OPENWORK_OPENCODE_CONFIG_SOURCE_DIR",
            text(&opencode_config_source)?,
        ),
        ("TEMP", text(&temp)?),
        ("TMP", text(&temp)?),
        // GitHub sign-in: the payload's gh, by absolute path, so a developer's own GitHub CLI
        // on the inherited PATH cannot stand in for the one the product ships.
        (
            "SUPERCLAW_GH_BIN",
            text(&github_cli_directory(payload_root).join("gh.exe"))?,
        ),
        // Where gh keeps the sign-in, shared with the runtime so the agent's gh acts as the account
        // signed in here, using the same shared credential configuration.
        ("GH_CONFIG_DIR", text(&github_config_directory(&data))?),
        // This process has no profile and runs in the workspace, so gh, finding no home, would write
        // its state (`.local\state\gh`) into the user's workspace. The runtime's directory, as there.
        ("XDG_STATE_HOME", text(&data.join("state"))?),
        // Gmail: Settings' credential upload and authorization run the Profile's Gmail scripts
        // from the published generation, with the payload's agent Python, and write what the agent's
        // tools then read. Same directory and interpreter as `runtime::runtime_launch`.
        (
            "GMAIL_TOOLS_DIR",
            text(&opencode_config_source.join("tools").join("gmail"))?,
        ),
        (
            "GMAIL_PYTHON",
            text(&agent_python_directory(payload_root).join("python.exe"))?,
        ),
        ("GMAIL_DATA_DIR", text(&gmail_data_directory(&data))?),
        // The scripts' output is read back as UTF-8; without this it is the ANSI code page.
        ("PYTHONUTF8", "1".to_owned()),
        // This process's own port, which the Gmail OAuth callback is built on; undeclared it is
        // assumed to be 8787 whatever `sandbox_port` the host configured.
        ("OPENWORK_HOST_PORT", supervisor_port.to_owned()),
    ]);
    environment.extend(runtime_auth_environment(validated, RuntimeAuthReader::Openwork)?);
    environment.extend(intent_classifier_auth_environment(validated)?);
    // As the runtime has it: GitHub login, the skill hub and the Telegram token check reach the network
    // only through the egress proxy's shell port.
    environment.extend(local_proxy_environment(validated)?);
    if hdr_enabled {
        environment.extend(declared(&[
            ("HYBRID_DR_PORT", hdr_port.to_owned()),
            ("HYBRID_DR_NATIVE_MANAGED", "1".to_owned()),
            ("HYBRID_DR_API_TOKEN", hdr_api_token.to_owned()),
            (
                "HYBRID_DR_PROGRESS_ROOT",
                text(&data.join("hybrid-dr").join("progress"))?,
            ),
        ]));
    }
    Ok(CatalogLaunchSpec {
        command: command_line(&executable, &arguments)?,
        executable,
        // The workspace, which this tier is the one tier allowed to open.
        current_directory: workspace_root.to_owned(),
        job_profile: JobLimitProfile::for_tier(tier),
        environment,
        stdin: RoleStdin::Eof,
        log_directory: log_directory(validated, tier)?,
    })
}

/// The packaged configuration tree inside a payload, which is where the projected agent
/// configuration and the Connector's search provider module are staged.
///
/// One function rather than the literal twice, because the supervisor's `OPENCODE_DEFAULTS` and the
/// Connector's `search_module` have to name the same tree - `native_backend.py::resolve_config_source`
/// is the product-side definition both follow.
fn config_source(payload_root: &Path) -> PathBuf {
    payload_root.join("config-source")
}

/// The pinned portable shell inside a payload.
fn shell_directory(payload_root: &Path) -> PathBuf {
    payload_root.join("shell")
}

/// `<root>\<tier>`: the per-tier subtree the shipped ACL policy provisions under a subdivided root.
fn tier_directory(
    validated: &ValidatedStartRequest,
    placeholder: BrokerPathPlaceholder,
    tier: IsolationTier,
) -> io::Result<PathBuf> {
    Ok(path(validated, placeholder)?.join(tier.as_str()))
}

/// gh's store (`GH_CONFIG_DIR`) inside the file_tool data subtree, whose shipped DACL admits the
/// owner, SYSTEM, Administrators and file_tool. One function, so openwork-server and the runtime name
/// the same store.
fn github_config_directory(file_tool_data: &Path) -> PathBuf {
    file_tool_data.join("gh")
}

/// Where Settings saves `superclaw-runtime-config.json` (`SC_RUNTIME_CONFIG_DIR`), shared by
/// openwork-server and the runtime's tools for the reason `github_config_directory` gives.
fn runtime_settings_directory(file_tool_data: &Path) -> PathBuf {
    file_tool_data.join("superclaw").join("runtime")
}

/// The Gmail tools' credentials, token and mail cache (`GMAIL_DATA_DIR`), shared by openwork-server's
/// Settings routes and the runtime's tools for the reason `github_config_directory` gives (EG1-8).
fn gmail_data_directory(file_tool_data: &Path) -> PathBuf {
    file_tool_data.join("gmail")
}

/// The tier's log directory, derived from the validated log root and the runner's tier.
///
/// Only the directory: the file name is the launch's own random pipe identifier, which resolution does
/// not see. `role_log` re-canonicalizes the root, so a spelling that walked out of the state tree is
/// refused a second time here even though the wire already refused it once.
pub fn log_directory(
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
) -> io::Result<PathBuf> {
    tier_log_directory(
        path_text(validated, BrokerPathPlaceholder::StateLogsRoot)?,
        tier,
    )
}

/// The declared environment overlay, as owned pairs.
fn declared(pairs: &[(&str, String)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect()
}

fn path_text(
    validated: &ValidatedStartRequest,
    placeholder: BrokerPathPlaceholder,
) -> io::Result<&str> {
    validated
        .paths
        .get(&placeholder)
        .map(String::as_str)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "the catalog entry for this role requires {} to be bound",
                    crate::launch_catalog::placeholder_label(&placeholder)
                ),
            )
        })
}

fn path(
    validated: &ValidatedStartRequest,
    placeholder: BrokerPathPlaceholder,
) -> io::Result<&Path> {
    path_text(validated, placeholder).map(Path::new)
}

/// A bound loopback host, checked against the one value it may be.
fn loopback_host(validated: &ValidatedStartRequest) -> io::Result<&str> {
    let bound = scalar(validated, BrokerScalarPlaceholder::LoopbackHost)?;
    if bound != LOOPBACK_HOST {
        // The bound value is deliberately not quoted back. It is caller-controlled text, and a refusal
        // is written into a report frame.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a bound loopback host must be exactly {LOOPBACK_HOST}"),
        ));
    }
    Ok(bound)
}

fn runtime_deployment_b64(validated: &ValidatedStartRequest) -> io::Result<&str> {
    let value = scalar(validated, BrokerScalarPlaceholder::RuntimeDeploymentB64)?;
    if value.len() > 16 * 1024
        || value.len() % 4 != 0
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime deployment carrier is not bounded standard base64",
        ));
    }
    Ok(value)
}

fn fixed_hex_scalar<'a>(
    validated: &'a ValidatedStartRequest,
    placeholder: BrokerScalarPlaceholder,
    label: &str,
    hex_chars: usize,
) -> io::Result<&'a str> {
    let value = scalar(validated, placeholder)?;
    if value.len() != hex_chars
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} has the wrong closed shape"),
        ));
    }
    Ok(value)
}

fn prefixed_hex_scalar<'a>(
    validated: &'a ValidatedStartRequest,
    placeholder: BrokerScalarPlaceholder,
    label: &str,
    prefix: &str,
    hex_chars: usize,
) -> io::Result<&'a str> {
    let value = scalar(validated, placeholder)?;
    let Some(suffix) = value.strip_prefix(prefix) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} has the wrong closed shape"),
        ));
    };
    if suffix.len() != hex_chars
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{label} has the wrong closed shape"),
        ));
    }
    Ok(value)
}

/// A bound port, re-checked as decimal digits before it becomes an argument.
///
/// The wire already validated the range, so this is defence in depth rather than the primary control:
/// it makes "no argument this module produces contains anything but digits and catalog literals" a
/// property provable from this file alone.
fn port(
    validated: &ValidatedStartRequest,
    placeholder: BrokerScalarPlaceholder,
) -> io::Result<&str> {
    let bound = scalar(validated, placeholder)?;
    if bound.is_empty() || !bound.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "a bound {} must be decimal digits",
                scalar_label(&placeholder)
            ),
        ));
    }
    Ok(bound)
}

fn scalar(
    validated: &ValidatedStartRequest,
    placeholder: BrokerScalarPlaceholder,
) -> io::Result<&str> {
    validated
        .scalars
        .get(&placeholder)
        .map(String::as_str)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "the catalog entry for this role requires {} to be bound",
                    scalar_label(&placeholder)
                ),
            )
        })
}

/// A path as text, refusing a non-Unicode one rather than losing bytes to a lossy conversion.
fn text(path: &Path) -> io::Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "a bound root must be a Unicode path",
        )
    })
}

#[cfg(test)]
mod supervisor_lrm_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod hdr_tests;
