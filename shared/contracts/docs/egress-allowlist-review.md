# Egress allowlist review (EG2-3)

Status: **draft**. Contract: `src/egress-allowlist.ts`; data: `src/egress-allowlist-entries.ts`
(generated copies under `generated/`). The Sandbox Manager seals it per proxy listener
(`src/egress-proxy-config.ts`, EG2-4a): in the shipped `log_only` mode the proxy only records what
enforce would refuse (`enforce_would_refuse`); enforce itself is off and has no user-facing switch.
Every entry stays `status: "draft"` until a reviewer signs the list off.

A *carrier* is the one hop a tier's traffic leaves through: `file_tool` -> `egress_proxy_shell`,
`channel` -> `egress_proxy_channel`, `network_connector` -> `connector`. All entries use port 443
only (the proxy tunnels no other port), so in enforce plain HTTP (port 80) is refused for every host
until an entry lists it. In enforce, an unlisted shell destination is held for the user's approval (EG2-4b,
below) and an unlisted channel destination is refused.

## Entries

| Entry | Tier | Carrier | Hosts | Why | Source |
|---|---|---|---|---|---|
| `shell_github` | file_tool | egress_proxy_shell | `github.com`, `api.github.com` | GitHub sign-in (device flow, gh CLI) and git over HTTPS | observed_in_audit |
| `shell_skill_hub` | file_tool | egress_proxy_shell | `api.github.com`, `raw.githubusercontent.com` | Skill marketplace catalog and skill files | required_by_inventory |
| `shell_google_apis` | file_tool | egress_proxy_shell | `gmail.googleapis.com`, `www.googleapis.com`, `oauth2.googleapis.com`, `people.googleapis.com` | Pro Gmail tools (including the display-name lookup, #4011) and the OAuth callback (moves to the Connector at GA) | required_by_inventory |
| `shell_package_registries` | file_tool | egress_proxy_shell | `pypi.org`, `files.pythonhosted.org`, `registry.npmjs.org` | pip, uv, npm installs, including first-run npx/uvx downloads | observed_in_audit |
| `shell_mcp_perplexity` | file_tool | egress_proxy_shell | `api.perplexity.ai` | One-click Perplexity MCP server (#3788) | product_decision |
| `shell_mcp_minimax` | file_tool | egress_proxy_shell | `api.minimax.io` | One-click MiniMax MCP server; the catalog pins `MINIMAX_API_HOST` (#3788) | product_decision |
| `shell_mcp_arxiv` | file_tool | egress_proxy_shell | `export.arxiv.org`, `arxiv.org`, `api.semanticscholar.org` | One-click arXiv MCP server: search API, paper downloads, citation graph (#3788) | product_decision |
| `shell_mcp_remote_catalog` | file_tool | egress_proxy_shell | `api.githubcopilot.com`, `huggingface.co`, `mcp.stripe.com`, `access.stripe.com` | One-click GitHub, Hugging Face and Stripe remote MCP servers and their OAuth servers; GitHub's token exchange uses `github.com` (`shell_github`) | product_decision |
| `channel_slack` | channel | egress_proxy_channel | `slack.com`, `*.slack.com` | Slack Web API, Socket Mode, file downloads; only `slack.com` seen in audit so far | observed_in_audit |
| `channel_telegram` | channel | egress_proxy_channel | `api.telegram.org` | Telegram Bot API (also serves files) | required_by_inventory |
| `connector_tavily` | network_connector | connector | `api.tavily.com` | Web search, made by the Connector | required_by_inventory |

## Categories: what happens to unlisted traffic

| Category | Tier | Unlisted destination |
|---|---|---|
| `shell_caller_chosen` | file_tool | **approval** (user is asked) |
| `channel_caller_chosen` | channel | **refuse** (headless caller, nobody to ask) |
| `connector_fetch_result` | network_connector | **approval**, unchanged (existing EG1-7 hold) |

## Decisions (human, 2026-10-24)

- Entries accepted as drafted for now: no additions or removals. Status stays `draft`.
- Unlisted destinations: shell -> approval; channel -> refuse; Connector fetch -> unchanged.
- The shell approval for an unlisted destination offers: deny, allow once, **allow this site for
  this chat**, and **allow all unlisted destinations for this chat**. A chat grant covers the
  current chat/session only and resets on a new chat or an app restart.
- The grant scopes are approval mechanics, not allowlist data: they live in the approval contract
  (`egress-proxy-approval.ts`, `grant_scope` in `sandbox-manager-host-api.ts`) and are deliberately not
  modelled in the allowlist contract.

## Decision (human, 2026-11-09, owner @fwu91): one-click MCP hosts (#3788)

- The three `shell_mcp_*` entries are fixed entries on `egress_proxy_shell`. They are not added when the
  user installs the MCP server, and they are not limited to MCP traffic.
- `surfaces: ["opencode_local_mcp"]` documents why an entry exists; it scopes nothing at runtime. In
  enforce, the five hosts pass without a prompt for every client of the shell listener, including the
  agent's own shell commands, whether or not the user ever added that MCP server.
- Accepted: these hosts serve the servers' own APIs, and the shell carrier already tunnels
  `api.github.com` and `raw.githubusercontent.com` the same way.
- An MCP server the user adds by hand is not covered: an unlisted host it calls is still offered allow
  once per connection. A per-server grant is not part of this decision.
- Status stays `draft`.

## Decision (human, 2026-11-11, owner @fwu91): one-click remote MCP hosts

- The UI catalog's three remote MCP servers (GitHub, Hugging Face, Stripe) get one fixed entry,
  `shell_mcp_remote_catalog`, on `egress_proxy_shell`, the same way as the one-click local servers
  above, with the same consequences: every client of the shell listener reaches these hosts without a
  prompt in enforce. Its surface is `opencode_catalog_remote_mcp`, kept apart from
  `opencode_remote_mcp` (a Remote URL the user adds), which goes through the MCP gateway at GA.
- The entry lists each server's MCP host and the host OpenCode calls for OAuth discovery, client
  registration and token exchange. Observed in a QA audit on 2026-11-11 (corporate static proxy,
  `log_only`): `api.githubcopilot.com`, `huggingface.co`, `mcp.stripe.com` and `access.stripe.com`, all
  `not_allowlisted`. GitHub's token exchange goes to `github.com`, which `shell_github` already lists.
  The OAuth authorize page opens in the user's browser on the host and does not use this proxy.
- Accepted: `huggingface.co` also serves model and dataset metadata and small files, so an agent shell
  fetch from it passes without a prompt. Large files redirect to other Hugging Face hosts, which are
  not listed and still ask.
- A Remote URL the user adds is not covered here; it moves to the host MCP gateway (#3794, option B).
- Status stays `draft`.

## How the shell approval behaves (EG2-4b, enforce mode only)

- The shipped mode is `log_only`: no request is held and no approval is asked. Everything below applies
  only when the proxy is sealed in `enforce`.
- Only a **public** destination the shell listener's list does not cover (`not_allowlisted`, or a listed host
  on an unlisted port) is held, for at most 120 s. Loopback, link-local, metadata, this host's own and
  private addresses, IP literals, and a name that does not resolve are refused as before, whatever the user
  allowed: `allow all unlisted sites until SuperClaw restarts` never covers them.
- The dialog offers deny, allow once and allow all
  unlisted sites until SuperClaw restarts; it says that covers commands from every chat, not only the one
  asked about (the proxy records it per chat). A deny answers 403 `approval_denied`; an unanswered hold 403
  `approval_expired`; no desktop listening 403 `approval_unavailable`.
- **This chat** is the root session of the conversation; a sub-agent's commands count as its root's. The
  agent plugin `11_superclaw_shell_proxy_credential.ts` tells the proxy by a credential in the command's
  `HTTPS_PROXY`, MAC'd under a key a command cannot read. A command with no valid credential is an unknown
  chat: it is offered allow once only, and nothing it is allowed outlives that request.
- Grants live in the proxy's memory only: they end when the proxy restarts, and a new chat starts with none.
- A session a Slack or Telegram thread owns has no interactive approver: its unlisted destinations are
  refused at once with `no_interactive_approver` and never held.
- The audit line of a request that went through this carries `approval_id`, `approval_decision`
  (`approved`, `denied`, `expired`, `allowed` by an existing grant, `refused`), `grant_scope` and a
  `session_ref` (a hash of the session id, never the id).

## Open questions

1. **Hugging Face / model downloads.** Resolved 2026-11-11: `huggingface.co` is listed for the
   one-click remote MCP server (`shell_mcp_remote_catalog`, decision above). OpenCode reaches that server
   directly from the tier, not through the MCP gateway. Model files on other Hugging Face hosts still
   fall under the shell approval.
2. **Gmail moves to the Connector at GA.** `shell_google_apis` is an M1-era entry; at GA the
   inventory sends those surfaces `via_connector`. Decide whether the entry is deleted then or
   becomes a Connector entry.
3. **Telegram is not yet observed.** `channel_telegram` rests on the inventory alone; no audited
   session has run Telegram.
4. **Slack hosts.** Only `slack.com` is audited. `*.slack.com` (Socket Mode, file hosts) is
   inventory-derived; check real Socket Mode traffic.
5. **Shared `api.github.com`.** Two entries cover it, so skill hub traffic and gh traffic are
   indistinguishable at host level.
6. **Package registries as a tunnel.** `pypi.org` and `registry.npmjs.org` let any package, and so
   any package's install script, through. Accepted as drafted; revisit with approval grants.
7. **Tavily direct surfaces** are `not_on_native_path`; the entry exists because the
   Connector makes the call, not because those tiers reach the host.
