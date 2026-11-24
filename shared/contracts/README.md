# `@different-ai/openwork-contracts` — wire schemas

The single source of truth for shapes that cross a process boundary in SuperClaw. SuperClaw's
processes talk over HTTP, pipes and files, not shared memory, so this package holds **data and
codegen, not behavioural interfaces**. Each shape is authored once in Zod and the bindings other
languages need are generated and committed.

## What lives here

Sources are `src/*.ts` and `src/capability/*.ts`. The main families:

| Family | Modules (`src/`) |
|---|---|
| Status and model routing | `runtime-status` (unified status payload), `model-routing`, `perf-weight`, `local-ctx-size` |
| Capability | `capability/`: `product-profile`, `model-bundle`, `model-binding`, `model-binding-activation`, `primary-bundle`, `app-capability-profile`, `app-readiness`, `runtime-deployment`, `runtime-profile-control`, `common` |
| Native isolation | `acl-policy-*`, `native-isolation-broker-*`, `native-path-contract`, `workspace-root-vocabulary`, `agent-runtime-*`, `isolation-reporting` |
| Network egress | `egress-policy-*`, `egress-allowlist*`, `egress-surface-inventory*`, `egress-loopback-*`, `egress-approval-grant`, `egress-proxy-*` |
| Host and channel APIs | `sandbox-manager-host-api`, `sandbox-manager-channel-messaging`, `host-mcp-api`, `servicehub-forwarding`, `connector-ipc`, `router-approval` |
| Workspace server | `mcp`, `config-patch`, `skill-package`, `feedback-ingest`, `security`, `correlation-id` |

## Generated artifacts (`generated/`)

Everything under `generated/` is produced by `pnpm contracts:gen` and committed:

| Directory | Contents |
|---|---|
| `json-schema/` | One JSON Schema (draft 2020-12) per schema registered in `DESCRIPTORS` (`scripts/gen.mjs`). |
| `python/contracts/` | Pydantic v2 models for the same schemas, plus `*_data.py` modules holding descriptor and table values (model routing, ACL and egress policy, loopback ports, user-facing copy, …). |
| `data/` | Canonical JSON values: model routing, agent-runtime descriptors, ACL and egress policy descriptors, egress surface inventory, isolation reporting, and others. |
| `ts/` | `model-routing.gen.ts` and `agent-runtime-descriptors.gen.ts` typed constants. TypeScript consumers otherwise import the Zod sources. |

## Regenerating

Install from the repository root with `pnpm install --frozen-lockfile`; the root `pnpm-lock.yaml`
owns this package's dependencies. Then:

```powershell
pnpm contracts:gen
```

JSON and TypeScript outputs need only Node. Pydantic generation runs `datamodel-code-generator` via
`uvx` ([uv](https://docs.astral.sh/uv/)); without `uvx` the script keeps the committed Python
bindings, warns, and regenerates the rest.

**Drift gate:** CI runs `pnpm contracts:gen` and fails on any diff under `shared/contracts`, so a
schema change must be committed together with its regenerated bindings.

## Importing

TypeScript consumers import the root barrel (`@different-ai/openwork-contracts`) or a subpath:
`/capability`, `/runtime-status`, `/model-routing`, `/mcp`, `/config-patch`, `/skill-package`,
`/feedback-ingest`, `/sandbox-manager-host-api`, `/sandbox-manager-channel-messaging`,
`/host-mcp-api`, `/egress-approval-grant`, `/egress-allowlist`, `/egress-proxy-approval`,
`/router-approval`, and `/data/*.json` for the generated data. Exports point at `dist/`, so run
`pnpm --filter @different-ai/openwork-contracts build` before building a consumer.

The barrels `src/index.ts` and `src/capability/index.ts` are generated from `DESCRIPTORS` (plus a
short `EXPORT_ONLY_MODULES` list) and committed. Do not hand-edit them; register the schema
instead.

## Product Profile checks

```powershell
pnpm product-profiles:check    # read-only validation of sandbox/agent_config/profiles
```

`scripts/check-product-profile-parity.mjs <source-root> <packaged-root>` compares Profile digests
between a source and a packaged copy; the Windows ServiceHub build calls it.

## Egress surface inventory

`src/egress-surface-inventory.ts` (the shape) and `src/egress-surface-inventory-entries.ts` (the
entries) list every network surface the product's code opens: the process, the destination, and
its disposition at each enforcement stage (`m1`, `ga`). CI reads
`generated/data/egress-surface-inventory.json`: every call site it finds needs an
`egress-surface: <id>` comment within three lines above it, and every `source: repo` entry needs a
call site. A test holds the loopback entries to the loopback reachability facts
(`EGRESS_LOOPBACK_ENDPOINT_FACTS` in `src/egress-policy-descriptor.ts`) in both directions.

## Egress allowlist (draft)

`src/egress-allowlist.ts` (the shape) and `src/egress-allowlist-entries.ts` (the entries) list, per
tier and carrier, the hosts and ports that enforce mode lets through and what happens to unlisted
traffic. Sandbox Manager's egress proxy wiring reads it; every entry is still `status: "draft"`.
The decisions and open questions are in [docs/egress-allowlist-review.md](docs/egress-allowlist-review.md).

Entries whose `source` is `upstream_opencode` or `agent_command` have no call site to scan, so they
are kept current by hand. On every OpenCode upgrade (`opencodeVersion` in
`sandbox/orchestrator/package.json` and the `opencode` entry in `patches/upstream.lock.json`):

1. Read the release for network use: update check, models.dev, LSP downloads, webfetch, websearch,
   MCP, session sharing, plugin installs, and anything new.
2. Check that each `disabled_by_environment` entry is still turned off by the variable the runtime
   starts with.
3. Check that each `denied_by_profile` entry is still off in all three Profiles.
4. Check that the native payload still seeds every npm plugin a Profile lists.
5. Add an entry, with its `m1` and `ga`, for any surface the release adds.

## Tests

```powershell
pnpm --filter @different-ai/openwork-contracts test:ci   # typecheck + vitest
```

## File-size exceptions

- `src/isolation-reporting.ts` is above the 1500-line maximum. It holds the isolation-report
  contract, including the diagnostic compatibility check in `refuseIsolationReport` and the
  `host_mcp_execution_enabled` warning, next to the shared refusal vocabulary. Covered by the
  isolation-report golden tests.
- `src/egress-policy-descriptor.ts` is above the 1500-line maximum. The tier table, its coverage
  check and the loopback dynamic-range rules that constrain it stay together; the host-range rule
  itself lives in `src/egress-loopback-dynamic-range.ts`.
