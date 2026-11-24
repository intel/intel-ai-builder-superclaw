# Hybrid-DR sidecar — tunable hyperparameters

Index of every knob the langgraph sidecar exposes, with default values
(branch `feat/hybrid-dr-langgraph-sidecar`), the value used in the
`pplx golden-query` test run (2026-06-11), and a short note on what
the field controls and how to change it.

Two tiers of knobs:

1. **Pipeline-config-driven** — settable per `task_class` in
   `pipeline_config.json` without code changes. Runner re-reads on every
   `Runner.__init__`.
2. **Hardcoded in node dataclasses** — currently only settable by
   editing the node source. Each is a Pydantic-friendly dataclass field
   with a default; the runner does not plumb them through
   `pipeline_config.json` yet (see Section 3 for a thin-list of fields
   that probably should be promoted to pipeline-config).

The L0 / L2 privacy tier toggle is a CreateSessionRequest field
(`privacy_tier: "0"` or `"2"`), not a tunable here — it routes through
the per-phase agent variant names instead.

---

## 1. Pipeline-config-driven (`pipeline_config.json` → `task_classes.deep_research`)

| Field | Default | pplx run | Notes |
|---|---|---|---|
| `report_shape.max_sections` | `2` | `8` | Integer required (sidecar Pydantic rejects `null`). Planner targets this many sections. |
| `report_shape.expected_length_words` | `"150-250"` | `"800-2000"` | Format `"min-max"`. Each section aims for this word range. |
| `candidates.section_write` | `2` | `3` | Number of writer attempts per section before reviewer picks one. |
| `candidates.conclusion` | `2` | `3` | Number of conclusion drafts the scorer chooses from. |
| `retries.input_local` | `2` | `2` | Reranking depth on local-analyst output. |
| `retries.input_web` | `1` | `1` | Reranking depth on web-researcher output. |
| `retries.plan` | `2` | `2` | Planner retries if its JSON shape is invalid. |
| `retries.section_write` | `3` | `4` | Section-writer retries if the reviewer fails it. |
| `retries.fill` | `1` | `1` | Local-filler retry budget. |
| `retries.conclusion` | `1` | `1` | Conclusion-writer retry budget. |
| `retries.assemble` | `0` | `0` | Pure-Python step, never needs retry. |
| `retries.polish` | `0` | `0` | Polisher is a single LLM round; retries here are wasteful. |
| `concurrency.stage1_local_workers` | `5` | `5` | Parallel local-analyst workers in input_local phase. |
| `concurrency.stage2_web_workers` | `5` | `5` | Parallel web-researcher workers in input_web phase. |
| `concurrency.stage4_writer_workers` | `4` | `4` | Parallel section-writer workers. |
| `concurrency.stage4_reviewer_workers` | `4` | `4` | Parallel section-reviewer workers. |
| `skip.input_local` | `false` | `false` | Set true when there is no local corpus to read. |
| `skip.input_web` | `false` | `false` | Set true when web is not needed (offline mode). |
| `skip.fill_conclusion` | `false` | `false` | Combined fill + conclusion skip flag. |
| `skip.polish` | `false` (sidecar branch) / `true` (upstream main) | `false` | When skipped, `assembled_report.md` is the deliverable; `executive_report.md` is not written. |
| `total_budget_sec` | `3600` | `18000` | End-to-end wall-clock budget for the whole pipeline. |

Three reference profiles are documented in the upstream config's
`_recommended_values_2026_05_21` block:

- **Fast iteration / verification** — `max_sections=2`, `total_budget=3600`,
  `expected_length="150-250"`
- **Balanced (some breadth)** — `max_sections=4`, `total_budget=7200`,
  `expected_length="400-800"`
- **High-recall production** — `max_sections=null` (planner-chosen),
  `total_budget=18000`. NOTE: the sidecar's Pydantic validator currently
  rejects `null`, so high-recall in the sidecar means picking a large
  integer (the pplx run used `8`).

## 2. Hardcoded in node dataclasses

These live as `@dataclass(frozen=True)` field defaults under
`src/hybrid_dr_orchestrator/nodes/`. Override path today is to construct
the context with a non-default value; the runner only plumbs `model`
(via `session_config.cloud_model`) and stage-specific dirs from
`SessionLayout`.

### `nodes/input_local.py`

| Field | Default | pplx run | Notes |
|---|---|---|---|
| `max_files` | `50` | `50` | Hard cap on the number of files the local-analyst will read from `data_paths`. If your corpus has more, only the first 50 (alphabetical-ish) are seen. |
| `preview_bytes` | `4000` | `4000` | First N bytes of each file fed into the local-analyst's "preview before deciding what to extract" pass. |

### `nodes/input_web.py`

| Field | Default | pplx run | Notes |
|---|---|---|---|
| `n_subquestions` | `5` | `5` | Sub-questions derived from `user_query` for the web search fan-out. Each sub-question produces one `W-NNN.md`. **Drives the size of the References section directly** — 5 subq → 5 web refs. |
| `hits_per_query` | `8` | `8` | URLs the search backend returns per sub-question. Synthesized into one W-NNN; only the top URL ends up in `References`. |
| `model` | `"cloud-model"` | `"cloud-model"` | LLM key in `llmrouter` serve.yaml. Override via `session_config.cloud_model`. |
| `max_tokens` | `2048` | `2048` | Per LLM call inside input_web. |
| `concurrency` | `3` | `3` | Async fan-out for sub-question workers. |

### `nodes/plan.py`

| Field | Default | pplx run | Notes |
|---|---|---|---|
| `max_sections` | `5` | n/a (planner uses pipeline-config value above when supplied) | Internal default if pipeline-config does not specify. |
| `expected_length_words` | `"1500-2500"` | n/a (overridden by pipeline-config above) | Internal default. |
| `model` | `"cloud-model"` | `"cloud-model"` | |
| `max_tokens` | `4096` | `4096` | Planner output is JSON; can be large for many-section plans. |

### `nodes/section_write.py`

| Field | Default | pplx run | Notes |
|---|---|---|---|
| `model_writer` | `"cloud-model"` | `"cloud-model"` | Cloud-writer model. |
| `model_reviewer` | `"cloud-model"` | `"cloud-model"` | Section-reviewer model. |
| `max_tokens_writer` | `2048` | `2048` | Per section write. |
| `max_tokens_reviewer` | `1024` | `1024` | Per reviewer pass. |
| `max_attempts` | `3` | `3` | Inner-loop attempts per section before giving up. |
| `concurrency` | `4` | `4` | Parallel section workers (also see `pipeline_config.concurrency.stage4_writer_workers`). |
| `target_words_default` | `500` | `500` | Fallback target if planner did not specify section length. |

### `nodes/fill.py`

| Field | Default | pplx run | Notes |
|---|---|---|---|
| `model` | `"local-model"` | `"local-model"` | Local-filler model. Always local because it sees raw L-data. |
| `max_tokens` | `2048` | `2048` | Per fill pass. |
| `concurrency` | `1` | `1` | Filler runs sequentially across sections by default. |

### `nodes/conclusion.py`

| Field | Default | pplx run | Notes |
|---|---|---|---|
| `n_candidates` | `2` | `2` | Number of conclusion drafts before scorer ranks. |
| `model_writer` | `"cloud-model"` | `"cloud-model"` | Conclusion-writer model. |
| `model_scorer` | `"cloud-model"` | `"cloud-model"` | Conclusion-scorer model. |
| `max_tokens_writer` | `2048` | `2048` | |
| `max_tokens_scorer` | `1024` | `1024` | |

### `nodes/assemble.py`

| Field | Default | pplx run | Notes |
|---|---|---|---|
| `title` | `"Assembled Report"` | n/a (per-session via CreateSessionRequest `title`) | The H1 of the assembled report. |

### `nodes/polish.py`

| Field | Default | pplx run | Notes |
|---|---|---|---|
| `model` | `"cloud-model"` | `"cloud-model"` | Polisher model. Reads `assembled_report.md` body and condenses it. |
| `local_model` | `"local-model"` | n/a | At tier 2 with local files, polish stays on `model` but every paragraph the cloud did not draft itself is masked and put back locally afterwards. `local_model` is used only when the cloud drafts are unavailable. |
| `max_tokens` | `8192` | `8192` | Polisher's output is the full `executive_report.md`. |
| `EXEC_MIN_BYTES` (module-level) | `500` | `500` | Polisher output below this is treated as a stub and rejected. |

## 3. Knobs that probably should be promoted to `pipeline_config.json`

The hardcoded defaults that meaningfully change report quality / shape
but are not yet pipeline-config-driven:

- `input_local.max_files` — corpus-size cap (matters for large data
  directories).
- `input_web.n_subquestions` — directly sets the upper bound on the
  References section size.
- `input_web.hits_per_query` — affects ranking quality of W-NNN.
- `section_write.max_attempts` — interplays with reviewer strictness.
- `section_write.target_words_default` — affects per-section length when
  planner is silent.
- `conclusion.n_candidates` — currently duplicated in
  `pipeline_config.candidates.conclusion`; consolidate.

A follow-up PR can plumb these through `pipeline_config.json` →
`Runner._build_phase_context()` so they are settable without code
changes.

## 4. LLM provider config (out-of-scope for this doc)

The actual model names + base URLs live in
`/config/llmrouter/serve.yaml` and are picked up by the LLMRouter
sidecar at `:18321`. The langgraph sidecar references them by the
short keys `cloud-model` / `local-model`; what those resolve to is an
LLMRouter concern, not a hybrid-DR sidecar concern.

For the pplx run on 2026-06-11:

- `cloud-model` → `z-ai/glm-5` via OpenRouter
- `local-model` → `qwen3.6-35b-a3b` on host llamacpp

## 5. Privacy tier toggle

`POST /v1/hybrid-dr/sessions` accepts `privacy_tier: "0"` or `"2"`.

- `"0"` (L0) — local-tier subagent variants (`hybrid-dr-*-l0`). Local
  data CAN appear in cloud envelope.
- `"2"` (L2) — privacy tier. Local-tier subagent variants
  (`hybrid-dr-*-l2`). L-data raw + derived summary are banned from the
  cloud envelope. Cloud agents read only `cloud_intermediate/`.

Both tiers run cloud + local agents. The pplx test ran every query at
L2.
