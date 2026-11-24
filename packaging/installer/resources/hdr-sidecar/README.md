# hybrid-dr-orchestrator (Hybrid Deep Research sidecar)

Python + LangGraph implementation of the Hybrid Deep Research pipeline. On the Windows product
path it runs as the native backend role `hdr_sidecar` in the `file_tool` tier, from a
`py\hybrid-dr-venv` that `scripts\native-backend\build-native-backend.ps1` stages from this
folder. Sandbox Manager starts it on a per-boot loopback port, with a Bearer token, when the
committed Product Profile includes Hybrid Deep Research (`pro`). See
[`scripts/native-backend/README.md`](../../../../scripts/native-backend/README.md) and
[`docs/INTEGRATION.md`](docs/INTEGRATION.md).

The OpenCode tool `hybrid_dr_post_polish_processor`
([`sandbox/agent_config/profiles/pro/tools/hybrid_dr_post_polish_processor.ts`](../../../../sandbox/agent_config/profiles/pro/tools/hybrid_dr_post_polish_processor.ts))
is its only caller: it creates a session, starts a background run, polls it, updates the tool
card title (`Hybrid Deep Research [n/9: <phase>]`) and returns the report paths.

The orchestration lives in its own process rather than an OpenCode plugin so the pipeline is
an explicit state machine with Pydantic-validated state and on-disk checkpoints. Graph design:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What the sidecar owns

| Concern | Owner |
|---|---|
| Chat UI, sessions, message history | OpenCode |
| LLM calls, PII masking and restore | LLMRouter (`llmrouter_manager`) |
| Web search | the Connector (native) or Tavily / DuckDuckGo (legacy mode) |
| **Phase orchestration, agent prompts, step budgets, per-phase tools** | **this sidecar** |

## L0 / L2 privacy contract

`privacy_tier` defaults to L2 (local files involved):

- Local file content, raw or summarised, never enters a cloud-model request.
- Cloud-model phases read only `cloud_intermediate/`; local phases read both intermediate
  directories.
- Model calls go through LLMRouter, which owns PII masking. In native managed mode the
  request cannot redirect them (see below).

## Pipeline

```
input_local → input_web → plan → section_write → fill → conclusion
            → fill_conclusion → assemble → polish
```

| Phase | Inputs | Outputs | LLM calls |
|---|---|---|---|
| `input_local` | `data_paths` files (when present) | `L-001.md`, `L-002.md`, … | one per local file |
| `input_web` | `user_query` | `W-001.md`, `W-002.md`, … | sub-question derivation, web searches, then synthesis into each `W-NNN.md` |
| `plan` | web + local insights | `plan.json` | one |
| `section_write` | `plan.json` + insights | `S<i>_attempt_<j>.md`, `S<i>_final.md` | writer + reviewer per attempt, up to 3 attempts per section |
| `fill` | `S<i>_final.md` + local insights | `S<i>_filled.md` | one per section with placeholders |
| `conclusion` | filled sections | `cand_<n>.md`, `winner.md`, `scoring.json` | candidate generation + scorer |
| `fill_conclusion` | winning conclusion | conclusion with placeholders filled | optional |
| `assemble` | sections + conclusion | `assembled_report.md`, `polish_skeleton.json` | none |
| `polish` | `assembled_report.md` | `reports/executive_report.md`, `analyst_report.md`, `gap_manifest.json`, `ui_summary.md` | one |

Per-phase knobs (candidates, retries, attempts, concurrency) are in
`src/hybrid_dr_orchestrator/pipeline_config.json` and the node dataclasses; see
[`docs/HYPERPARAMETERS.md`](docs/HYPERPARAMETERS.md). `llm.py` retries httpx transport errors
and HTTP 429/500/502/503/504 with backoff of 3, 8, 20 and 45 s.

## HTTP surface

```
GET  /healthz                              → {"status": "ok", "version": ...}   (no auth)
GET  /readyz                               → {"status": "ready", "mode": "native_managed" | "legacy"}
POST /v1/hybrid-dr/sessions                → 201 { session_id, root_dir, state }
GET  /v1/hybrid-dr/sessions/{sid}/state    → { session_id, state }
POST /v1/hybrid-dr/sessions/{sid}/advance  → one phase: { session_id, state, error }
POST /v1/hybrid-dr/sessions/{sid}/run      → start a background run to a terminal phase
GET  /v1/hybrid-dr/sessions/{sid}/run      → { session_id, run_id, status, state, error }
POST /v1/hybrid-dr/sessions/{sid}/cancel
```

The create, advance and run requests share one body: `user_query`, `task_class`,
`privacy_tier`, `data_paths`, and optional `title`, `cloud_model`, `cloud_llm`, `local_llm`,
`llmrouter_url`, `tavily_api_key`, `session_root`.

## Native managed mode

Sandbox Manager starts the role with `HYBRID_DR_NATIVE_MANAGED=1`. In that mode the sidecar
refuses to start unless it has:

| Variable | Meaning |
|---|---|
| `HYBRID_DR_API_TOKEN`, `HYBRID_DR_READY_TOKEN` | Two distinct Bearer tokens. Every route except `/healthz` needs the API token; `GET /readyz` also accepts the readiness token. |
| `HYBRID_DR_SESSION_ROOT` | Absolute session root. |
| `HYBRID_DR_WORKSPACE_ROOT` | Absolute broker-bound workspace root that `data_paths` must stay under. |
| `HYBRID_DR_LLMROUTER_URL`, `LRM_API_KEY` | LLMRouter on a fixed `http://127.0.0.1:<port>` URL, and its key. |
| `SUPERCLAW_CONNECTOR_CONFIG`, `SUPERCLAW_CONNECTOR_READER_PYTHON`, `SUPERCLAW_CONNECTOR_READER_ROOT` | The sealed Connector configuration for web search and the reader that opens it. |

A request may not override `session_root`, `tavily_api_key`, `llmrouter_url`, `cloud_llm` or
`local_llm`; doing so is a `400`. `data_paths` is authorized by `managed_paths.py`: each entry
must be a plain canonical drive path to a regular, singly linked file under the workspace
root, with no reparse point in any component. A refusal is
`400 {"detail": {"code": "data_path_refused", "reason": <code>, "index": <n>}}` and never
echoes the path; `input_local` then reads each file only through a handle whose identity still
matches what validation recorded.

Without `HYBRID_DR_NATIVE_MANAGED` the sidecar runs in legacy mode: no auth, request overrides
allowed, LLMRouter defaulting to `http://127.0.0.1:18321`, and web search through Tavily with
the request's key, falling back to DuckDuckGo.

Tunables, all optional: `HYBRID_DR_MAX_CONCURRENT_SESSIONS` (2), `HYBRID_DR_SESSION_STALE_S`
(1800), `HYBRID_DR_PHASE_MAX_RETRIES` (2), `HYBRID_DR_RUN_BUDGET_S` (600),
`HYBRID_DR_LLM_TIMEOUT_S` (420), `HYBRID_DR_LLM_CONNECT_TIMEOUT_S` (8), and
`HYBRID_DR_PIPELINE_CONFIG_PATH` to replace the bundled `pipeline_config.json`.

## Layout

```
hdr-sidecar/
├── pyproject.toml, uv.lock            package, dependencies, lint and test config
├── docs/                              ARCHITECTURE, HYPERPARAMETERS, INTEGRATION
├── scripts/                           developer tools, not shipped (see scripts/README.md)
├── src/hybrid_dr_orchestrator/
│   ├── api/serve.py                   FastAPI app, deployment policy, auth, admission control
│   ├── graph.py, runner.py            phase graph and runner
│   ├── state.py, persistence.py       pipeline state (Pydantic) and its on-disk form
│   ├── config.py, pipeline_config.json
│   ├── llm.py                         LLMRouter client and retry
│   ├── search.py, connector_reader.py web search clients and the sealed Connector config reader
│   ├── managed_paths.py               native-mode data_paths authorization
│   ├── json_repair.py, delims.py      lenient parsing of model output
│   ├── nodes/                         one module per phase
│   └── prompts/                       system prompts per node
├── tests/
└── Dockerfile, hybrid_dr_sidecar.spec, packaging/Dockerfile.binary   deferred Linux build only
```

## Run

For local development, from this folder:

```powershell
uv venv
uv pip install -e ".[dev]"
uv run pytest tests/
uv run python -m hybrid_dr_orchestrator --host 127.0.0.1 --port 18324
```

`python -m hybrid_dr_orchestrator` (also installed as `hybrid-dr-sidecar`) starts uvicorn on
`--host` / `--port`, default `127.0.0.1:18324`, in legacy mode unless the managed variables
above are set.

## Deferred Linux artifact

`Dockerfile`, `hybrid_dr_sidecar.spec` and `packaging/Dockerfile.binary` are the inputs of a
container-built Linux onedir (`packaging\installer\build-hdr-sidecar.ps1`, output under
`vendor/hdr-sidecar/linux-x64/`). It is not the product path; #3047 tracks removing it.
