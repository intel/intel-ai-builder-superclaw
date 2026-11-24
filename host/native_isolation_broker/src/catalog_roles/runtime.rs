//! The file-tool runtime's launch: `opencode.exe serve`.
//!
//! Split out of `mod.rs` for the same reason `connector.rs` is, and for one more. The mechanical
//! reason is the crate's line limit. The substantive one is that this is the only role whose
//! environment is also an *agent-facing* interface: the model reads a shell, an interpreter and a
//! `PATH` out of it, so a change here changes what the agent can run, which is a different review
//! than changing what a service process can reach.

use super::*;
use crate::payload_paths::{node_directory, uv_directory};

/// `opencode.exe serve`, the file-tool runtime.
///
/// The machine `PATH` is the one input this role reads from the host rather than from its bindings.
/// Both hops read the same registry value, and only the runner's resolution is launched.
pub fn resolve_runtime(
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
) -> io::Result<CatalogLaunchSpec> {
    runtime_launch(validated, tier, &crate::machine_path::machine_path()?)
}

pub(super) fn runtime_launch(
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
    machine_path: &str,
) -> io::Result<CatalogLaunchSpec> {
    let payload_root = path(validated, BrokerPathPlaceholder::PayloadRoot)?;
    let workspace_root = path(validated, BrokerPathPlaceholder::WorkspaceRoot)?;
    let config_root = path(validated, BrokerPathPlaceholder::StateConfigRoot)?;
    let config = tier_directory(validated, BrokerPathPlaceholder::StateConfigRoot, tier)?;
    let data = tier_directory(validated, BrokerPathPlaceholder::StateDataRoot, tier)?;
    let temp = tier_directory(validated, BrokerPathPlaceholder::StateTempRoot, tier)?;
    let loopback = loopback_host(validated)?;
    let runtime_port = port(validated, BrokerScalarPlaceholder::RuntimePort)?;
    let runtime_instance_id = prefixed_hex_scalar(
        validated,
        BrokerScalarPlaceholder::RuntimeInstanceId,
        "runtime instance id",
        "runtime-instance-",
        32,
    )?;
    let llmrouter_port = port(validated, BrokerScalarPlaceholder::LlmrouterPort)?;
    let lrm_api_key = scalar(validated, BrokerScalarPlaceholder::LrmApiKey)?;
    let privacy_api_key = scalar(validated, BrokerScalarPlaceholder::PrivacyApiKey)?;
    let hdr_enabled = binary_flag(
        validated,
        BrokerScalarPlaceholder::HdrEnabled,
        "HDR enabled",
    )?;
    let hdr_port = port(validated, BrokerScalarPlaceholder::HdrPort)?;
    let hdr_api_token = scalar(validated, BrokerScalarPlaceholder::HdrApiToken)?;
    let router_health_port = port(validated, BrokerScalarPlaceholder::RouterHealthPort)?;
    let router_scoped_token = scalar(validated, BrokerScalarPlaceholder::RouterScopedToken)?;

    let executable = payload_root.join("opencode.exe");
    // `--print-logs` because without it this role fails silently. opencode writes its own log under
    // the home directory it resolves for itself, which under a tier account is a path the tier cannot
    // open, so everything it reports about a failed startup - a config it could not read, a fetch that
    // timed out - lands nowhere. The flag routes that log to stderr instead, and stderr is what
    // `log_directory` already captures. It is the only way this role's startup failures are legible.
    let arguments = vec![
        "serve".to_owned(),
        "--hostname".to_owned(),
        loopback.to_owned(),
        "--port".to_owned(),
        runtime_port.to_owned(),
        "--cors".to_owned(),
        "*".to_owned(),
        "--print-logs".to_owned(),
    ];

    let opencode_config = config_root
        .join("bootstrap")
        .join("runtime-generations")
        .join(runtime_instance_id)
        .join("opencode");
    // Everything opencode resolves relative to a home directory has to be named here, under the
    // tier's own data subtree. Undeclared, opencode does not fail to find a home - it resolves the
    // owner's, because Windows answers `SHGetKnownFolderPath` whether or not the caller can open the
    // result. The role then reads and writes a profile the tier has no rights to, and reports it as
    // an install error rather than an access one.
    let home = data.join("home");
    let home_text = text(&home)?;
    // `HOMEDRIVE` and `HOMEPATH` are the pair Windows tools read in preference to `USERPROFILE`.
    // Split from the one home value rather than declared separately, so the two cannot disagree.
    let split_at = home_text.find('\\').ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "home root is not an absolute Windows path",
        )
    })?;
    let (home_drive, home_tail) = home_text.split_at(split_at);
    let cache = data.join("cache");
    let mut environment = declared(&[
        // The runtime reads this tree and never writes it: the shipped policy gives the file_tool
        // tier read-and-traverse on its config subtree and nothing more. Whatever puts a projected
        // configuration there runs as the owner, and that projection is P7's.
        ("OPENCODE_CONFIG_DIR", text(&opencode_config)?),
        // Where Settings saved the user's choices, not the read-only Profile tree above.
        (
            "SC_RUNTIME_CONFIG_DIR",
            text(&runtime_settings_directory(&data))?,
        ),
        ("LOGDIR", text(&data.join("opencode").join("logs"))?),
        ("OPENCODE_DIRECTORY", text(workspace_root)?),
        ("TEMP", text(&temp)?),
        ("TMP", text(&temp)?),
        ("TMPDIR", text(&temp)?),
        ("HOME", home_text.clone()),
        ("USERPROFILE", home_text.clone()),
        ("HOMEDRIVE", home_drive.to_owned()),
        ("HOMEPATH", home_tail.to_owned()),
        ("APPDATA", text(&home.join("AppData").join("Roaming"))?),
        ("LOCALAPPDATA", text(&home.join("AppData").join("Local"))?),
        // opencode resolves its own config, data, state and cache through XDG before falling back
        // to the home directory, on Windows too. The cache is the load-bearing one: it is where the
        // pre-seeded npm plugin tree lives, and a role that cannot find it installs the plugin from
        // the registry during init instead - which is a network call this tier must not need.
        ("XDG_CONFIG_HOME", text(&data.join("config"))?),
        ("XDG_DATA_HOME", text(&data)?),
        ("XDG_STATE_HOME", text(&data.join("state"))?),
        ("XDG_CACHE_HOME", text(&cache)?),
        // npm honours an inherited NPM_CONFIG_CACHE ahead of LOCALAPPDATA. Pinned so opencode's
        // embedded package resolution cannot reach into the owner's profile.
        ("NPM_CONFIG_CACHE", text(&cache.join("npm"))?),
        // Fetches opencode makes on its own, none of which this role depends on: the self-update
        // check, the models.dev catalogue (the bundled snapshot answers instead) and language-server
        // downloads.
        ("OPENCODE_DISABLE_AUTOUPDATE", "1".to_owned()),
        ("OPENCODE_DISABLE_MODELS_FETCH", "1".to_owned()),
        ("OPENCODE_DISABLE_LSP_DOWNLOAD", "1".to_owned()),
        ("UV_TOOL_DIR", text(&home.join(".local").join("tools"))?),
        ("UV_TOOL_BIN_DIR", text(&user_local_bin(&home))?),
        ("UV_CACHE_DIR", text(&home.join(".local").join("cache").join("uv"))?),
        ("UV_PYTHON", text(&payload_root.join("py").join("runtime").join("python.exe"))?),
        ("UV_PYTHON_DOWNLOADS", "never".to_owned()),
        // The runtime's and its shell's default. A catalog `uvx` MCP server overrides it in its own
        // entry environment, and only there, to resolve its pinned package.
        ("UV_OFFLINE", "1".to_owned()),
        ("UV_NO_CONFIG", "1".to_owned()),
        ("UV_NO_BUILD", "1".to_owned()),
        ("VIRTUAL_ENV", text(&task_python_directory(&home))?),
        // Where the model lives. Every Product Profile writes the provider as
        // `{env:LRM_API_BASE_URL}/v1`, and a cross-account launch carries only what is declared here,
        // so undeclared this does not fall back to a default: it expands to nothing, the provider is
        // left holding the relative path `/v1/chat/completions`, and every model call fails to parse
        // it as a URL. Measured on this branch as the reason a sent message never reaches a model.
        //
        // Only the two variables the tier actually reads are declared. `LRM_EMBEDDING_API_BASE` and
        // `LRM_EMBEDDING_MODEL` are read by LLMRouter Manager itself, which is a host service and not
        // a role; `LLMROUTER_PORT` is read by the orchestrator, which resolves its own default;
        // `LRM_CLOUD_MODEL` and `LRM_AUTO_MODEL` have no reader at all. Declaring an unread variable
        // states a dependency the role does not have.
        (
            "LRM_API_BASE_URL",
            format!("http://{loopback}:{llmrouter_port}"),
        ),
        // The Manager's inference credential: it refuses every `/v1/*` call without it. Bound as an
        // opaque scalar, so it carries the redaction obligation in `BROKER_OPAQUE_SCALARS`. The cloud
        // provider credentials still stay in LLMRouter Manager.
        ("LRM_API_KEY", lrm_api_key.to_owned()),
        ("SUPERCLAW_STEP_BUDGET", STEP_BUDGET.to_owned()),
        ("SUPERCLAW_STEP_STATUS", STEP_STATUS.to_owned()),
        ("SUPERCLAW_LINEAGE_BUDGET", LINEAGE_BUDGET.to_owned()),
        // The authenticated Privacy Manager data plane used by protected-file tools.
        ("PRIVACY_API_KEY", privacy_api_key.to_owned()),
        // The packaged interpreter, named absolutely. The payload ships a pinned CPython and four
        // locked virtual environments, and the shipped ACL policy gives every tier read-and-execute on
        // the payload root, so this tier could always run them - it just had no way to find them. The
        // two names are the ones the Product Profiles' own tools read: `OPENCODE_PYTHON` for the agent
        // environment (web search, the maths and plotting helpers) and `READERS_VENV` for the document
        // and OCR readers, which append `Scripts\python.exe` to it themselves. Undeclared, those tools
        // fall through to a bare `python3` on the inherited owner `PATH`, which on a clean machine is
        // nothing and on a developer's is a path under the owner's profile this account cannot open.
        (
            "OPENCODE_PYTHON",
            text(&agent_python_directory(payload_root).join("python.exe"))?,
        ),
        ("READERS_VENV", text(&readers_venv(payload_root))?),
        // The scripts that interpreter runs. Undeclared, `parse_pdf` falls back to the container's
        // `/opt/readers/extract_text.py`, which does not exist on this host.
        ("READERS_DIR", text(&readers_directory(payload_root))?),
        // Tools read Python's piped stdout as UTF-8; without this it is the ANSI code page (cp1252).
        ("PYTHONUTF8", "1".to_owned()),
        // The pinned shell, which is what the agent's own shell tool runs. The runtime starts it as a
        // child of its own rather than through a catalog role, so naming it here is the only place the
        // pinned-shell guarantee the runtime descriptor declares (`guard: "native_pinned_shell"`)
        // becomes a fact instead of a claim: undeclared, the runtime falls back to whatever `sh` the
        // inherited `PATH` offers, which is typically a Git-Bash that cannot start under a constrained
        // token at all.
        (
            "SHELL",
            text(&shell_directory(payload_root).join("sh.exe"))?,
        ),
        // Declaring `PATH` replaces the owner's inherited value rather than extending it. Payload
        // directories first, so a same-named machine tool cannot shadow them - which includes the
        // pinned `node`, `npx`, `uv` and `uvx` that catalog stdio MCP servers start through, and
        // `venv_launcher_directory`: python/pip shims built into the read-only payload (see
        // `shell-shims/venv-launcher`), ahead of the packaged `agent_python_directory` interpreter so
        // a bare `pip install` resolves the tier's own writable task venv through `VIRTUAL_ENV`
        // instead of the immutable payload (#3876). The tier can read and run these shims but never
        // write to them - unlike an earlier version of this fix, which copied the same three
        // executables into a tier-writable directory and relied on nothing *else* writing there
        // (#3897 review: that convention was not an enforced boundary). Then the machine `PATH`,
        // where the agent finds `git` and the system commands; then the writable directories last -
        // the task venv's full `Scripts` (where a later `pip install` can still drop an arbitrary
        // console script) and `.local\bin` - because the agent's shell resolves by `PATH` order
        // alone, and a file file_tool drops into either one must not be able to shadow `git`,
        // `where` or any other system command for a later chat.
        ("PATH", runtime_path(payload_root, machine_path, &home)?),
        // The agent's gh uses the store openwork-server's GitHub sign-in writes (EG1-11).
        ("GH_CONFIG_DIR", text(&github_config_directory(&data))?),
        // The Gmail tools (EG1-8) run their scripts with this interpreter, which carries the Google
        // client libraries, instead of `uv run`, and keep the token where Settings put it.
        (
            "GMAIL_PYTHON",
            text(&agent_python_directory(payload_root).join("python.exe"))?,
        ),
        ("GMAIL_DATA_DIR", text(&gmail_data_directory(&data))?),
        // The managed `opencode_router_send` and `opencode_router_status` tools call the router from
        // here with the scoped token: replies and sends to bound conversations go out, anything else
        // waits for an approval in the desktop app, and nothing here can write a binding (EG2-7).
        ("OPENCODE_ROUTER_HEALTH_PORT", router_health_port.to_owned()),
        (
            "OPENCODE_ROUTER_SCOPED_TOKEN",
            router_scoped_token.to_owned(),
        ),
        // openwork-server's port: the Gmail tools' OAuth callback and the LLM logger plugin go to it.
        (
            "OPENWORK_HOST_PORT",
            port(validated, BrokerScalarPlaceholder::SupervisorPort)?.to_owned(),
        ),
    ]);
    environment.extend(crate::catalog_runtime::connector_reader_environment(
        payload_root,
        &config,
    )?);
    // Not in the shared reader set: HDR reads the Connector configuration too, but never this.
    environment.extend(declared(&[(
        "SUPERCLAW_CONNECTOR_REQUIRED",
        "1".to_owned(),
    )]));
    environment.extend(local_proxy_environment(validated)?);
    // The HTTP Basic credential this server checks, and the one its plugin client presents.
    environment.extend(runtime_auth_environment(validated, RuntimeAuthReader::OpencodeServer)?);
    if hdr_enabled {
        environment.extend(declared(&[
            ("HYBRID_DR_PORT", hdr_port.to_owned()),
            ("HYBRID_DR_NATIVE_MANAGED", "1".to_owned()),
            ("HYBRID_DR_API_TOKEN", hdr_api_token.to_owned()),
            ("HYBRID_DR_RUN_BUDGET_S", HDR_RUN_BUDGET_S.to_owned()),
            (
                "HYBRID_DR_PROGRESS_ROOT",
                text(&data.join("hybrid-dr").join("progress"))?,
            ),
        ]));
    }
    Ok(CatalogLaunchSpec {
        command: command_line(&executable, &arguments)?,
        executable,
        current_directory: workspace_root.to_owned(),
        job_profile: JobLimitProfile::for_tier(tier),
        environment,
        stdin: RoleStdin::Eof,
        log_directory: log_directory(validated, tier)?,
    })
}

/// The one writable directory on the runtime's `PATH`: where a toolchain the payload does not ship
/// can be installed.
///
/// Inside the tier's own home rather than the workspace, so a project the user opens does not carry
/// executables the agent put there, and `.local\bin` rather than a name of this product's invention,
/// because it is the convention a model already knows.
fn user_local_bin(home: &Path) -> PathBuf {
    home.join(".local").join("bin")
}

/// The writable venv `pip install` targets, prepared by Sandbox Manager before the runtime starts.
fn task_python_directory(home: &Path) -> PathBuf {
    home.join(".local").join("python")
}

/// The payload directories, the usable machine `PATH` entries, then the writable directories.
///
/// A machine entry is kept only if it is an absolute path with no unexpanded `%` reference. An
/// empty or relative entry resolves against the working directory, which for this role is the
/// user's workspace.
///
/// The task venv's full `Scripts` directory is writable the same way `.local\bin` is - a later
/// `pip install` can drop an arbitrary console script into it - so it belongs beside `.local\bin`
/// at the end, never ahead of the machine `PATH`: a dropped file there must not be able to shadow
/// `git`, `where` or any other system command for a later chat (#3897). `venv_launcher_directory`
/// is different: it is read-only payload, like `shell_directory`/`node_directory`/`uv_directory`,
/// so it is grouped with them instead, ahead of `agent_python_directory` - the read-only packaged
/// interpreter `pip install` could never write through - so a bare `python`/`pip` resolves to the
/// tier's own writable venv rather than silently falling back to the payload one (#3876).
fn runtime_path(payload_root: &Path, machine_path: &str, home: &Path) -> io::Result<String> {
    let machine = machine_path
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.contains('%') && Path::new(entry).is_absolute())
        .map(str::to_owned);
    let entries: Vec<String> = [
        text(&shell_directory(payload_root))?,
        text(&node_directory(payload_root))?,
        text(&uv_directory(payload_root))?,
        text(&github_cli_directory(payload_root))?,
        text(&venv_launcher_directory(payload_root))?,
        text(&agent_python_directory(payload_root))?,
    ]
    .into_iter()
    .chain(machine)
    .chain([
        text(&task_python_directory(home).join("Scripts"))?,
        text(&user_local_bin(home))?,
    ])
    .collect();
    Ok(entries.join(";"))
}

const STEP_BUDGET: &str = "100";
// Plugin 91's per-step status line; `late` is the plugin's own default and the way to switch it back.
const STEP_STATUS: &str = "every";
const LINEAGE_BUDGET: &str = "250";
