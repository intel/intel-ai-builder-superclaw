//! Resolution tests for the production roles: what each role is launched with, asserted exactly.
//!
//! Split out of `mod.rs` rather than kept beside the resolvers because the two grow for different
//! reasons - a role added to the catalog adds one resolver and several cases - and the crate holds every
//! file under a line limit. `use super::*` keeps the cases reading as though they were still inline.

use super::*;
use crate::launch_catalog::{catalog_entry_for_role, validate_start_request_bytes};
use serde_json::Value;
use std::path::PathBuf;

/// The shared cross-language positive cases, which is where the bindings in these tests come from.
///
/// Resolution is exercised through the real wire validation rather than a hand-built
/// `ValidatedStartRequest`, so every assertion below is also a statement that the request a caller
/// would actually send is accepted: a role whose resolution needs a binding its catalog entry does
/// not declare fails here rather than in production.
pub(super) fn validated(role: &str) -> ValidatedStartRequest {
    let cases: Value = serde_json::from_slice(
        &std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("shared")
                .join("contracts")
                .join("test-fixtures")
                .join("native-isolation-broker-cases.json"),
        )
        .expect("the shared case table should be readable"),
    )
    .expect("the shared case table should be JSON");
    let request = cases["valid_starts"]
        .as_array()
        .expect("valid_starts array")
        .iter()
        .find(|positive| positive["launch_role"] == role)
        .unwrap_or_else(|| panic!("the shared table has no accepted request for {role}"))
        .get("request")
        .expect("a case carries a request")
        .clone();
    validate_start_request_bytes(&serde_json::to_vec(&request).expect("serialize"))
        .unwrap_or_else(|refusal| panic!("the shared {role} request is accepted: {refusal:?}"))
}

pub(super) const PAYLOAD: &str = r"C:\Users\tester\SuperClaw\payload";
pub(super) const WORKSPACE: &str = r"C:\Users\tester\Projects\demo";
pub(super) const CONFIG: &str = r"C:\ProgramData\SuperClaw\state\config";
pub(super) const DATA: &str = r"C:\ProgramData\SuperClaw\state\data";
pub(super) const TEMP: &str = r"C:\ProgramData\SuperClaw\state\temp";
pub(super) const LOGS: &str = r"C:\ProgramData\SuperClaw\state\logs";
pub(super) const HOST_TOKEN: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OPENWORK_TOKEN: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const ROUTER_CONTROL_TOKEN: &str =
    "0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978";
pub(super) const ROUTER_SCOPED_TOKEN: &str =
    "5a4b3c2d1e0f9a8b5a4b3c2d1e0f9a8b5a4b3c2d1e0f9a8b5a4b3c2d1e0f9a8b";
pub(super) const LRM_API_KEY: &str =
    "lrmkey0123456789lrmkey0123456789lrmkey0123456789lrmkey0123456789";
pub(super) const PRIVACY_API_KEY: &str =
    "privacykey0123456789privacykey0123456789privacykey0123456789privacykey0123456789";
pub(super) const HDR_READY_TOKEN: &str = "ready_0123456789abcdef0123456789abcdef";
pub(super) const RUNTIME_PASSWORD: &str =
    "rtpw_0123456789-abcdefghij_0123456789-ABCDEFGHIJ_0123456789-wxyz";

pub(super) fn value<'a>(spec: &'a CatalogLaunchSpec, name: &str) -> &'a str {
    spec.environment
        .iter()
        .find(|(candidate, _)| candidate == name)
        .map(|(_, value)| value.as_str())
        .unwrap_or_else(|| panic!("{name} is not declared: {:?}", spec.environment))
}

#[test]
fn hdr_rejects_equal_tokens_before_launch() {
    let mut request = validated("hdr_sidecar");
    request.scalars.insert(
        BrokerScalarPlaceholder::HdrReadyToken,
        HOST_TOKEN.to_owned(),
    );
    let error = resolve_hdr_sidecar(&request, IsolationTier::FileTool)
        .expect_err("distinct credentials required");
    assert!(!error.to_string().contains(HOST_TOKEN));
}

fn with_hdr_disabled(mut request: ValidatedStartRequest) -> ValidatedStartRequest {
    request
        .scalars
        .insert(BrokerScalarPlaceholder::HdrEnabled, "0".to_owned());
    request
}

#[test]
fn disabled_hdr_reaches_neither_supervisor_nor_file_tool_clients() {
    let supervisor = with_hdr_disabled(validated("supervisor_executable"));
    let runtime = with_hdr_disabled(validated("runtime_executable"));
    let specs = [
        resolve_supervisor(&supervisor, IsolationTier::Bootstrap)
            .expect("disabled supervisor resolves"),
        resolve_runtime(&runtime, IsolationTier::FileTool).expect("disabled runtime resolves"),
        resolve_openwork_server(
            &with_hdr_disabled(validated("token_service_executable")),
            IsolationTier::FileTool,
        )
        .expect("disabled server resolves"),
    ];
    for spec in specs {
        assert!(!spec.command.contains("--external-hybrid-dr"));
        for name in [
            "HYBRID_DR_PORT",
            "HYBRID_DR_NATIVE_MANAGED",
            "HYBRID_DR_API_TOKEN",
            "HYBRID_DR_READY_TOKEN",
            "HYBRID_DR_PROGRESS_ROOT",
        ] {
            assert!(
                spec.environment
                    .iter()
                    .all(|(candidate, _)| candidate != name)
            );
        }
    }
}

/// The supervisor's whole launch, asserted as exact values.
///
/// The command line is compared as one string rather than argument by argument, because that string
/// is what `CreateProcessW` parses: an argument that needed quoting and did not get it, or a
/// separator that went missing, is only visible in the assembled form.
#[test]
fn the_supervisor_launch_is_fixed_by_its_role() {
    let spec = resolve_supervisor(
        &validated("supervisor_executable"),
        IsolationTier::Bootstrap,
    )
    .expect("the shared supervisor request resolves");

    assert_eq!(spec.executable, PathBuf::from(PAYLOAD).join("openwork.exe"));
    // Unquoted because none of these fixture paths contains a space; `launch_spec` owns the quoting
    // rule and proves it on a path that does.
    assert_eq!(
        spec.command,
        format!(
            r"{PAYLOAD}\openwork.exe serve --workspace {WORKSPACE} --opencode-directory {WORKSPACE} --openwork-host 127.0.0.1 --openwork-port 47821 --opencode-host 127.0.0.1 --opencode-port 47822 --external-opencode --opencode-auth --connect-host 127.0.0.1 --approval auto --allow-external --external-openwork-server --external-opencode-router --opencode-router-health-port 47824 --external-hybrid-dr --hybrid-dr-port 47825"
        )
    );
    // Not the workspace: `CreateProcessW` opens the working directory, and the bootstrap tier holds
    // no right on a workspace root under any policy class, so naming it here would fail the launch.
    assert_eq!(
        spec.current_directory,
        PathBuf::from(TEMP).join("bootstrap"),
        "the working directory must be a location this tier can actually open"
    );
    assert_eq!(
        spec.log_directory,
        PathBuf::from(LOGS).join("bootstrap"),
        "the log directory is the tier's own subtree, and only the directory"
    );
    assert_eq!(spec.stdin, RoleStdin::Eof, "this role reads nothing");
    assert_eq!(spec.job_profile, JobLimitProfile::BootstrapTier);

    assert_eq!(value(&spec, "OPENWORK_PORT"), "47821");
    assert_eq!(
        value(&spec, "OPENCODE_CONFIG_DIR"),
        format!(
            r"{CONFIG}\bootstrap\runtime-generations\runtime-instance-0123456789abcdef0123456789abcdef\opencode"
        )
    );
    assert_eq!(
        value(&spec, "SC_RUNTIME_CONFIG_DIR"),
        format!(r"{DATA}\bootstrap\runtime")
    );
    // Moved to `token_service_executable`, which is the only process that reads it and the only one with
    // access to the subtree it now names. Asserted as absent rather than simply dropped, because a store
    // path pointing at a tier that cannot open it is a launch that fails for a reason nothing states.
    assert!(
        spec.environment
            .iter()
            .all(|(name, _)| name != "OPENWORK_TOKEN_STORE")
    );
    assert_eq!(
        value(&spec, "OPENWORK_DATA_DIR"),
        format!(r"{DATA}\bootstrap\openwork-orchestrator")
    );
    assert_eq!(
        value(&spec, "LOGDIR"),
        format!(r"{DATA}\bootstrap\opencode\logs")
    );
    assert_eq!(value(&spec, "OPENCODE_DIRECTORY"), WORKSPACE);
    assert_eq!(
        value(&spec, "OPENCODE_DEFAULTS"),
        format!(r"{PAYLOAD}\config-source")
    );
    assert!(
        spec.environment
            .iter()
            .all(|(name, _)| name != "HYBRID_DR_PYTHON_BIN")
    );
    assert_eq!(
        value(&spec, "CLASSIFIER_PYTHON_BIN"),
        format!(r"{PAYLOAD}\py\classifier-venv\Scripts\python.exe")
    );
    assert_eq!(
        value(&spec, "CLASSIFIER_SERVER_SCRIPT"),
        format!(r"{PAYLOAD}\intent-classifier\intent_classifier_server.py")
    );
    assert_eq!(value(&spec, "TEMP"), format!(r"{TEMP}\bootstrap"));
    assert_eq!(value(&spec, "TMP"), format!(r"{TEMP}\bootstrap"));

    // The bootstrap tier must not be handed the path it would use to execute the file-tool member.
    // `--opencode-bin` is the one spelling that does that, and `--external-opencode` is what makes its
    // absence effective rather than merely stated, so the pair is asserted together: a supervisor with
    // neither flag resolves a runtime binary of its own and spawns it.
    assert!(!spec.command.contains("--opencode-bin"));
    assert!(spec.command.contains("--external-opencode"));

    // The host token reaches the role as one declared environment variable and appears nowhere on the
    // command line. This is the assertion that keeps the carrier from drifting to an argument, which is
    // where a secret becomes readable by anything that can enumerate processes.
    assert_eq!(value(&spec, "OPENWORK_HOST_TOKEN"), HOST_TOKEN);
    assert!(!spec.command.contains(HOST_TOKEN));
    assert_eq!(value(&spec, "HYBRID_DR_PORT"), "47825");
    assert_eq!(value(&spec, "HYBRID_DR_NATIVE_MANAGED"), "1");
    assert_eq!(value(&spec, "HYBRID_DR_READY_TOKEN"), HDR_READY_TOKEN);
    assert!(
        spec.environment
            .iter()
            .all(|(name, _)| name != "HYBRID_DR_API_TOKEN")
    );
    assert!(!spec.command.contains(HDR_READY_TOKEN));
}

/// openwork-server's whole launch, asserted as exact values.
///
/// The two things this case exists for beyond the command line: the workspace really is its working
/// directory, which is the whole reason it moved tiers, and both tokens arrive as environment variables
/// rather than as the `--token` / `--host-token` arguments the binary would equally accept.
#[test]
fn the_openwork_server_launch_is_fixed_by_its_role() {
    let spec = resolve_openwork_server(
        &validated("token_service_executable"),
        IsolationTier::FileTool,
    )
    .expect("the shared openwork-server request resolves");

    assert_eq!(
        spec.executable,
        PathBuf::from(PAYLOAD).join("openwork-server.exe")
    );
    assert_eq!(
        spec.command,
        format!(
            r"{PAYLOAD}\openwork-server.exe --host 127.0.0.1 --port 47821 --workspace {WORKSPACE} --approval auto --cors * --opencode-base-url http://127.0.0.1:47822 --opencode-directory {WORKSPACE} --log-format json"
        )
    );
    // The workspace, which is the point of this role being in file_tool: it is the one tier the shipped
    // policy lets open a workspace root, and this process reads and writes project content.
    assert_eq!(spec.current_directory, PathBuf::from(WORKSPACE));
    assert_eq!(spec.log_directory, PathBuf::from(LOGS).join("file_tool"));
    assert_eq!(spec.stdin, RoleStdin::Eof, "this role reads nothing");
    assert_eq!(spec.job_profile, JobLimitProfile::FileToolTier);

    // Creation and revocation require mutable data, not the read-only config subtree.
    assert_eq!(
        value(&spec, "OPENWORK_TOKEN_STORE"),
        format!(r"{DATA}\file_tool\openwork\tokens.json")
    );
    // The router's data directory is not named here any more: it is the channel tier's, and this process
    // reads and writes none of it. Channel settings go through the host, and what this process still
    // shows of the router comes from the router's own endpoints.
    assert!(
        spec.environment
            .iter()
            .all(|(name, _)| name != "OPENCODE_ROUTER_DATA_DIR"),
        "openwork-server must not be pointed at the router's data"
    );
    // The Tavily API key's only home, and writable for the same reason the token store is. The
    // value is asserted here and read back at the identical path by
    // `native_backend.py::_start_broker_roles`; the two must agree or a saved key reaches nothing.
    // Undeclared, Node falls back to `/data/superclaw/runtime` and the key lands on the current
    // drive's root instead.
    assert_eq!(
        value(&spec, "SC_RUNTIME_CONFIG_DIR"),
        format!(r"{DATA}\file_tool\superclaw\runtime")
    );
    assert_eq!(value(&spec, "OPENCODE_ROUTER_HEALTH_PORT"), "47824");
    // Where openwork-server copies a file the agent wants delivered; the channel tier reads it from there.
    assert_eq!(
        value(&spec, "OPENCODE_ROUTER_OUTBOX_DIR"),
        format!(r"{DATA}\channel\outbox")
    );
    assert_eq!(
        value(&spec, "OPENWORK_OPENCODE_BASE_URL"),
        "http://127.0.0.1:47822"
    );
    assert_eq!(value(&spec, "OPENWORK_OPENCODE_DIRECTORY"), WORKSPACE);
    // The published generation's opencode directory - the one `runtime_executable` is given as
    // OPENCODE_CONFIG_DIR - is where the custom-agent creator's tool and skill catalog comes from.
    // Undeclared, the catalog is empty and the Agents tab offers no capabilities (#2985).
    assert_eq!(
        value(&spec, "OPENWORK_OPENCODE_CONFIG_SOURCE_DIR"),
        format!(
            r"{CONFIG}\bootstrap\runtime-generations\runtime-instance-0123456789abcdef0123456789abcdef\opencode"
        )
    );
    // Deliberately not OPENCODE_CONFIG_DIR: openwork-server's Gmail credential routes write under that
    // variable, and the generation directory is read-only for this tier.
    assert!(
        spec.environment
            .iter()
            .all(|(name, _)| name != "OPENCODE_CONFIG_DIR")
    );
    assert_eq!(value(&spec, "TEMP"), format!(r"{TEMP}\file_tool"));
    assert_eq!(value(&spec, "TMP"), format!(r"{TEMP}\file_tool"));

    // Both tokens by environment and neither on the command line, which is what makes them unreadable
    // to anything that can only enumerate processes.
    assert_eq!(value(&spec, "OPENWORK_TOKEN"), OPENWORK_TOKEN);
    // Only the host token's hash; see `no_file_tool_role_holds_the_plaintext_host_token`.
    assert_eq!(
        value(&spec, "OPENWORK_HOST_TOKEN_HASH"),
        "a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e"
    );
    assert_eq!(value(&spec, "PRIVACY_API_KEY"), PRIVACY_API_KEY);
    // The router's SCOPED token, the one the router itself is launched with for the file_tool tier. The
    // control token, which writes bindings and identities, is never given to this process (EG2-7).
    assert_eq!(
        value(&spec, "OPENCODE_ROUTER_SCOPED_TOKEN"),
        ROUTER_SCOPED_TOKEN
    );
    assert!(
        spec.environment
            .iter()
            .all(|(name, _)| name != "OPENCODE_ROUTER_CONTROL_TOKEN"),
        "openwork-server must not hold the router's admin token"
    );
    assert!(!spec.command.contains(OPENWORK_TOKEN));
    assert!(!spec.command.contains(HOST_TOKEN));
    assert!(!spec.command.contains(PRIVACY_API_KEY));
    assert!(!spec.command.contains(ROUTER_SCOPED_TOKEN));
    assert!(!spec.command.contains("--token"));
    assert!(!spec.command.contains("--host-token"));

    // The runtime credential it forwards travels by environment only: no auth flag carries it, and
    // the value appears nowhere on the command line.
    assert_eq!(value(&spec, "OPENWORK_OPENCODE_PASSWORD"), RUNTIME_PASSWORD);
    assert!(!spec.command.contains(RUNTIME_PASSWORD));
    assert!(!spec.command.contains("--opencode-username"));
    assert!(!spec.command.contains("--opencode-password"));
}

/// The reader tools need the interpreter and the scripts it runs, both inside the payload. Without the
/// scripts `parse_pdf` falls back to the container's `/opt/readers` and fails on every PDF.
#[test]
fn the_runtime_names_the_packaged_readers_interpreter_and_scripts() {
    let spec = resolve_runtime(&validated("runtime_executable"), IsolationTier::FileTool).unwrap();
    assert_eq!(
        value(&spec, "READERS_VENV"),
        format!(r"{PAYLOAD}\py\readers-venv")
    );
    assert_eq!(value(&spec, "READERS_DIR"), format!(r"{PAYLOAD}\readers"));
    assert_eq!(value(&spec, "PYTHONUTF8"), "1");
}

#[test]
fn hdr_clients_share_only_research_auth_and_writable_progress_root() {
    let server = resolve_openwork_server(
        &validated("token_service_executable"),
        IsolationTier::FileTool,
    )
    .unwrap();
    let runtime =
        resolve_runtime(&validated("runtime_executable"), IsolationTier::FileTool).unwrap();
    for spec in [server, runtime] {
        assert_eq!(
            value(&spec, "HYBRID_DR_PROGRESS_ROOT"),
            format!(r"{DATA}\file_tool\hybrid-dr\progress")
        );
        assert_eq!(value(&spec, "HYBRID_DR_API_TOKEN"), HOST_TOKEN);
        assert_eq!(value(&spec, "HYBRID_DR_PORT"), "47825");
        assert_eq!(value(&spec, "HYBRID_DR_NATIVE_MANAGED"), "1");
        assert!(!spec.command.contains(HOST_TOKEN));
        assert!(
            spec.environment
                .iter()
                .all(|(name, _)| name != "HYBRID_DR_READY_TOKEN")
        );
    }
}

/// opencode-router's whole launch, asserted as exact values.
///
/// The router runs in the channel tier. It holds the Slack and Telegram tokens, so nothing about its
/// launch may name a path another tier can read: its working directory is its own data directory, and
/// the workspace reaches it as a string only.
#[test]
fn the_opencode_router_launch_is_fixed_by_its_role() {
    let spec = resolve_opencode_router(&validated("connector_executable"), IsolationTier::Channel)
        .expect("the shared opencode-router request resolves");

    assert_eq!(
        spec.executable,
        PathBuf::from(PAYLOAD).join("opencode-router.exe")
    );
    assert_eq!(
        spec.command,
        format!(
            r"{PAYLOAD}\opencode-router.exe serve {WORKSPACE} --opencode-url http://127.0.0.1:47822"
        )
    );
    assert_eq!(
        spec.current_directory,
        PathBuf::from(DATA).join("channel"),
        "the channel tier has no ACE on the workspace, so it cannot start there"
    );
    assert_eq!(spec.log_directory, PathBuf::from(LOGS).join("channel"));
    assert_eq!(spec.stdin, RoleStdin::Eof, "this role reads nothing");
    assert_eq!(spec.job_profile, JobLimitProfile::ChannelTier);

    assert_eq!(value(&spec, "OPENCODE_URL"), "http://127.0.0.1:47822");
    assert_eq!(value(&spec, "OPENCODE_DIRECTORY"), WORKSPACE);
    assert_eq!(value(&spec, "OPENCODE_ROUTER_HEALTH_PORT"), "47824");
    // Without it the router refuses to start its health server and exits before reporting started.
    assert_eq!(
        value(&spec, "OPENCODE_ROUTER_CONTROL_TOKEN"),
        ROUTER_CONTROL_TOKEN
    );
    assert!(!spec.command.contains(ROUTER_CONTROL_TOKEN));
    // The second bearer, for the file_tool tier; the router tells the two apart.
    assert_eq!(
        value(&spec, "OPENCODE_ROUTER_SCOPED_TOKEN"),
        ROUTER_SCOPED_TOKEN
    );
    assert!(!spec.command.contains(ROUTER_SCOPED_TOKEN));
    // Its own data directory: the tokens' home, which no other tier can read.
    assert_eq!(
        value(&spec, "OPENCODE_ROUTER_DATA_DIR"),
        format!(r"{DATA}\channel\opencode-router")
    );
    // The three openings. The inbox is where it writes what a chat sends, the outbox is where it reads
    // what the agent hands back, and the agent definition is the host's copy in its read-only config.
    assert_eq!(
        value(&spec, "OPENCODE_ROUTER_MEDIA_DIR"),
        format!(r"{DATA}\channel\inbox")
    );
    assert_eq!(
        value(&spec, "OPENCODE_ROUTER_OUTBOX_DIR"),
        format!(r"{DATA}\channel\outbox")
    );
    assert_eq!(
        value(&spec, "OPENCODE_ROUTER_AGENT_FILE"),
        format!(r"{CONFIG}\channel\agents\superclaw-router.md")
    );
    assert_eq!(value(&spec, "TEMP"), format!(r"{TEMP}\channel"));
    assert_eq!(value(&spec, "TMP"), format!(r"{TEMP}\channel"));

    // Left unset on purpose: the classifier endpoint, because advertising a port nothing listens on
    // costs the bridge its timeout on the first message of every thread. Stated in the resolver.
    assert!(
        spec.environment
            .iter()
            .all(|(bound, _)| bound != "INTENT_CLASSIFIER_URL"),
        "INTENT_CLASSIFIER_URL must stay undeclared"
    );

    // No path of the workspace is named as a place to open: the only occurrences are the positional
    // workspace argument and the OpenCode directory, both of which the router sends to the runtime.
    for (name, bound) in &spec.environment {
        if name != "OPENCODE_DIRECTORY" {
            assert!(!bound.contains(WORKSPACE), "{name} names the workspace");
        }
    }

    // No token of any kind: the router's health endpoint is unauthenticated, and its channel secrets come
    // from its own configuration file rather than from whoever launched it.
    for token in [HOST_TOKEN, OPENWORK_TOKEN] {
        assert!(!spec.command.contains(token));
        assert!(spec.environment.iter().all(|(_, value)| value != token));
    }
}

#[test]
fn the_connector_launch_is_fixed_by_its_role() {
    let spec = resolve_connector(
        &validated("connector_service"),
        IsolationTier::NetworkConnector,
    )
    .expect("the shared connector request resolves");

    assert_eq!(
        spec.executable,
        PathBuf::from(PAYLOAD)
            .join("py")
            .join("agent-python-venv")
            .join("Scripts")
            .join("python.exe")
    );
    assert_eq!(
        spec.command,
        format!(
            r"{PAYLOAD}\py\agent-python-venv\Scripts\python.exe -m sandbox_manager.connector --host 127.0.0.1 --port 47823 --runtime-config-file {CONFIG}\network_connector\superclaw\connector-provider.json"
        )
    );
    assert_eq!(
        spec.current_directory,
        PathBuf::from(PAYLOAD).join("connector-service"),
        "the working directory is what puts the package on sys.path under -m"
    );
    assert_eq!(
        spec.log_directory,
        PathBuf::from(LOGS).join("network_connector")
    );
    assert_eq!(spec.job_profile, JobLimitProfile::ConnectorTier);
    assert_eq!(value(&spec, "PYTHONDONTWRITEBYTECODE"), "1");
    assert_eq!(value(&spec, "TEMP"), format!(r"{TEMP}\network_connector"));
    assert!(
        spec.environment
            .iter()
            .all(|(name, _)| name != "PYTHONPATH" && name != "SC_RUNTIME_CONFIG_FILE"),
        "the working directory and the Connector's own CLI cover both: {:?}",
        spec.environment
    );

    // Resolution names the bootstrap and does not build one, so no key material exists at this point
    // in either hop. The module it names is the one inside the packaged config tree, which is what
    // `connector_bootstrap` will put in the line the runner writes.
    assert_eq!(
        spec.stdin,
        RoleStdin::ConnectorBootstrap {
            search_module: PathBuf::from(DATA)
                .join("network_connector")
                .join("superclaw")
                .join("sc_tavily_search.py"),
            endpoint: "http://127.0.0.1:47823/v1/connector".to_owned(),
        }
    );
    // And the line itself, generated the way the runner generates it, names that same module and
    // reaches neither the command line nor a variable.
    let payload = crate::connector_bootstrap::connector_bootstrap_line(match &spec.stdin {
        RoleStdin::ConnectorBootstrap { search_module, .. } => search_module,
        other => panic!("the Connector's stdin is a bootstrap, not {other:?}"),
    })
    .expect("a bootstrap line");
    let line = std::str::from_utf8(payload.as_slice()).expect("the line is UTF-8");
    assert!(line.ends_with('\n'));
    assert!(
        line.contains(r"data\\network_connector\\superclaw\\sc_tavily_search.py"),
        "{line}"
    );
    assert!(
        !spec.command.contains("boot-") && !spec.command.contains("caller_"),
        "no bootstrap material may reach the command line: {}",
        spec.command
    );
    for (name, value) in &spec.environment {
        assert!(
            !value.contains("boot-") && !value.contains("caller_"),
            "no bootstrap material may reach {name}"
        );
    }
}

/// Every scalar a role declares is consumed by its resolution.
///
/// A declared scalar that reaches nothing is a value a caller must bind for no reason, and the
/// review question it raises - is this fed to the role or not? - has to be answerable from the
/// catalog. Path placeholders are deliberately exempt: `launcher::drift` reads the DACL of every
/// bound root before the launch, so binding a root has a purpose whether or not an argument names
/// it.
#[test]
fn every_declared_scalar_reaches_the_assembled_launch() {
    for (role, tier, resolve) in production_roles() {
        let request = validated(role);
        let spec = resolve(&request, tier).expect("the shared request resolves");
        let assembled = format!(
            "{} {} {}",
            spec.command,
            spec.current_directory.display(),
            spec.environment
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let entry = catalog_entry_for_role(role).expect("a shipped entry");
        assert!(
            !entry.scalar_placeholders.is_empty(),
            "{role} declares no scalar, so this case proves nothing"
        );
        for placeholder in &entry.scalar_placeholders {
            let bound = request.scalars.get(placeholder).expect("bound by the case");
            assert!(
                assembled.contains(bound.as_str()),
                "{role} declares {} and consumes it nowhere",
                scalar_label(placeholder)
            );
        }
    }
}

/// No file_tool role is given the plaintext host token (#3498).
///
/// Agent shell code, as file_tool, can read a role's environment and the tier runner's memory, which
/// holds the whole start request. The plaintext is in neither; openwork-server checks it by its hash.
#[test]
fn no_file_tool_role_holds_the_plaintext_host_token() {
    let file_tool_roles: Vec<_> = production_roles()
        .into_iter()
        .filter(|(_, tier, _)| *tier == IsolationTier::FileTool)
        .collect();
    assert!(!file_tool_roles.is_empty());
    for (role, tier, resolve) in file_tool_roles {
        let request = validated(role);
        assert!(
            !request
                .scalars
                .contains_key(&BrokerScalarPlaceholder::HostToken),
            "{role} runs as file_tool and its start request binds the plaintext host token"
        );
        let spec = resolve(&request, tier).expect("the shared request resolves");
        assert!(
            spec.environment
                .iter()
                .all(|(name, _)| name != "OPENWORK_HOST_TOKEN"),
            "{role} runs as file_tool and is given the plaintext host token"
        );
        assert!(!spec.command.contains("--host-token"), "{role}");
    }
}

#[test]
fn openwork_server_refuses_a_host_token_hash_of_the_wrong_shape() {
    for bad in [
        "A8AE6E6EE929ABEA3AFCFC5258C8CCD6F85273E0D4626D26C7279F3250F77C8E",
        "a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8",
        "zzae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e",
    ] {
        let mut request = validated("token_service_executable");
        request
            .scalars
            .insert(BrokerScalarPlaceholder::HostTokenSha256, bad.to_owned());
        let error = resolve_openwork_server(&request, IsolationTier::FileTool)
            .expect_err("a hash that is not 64 lowercase hex characters is refused");
        assert!(!error.to_string().contains(bad), "{error}");
    }
}

/// Every role's working directory is a location its own tier can open.
///
/// This is not a style rule. `CreateProcessW` opens `lpCurrentDirectory` as part of creating the
/// process, so a working directory the launching tier holds no traverse right on fails the launch
/// itself - not the first file operation, the launch. The shipped ACL descriptor gives a tier exactly
/// three kinds of directory it can open: the payload root, which every sandbox principal reads and
/// traverses; its own `<state_root>\<tier>` subtree under a subdivided managed root; and, for the
/// file-tool tier alone, a workspace root. Anything else is a role that cannot start.
#[test]
fn every_working_directory_is_one_its_own_tier_can_open() {
    for (role, tier, resolve) in production_roles() {
        let spec = resolve(&validated(role), tier).expect("the shared request resolves");
        let directory = &spec.current_directory;
        let own_state_subtree = [CONFIG, DATA, TEMP, LOGS]
            .into_iter()
            .any(|root| directory.starts_with(PathBuf::from(root).join(tier.as_str())));
        let openable = directory.starts_with(PAYLOAD)
            || own_state_subtree
            || (tier == IsolationTier::FileTool && directory.starts_with(WORKSPACE));
        assert!(
            openable,
            "{role} runs in {} as {}, which the shipped policy gives that tier no right to open",
            directory.display(),
            tier.as_str()
        );
    }
}

/// A loopback host that is not the loopback address is refused before it can become an argument,
/// for every role that binds one.
#[test]
fn a_bound_host_that_is_not_loopback_is_refused() {
    for (role, tier, resolve) in production_roles() {
        for rejected in [
            "localhost",
            "0.0.0.0",
            "::1",
            "127.0.0.2",
            "127.0.0.1 --allow-external",
            r#"127.0.0.1" --allow-external ""#,
            "",
        ] {
            let mut request = validated(role);
            request
                .scalars
                .insert(BrokerScalarPlaceholder::LoopbackHost, rejected.to_owned());
            let refusal =
                resolve(&request, tier).expect_err("only the loopback address may be bound");
            assert_eq!(
                refusal.kind(),
                io::ErrorKind::InvalidData,
                "{role} {rejected:?}"
            );
            assert!(
                !refusal.to_string().contains("allow-external"),
                "a refusal must not echo caller text: {refusal}"
            );
        }
    }
}

/// A bound root that resolution needs and the request does not carry is a refusal, not a path with
/// a hole in it. This cannot happen through the wire - the catalog declares the placeholder, so
/// validation requires it - which is exactly why it is asserted here rather than assumed.
#[test]
fn a_missing_binding_is_refused_rather_than_composed_around() {
    let mut request = validated("supervisor_executable");
    request.paths.remove(&BrokerPathPlaceholder::StateTempRoot);
    let refusal = resolve_supervisor(&request, IsolationTier::Bootstrap)
        .expect_err("a missing root is a refusal");
    assert_eq!(refusal.kind(), io::ErrorKind::InvalidData);
    assert!(refusal.to_string().contains("state_temp_root"), "{refusal}");

    let mut request = validated("connector_service");
    request
        .scalars
        .remove(&BrokerScalarPlaceholder::ConnectorPort);
    let refusal = resolve_connector(&request, IsolationTier::NetworkConnector)
        .expect_err("a missing port is a refusal");
    assert!(refusal.to_string().contains("connector_port"), "{refusal}");
}

type Resolver = fn(&ValidatedStartRequest, IsolationTier) -> io::Result<CatalogLaunchSpec>;

/// The router's admin token reaches the router and no other role: the roles that run the agent hold
/// only the scoped one, and a role that holds neither is given neither (EG2-7).
#[test]
fn only_the_router_holds_the_admin_token() {
    for (role, tier, resolve) in production_roles() {
        let spec = resolve(&validated(role), tier).expect("every shipped role resolves");
        let holds = |name: &str| spec.environment.iter().any(|(candidate, _)| candidate == name);
        assert_eq!(
            holds("OPENCODE_ROUTER_CONTROL_TOKEN"),
            role == "connector_executable",
            "{role}"
        );
        assert!(!spec.command.contains(ROUTER_CONTROL_TOKEN), "{role}");
        assert!(!spec.command.contains(ROUTER_SCOPED_TOKEN), "{role}");
        let scoped = ["token_service_executable", "connector_executable", "runtime_executable"];
        assert_eq!(holds("OPENCODE_ROUTER_SCOPED_TOKEN"), scoped.contains(&role), "{role}");
        if holds("OPENCODE_ROUTER_SCOPED_TOKEN") && role != "connector_executable" {
            assert_eq!(value(&spec, "OPENCODE_ROUTER_HEALTH_PORT"), "47824", "{role}");
        }
    }
}

/// Every production role with the tier the catalog gives each one, so a property asserted
/// "for every role" really is.
fn production_roles() -> Vec<(&'static str, IsolationTier, Resolver)> {
    vec![
        (
            "supervisor_executable",
            IsolationTier::Bootstrap,
            resolve_supervisor as Resolver,
        ),
        (
            "token_service_executable",
            IsolationTier::FileTool,
            resolve_openwork_server as Resolver,
        ),
        (
            "connector_executable",
            IsolationTier::Channel,
            resolve_opencode_router as Resolver,
        ),
        (
            "runtime_executable",
            IsolationTier::FileTool,
            resolve_runtime as Resolver,
        ),
        (
            "connector_service",
            IsolationTier::NetworkConnector,
            resolve_connector as Resolver,
        ),
        (
            "egress_proxy",
            IsolationTier::NetworkConnector,
            resolve_egress_proxy as Resolver,
        ),
        (
            "hdr_sidecar",
            IsolationTier::FileTool,
            resolve_hdr_sidecar as Resolver,
        ),
    ]
}

mod intent_classifier_auth_tests;
mod runtime_auth_tests;
mod egress_proxy_tests;
mod runtime_tests;
