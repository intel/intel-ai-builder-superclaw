# Product Profiles

Each child directory is a complete, self-contained OpenCode configuration root. Profiles are
packaged exactly as authored: none depends on another Profile's files, and nothing merges, filters,
rewrites or deletes Profile files at runtime.

| Profile | Product form | Serves Bundles |
|---|---|---|
| `lite` | Cloud-only, on qualifying hardware without a local Bundle | none |
| `standard` | Local ~4B-parameter model | `local-4b`, `local-gemma-4e4b` |
| `pro` | Local 26B-35B-class model, or a trusted edge model | `local-35b`, `local-27b`, `local-gemma4-26b-a4b`, `edge-qwen3-coder-next-80b`, `edge-qwen3.8-flash-next` |

Selection follows the committed Primary Bundle, or the hardware-qualified cloud-only Lite verdict
when no Bundle is available. Each Bundle in
`host/llmrouter_manager/src/llmrouter_manager/data/bundles.builtin.json` declares
`compatible_product_profiles`; ServiceHub commits the resolved Profile and its digest, and the
sandbox orchestrator verifies the digest and publishes the Profile's directory into the Runtime
generation's OpenCode config directory before OpenCode starts (see
[`sandbox/orchestrator/src/capability/`](../../orchestrator/src/capability/README.md)).
`capability_grade` is only an opaque tag on a Bundle; it never selects a Profile.

## Contract

Each `profile.json` conforms to `ProductProfileDescriptorSchema` in
`shared/contracts/src/capability/product-profile.ts`. It is strict: every field and feature flag is
required, unknown fields are rejected, and the only Profile IDs are `lite`, `standard` and `pro`.

Agents are defined only in `opencode.jsonc`. Sidecars a Profile needs are listed in
`profile.json` `required_sidecars`: `intent-classifier` and/or `hdr-sidecar`.

`package.json` must be byte-identical across the three Profiles, because the runtime reuses one
resolved OpenCode dependency root for whichever Profile is selected. Each Profile's
`lib/protected-source-access.ts` is a byte-identical leaf helper shared by the confirmation guard
and Pro's built-in default guard; custom-agent opt-in comes from the resolved
`confirm_file_protection` permission, not from the agent's prompt or model.

## Validation and packaging

```powershell
pnpm product-profiles:check
```

The validator is read-only. It checks the three directories, their descriptors, required files and
directories, local `{file:...}` references, symlinks (refused), `package.json` parity, and key
feature-to-agent/sidecar consistency.

The Windows build copies this directory unchanged into the ServiceHub payload
(`agent-config\profiles`). The Profile digest is SHA-256 over each Profile's sorted relative paths,
entry types and file bytes (not timestamps or permissions). `packaging/installer/build-servicehub.ps1`
computes it for the source and packaged copies (`shared/contracts/scripts/check-product-profile-parity.mjs`)
and fails if they differ; the orchestrator recomputes it at start-up. Digests are never written into `profile.json` or committed, so do not
hot-edit an installed Profile.

## Todo progress reminders

Each Profile ships `plugins/96_superclaw_todo_reminder.ts`. After a successful `todowrite`, it
attaches a progress reminder to a work-tool result once three later tool batches pass without
another update (one assistant response with several tools is one batch), and again after every
three further batches. A successful update resets the count. The plugin never changes task
statuses, never refuses a tool, and cannot force a `todowrite`.

At a normal final stop with unfinished todos it requests at most one extra reconciliation turn per
real user turn, asking for one accurate `todowrite` based on work already done. That turn is marked
with a persisted `superclaw_todo_final_reminder: { turnID }` part so it never recurses, even after a
restart. It does not run after cancellation, errors, non-normal stops, in child sessions, or for
structured output; a new user message supersedes it.

Reminders and their `superclaw_todo_reminder` metadata are persisted and appear in trajectory
exports; superseded reminder text is dropped only from outgoing model context. The plugin's state
survives compaction while running but can be lost on a restart after older history was compacted.
Its service log (`superclaw-todo-reminder`) reports `Todo reminder initialized`,
`Todo checklist recorded`, `Todo progress reminder attached` and
`Todo final reconciliation requested`.

Changes take effect only after rebuilding and redeploying the Profile and restarting its runtime.
To disable the plugin, remove it from each Profile and rebuild. Its mocked and packaged-runtime
tests run with `pnpm --dir tests/plugins test:ci` (internal test tree; the runtime subprocess test
runs only on Windows).

## File-size exception

`plugins/93_protected_pipeline_terminal_guard.ts` is above the 1500-line maximum in all three
Profiles. It holds the consumed-decline receipt lookup and child-session check that keep host
local-read grants working after plugin 08 consumes the shared decline token; splitting its
terminal and output-restore responsibilities is a separate change.
