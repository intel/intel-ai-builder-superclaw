# SuperClaw LLM Router Manager (LRM)

The Windows-host service that owns every model call SuperClaw makes. It routes chat requests
between a local `llama-server` (GGUF), a cloud provider (via LiteLLM) and a user-deployed
OpenAI-compatible edge endpoint; owns the trusted Model Bundle registry and the committed primary
Bundle; and supervises the local `llama-server` lifecycle (hardware eligibility, download, verify,
spawn, probe).

- **Port:** `18321` (control and data plane). ServiceHub child `llmrouter_manager`, proxy prefix
  `/llm-router`, required at boot.
- **Contracts:** ModelRouter (`/v1/*` OpenAI-compatible data plane), the ServiceHub child lifecycle
  contract, and the Bundle/Binding types from `shared/contracts` (consumed by ServiceHub's
  capability adapters).
- **Allowed dependencies:** FastAPI/uvicorn/httpx, LiteLLM (cloud dispatch only, via
  `cloud.catalog`), OpenTelemetry (debug telemetry), `pywin32` (DPAPI), `wmi` (hardware probe),
  `huggingface_hub` (GGUF download), the numpy/scikit-learn stack for the latency router (no
  `torch`: `routing/auto_router/_runtime_stubs.py` stubs it), and `superclaw-host-observability`.
  See [`pyproject.toml`](pyproject.toml).
- **Platform:** Windows (DPAPI user-scope encryption for credentials).

## Layout

```
src/llmrouter_manager/
├── __main__.py, app.py, config.py   CLI, FastAPI wiring, RuntimeConfig
├── routing/      /v1/* data plane: alias resolution + dispatch (proxy.py), pinned route
│   │             (pinned.py), primary-Bundle resolution, perf-weight and local ctx-size knobs
│   ├── auto_router/   trained latency router behind the `auto` alias
│   └── policy/        routing policy, context cap, prompt transforms (prompts/)
├── cloud/        provider catalog, DPAPI key registry, cloud-model singleton, LiteLLM dispatch
├── oauth/        PKCE / device login for ChatGPT (openai) and GitHub Copilot
├── edge/         user-deployed OpenAI-compatible endpoint
├── local/        hardware, eligibility, GGUF registry/downloader, llama-server supervisor, booster
├── capability/   trusted Bundle registry and primary-Bundle prepare/commit (see capability/README.md)
├── security/     /data-protection/* settings (file protection mode, hybrid threshold)
├── telemetry/    debug-only OpenTelemetry control plane
├── common/       health/template routes, management auth, logging, SQLite store, DPAPI, usage
└── data/         bundles.builtin.json, models.builtin.json, router_model_map.json, tokenizer.json,
                  latent_factor_artefacts.pkl, pca_model.pkl
```

Prompt files under `routing/policy/prompts/` are paid on every local turn: change them only with
before/after benchmark numbers.

## Run

Under ServiceHub (normal): see [`../README.md`](../README.md). ServiceHub injects
`SERVICEHUB_SERVICE_NAME`, `SERVICEHUB_INSTANCE_ID`, `SERVICEHUB_PROCESS_CREDENTIAL` and
`SERVICEHUB_MANAGED=1`; in managed mode LRM loads or creates its inference keys and ServiceHub
fetches them from `/llm-router/v1/internal/inference-key`.

Standalone:

```powershell
$env:LRM_API_KEY = "dev-only-secret"                         # required: the /v1/* bearer
$env:SERVICEHUB_PROCESS_CREDENTIAL = "dev-only-credential"   # without it every management route is 401
uv run --directory host\llmrouter_manager python -u -m llmrouter_manager --port 18321

curl http://127.0.0.1:18321/llm-router/v1/health
curl -H "Authorization: Bearer $env:LRM_API_KEY" http://127.0.0.1:18321/v1/models
```

`--port` is required; `--host` defaults to `127.0.0.1`. Standalone mode uses `LRM_API_KEY` for both
the shared and the host-only key. `scripts/dev_run.ps1` wraps this (sync, start, seed, verify).

### Seed configuration for dev: `scripts/dev_bootstrap.py`

With LRM running and the same `SERVICEHUB_PROCESS_CREDENTIAL` in the shell:

```powershell
uv run --directory host\llmrouter_manager python scripts\dev_bootstrap.py --url http://127.0.0.1:18321 --verify
```

| Env var | Seeds |
|---|---|
| `LOCAL_LLM_API_BASE`, `LOCAL_LLM_API_KEY` | Edge endpoint (both required) |
| `LOCAL_LLM_MODEL_NAME`, `LOCAL_LLM_EMBEDDING_MODEL_NAME` | Edge model names (optional; server defaults apply) |
| `CLOUD_LLM_PROVIDER`, `CLOUD_LLM_APIKEY`, `CLOUD_LLM_MODEL_NAME` | Cloud provider key and cloud-model (all required) |

Partial sets are skipped. `--input <file>.json` supplies the same sections (plus `llama-cpp`) as a
lower-priority fallback; `--provision-local <model_id|auto>` downloads and starts a local chat
model. Exit codes: `0` ok, `2` config error, `3` LRM unreachable within 30 s, `4` a `--verify`
probe failed, `5` local provisioning failed.

## Routing

Sandbox OpenCode declares one provider whose base URL is `{env:LRM_API_BASE_URL}/v1`;
SandboxManager sets `LRM_API_BASE_URL=http://127.0.0.1:18321` for the native roles, so agent
traffic reaches LRM over loopback with the inference bearer, not through ServiceHub.

| `model` | Resolves to |
|---|---|
| `local-model` | The committed primary Bundle's chat backend: the supervised `llama-server` (on `LLAMA_ROUTER_PORT`, default 18103) or the edge endpoint. |
| `cloud-model` | The cloud-model singleton (`PUT /llm-router/v1/cloud/model`), by API key or OAuth session. |
| `auto` | Both slots configured: the latency router embeds the query and picks one (`perf_weight` 1.0 / 0.0 short-circuit to cloud / local); on router failure it falls back to `cloud-model`. One slot configured: that slot. |

A missing slot returns **`424`** (`no_provider_available`, `local_model_not_configured`), never
`503`: it is a configuration error, and OpenAI-compatible SDKs retry every `5xx` with backoff,
which would hang a caller. Credentials and selections are read fresh per request, so no restart
is needed after a change.

Two request headers change `/v1/chat/completions` for one call:

- `X-SuperClaw-Require-On-Device: 1` answers `424 on_device_required` unless the alias resolves to
  the local `llama-server`. An edge backend is remote, so it does not qualify (used by ASR's
  `local` clean-up mode).
- `X-SuperClaw-Suppress-Model-Prefix: 1` drops the `[model-id] ` label that
  `SUPERCLAW_LRM_MODEL_PREFIX=1` adds, for callers that insert the text directly.

## Auth

| Surface | Requirement |
|---|---|
| `/v1/*` | `Authorization: Bearer <inference key>` (`401 invalid_inference_credential`). |
| `POST /v1/chat/completions/pinned` | The host-only key (`LRM_HOST_API_KEY`). ServiceHub never gives it to SandboxManager, so agent code cannot choose its own provider, model or usage label. |
| Management routes | `X-SuperClaw-Process-Credential` (`401 management_credential_required`), enforced by [`common/management_auth.py`](src/llmrouter_manager/common/management_auth.py): everything under `/cloud/`, `/capability/`, `/edge/`, `/telemetry/`, `/oauth/`; every `/data-protection/` route except `GET /mode` and `GET /hybrid-threshold`; and writes (not `GET`) under `/local`, `/perf-weight`, `/models`, `/model-selections`, `/inference-servers`, `/usage`, `/operations`. ServiceHub's proxy mirrors these lists and injects the credential after checking the hub token. |
| `POST /llm-router/v1/shutdown`, `GET /llm-router/v1/internal/inference-key` | Process credential (the key route also requires a loopback client). `403` otherwise. |
| Everything else under `/llm-router/*` | Open on loopback. |

LRM binds `127.0.0.1`. The sandbox runs on the same host, so it can reach any route on that
listener, not only `/v1/*`. Two sandbox callers rely on open control-plane reads; adding a third
means adding a row here:

| Path | Caller |
|---|---|
| `GET /llm-router/v1/data-protection/mode` | `sandbox/agent_config/profiles/pro/tools/confirm_file_protection.ts` |
| `GET /llm-router/v1/usage/events` | `sandbox/channels/src/lrm-usage.ts` (Slack/Telegram `Model:` footer) |

## API

Errors use `{"error": {"code", "message", "details"?}}`; ServiceHub forwards that shape verbatim and
collapses anything else to `upstream_error`. Unknown paths under a namespace return
`404 route_not_found`. FastAPI docs are served at `/llm-router/docs`.

### Data plane `/v1`

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/chat/completions` | Chat on `auto`, `local-model` or `cloud-model`. |
| POST | `/v1/chat/completions/pinned` | Chat against an explicitly named catalog `provider` + `model` with its stored key (dictation clean-up). Optional `provider_routing` (OpenRouter `extra_body.provider`) and `usage_alias`. Not listed by `/v1/models`. |
| GET | `/v1/models` | `auto`, plus `local-model` when a primary Bundle is committed and `cloud-model` when the singleton is set. |
| GET | `/v1/session/{session_id}/locality` | Last recorded locality (`cloud`/`local`/`edge`) of a session's completions; `unknown` by default. |
| GET | `/v1/pii/level` | Always `{"level":"off"}`; the live PII layer is the protected-file agent chain. |

### Control plane `/llm-router/v1`

| Group | Routes |
|---|---|
| Liveness | `GET /health` (`service`, `status`, `pid`, `instance_id`, `version`, `uptime_seconds`), `GET /version`, `POST /shutdown` |
| ServiceHub template | `GET /status` (hardware, eligibility, models, selections, providers, servers, tiers), `GET /config` (version only; `PUT`/`PATCH` are `405` by design), `POST /restart` (202 operation), `GET /events` (SSE: one `service.status`, then 15 s keepalives), `GET /operations/{id}`, `POST /operations/{id}/cancellations` |
| Capability | `GET /capability/model-binding`, `GET /capability/primary-bundle` (read-only), `POST /capability/primary-bundle/preparations` (+ `GET .../{id}`, `GET .../{id}/model-binding`, `POST .../{id}/resume`), `POST /capability/primary-bundle/commits` (+ `GET .../{id}`), `POST .../aborts`, `POST .../releases` |
| Host probes | `GET /system/hardware`, `/system/hardware-eligibility`, `/system/preflight` |
| GGUF models | `GET /models`, `GET /models/status`, `POST /models/{id}/downloads`, `GET /models/{id}/downloads/latest`, `POST /models/{id}/verifications`, `DELETE /models/{id}` |
| Selections | `GET /model-selections`, `PUT /model-selections/{role}` (`chat`/`embedding`), `GET`/`PUT /model-selections/local-provider` (`llamacpp`/`edge`), `GET`/`PUT`/`DELETE /model-selections/tier` (hardware-gated chat tier; `PUT` provisions and returns `{state, run_id}`) |
| llama-server | `GET /inference-servers`, `POST /inference-servers/provisions`, `POST /inference-servers/{role}/actions` (`start`/`stop`/`restart`), `GET /inference-servers/{role}/logs?tail=N`, `GET /inference-servers/{role}/probes` |
| Edge | `GET`/`PUT`/`DELETE /edge`, `POST /edge/test`, `GET /edge/models` |
| Cloud | `GET /cloud/catalog`, `GET /cloud/providers`, `GET`/`PUT`/`DELETE /cloud/providers/{id}`, `POST /cloud/providers/{id}/test`, `GET /cloud/providers/{id}/models`, `GET`/`PUT`/`DELETE /cloud/model`, `GET /cloud/model/health` |
| OAuth | `GET /oauth/providers`, `GET`/`DELETE /oauth/providers/{p}`, `POST .../{p}/login`, `GET .../{p}/status`, `POST .../{p}/cancel`, `POST .../{p}/refresh` |
| Routing knobs | `GET`/`PUT /perf-weight` (0..1, higher favours cloud), `GET`/`PUT /local/ctx-size` (llama-server `-c` override; `PUT` restarts the chat server) |
| Data protection | `GET`/`PUT /data-protection/mode` (`none`/`deterministic`/`hybrid`/`llm`), `GET`/`PUT /data-protection/hybrid-threshold` (0..1) |
| Usage | `GET /usage`, `GET /usage/events?session_id=&message_id=&limit=`, `DELETE /usage` |
| Telemetry | `GET`/`PUT /telemetry/config`, `GET /telemetry/status`, `POST /telemetry/test-export`, `/flush`, `/reset`. Mounted only when `SUPERCLAW_DEBUG_OBSERVABILITY=1`. |

Behaviour worth knowing before calling these:

- **Edge `PUT`** takes `{base_url, api_key?, model_name?, embedding_model_name?}`; the model names
  default to `Qwen3.8-Flash-Next` / `KaLM-embedding-v2.5` and are persisted. A blank `api_key`
  reuses the saved key only for the same origin (else `422 missing_api_key`); `409
  edge_config_changed` means the config changed during the probe. `POST /edge/test` merges an
  inline body over the saved config the same way.
- **Cloud provider `PUT`** takes `{api_key}`, probes the provider's `/models` first (`?probe=false`
  skips it) and does not persist on `401 invalid_api_key` / `502 upstream_unreachable`. `DELETE`
  returns `409 in_use` while the cloud-model refers to it. Provider ids must match
  `^[a-z0-9][a-z0-9_-]{0,31}$` and be in the shipped catalog (`422 unsupported_provider`); custom
  base URLs are not supported.
- **`PUT /cloud/model`** takes `{provider, model, auth_mode?, max_tokens?, context_limit?}`;
  `422 provider_not_configured` if the provider has no key or session.
- **OAuth** (`openai` for a ChatGPT subscription, `github_copilot`): LRM owns login, refresh and
  DPAPI storage and projects a derived token cache for LiteLLM, so LiteLLM never runs its own login.
  A token is refreshed on dispatch within 60 s of expiry; a dead refresh token is
  `401 oauth_reauth_required`. `DELETE` removes the local session only (no upstream revoke).

### Cloud catalog

[`cloud/catalog.py`](src/llmrouter_manager/cloud/catalog.py) ships 29 API-key providers, including
`openai`, `anthropic`, `google`, `openrouter`, `deepseek`, `xai`, `mistral`, `perplexity`, and the
`zhipuai`/`zai`, `minimax`, `alibaba`, `tencent` and `xiaomi` families with their coding/token
plans. `GET /cloud/catalog` exposes only `id` and display name; endpoints and LiteLLM adapters stay
internal. Vertex is excluded (it needs tenant-specific project, region and credentials). Adding a
provider means adding its fixed endpoint and LiteLLM mapping to `CATALOG`.

## Configuration

Mutable settings live behind the domain endpoints above. Process-level knobs:

| Env var | Default | Effect |
|---|---|---|
| `LRM_API_KEY` | — | Inference bearer. Required standalone; in managed mode ServiceHub distributes it to dependents. |
| `LRM_LOG_LEVEL` | `INFO` | `DEBUG` also opens third-party loggers (normally clamped to WARNING). |
| `LRM_LOG_DIR`, `LRM_LOG_RETENTION` | `<data>\logs`, `50` | Log directory and number of per-launch files kept. |
| `LRM_MODEL_DIR` | `<data>\models` | GGUF cache. |
| `LLAMA_ROUTER_PORT` | `18103` | Loopback port of the supervised `llama-server`. |
| `LRM_HEALTH_TIMEOUT_S`, `LRM_MODEL_LOAD_TIMEOUT_S` | `60`, `300` | `llama-server` reachability budget, then model-load budget. |
| `LRM_LOCAL_MAX_OUTPUT_TOKENS` | model's `n_predict`, else `8192` | Per-step output cap on local requests; `0` disables the clamp. |
| `LRM_SANITIZE_LOCAL_TOOL_GRAMMAR` | `1` | Strip `format`/`pattern` from tool schemas before llama.cpp compiles them to GBNF. |
| `LATENTFACTOR_LOCAL_CTX` | — | Overrides the local context size (wins over `PUT /local/ctx-size`). |
| `LATENTFACTOR_MAX_CONTEXT` | — | Overrides the context ceiling the routing policy enforces. |
| `SUPERCLAW_DEBUG_OBSERVABILITY` | unset | `1` mounts `/telemetry/*` and enables OTLP export. |
| `LRM_MOCK_LOCAL_*` | unset | Dev-only local-Bundle mock; see [`dev/mock-bundles/README.md`](dev/mock-bundles/README.md). |

`<data>` is `%LOCALAPPDATA%\SuperClaw\llmrouter_manager`.

## State

| Data | Location under `<data>` | Encryption |
|---|---|---|
| Provider API keys | `state\providers\<id>.bin` | DPAPI |
| OAuth sessions | `state\oauth\<provider>.bin`; derived LiteLLM caches `state\litellm-chatgpt\`, `state\litellm-github-copilot\` | DPAPI (`.bin`); caches plaintext |
| Cloud-model selection | `state\cloud-model.json` | none (no secret) |
| Edge config | `state\edge.json` | DPAPI |
| Latency-router artefact overrides | `state\{latent_factor_artefacts,pca_model}.pkl` (win over the shipped `data\` copies) | none |
| Selections, primary Bundle, model verifications, usage, diagnostic events | `llmrouter_manager.db` (SQLite WAL) | none |
| Logs | `logs\llmrouter_manager-<YYYYMMDDTHHMMSS>.log`, one per launch | none |

LRM runs as the signed-in user; DPAPI is user-scope. Its database is not shared with any other
service. `chat.request` log lines carry only a masked character count of the user message, but
`chat.completion.error` tracebacks can include upstream error text: treat the logs as sensitive.

## Test

```powershell
uv run --directory host\llmrouter_manager pytest -q
```

Markers: `integration` (needs a live LRM process) and `windows_only` (pywin32, real DPAPI).
`scripts/smoke/` holds PowerShell smokes against a running instance.

## File-size exceptions

- `local/supervisor.py` (about 1750 lines) owns the whole `llama-server` lifecycle: launch,
  readiness, self-heal, termination. The start-up key-enforcement check lives in
  `local/llama_auth.py`; splitting the lifecycle is out of scope.
