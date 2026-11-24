# `@different-ai/openwork-mcp-policy` — shared MCP tool policy

Read-only MCP policy logic shared by the two places that build an OpenCode `tools` map:
the sandbox server's UI gate (`sandbox/server/src/mcp/mcp-tool-gate.ts`) and the channel
router's Slack/Telegram gate (`sandbox/channels/src/mcp-tool-gate.ts`).

**Owner:** the sandbox server MCP module (`sandbox/server/src/mcp/`). A change here changes
both gates, so review it against both.

## What lives here

| File | Covers |
|---|---|
| `src/policy.ts` | The per-workspace policy file (`.opencode/superclaw-mcp-policy.json`): types, path, validation, `readPolicy`, engine tool keys. |
| `src/mcp-config.ts` | Read-only discovery of configured MCP servers from project and global `opencode.jsonc`, including config-level off switches. |
| `src/projection.ts` | Conservative projection of a session permission ruleset into a per-message `tools` map, plus the policy-deny overlay. |

Writes to the policy file and agent-grant resolution stay in `sandbox/server`; this package
only reads.

## Contract

Implements the workspace MCP tool policy as read by both ingress paths. Behaviour and the
documented differences between the two gates are in
[`sandbox/server/src/mcp/README.md`](../../sandbox/server/src/mcp/README.md).

## Allowed dependencies

Node built-ins, `jsonc-parser` and `minimatch` only. No imports from `sandbox/*`, no HTTP
clients, no opencode SDK: callers bring their own transport.

## Build and tests

Consumers import the built `dist/`, so build it before typechecking or testing
`sandbox/server` or `sandbox/channels`:

```sh
pnpm --filter @different-ai/openwork-mcp-policy build
pnpm --filter @different-ai/openwork-mcp-policy test:ci   # typecheck + bun test
```
