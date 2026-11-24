use super::*;

/// `opencode-router.exe serve`, the Slack and Telegram bridge, in the channel tier.
///
/// It holds the channel tokens, so it runs in a tier whose data no other tier can read, and it never
/// opens the workspace. What used to make it a file_tool process was three workspace openings: its
/// working directory, a media directory under the workspace, and an agent file read out of it. Each
/// is replaced by a path inside the channel tier's own directories - the working directory is its data
/// directory, the media directory is the inbox, the agent file is the host's copy in its read-only
/// config - plus an outbox it reads. The workspace is bound as text only, because the router names it
/// to the runtime as the OpenCode directory.
pub fn resolve_opencode_router(
    validated: &ValidatedStartRequest,
    tier: IsolationTier,
) -> io::Result<CatalogLaunchSpec> {
    let payload_root = path(validated, BrokerPathPlaceholder::PayloadRoot)?;
    let workspace_root = path(validated, BrokerPathPlaceholder::WorkspaceRoot)?;
    let config = tier_directory(validated, BrokerPathPlaceholder::StateConfigRoot, tier)?;
    let data = tier_directory(validated, BrokerPathPlaceholder::StateDataRoot, tier)?;
    let temp = tier_directory(validated, BrokerPathPlaceholder::StateTempRoot, tier)?;
    let loopback = loopback_host(validated)?;
    let runtime_port = port(validated, BrokerScalarPlaceholder::RuntimePort)?;
    let router_health_port = port(validated, BrokerScalarPlaceholder::RouterHealthPort)?;
    let router_control_token = scalar(validated, BrokerScalarPlaceholder::RouterControlToken)?;
    let router_scoped_token = scalar(validated, BrokerScalarPlaceholder::RouterScopedToken)?;

    let executable = payload_root.join("opencode-router.exe");
    // `--opencode-url` is passed unconditionally. The supervisor feature-detects it by running the
    // binary with `--help`, which a catalog cannot do and should not want to: both hops resolve the same
    // request independently, and a probe would let their two command lines diverge. It is also not a bet
    // here - the router in a verified payload is built from this repository, where `serve` declares the
    // option.
    let arguments = vec![
        "serve".to_owned(),
        text(workspace_root)?,
        "--opencode-url".to_owned(),
        format!("http://{loopback}:{runtime_port}"),
    ];

    Ok(CatalogLaunchSpec {
        command: command_line(&executable, &arguments)?,
        executable,
        // The tier's own data directory. The channel tier has no ACE on the workspace, so it could not
        // start there, and nothing it does depends on where it starts.
        current_directory: data.clone(),
        job_profile: JobLimitProfile::for_tier(tier),
        environment: declared(&[
            ("OPENCODE_URL", format!("http://{loopback}:{runtime_port}")),
            ("OPENCODE_DIRECTORY", text(workspace_root)?),
            ("OPENCODE_ROUTER_HEALTH_PORT", router_health_port.to_owned()),
            // Required: the router refuses to start its health server without it. The admin bearer:
            // only the Sandbox Manager holds a copy.
            (
                "OPENCODE_ROUTER_CONTROL_TOKEN",
                router_control_token.to_owned(),
            ),
            // The file_tool tier's bearer, which the router accepts for status reads and sends only.
            (
                "OPENCODE_ROUTER_SCOPED_TOKEN",
                router_scoped_token.to_owned(),
            ),
            (
                "OPENCODE_ROUTER_DATA_DIR",
                text(&data.join("opencode-router"))?,
            ),
            // The three openings. The inbox is written by this tier and read by file_tool; the outbox is
            // written by file_tool and read by this tier; the agent definition is copied by the host into
            // this tier's read-only config. The ACL policy declares each directory's DACL.
            ("OPENCODE_ROUTER_MEDIA_DIR", text(&data.join("inbox"))?),
            ("OPENCODE_ROUTER_OUTBOX_DIR", text(&data.join("outbox"))?),
            (
                "OPENCODE_ROUTER_AGENT_FILE",
                text(&config.join("agents").join("superclaw-router.md"))?,
            ),
            // `INTENT_CLASSIFIER_URL` is deliberately unset, and that one costs something: the
            // classifier sidecar is still a bootstrap-tier child of the supervisor, and the supervisor no
            // longer builds this process's environment, so on a Profile that runs the sidecar the bridge
            // will not classify threads. Setting it here unconditionally would be worse - on the
            // Profiles that run no sidecar, the bridge would spend its classifier timeout on the first
            // message of every thread calling a port nothing listens on, which is the exact bug
            // `opencode-router-env.ts` documents. It also is not a port the channel tier may reach.
            ("TEMP", text(&temp)?),
            ("TMP", text(&temp)?),
        ])
        .into_iter()
        .chain(runtime_auth_environment(validated, RuntimeAuthReader::OpencodeServer)?)
        .chain(intent_classifier_auth_environment(validated)?)
        // Slack and Telegram are reached from this tier, through the egress proxy's channel port. The
        // bypass list keeps the runtime and health ports off the proxy.
        .chain(super::local_proxy_environment(validated)?)
        .collect(),
        stdin: RoleStdin::Eof,
        log_directory: log_directory(validated, tier)?,
    })
}
