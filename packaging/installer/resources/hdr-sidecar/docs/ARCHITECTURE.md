# Architecture

## Graph compilation strategy

The pipeline is one LangGraph `StateGraph` with eight phase nodes wired
by conditional edges plus a supervisor router. The supervisor is what
the current opencode primary used to do (call `task(subagent_type)` in
a loop); LangGraph absorbs it as a graph edge function and the
primary's role shrinks to "start the graph + wait for the final
state".

```
                          ┌──────────────┐
                          │   START      │
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │ input_local  │  (skipped when data_dir empty)
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │ input_web    │
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │    plan      │
                          └──────┬───────┘
                                 │
                                 ▼
              ┌───────────  section_write  ───────────┐
              │            (parallel S1..SN)          │
              └─────────────────────┬─────────────────┘
                                    │
                                    ▼
              ┌───────────     fill     ──────────────┐
              │           (parallel per Si)           │
              └─────────────────────┬─────────────────┘
                                    │
                                    ▼
              ┌──────── conclusion (cand_1 + cand_2)  ┐
              │              ↓ scorer                 │
              └─────────────────────┬─────────────────┘
                                    │
                                    ▼
                          ┌──────────────┐
                          │   assemble   │
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │    polish    │
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │     END      │
                          └──────────────┘
```

### Conditional edges

The pre-existing pipeline_config.json drives:

- which phases are skipped (`skip.input_local`, `skip.polish`, etc.)
- candidate counts (`candidates.section_write = 2`, etc.)
- retry budgets (`retries.section_write = 3`, etc.)
- per-phase concurrency (`concurrency.stage1_local_workers = 5`)

The graph reads pipeline_config.json at compile time and bakes these
into the edge conditions. `task_class` (deep_research / ten_task /
officeqa) selects which config block.

### Supervisor pattern (replaces hybrid-dr-primary)

There is no separate "primary" agent any more. The graph is the
supervisor: each node returns a state delta describing whether the
phase succeeded, failed, or needs a retry, and conditional edges decide
the next node. The primary-prompt that today says "call task() in a
loop with subagent_type=next" disappears.

### Subgraph composition

`section_write` and `fill` phases are themselves small graphs:

- `section_write[i]` = writer-node → reviewer-node → (pass: write final |
  fail: increment attempt → retry up to N)
- `fill[i]` = filler-node only

Modeling these as subgraphs makes the per-section retry loop a
first-class graph construct, not a manual loop with retry counters
spread across plugin 02 / pipeline_state.ts.

## State (Pydantic)

See `src/hybrid_dr_orchestrator/state.py`.

The state object matches today's `pipeline_state.json` field-for-field
so the two formats are mutually convertible during the migration
window. After migration we can simplify (drop `fill_conclusion`
intermediate phase that the orchestrator drift-creates today, etc.).

## LLM calls

Every LLM call goes to llmrouter at `http://127.0.0.1:18321/v1/chat/completions`
with the OpenAI wire format, model name = one of:

- `local-model` — local llama-server
- `cloud-model` — cloud egress (today: openrouter z-ai/glm-5)

llmrouter applies PII sanitize on outbound and restore on return. The
sidecar never bypasses it — the L0/L2 contract enforcement point stays
the same.

## Persistence / checkpointing

LangGraph has built-in checkpointing (sqlite / postgres / memory). We
use sqlite at first, file at
`/workspace/deep-research-workspaces/sessions/<sid>/checkpoint.sqlite`.

For backwards compatibility during migration, we also dump the state
to `pipeline_state.json` after every state change so the old observers
(plugin 02's `progress.jsonl`, our monitor script) keep working.

## HTTP surface

```
POST /v1/hybrid-dr/sessions
  Body: { task_id, user_query, privacy_tier, data_paths,
          task_class?, model_for_cloud?, model_for_local? }
  → 201 { session_id, root_dir }

POST /v1/hybrid-dr/sessions/{sid}/advance
  → 200 { current_phase, completed_phases[], failed_phases[], deltas }
  Used by the opencode bridge to drive the graph one step at a time
  (or stream all the way to terminal in non-interactive mode).

GET /v1/hybrid-dr/sessions/{sid}/state
  → 200 (full state object)

GET /v1/hybrid-dr/sessions/{sid}/stream  (SSE)
  Streams state deltas + phase events for live UI.

POST /v1/hybrid-dr/sessions/{sid}/cancel
  → 200 { cancelled: true }
```

## Tool glue (opencode side)

The `hybrid-deep-research` root agent calls
`hybrid_dr_post_polish_processor` exactly once. The tool creates a sidecar
session, drives `/advance` until completion, and returns report paths for the
UI report panel. There is no deployed Hybrid-DR model-injection plugin in the
runtime path; the tool defaults the sidecar cloud endpoint to LLMRouter
`cloud-model`.

## Migration order

Strangler-fig: run sidecar + plugin together but only one owns the
phase at a time. Roll phase-by-phase from "easy and stateless" to
"complex and stateful":

1. **polish** — single-shot, single subagent, well-bounded. Run on
   sidecar; old polisher SKILL.md becomes a no-op.
2. **assemble** — pure file concat, deterministic.
3. **conclusion** — two candidates + a scorer; subgraph proof.
4. **fill** — per-section loop, parallelism proof.
5. **section_write** — writer/reviewer subgraph, retries proof.
6. **plan** — single planner call.
7. **input_web** + **input_local** — fan-out research.

Each step is its own PR.
