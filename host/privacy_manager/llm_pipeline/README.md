# LLM Pipeline

The LLM-driven masking pipeline for tabular files (`.csv`, `.xlsx`, `.xls`, `.xlsm`). An LLM
inspects the file, chooses the sensitive columns, and calls a tool that replaces their values with
placeholders and writes a JSON registry mapping each placeholder back to its original value.

- **Owner / runtime:** part of Privacy Manager. It is imported in-process by
  [`../data_protection`](../README.md) and frozen into the `privacy_manager` role of
  `superclaw-services.exe`; ServiceHub does not spawn it as its own child.
- **Contract:** the protected-file response (`success`, `masked_file_path`, `final_answer`,
  `error_message`), exposed by Privacy Manager's `POST /v1/file/protect` (mode `llm`, or `hybrid`
  fallback) and `POST /v1/file/llm-pipeline`.
- **Allowed dependencies:** FastAPI/uvicorn/httpx, pandas/openpyxl, `superclaw-host-observability`.
  It reaches LRM only over HTTP. Its `pyproject.toml` also declares the `data_protection` runtime
  dependencies, because that tree has no project of its own in the frozen build.

## Workflow

`api/server.py` → `run_protected_file_pipeline()` drives `src/pipeline/orchestrator.py`:

1. **Inspect:** the LLM calls `inspect_dataset_file` (`src/tools/inspect_dataset_file.py`) and sees
   the headers and sample rows.
2. **Mask:** the LLM calls `mask_sensitive_columns` (`src/tools/mask_sensitive_columns.py`), which
   writes the masked file and the registry.
3. **Final answer:** the LLM returns a `FinalResponse` summary.

Output is never written next to the source. It goes under
`%USERPROFILE%\SuperClawProjects\data_protection_workspace\` (`WINDOWS_SUPERCLAW_PATH` overrides
the root; `HYBRID_CODING_WORKSPACE` in `mask_sensitive_columns.py`):
`masked_datasets/<dataset>/<timestamp>/` and `mask_registries/<dataset>/<timestamp>/`.

`src/clients/llm_client.py` (`LLMClient`) calls LRM's `local-model` at `/v1/chat/completions`
with `LRM_API_KEY` as the bearer and `X-Opencode-Session-Id` for usage attribution. LRM's
`424 no_provider_available` raises `NoLocalProviderError`, so the caller falls back to
deterministic masking instead of ever sending the data to `cloud-model`.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `LRM_API_KEY` | — | LRM inference bearer (ServiceHub injects it into Privacy Manager). |
| `SERVICEHUB_CFG_PATH` | injected by ServiceHub | `service_cfg.json` path, used to derive the LRM URLs. |
| `LLMROUTER_CHAT_URL`, `LLMROUTER_HEALTH_URL` | derived from `service_cfg.json` | Override the LRM endpoints. |
| `LLMROUTER_TIMEOUT` | `200` | Request timeout in seconds; values outside (0, 3600] fall back to the default. |
| `WINDOWS_SUPERCLAW_PATH` | `%USERPROFILE%\SuperClawProjects` | Root of `data_protection_workspace`. |

Logs go to `%LOCALAPPDATA%\SuperClaw\security\logs` (`utils/logger.py`).

## Standalone dev app

The package still has its own small FastAPI app for development and tests. `--port` is required;
`--host` defaults to `127.0.0.1`.

```powershell
cd host
uv sync --all-packages
$env:LRM_API_KEY = "<the key LRM was started with>"
uv run python -m llm_pipeline --port 18025

Invoke-RestMethod http://127.0.0.1:18025/file-guard/v1/health
Invoke-RestMethod http://127.0.0.1:18025/file-guard/v1/run -Method Post -ContentType application/json `
  -Body '{"source_file_path": "C:\\path\\to\\test.csv"}'
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/file-guard/v1/health` | Liveness. |
| POST | `/file-guard/v1/run` | Run the pipeline. Body `{"source_file_path": "..."}`; response is the protected-file schema. |
| POST | `/file-guard/v1/shutdown` | Graceful stop. |

In the product, call Privacy Manager instead (`POST http://127.0.0.1:18826/v1/file/llm-pipeline`
with the data-plane bearer).

## Test

LLM I/O and tool execution are mocked; no LRM is needed.

```powershell
uv run --directory host\privacy_manager\llm_pipeline pytest -q
```

Suites: `tests/pipeline/` (orchestrator and tool-call parsing), `tests/clients/` (LRM client
payload, proxy, timeout, URL masking), `tests/tools/` (file boundaries, placeholder categories),
plus path and reparse-point guards.

## Layout

```
llm_pipeline/
├── __main__.py            standalone entry point
├── api/server.py          FastAPI app and run_protected_file_pipeline()
├── src/
│   ├── clients/llm_client.py
│   ├── pipeline/          orchestrator.py, registry.py (tool name → function), tool_calls.py
│   ├── prompts/llm_pipeline_prompt.py
│   ├── schemas/           api.py, responses.py, tool_schemas.py
│   └── tools/             inspect_dataset_file.py, mask_sensitive_columns.py
├── utils/                 logger.py, paths.py, registry_io.py
└── tests/
```
