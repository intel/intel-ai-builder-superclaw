# Privacy Manager — PII data protection

The Windows-host service that masks personally identifiable information (PII) in files and text
before a cloud model sees them, and restores the placeholders afterwards. It is the ServiceHub
child `privacy_manager` (port `18826`, proxy prefix `/data-protection`, required at boot, depends
on `llmrouter_manager`). Sandbox tools call it directly at
`http://${DATA_PROTECTION_HOST:-127.0.0.1}:18826/v1/...` with the data-plane bearer.

It is two workspace packages, frozen into the `privacy_manager` role of `superclaw-services.exe`:

| Package | Path | Role |
|---|---|---|
| `protection-service` | [`data_protection/`](data_protection/) | The HTTP service: deterministic file masking (DPS), the text sanitizer, restore, sessions, model delivery. |
| `llm-pipeline` | [`llm_pipeline/`](llm_pipeline/README.md) | The LLM-driven tabular masking pipeline, imported in-process. |

- **Contracts:** the ServiceHub child lifecycle contract, the `/v1/*` data-protection API used by
  the sandbox tools, and the protected-file response schema (`success`, `masked_file_path`,
  `final_answer`, `error_message`, `operation_id`, `resolved_by`, `degraded_reason`).
- **Allowed dependencies:** FastAPI/uvicorn, pandas/openpyxl/pyarrow, python-docx, beautifulsoup4,
  rapidfuzz, OpenVINO + tokenizers + spaCy for NER (no `torch`), `superclaw-host-observability`,
  and `llm-pipeline`. LRM is reached only over HTTP. See
  [`data_protection/pyproject.toml`](data_protection/pyproject.toml).

## What it protects

| Input | Path | Engine |
|---|---|---|
| Tables (`.csv`, `.xlsx`, `.xls`, `.parquet`) | `/v1/file/*` | DPS column detector + masking, optionally the LLM pipeline |
| Documents (`.txt`, `.md`, `.html`, `.htm`, `.docx`) | `/v1/file/*` | DPS prose-span masking |
| Free-form text | `/v1/text/redact` | Text sanitizer (PPLX NER on OpenVINO + regex + spaCy) |

Masking replaces values with placeholders such as `<PERSON_1>` and writes a
`{placeholder: original}` registry so they can be restored later.

### File protection modes

`POST /v1/file/protect` reads the mode and hybrid threshold from LRM
(`GET /llm-router/v1/data-protection/mode` and `/hybrid-threshold`) on every request, so a change
in Settings takes effect on the next call. If LRM is unreachable it uses the defaults: mode
`none`, threshold `0.75`.

| Mode | Behaviour |
|---|---|
| `none` (default) | No-op: returns the source path as `masked_file_path`, `resolved_by: "none"`. |
| `deterministic` | DPS only. |
| `hybrid` | DPS first. If DPS fails, or a table's lowest column confidence is below the threshold, run the LLM pipeline. Documents are accepted from DPS. |
| `llm` | LLM pipeline for `.csv`, `.xlsx`, `.xls`, `.xlsm`; DPS for other types. |

The LLM pipeline only uses LRM's `local-model`. With no local model configured it falls back to
DPS (in `hybrid`, a low-confidence DPS result is then accepted and reported with
`degraded_reason`). `deterministic_only: true` in the request forces DPS. Settings → Privacy →
File Protection exposes this as a toggle: on writes `hybrid`, off writes `none`.

The sandbox side is the `protected-file-agent` and the `run_protected_file_pipeline` tool in each
Product Profile (`sandbox/agent_config/profiles/*/tools/`). The cloud model analyses the masked
output, never the original.

`POST /v1/file/protect/batch` takes `source_file_paths` (2+) and `session_id` and protects each file
in turn with its own operation and registry. Placeholders are namespaced per file
(`_namespace_placeholders_for_batch_file`) so `<PERSON_1>` from two files cannot collide; results
come back in request order.

### Output layout and restore

Masked output goes under `%USERPROFILE%\SuperClawProjects\data_protection_workspace\`
(`WINDOWS_SUPERCLAW_PATH` overrides the root; the sandbox sees it as
`/workspace/data_protection_workspace/`):

```
data_protection_workspace/
├── masked_datasets/<dataset>/<YYYYMMDD_HHMMSS>/   masked files
└── mask_registries/<dataset>/<YYYYMMDD_HHMMSS>/   registry JSON
```

Agents are denied direct reads of `mask_registries/` (each Profile's `opencode.jsonc` deny rules
and `93_protected_pipeline_terminal_guard.ts`); registries resolve only through the restore
endpoints. Restore never mutates the masked file or its registry:

| Caller | Restore path |
|---|---|
| Agent chat responses (display only) | The sandbox server chains `POST /v1/session/response/restore` over every operation a `/message` response touched; the OpenCode transcript stays masked. |
| Files `build` writes from a masked handoff | Restored on disk once the delegating `task()` completes. |
| Explicit callers | `POST /v1/session/response/restore` (session + optional `operation_id`) or `POST /v1/restore` (explicit `registry` or `replacements`). Both report `unmatched_placeholders`. |

## How detection works

### DPS column detector (offline, no LLM)

`file_protection/detect.py` → `suggest_sensitive_columns()` returns `suggestions[]` of
`column`, `category`, `confidence`; `file_protection/agents/redact_agent.py` → `redact_dataframe()`
masks them.

| Signal | Checks | Categories |
|---|---|---|
| Header | Column-name keyword map (`ssn` → 0.99, `name` → 0.6) | `EMAIL`, `PHONE`, `ID`, `PERSON`, `ORG`, `STREET`, `ZIPCODE`, `CITY`, `FINANCIAL`, `URL` |
| Content | Regex/checksum validators on sampled values | adds `DATETIME`, `COUNTRY`, `COUNTY`, `AGE`, `SEX`, `GENDER`, `SECRET` |
| Structural | Uniqueness ratio and column co-occurrence (`first_name` + `last_name`) | none new; adjusts confidence |
| Local NER (`sanitize.detect_use_ner`, on by default) | PPLX classifies ambiguous sampled values via `SanitizeManager.entity_column_classifier()` | soft entities only: `PERSON`, `ORG`, `CITY`, `COUNTRY`, `COUNTY` |

Header and content merge first, and content wins a disagreement. Structural rules then adjust
confidence. NER runs last on ambiguous soft-entity columns and never overrides a structured format
(`EMAIL`, `ID`, `FINANCIAL`). It runs locally and never calls LRM.

### Text sanitizer (offline, no LLM)

`text_protection/sanitizer.py` → `ConsistentSanitizer.sanitize()` returns `redacted` and
`replacements`, in two stages (`text_protection/_stages.py`):

1. **`Stage1TokenDetection`** collects spans from `CustomTermDetector` (priority 0),
   `NerDetector`/PPLX (1), `RegexDetector` and `FinancialRegexDetector` (2) and `SpacyDetector`
   (3); lower priority claims first. On overlap, a strictly longer span of the same category
   replaces the accepted one (a lower-priority span only if it fully contains it and passes the
   name-extension guard), a different category is rejected, except that a trusted regex category
   (`ID`, `SECRET`, `FINANCIAL`) always replaces a PPLX span.
2. **`Stage2FinancialDetection`** masks amounts and finance terms (`FIN_AMOUNT`, `FIN_TERM`,
   `PERCENT` → `FINANCIAL`) in the Stage-1 output.

Raw labels are normalised through `LABEL_CATEGORY_MAP`, so PPLX `private_email` becomes `<EMAIL_1>`
and regex `SSN` becomes `<ID_1>`. `/health` reports the NER device as `ner_backend`
(for example `OpenVINO:GPU`).

### LLM pipeline

Three tool-calling steps in one conversation (inspect headers and sample rows, choose and mask
columns, write a summary), against LRM `/v1/chat/completions` with `X-Opencode-Session-Id` for
usage attribution. Details: [`llm_pipeline/README.md`](llm_pipeline/README.md).

## API

All `/v1/*` routes need `Authorization: Bearer <data-plane key>`. `/health` and
`/data-protection/v1/health` are open.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/file/preflight` | Validate a source path (exists, size, allowed root) before the approval dialog; also wakes the sanitizer. |
| POST | `/v1/file/protect`, `/v1/file/protect/batch` | Mode-aware protection (above). |
| POST | `/v1/file/protect/review` | List what an operation masked, for the user to review. |
| POST | `/v1/file/protect/summary` | Masking counts for an operation, including user-added words. |
| POST | `/v1/file/protect/extra-terms` | Additionally mask user-supplied words in an already-masked file. |
| POST | `/v1/file/llm-pipeline` | Always run the LLM pipeline, ignoring the mode. |
| POST | `/v1/file/detect`, `/v1/file/redact`, `/v1/file/detect_and_redact` (+ `/upload` multipart variants) | Explicit DPS detect, mask, or both. |
| POST | `/v1/file/local-read` | Host-side read of a `sensitive/` file for the local-file agent, allowed only when the mode is `none` or a local-read grant is open. |
| POST | `/data-protection/v1/file/local-read/grant` | Opens a 600 s local-read window after the user declines protection. Process credential required (ServiceHub only). |
| POST | `/v1/text/redact` | Mask free-form text. |
| GET | `/v1/text/categories` | Recognised categories. |
| POST | `/v1/text/custom-level` | Set the global custom masking level. Also needs the process credential. |
| POST | `/v1/session/query/rewrite` | Replace real values in a query with an operation's placeholders. |
| POST | `/v1/session/response/restore` | Restore placeholders in an agent response. |
| POST | `/v1/restore` | Restore from an explicit registry or replacements map. |
| GET | `/health` | Service detail: `sanitize_ready`, `sanitize_dormant`, `sanitize_warming_up`, `sanitize_degraded_reason`, `ner_backend`, `models_state`, download bytes. |
| GET | `/data-protection/v1/health` | ServiceHub probe; `503` with a `reason` while the sanitizer needs a restart. |
| GET | `/data-protection/v1/models/status` | `models_state`, byte counts, `models_present`. Process credential. |
| POST | `/data-protection/v1/models/prepare` | Wake the sanitizer and start missing downloads. Process credential. |
| GET | `/data-protection/v1/internal/data-plane-key` | Key handoff to ServiceHub (loopback + process credential). |
| POST | `/data-protection/v1/shutdown` | Graceful stop (process credential). |

## Configuration

### Authentication

In managed mode (`SERVICEHUB_MANAGED=1`) the service generates a random data-plane key, persists it
DPAPI-protected in the user's state directory (replaced atomically; a malformed file stops startup
rather than rotating the key), and hands it to ServiceHub, which gives it only to SandboxManager.
Inherited `DATA_PROTECTION_API_KEY` is ignored. Standalone, `DATA_PROTECTION_API_KEY` is required.

### `config.yaml`

The ServiceHub entry (`protection_service.servicehub_entry`, flags `--host`/`--port` only) loads
`data_protection/config.yaml` next to the package (the installer seeds it); without one it uses
built-in defaults. [`config.yaml.example`](data_protection/config.yaml.example) lists every key. The
ones you are most likely to change:

| Key | Default | Meaning |
|---|---|---|
| `redact.redacts_dir` | `%LOCALAPPDATA%\protection_service\redacts` (`PII_APP_REDACTS_DIR`) | Short-lived masked files and registries. |
| `redact.max_source_bytes` | 500 MB | Largest accepted input. |
| `redact.default_ttl_seconds` / `max_ttl_seconds` | 300 / 3600 | TTL range for path-mode output (hard cap 24 h). |
| `sanitize.enabled` | `true` | `false` disables the text sanitizer and NER. |
| `sanitize.device` | `AUTO` | OpenVINO device. |
| `sanitize.ner_model_path` | `./models/pplx-pii-masking-ov-int8` | PPLX model directory. |
| `sanitize.ov_cache_dir` | `%LOCALAPPDATA%\SuperClaw\privacy_manager\ov_cache` | OpenVINO kernel cache; relative paths resolve against the exe; unwritable means no cache. |
| `sanitize.detect_use_ner` | `true` | NER enrichment in the DPS detector. |

Mode and threshold are not configured here; they live in LRM (see above).

| Env var | Effect |
|---|---|
| `LRM_BASE_URL` | LRM base URL for mode/threshold (default `http://127.0.0.1:18321`). |
| `LRM_API_KEY` | Bearer for LRM calls (ServiceHub injects it). |
| `SUPERCLAW_PRIVACY_MODELS_DIR` | Model download directory. |
| `SUPERCLAW_PRIVACY_MODEL_BASE_URL` | Model host (default `https://aibuilder.intel.com/models`). |
| `WINDOWS_SUPERCLAW_PATH` | Root of `data_protection_workspace`. |

## Operations

### Sanitizer start-up

The NER models stay unloaded at boot (`sanitize_dormant: true`) so readiness never waits for them.
The first request that needs the sanitizer, a `/v1/file/preflight`, `models/prepare`, or an LRM mode
change away from `none` starts loading them on a background thread (`sanitize_warming_up: true`).
Once loaded they stay loaded. Restore never needs them.

- A request that needs the sanitizer waits up to 90 s, then fails `503 sanitizer_warming_up`. File
  protect never falls back to the LLM pipeline for this.
- A load still running after 90 s (or ended by `SystemExit`/`KeyboardInterrupt`) is logged at ERROR
  and makes `/data-protection/v1/health` answer `503`, so the ServiceHub watchdog restarts the
  service under its normal restart budget.
- A load that raises leaves the service degraded with
  `sanitize_degraded_reason: "pii_model_not_ready"`; NER-dependent requests fail
  `503 pii_model_not_ready` with the load error.

### Storage and TTL

- **`RedactsStore`** (`redacts_store.py`) keeps masked files and registries in `redacts_dir` with an
  in-memory `{file_id: (path, expires_at)}` index. Files are `r_<hex>`; on POSIX they are chmod 0600,
  on Windows the directory ACL protects them. Because the index is not persisted, startup deletes
  any file older than `max_ttl_seconds`.
- **`PiiRegistryStore`** (`pii_registry_store.py`) is SQLite (WAL) at
  `<redacts_dir>\..\pii_session_registry.db`, table `pii_registry_operations` keyed by
  `(session_id, operation_id)`. Rows hold paths and timestamps only, never the mapping. Session
  routes use the given `operation_id` or the session's latest operation; a locked or corrupt
  database fails closed (`404`).
- **Sweeper:** `RedactsStore.sweeper_loop()` runs at startup and every 60 s, and also runs the
  registry expiry and the sanitizer cache reaper.

### PII model download

The installer does not bundle `pplx-pii-masking-ov-int8` (about 511 MiB). When the sanitizer first
wakes and the model is missing, it is downloaded in the background to
`%LOCALAPPDATA%\SuperClaw\privacy_manager\models\<model>\`.

- **Present** means the verified per-user copy exists (sizes on every check, sha256 of every file
  once per process on a worker thread, `models_state=verifying` meanwhile), or a directory the
  service already resolves (the repo copy in a source run) holds every pinned file at its pinned
  size and hash.
- **Consent:** Settings → Privacy → File Protection checks `models/status` and asks for consent
  only when `models_present` is false, then calls `models/prepare` and enables protection once the
  status reports the models ready.
- **Source:** one zip per model at `<base>/<model>.zip`. The base must be https (plain http only
  for loopback); TLS verification is always on. Proxies come from `*_PROXY`; `aibuilder.intel.com`
  always goes through `HTTPS_PROXY`, other `NO_PROXY` hosts are tried direct first, loopback is
  always direct. ServiceHub passes its environment to the child, so a user environment variable
  takes effect after an app restart.
- **Integrity:** [`model_manifest.json`](data_protection/protection_service/model_manifest.json)
  pins the zip's size and sha256 and every file's path, size and sha256. Transfers resume with HTTP
  Range; only listed files are unpacked, each re-verified, into `<model>.partial\`, renamed into
  place when complete.
- **Activation:** the sanitizer is rebuilt in-process when the model lands. If that fails,
  `/data-protection/v1/health` answers `503` and ServiceHub restarts the service.
- **Fail closed:** until the model is installed and loaded (`ner_backend` not `none`), every
  request that needs NER answers `503 pii_model_not_ready`: `/v1/text/redact`, the DPS detect/redact
  routes when they consult NER, and the deterministic step of `/v1/file/protect`. Requests with
  `use_ner: false` / `free_text_use_ner: false`, `sensitivity_level: "none"`, restore, session and
  category routes keep working. `models_state` is one of `pending`, `downloading`, `verifying`,
  `activating`, `ready`, `failed`, `disabled`, `unsupported`.
- **Retry:** a failed download is retried by the next request that needs the model after 5 min,
  15 min, then 1 h, and on every start. A response larger than the pinned size fails at once.

To change the model, edit `data_protection/models/`, then regenerate the manifest and upload the
zip unchanged (the manifest pins its exact bytes; files must be LF, real weights, not LFS
pointers):

```powershell
cd host/privacy_manager/data_protection
uv run python scripts/gen_model_manifest.py --zip-dir <out>   # --check reports drift
```

A checkout made with `core.autocrlf=true` has CRLF copies of the model's text files, and the service
logs a size-mismatch WARNING for each. Delete the text files under `data_protection/models/*`
(everything except `openvino_model.bin`) and run
`git checkout -- host/privacy_manager/data_protection/models`; a reported LFS pointer needs
`git lfs pull`.

#### Testing the download against a local mock host

`data_protection/scripts/serve_privacy_models.py` serves `<model>.zip` files on 127.0.0.1 with Range support and
fault injection (`--throttle-kbps`, `--drop-after-bytes`, `--corrupt`, `--ignore-range`,
`--status-for`; see `--help`).

```powershell
# terminal 1: build the zips (needs `git lfs pull`) and serve them, dropping once at 200 MB
cd host/privacy_manager/data_protection
uv run python scripts/gen_model_manifest.py --zip-dir $env:TEMP\privacy-zips
uv run python scripts/serve_privacy_models.py --root $env:TEMP\privacy-zips --port 18990 --drop-after-bytes 200000000

# terminal 2: the service, from a directory without models/ (else the repo copy counts as present)
$dp = (Resolve-Path host/privacy_manager/data_protection).Path
$env:SUPERCLAW_PRIVACY_MODEL_BASE_URL = "http://127.0.0.1:18990"
$env:SUPERCLAW_PRIVACY_MODELS_DIR = "$env:TEMP\privacy-models"
$env:DATA_PROTECTION_API_KEY = "dev-only-secret"
cd $env:TEMP
uv run --project $dp python -m protection_service.servicehub_entry --port 18826

# terminal 3: wake the sanitizer, then watch models_state go downloading -> activating -> ready
Invoke-RestMethod http://127.0.0.1:18826/v1/text/redact -Method POST -ContentType application/json `
  -Headers @{ Authorization = "Bearer dev-only-secret" } -Body '{"text": "Email John Smith at john.smith@example.com"}'
while ($true) { Invoke-RestMethod http://127.0.0.1:18826/health | Select-Object models_state, models_done_bytes, models_total_bytes, ner_backend; Start-Sleep 2 }
```

On an installed build, set `SUPERCLAW_PRIVACY_MODEL_BASE_URL` with `setx`, quit SuperClaw from the
tray, delete `%LOCALAPPDATA%\SuperClaw\privacy_manager\models`, start SuperClaw, and poll
`/health` the same way. Remove the override afterwards
(`reg delete HKCU\Environment /v SUPERCLAW_PRIVACY_MODEL_BASE_URL /f`).

### Logs

`%LOCALAPPDATA%\SuperClaw\security\logs\privacy_manager_<YYYY-MM-DD>.log` (UTC, with `boot_id`),
also mirrored to stdout, which ServiceHub captures. `protection_service/io/run_trace.py` writes a
per-run trace to `pipeline_runs\<session>\<timestamp>_<operation_id>\pipeline.log` in the same
directory.

## Run locally

```powershell
cd host/privacy_manager/data_protection
$env:DATA_PROTECTION_API_KEY = "dev-only-secret"
uv run python -m protection_service.servicehub_entry --host 127.0.0.1 --port 18826

Invoke-RestMethod http://127.0.0.1:18826/health
$h = @{ Authorization = "Bearer $env:DATA_PROTECTION_API_KEY" }
# Deterministic detect + redact (no LRM needed)
Invoke-RestMethod http://127.0.0.1:18826/v1/file/detect_and_redact -Method POST -ContentType application/json `
  -Headers $h -Body '{"source": "C:/path/to/data.csv", "auto_pii": true, "min_confidence": 0.5}'
# Mode-aware protect (reads the mode from LRM; with LRM down the mode is none)
Invoke-RestMethod http://127.0.0.1:18826/v1/file/protect -Method POST -ContentType application/json `
  -Headers $h -Body '{"source_file_path": "C:/path/to/data.csv"}'
```

`python -m data_protection` does not start the server: `__main__.py` is a shim for the frozen exe.
`protection_service/cli.py` (`python -m protection_service`, with `--config`) is a separate
standalone entry point that ServiceHub does not use.

## Test

```powershell
uv run --directory host\privacy_manager\data_protection pytest -q
uv run --directory host\privacy_manager\llm_pipeline pytest -q
```

## Layout

```
data_protection/
  protection_service/   FastAPI app (server.py), config, auth, ServiceHub entry, stores,
                        sanitizer lifecycle (sanitize_state.py), model delivery and manifest
    routes/             one module per route group (protect, review, file, local_read, text,
                        session, restore, health)
    io/                 path mapping, source validation, uploads, registry delivery, run traces
    redaction/          column detection, tabular/document/file redaction, restore handlers
  file_protection/      DPS: detect.py, agents/redact_agent.py, documents.py, io.py,
                        gazetteers, registry, restore, rewrite
  text_protection/      NER text sanitizer (sanitizer.py, _stages.py, _detectors.py, OpenVINO backend)
  common/               import-cheap helpers (error envelope, model naming, validators)
  models/               pplx-pii-masking-ov-int8 (downloaded after install, not bundled)
  scripts/              gen_model_manifest.py, serve_privacy_models.py
llm_pipeline/           see llm_pipeline/README.md
```
