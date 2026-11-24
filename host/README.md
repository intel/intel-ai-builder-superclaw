# `host/` — Windows host control plane

The Windows-host services that supervise local models, data protection, speech,
host MCP, and the native sandbox. ServiceHub is the supervisor; every other
Python service is one of its children.

| Folder | Role |
|---|---|
| [`servicehub/`](servicehub/README.md) | Process supervisor and control-plane proxy. Spawns and health-gates the children and proxies `/llm-router/*`, `/sandbox-manager/*`, etc. by first path segment. |
| [`llmrouter_manager/`](llmrouter_manager/README.md) | LLM routing: local GGUF (llama.cpp), cloud (LiteLLM), edge, PII-aware routing. |
| [`sandbox_manager/`](sandbox_manager/README.md) | Native sandbox lifecycle: payload staging, tier-account provisioning, role start, readiness, OpenWork token. |
| [`privacy_manager/`](privacy_manager/README.md) | PII file and text protection and the LLM file pipeline (two members: `llm_pipeline`, `data_protection`). |
| [`tts_manager/`](tts_manager/README.md), [`asr_manager/`](asr_manager/README.md) | Local narration and speech-to-text. On-demand children. |
| [`mcp_host_manager/`](mcp_host_manager/README.md) | Host MCP gateway: MCP servers the user chose to run outside the sandbox, and the visible host browser. On-demand child. |
| [`observability/`](observability/README.md) | Crash-record builder shared by the host services. |
| [`sandbox_policy/`](sandbox_policy/README.md) | Isolation policy rules (plans and verdicts only; applies nothing). |
| `superclaw_services/` | The merged PyInstaller entry point, `superclaw-services.exe`, that runs ServiceHub and every child as `--service <role>`. |
| [`native_isolation_broker/`](native_isolation_broker/README.md) | Rust crate: the elevated on-demand broker (tier identities, ACLs) and the unelevated role launcher. Not a uv workspace member. |

To add a shipped host service, follow [`servicehub/ADDING_A_SERVICE.md`](servicehub/ADDING_A_SERVICE.md).

## uv workspace

`host/pyproject.toml` is a virtual [uv workspace](https://docs.astral.sh/uv/concepts/projects/workspaces/)
root. Its members are `servicehub`, `llmrouter_manager`, `sandbox_manager`, `sandbox_policy`,
`privacy_manager/llm_pipeline`, `privacy_manager/data_protection`, `tts_manager`, `asr_manager`,
`mcp_host_manager`, `observability` and the generated contracts package
(`../shared/contracts/generated/python`). They resolve into **one shared `host/.venv`**.

The shared environment is required, not cosmetic. In source mode ServiceHub spawns each child as
`sys.executable -m <entrypoint>` (`servicehub/src/servicehub/supervisor/process_manager.py`), so
every child must import from ServiceHub's own interpreter. In packaged builds the same
`service_cfg.json` entries use `launch.kind = "role"`: ServiceHub and every child ship as one
PyInstaller bundle (`servicehub\superclaw-services.exe`), and a child is that exe re-executed with
`--service <name>` (dispatch in `superclaw_services/_pyinstaller_entry.py`).

```powershell
cd host
uv sync --all-packages            # dev
uv sync --locked --all-packages   # reproducible build
```

- `host/uv.lock` is the only lock for the members, including commands run from a member folder;
  `uv` discovers the parent workspace. Do not use `--no-workspace`: workspace sources and the root
  constraints are required.
- Resolver settings (`constraint-dependencies`, `override-dependencies`, the CPU-only torch index)
  live in the root `pyproject.toml`; member `[tool.uv]` tables are ignored for locking.

## Run ServiceHub and its children

```powershell
cd host
./servicehub/scripts/start_servicehub.ps1 -Port 19000 -HubToken devtoken
```

The script runs `uv sync --all-packages --frozen` (`-SkipSync` skips it), refuses to start if the
hub port is already held (defaults: `-Port 18880 -HubToken dev-token`), starts ServiceHub, and waits
for `SERVICEHUB_READY`. It keeps running until `Ctrl+C`, which asks the hub for a graceful shutdown;
`-Detach` returns instead. Logs and a ready file go to `servicehub/.smoke-logs/`.

ServiceHub spawns the required children in `depends_on` order — `llmrouter_manager` (:18321), then
`privacy_manager` (:18826), then `sandbox_manager` (:18821) — polls each one's
`/<proxy_prefix>/v1/health`, and prints `SERVICEHUB_READY {"port","token"}` only after every
required child is ready. On-demand children (`tts_manager`, `asr_manager`, `mcp_host_manager`) stay
dormant until their first authenticated business request.

ServiceHub is single-instance. A second launch while one is running prints `REUSE {...}` and exits;
the desktop shell reconnects to the existing hub, while `start_servicehub.ps1` reports the conflict
and fails.

Equivalent manual invocation:

```powershell
cd host
.venv/Scripts/python.exe -u -m servicehub --port 19000 --hub-token devtoken
```

ServiceHub finds `service_cfg.json` next to its package by default (`--service-cfg` overrides it).

Do not start the children yourself. To debug one standalone, stop the hub first (the ports are
fixed), then run each from the repository root in its own shell:

```powershell
# Sandbox Manager: cleanup mutations need this value in X-SuperClaw-Process-Credential.
$env:SERVICEHUB_PROCESS_CREDENTIAL = "<random value>"
cd host/sandbox_manager
uv run python -m sandbox_manager --host 127.0.0.1 --port 18821   # add --reload to restart on edits
```

```powershell
# LLM Router: standalone mode refuses to start without LRM_API_KEY (the inference bearer key).
$env:LRM_API_KEY = "<random value>"
cd host/llmrouter_manager
uv run python -m llmrouter_manager --host 127.0.0.1 --port 18321
```

### Verify (another shell)

```powershell
# Child health through the hub proxy (unauthenticated)
curl http://127.0.0.1:19000/llm-router/v1/health
curl http://127.0.0.1:19000/sandbox-manager/v1/health

# Hub aggregate status (bearer required)
curl http://127.0.0.1:19000/app/system/preflight -H "Authorization: Bearer devtoken"
curl http://127.0.0.1:19000/app/services/status  -H "Authorization: Bearer devtoken"
```

A health response whose `instance_id` is a UUID rather than `dev-instance` confirms that the hub
spawned the child.

### Stop

```powershell
curl -X POST http://127.0.0.1:19000/app/system/shutdown -H "Authorization: Bearer devtoken"
```

The hub shuts down every child gracefully, then exits.

## `service_cfg.json`

[`servicehub/service_cfg.json`](servicehub/service_cfg.json) declares every hub-managed service.
Invalid configuration prevents bring-up.

| Service | Proxy prefix | Port | Startup | Depends on |
|---|---|---|---|---|
| `llmrouter_manager` | `/llm-router` | 18321 | required | — |
| `privacy_manager` | `/data-protection` | 18826 | required | `llmrouter_manager` |
| `sandbox_manager` | `/sandbox-manager` | 18821 | required | `llmrouter_manager`, `privacy_manager` |
| `tts_manager` | `/tts-narration` | 18827 | on demand | — |
| `asr_manager` | `/speech-to-text` | 18829 | on demand | `llmrouter_manager` |
| `mcp_host_manager` | `/mcp-host` | 18831 | on demand | — |

## Troubleshooting

`<service> exited before health readiness` almost always means the child's fixed port is held by a
stale process (an earlier child, or a standalone `python -m <entrypoint>`). `start_servicehub.ps1`
checks only the hub port. To free the child ports:

```powershell
foreach ($port in 18321, 18826, 18821, 18827, 18829, 18831) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -Expand OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force }
}
```
