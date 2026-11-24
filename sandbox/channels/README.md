# opencode-router

Slack and Telegram bridge for a running OpenCode server. Each message is routed by its
`(channel, identityId, peerId)` binding to a workspace directory and answered by an OpenCode
session there.

In the installed app the router runs as its own role in the `channel` isolation tier, with its
health server on a port from 18848-18851. Sandbox Manager owns its tokens and configuration writes
(see [Installed app](#installed-app)).

- **Contracts:** scoped sends and approvals follow `shared/contracts/src/router-approval.ts`. The
  per-message MCP tool gate uses `@different-ai/openwork-mcp-policy`; its behaviour is described in
  [`sandbox/server/src/mcp/`](../server/src/mcp/README.md).
- **Dependencies:** Bun 1.3+, `@opencode-ai/sdk`, `@slack/socket-mode`, `@slack/web-api`, `grammy`.

## Run from source

```powershell
pnpm -C sandbox/channels setup    # root pnpm install, build, and .env from .env.example
# edit sandbox/channels/.env, then:
pnpm -C sandbox/channels start    # bun dist/cli.js start
```

`start [path]` and `serve [path]` take the workspace directory and `--opencode-url <url>`. The
health server always starts, so `OPENCODE_ROUTER_CONTROL_TOKEN` must be set.

## Configuration

Environment variables (also read from `sandbox/channels/.env`):

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server. |
| `OPENCODE_DIRECTORY` | current directory | Default workspace. |
| `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD` | | OpenCode basic auth. |
| `OPENCODE_ROUTER_CONTROL_TOKEN` | required | Bearer for every health-server route except `/` and `/health`. |
| `OPENCODE_ROUTER_SCOPED_TOKEN` | | Second, limited bearer for the agent's tier (see [Health server](#health-server)). Must differ from the control token. |
| `OPENCODE_ROUTER_HEALTH_PORT` (alias `PORT`) | `3005` | Health server port. |
| `OPENCODE_ROUTER_HEALTH_HOST` | `127.0.0.1` | Health server bind host. |
| `OPENCODE_ROUTER_DATA_DIR` | `~/.openwork/opencode-router` | Holds `opencode-router.db`, `opencode-router.json` and `logs/`. |
| `OPENCODE_ROUTER_DB_PATH`, `OPENCODE_ROUTER_CONFIG_PATH`, `OPENCODE_ROUTER_LOG_FILE` | under the data dir | Override single files. |
| `OPENCODE_ROUTER_MEDIA_DIR` | `<workspace>/.opencode-router/media` | Inbound files. |
| `OPENCODE_ROUTER_OUTBOX_DIR` | unset | When set, outbound files are accepted only from here. |
| `OPENCODE_ROUTER_AGENT_FILE` | unset | Agent definition provided by the host. |
| `OPENCODE_ROUTER_MAX_MEDIA_BYTES` | | Outbound media size limit. |
| `OPENCODE_ROUTER_MODEL` | | Default model, `provider/model`. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ENABLED` | `true` | Single Telegram bot from the environment. |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ENABLED` | `true` | Single Slack app from the environment. |
| `SLACK_ALLOWED_USERS` | | Pre-approved Slack member IDs (see [Approved Slack senders](#approved-slack-senders)). |
| `PERMISSION_MODE` | `inherit` | `inherit`, `allow` or `deny` (below). Any other value stops start-up. |
| `GROUPS_ENABLED` | `false` | Answer in group chats. |
| `TOOL_UPDATES_ENABLED`, `TOOL_OUTPUT_LIMIT` | `false`, `1200` | Tool progress messages and their length. |
| `LRM_API_BASE_URL`, `LRM_API_KEY` | unset | LLMRouter, used only for the reply's model label. Unset or unreachable degrades the label, never the reply. |
| `SC_CHANNEL_SECRET_API_URL` with `SC_CHANNEL_SECRET_RESOLVE_TOKEN` / `SC_CHANNEL_SECRET_MANAGEMENT_TOKEN` | unset | Channel secret adapter that resolves and stores `botTokenRef`/`appTokenRef`. Needed by `slack add`; none runs on the native backend. |
| `LOG_LEVEL` | `info` | |

`PERMISSION_MODE`: `inherit` applies each agent's configured permissions. Channel sessions cannot
show an approval prompt, so tools configured as `ask` are denied with a notice. `allow` grants all
session permissions except the channel's protected web-tool denies; use it only as a deliberate
operator choice. `deny` blocks all session permissions. A stored session created under an older
blanket-allow default is replaced by a new session under the configured mode; the old session stays
in OpenCode unchanged but is no longer used by the channel.

The config file (`opencode-router.json`) holds identities (`channels.telegram.bots[]`,
`channels.slack.apps[]`), `groupsEnabled`, and the host-written `approval` section. Bindings live in
the SQLite database.

## Approved Slack senders

The Slack adapter answers only approved members. Until someone is approved, every DM and mention is
held. The check runs as soon as a message is addressed to the bot, before any file download or
session work.

- A held sender gets one reply naming their member ID, and appears as pending in the app under
  **Connections → Slack**, where the owner approves them. Pending requests live in memory, so a
  restart clears them; the sender is told again on their next message.
- Approving or removing takes effect at once. Approved IDs are stored in the router database
  (`slack_allowed_senders` table), not in `opencode-router.json`, so a concurrent rewrite of that
  file cannot restore a removed sender. One list covers every connected Slack app.
- `SLACK_ALLOWED_USERS` (comma/whitespace-separated `U…`/`W…` IDs) adds entries that cannot be
  removed from the app. `*` is not a wildcard.
- Control API (control token only; the scoped token gets `scoped_token_forbidden`):
  `GET /slack/senders` returns `{ allowed: [{ userId, source }], pending: [{ userId, identityId, firstSeenAt, lastSeenAt, attempts }] }`;
  `POST /slack/senders` with `{ userId, allowed }` approves or removes one.

Telegram has its own model: a public bot answers anyone; a private bot (`access: "private"`)
answers a chat only after `/pair <code>`.

## Telegram setup

1. In Telegram, open **@BotFather**, send `/newbot`, and pick a display name and a username ending
   in `bot`. BotFather replies with the token (`1234567890:ABC…`); `/token` reissues it.
2. In the desktop app, open **Connections → Telegram** and paste the token. For a router you run
   yourself, set `TELEGRAM_BOT_TOKEN`, or add bots with `opencode-router telegram add <token> --id <id>`.
3. Open your bot in Telegram, click **Start**, and send a message.

Router sends to Telegram need a numeric `chat_id`; `@username` is not a valid `peerId`. A user who
never clicked **Start** gets `chat not found`.

## Slack setup

Slack uses Socket Mode, so no public ingress is needed. The bot replies in DMs, and in threads when
`@mentioned` in channels.

**In the desktop app**, use **Connections → Slack → Connect Slack**:

1. Generate an app configuration token on [api.slack.com/apps](https://api.slack.com/apps) (**Your
   App Configuration Tokens**) and paste it. SuperClaw creates its app with the scopes below and
   opens Slack's install page; click **Allow**. The configuration token is used once and not saved.
2. On the app's Socket Mode page, turn on **Enable Socket Mode**, generate the offered app-level
   token (`connections:write`), and paste it. SuperClaw enables Socket Mode and subscribes the events
   itself.

If your workspace requires admin approval for new apps, the install waits up to 15 minutes. The
connected bot has an on/off switch that keeps its tokens. To reconnect, remove the connection first;
removing it leaves the app in your workspace. Sandbox Manager runs this flow; see
[`host/sandbox_manager/README.md`](../../host/sandbox_manager/README.md).

**By hand**, for a router you configure yourself (the desktop app does not accept a hand-made bot
token):

1. **Create the app:** [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From
   scratch**, pick a name and workspace.
2. **Bot token scopes** (**OAuth & Permissions → Scopes**):

   | Scope | Why |
   |---|---|
   | `chat:write` | Required; without it every reply fails with `missing_scope`. |
   | `app_mentions:read` | Receive `app_mention` events in channels. |
   | `im:history` | Read DMs (`message.im`). |
   | `files:read` | Download shared files (`url_private_download` needs the bot token). |
   | `files:write` | Attach files to replies. |
   | `im:read`, `im:write` | Recommended for full DM support. |
   | `chat:write.public` | Optional: post in channels the bot was not invited to. |

3. **Socket Mode** (**Settings → Socket Mode**): turn on **Enable Socket Mode**, generate an
   app-level token with `connections:write`, and copy the `xapp-1-…` value (`SLACK_APP_TOKEN`).
4. **Events** (**Event Subscriptions**): turn on **Enable Events** and subscribe the bot events
   `message.im` and `app_mention`. No Request URL is needed with Socket Mode.
5. **Install** (**OAuth & Permissions → Install to Workspace**, or **Reinstall** after any scope
   change) and copy the `xoxb-…` Bot User OAuth Token (`SLACK_BOT_TOKEN`).
6. Set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (and `SLACK_ENABLED=true`) and start the router.
   `opencode-router slack add <xoxb> <xapp> --id <id>` registers more apps, but only with a channel
   secret adapter configured.
7. DM the bot `hello`. A `🧭 Session started.` message arrives within seconds, then the reply.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Adapter starts, then nothing arrives | Socket Mode is off (`apps.connections.open` returns `Socket Mode is not turned on`) | Enable Socket Mode, then reconnect. |
| `slack inbound handler failed` right after `session created`, or `missing_scope` with `needed: chat:write:bot` | Bot lacks `chat:write` | Add the scope and **reinstall**; scope changes apply only after reinstall. |
| Token shows the new scope but the running bot still gets `missing_scope` | Reinstall rotated the token and the router has the old one | Desktop app: remove the connection and connect again. By hand: copy the new `xoxb-` token and restart. |
| `not_authed` from `apps.connections.open` | App-level token lacks `connections:write`, or the wrong string was copied | Regenerate it with `connections:write`. |
| DMs work, channel messages are ignored | By design the bot answers in channels only when `@mentioned` | Mention the bot or DM it. |

Check what a bot token can do:

```bash
curl -i -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $BOT" | grep -i 'x-oauth-scopes'
curl -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $BOT" \
  -H "Content-Type: application/json" -d '{"channel":"D...","text":"scope-check"}'
```

### What Slack replies look like

- **Markdown** renders natively through Block Kit `markdown` blocks.
- **Model label:** a `Model: <provider/model>` line under each reply. When the reply went through a
  router alias (`auto`, `local-model`, `cloud-model`), the bridge resolves the concrete model from
  LLMRouter's `GET /llm-router/v1/usage/events` at `LRM_API_BASE_URL`, matched by OpenCode session
  ID, and falls back to the alias name.
- **Live status:** while the agent works, Slack's native thinking status
  (`assistant.threads.setStatus`) shows progress in channel threads and DMs, using only
  `chat:write`. When it is unavailable the bot falls back to an editable `🤔 Working on it…`
  message. As a side effect, DM replies are threaded.

Telegram replies are plain.

## Installed app

On the Windows-native backend the router runs as the `channel` tier. Its config file lives in that
tier's data directory (`data\channel\opencode-router\`), which the `file_tool` tier (the agent's
shell and tools, and openwork-server) cannot read.

- **Tokens:** the desktop app saves Slack and Telegram tokens through Sandbox Manager
  (`PUT /sandbox-manager/v1/channels/{slack,telegram}/identities/{id}`). Sandbox Manager verifies
  Slack credentials with the router (`POST /identities/slack/verify`, which neither starts nor
  replaces adapters), writes `botToken`/`appToken` into `channels.slack.apps[]` as the file's owner,
  then applies the identity to the running router. A failed verify or write leaves the running
  identity unchanged; `persisted: true` with `applied: false` means the settings were saved but
  activation failed or is still starting. openwork-server only proxies the router's read-only
  `GET /identities/*`. Entries holding `botTokenRef`/`appTokenRef` from older installs are still
  read but need a channel secret adapter; updating the identity replaces them with tokens.
- **Slack senders:** the app uses `GET /sandbox-manager/v1/channels/slack/senders` and
  `PUT /sandbox-manager/v1/channels/slack/senders/{user_id}` (`{ "allowed": true|false }`, each
  returning the whole list). Only Sandbox Manager and the router's tier hold the control token;
  openwork-server holds only the scoped token, so its `/opencode-router/slack/senders` proxy is
  refused. Without a reachable router, Sandbox Manager answers `channel_credentials_unavailable`,
  `channel_router_unreachable` or `channel_router_rejected`; an ID from `SLACK_ALLOWED_USERS`
  answers `slack_sender_env_managed`.
- **Router-written settings:** bindings, `groupsEnabled` and CLI changes are still written by the
  router into the same `opencode-router.json`.
- **LLMRouter:** `LRM_API_BASE_URL` is the only way to enable the model lookup; the channel tier
  cannot reach an LLMRouter port by guessing.

The router reaches the workspace only through three openings declared in the ACL descriptor
(`tier_openings`):

| Opening | Path | Router | `file_tool` | Used for |
|---|---|---|---|---|
| Inbox | `data\channel\inbox` (`OPENCODE_ROUTER_MEDIA_DIR`) | read/write | read | Files users send; the agent reads them here. |
| Outbox | `data\channel\outbox` (`OPENCODE_ROUTER_OUTBOX_DIR`) | read | write | Files to deliver; outbound files are accepted only from here. |
| Agent definition | `config\channel\agents\superclaw-router.md` (`OPENCODE_ROUTER_AGENT_FILE`) | read | none | The workspace's `superclaw-router.md`, copied in by Sandbox Manager at each router start. |

The MCP tool gate reads the workspace `opencode.jsonc` and `.opencode\superclaw-mcp-policy.json`
through the engine's file API (`GET /file`, `GET /file/content`), so no further opening is needed;
the global OpenCode config is read from the router's own environment.

**Known limitation (#3611):** with an outbox, a `FILE:<path>` reply is delivered only if the file is
already in the outbox; a workspace path is refused with "File not sent: only files staged in the
delivery outbox can be sent." Only openwork-server's `POST /workspace/:id/opencode-router/send`
with `file` stages a file. Without an outbox (development), `FILE:` replies send workspace files.

## Health server

| Route | Auth |
|---|---|
| `GET /`, `GET /health` | none |
| `GET /bindings`, `GET /identities/telegram`, `GET /identities/slack`, `POST /send` | control or scoped token |
| `POST /bindings`, `POST /identities/telegram`, `DELETE /identities/telegram/:id`, `POST /identities/slack`, `POST /identities/slack/verify`, `DELETE /identities/slack/:id`, `GET\|POST /config/groups`, `GET\|POST /slack/senders`, `POST /config/telegram-token`, `POST /config/slack-tokens` (legacy aliases) | control token |
| `GET /v1/admin/approvals`, `POST /v1/admin/grants`, `POST /v1/admin/decisions` | admin secret from the `approval` section of `opencode-router.json` |

When the orchestrator spawns the services itself, it gives openwork-server, OpenCode and the router
one run-scoped control token. In the installed app the broker gives the router both tokens and the
`file_tool` roles (openwork-server, OpenCode) only the scoped token. A standalone deployment must
give each process matching values.

**Scoped sends.** The scoped token cannot set `autoBind`. A scoped send needs no approval when it
targets the conversation of the `sessionId` it names, or a conversation bound to the workspace or
directory. Any other peer is held as a `router.send_new_target` approval (`src/scoped-send.ts`,
`src/send-approvals.ts`) until Sandbox Manager's signed grant arrives on `/v1/admin/*`, or it is
denied or expires after 120 s. Each scoped send writes an audit line with the channel, a redacted
target and the basis, never the text.

Send to every peer bound to a directory, or text plus media to one peer:

```bash
curl -sS "http://127.0.0.1:${OPENCODE_ROUTER_HEALTH_PORT:-3005}/send" \
  -H "Authorization: Bearer ${OPENCODE_ROUTER_CONTROL_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"channel":"telegram","directory":"/path/to/workdir","text":"hello"}'

curl -sS "http://127.0.0.1:${OPENCODE_ROUTER_HEALTH_PORT:-3005}/send" \
  -H "Authorization: Bearer ${OPENCODE_ROUTER_CONTROL_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"channel":"slack","peerId":"D12345678","text":"Here is the export",
       "parts":[{"type":"file","filePath":"./artifacts/report.pdf"},
                {"type":"image","filePath":"./artifacts/plot.png","caption":"latest trend"}]}'
```

Media parts are `image`, `audio` or `file`, with `filePath` and optional `caption`, `filename` and
`mimeType`. `filePath` is absolute or relative to the send directory and must resolve inside that
workspace; traversal and symlink escapes are refused.

## CLI

```bash
opencode-router start|serve [path] [--opencode-url <url>]
opencode-router status | health        # add --json for machine output
opencode-router config get [key] | config set <key> <value>
opencode-router telegram list | add <token> --id <id> | remove <id>
opencode-router slack list | add <xoxb> <xapp> --id <id> | remove <id>
opencode-router bindings list | set --channel telegram --identity <id> --peer <chatId> --dir <path> | clear ...
opencode-router send --channel telegram --identity <id> --to <chatId> --message "hello"
opencode-router send --channel slack --identity <id> --to D123 --file ./report.pdf
```

From source, run these as `bun sandbox/channels/dist/cli.js <command>` after a build.

## Test

```powershell
pnpm -C sandbox/channels test:unit
pnpm -C sandbox/channels test:integration
pnpm -C sandbox/channels test:cli
pnpm -C sandbox/channels test:npx
```

`test:smoke` needs a running OpenCode server at `OPENCODE_URL` (default `http://127.0.0.1:4096`):

```bash
opencode serve --port 4096 --hostname 127.0.0.1
pnpm -C sandbox/channels test:smoke
```

## File-size exception

`src/bridge.ts` is above the 1500-line maximum. It keeps call sites that share the inbound
handler's session queue and migration state: re-applying the `webfetch`/`websearch` denies when a
stored session is reused, Slack sender approvals, legacy-session migration and fail-closed
permission inspection, and constructing the outbox delivery, scoped send and approval hold in
`startBridge`. The logic lives in `src/opencode.ts`, `src/session-lifecycle.ts`,
`src/health-slack-senders.ts`, `src/slack-senders.ts`, `src/scoped-send.ts`,
`src/send-approvals.ts` and `src/messaging-agent-config.ts`; splitting the handler is a separate
change.
