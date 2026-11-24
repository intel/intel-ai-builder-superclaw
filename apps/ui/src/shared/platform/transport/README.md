# `shared/platform/transport/`

HTTP clients for the backends the UI talks to: OpenCode (`opencode*.ts`), ServiceHub
(`servicehub.ts`), the OpenWork server (`openwork-server*.ts`), the LLM Router
(`llmrouter-client.ts`) and Den (`den.ts`). Two adapters reach host services through
ServiceHub's forwarding with the hub token, never through openwork-server, and are the only
files that name those routes: `instance-api.ts` for the Sandbox Manager host API (egress
approvals, chat grants, the Tavily key, channels) and `host-mcp-api.ts` for the host MCP
gateway. Also holds the sandbox networking-mode probe and the managed-workspace token
refresh. Reads the runtime environment (Tauri vs web) through
`~/shared/platform/runtime-env`.

**Allowed imports:** `shared/`, npm and `@different-ai/openwork-contracts/*`. Responses from
the contract-backed adapters are parsed with the contract's schemas.

**Verify:** from `apps/ui`, `pnpm test src/shared/platform/transport/`.

**Contract:** leaf platform adapter; it consumes `shared/contracts` schemas and implements
none.
