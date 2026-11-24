# OpenWork Orchestrator (`openwork`)

The sandbox supervisor. `openwork start` / `openwork serve` publishes the packaged Product Profile
for the OpenCode runtime (see [`src/capability/`](src/capability/README.md)), then starts or
connects to OpenCode, openwork-server (`sandbox/server`) and opencode-router (`sandbox/channels`),
and runs the intent classifier when the Profile requires it. The same binary has client commands
for approvals, health and file sessions.

## How the installed app runs it

Sandbox Manager launches every role through the native isolation broker, each in its own isolation
tier. The supervisor runs as:

```text
openwork.exe serve --workspace <ws> --opencode-directory <ws>
  --openwork-host 127.0.0.1 --openwork-port <8787> --opencode-host 127.0.0.1 --opencode-port <runtime port>
  --external-opencode --opencode-auth --connect-host 127.0.0.1 --approval auto --allow-external
  --external-openwork-server --external-opencode-router --opencode-router-health-port <router port>
  [--external-hybrid-dr --hybrid-dr-port <port>]
```

The `--external-*` flags mean OpenCode, openwork-server and opencode-router are separate roles
that the broker already started; the supervisor connects to them instead of spawning them. Ports
come from the fixed candidate lists in `shared/contracts/src/egress-loopback-ports.ts` (runtime
18840-18843, router health 18848-18851); openwork-server uses Sandbox Manager's `sandbox_port`
(default 8787).

## Runtime deployment inputs

`start` and `serve` refuse to run without a Runtime deployment from the host. These come from the
environment, never from flags:

| Variable | Meaning |
|---|---|
| `SUPERCLAW_RUNTIME_DEPLOYMENT_B64` | Base64 JSON `RuntimeDeploymentSpec`: the committed `product_profile_id` and `product_profile_digest`. |
| `SC_RUNTIME_DESIRED_FINGERPRINT` | SHA-256 of the desired Runtime. |
| `SC_RUNTIME_INSTANCE_ID`, `SC_RUNTIME_LAUNCH_ATTEMPT_ID` | `runtime-instance-<hex>` and `runtime-attempt-<hex>` for this generation. |
| `SC_RUNTIME_GENERATION_ROOT` | Parent of per-instance generations. `OPENCODE_CONFIG_DIR` must equal `<root>/<instance id>/opencode`. |
| `SC_PRODUCT_PROFILE_SOURCE_ROOT` | Directory holding the packaged `lite`/`standard`/`pro` Profiles. |
| `SC_OPENCODE_DEPS_ROOT` | Shared OpenCode dependency scaffold. |
| `SC_RUNTIME_CONFIG_DIR` | Runtime state directory. |

The Profile digest is recomputed at start; a mismatch with the committed digest stops start-up.

## Commands

```text
openwork start|serve [--workspace <path>] [options]   # start runs a TUI in a TTY; serve logs only
openwork daemon run|start|stop|status                  # router daemon: one OpenCode, many workspaces
openwork workspace add|add-remote|list|switch|info|path
openwork instance dispose <id>
openwork approvals list --openwork-url <url> --host-token <token>
openwork approvals reply <id> --allow|--deny --openwork-url <url> --host-token <token>
openwork files session create|renew|close, catalog, events, read, write, mkdir, delete, rename
openwork status --openwork-url <url> --opencode-url <url>
```

`openwork --help` lists every flag. File-session commands take `--openwork-url`, `--token`
(client token), `--workspace-id` and `--json`, for example:

```text
openwork files session create --openwork-url http://127.0.0.1:8787 --token <t> --workspace-id <id> --write --json
openwork files read <session-id> --openwork-url http://127.0.0.1:8787 --token <t> --paths "README.md,notes/todo.md" --json
```

`start --check --check-events` starts the services, verifies health and SSE events, then exits.

## Options

| Flag | Environment | Effect |
|---|---|---|
| `--external-opencode`, `--external-openwork-server`, `--external-opencode-router` | `OPENWORK_EXTERNAL_OPENCODE`, `OPENWORK_EXTERNAL_OPENWORK_SERVER`, `OPENWORK_EXTERNAL_OPENCODE_ROUTER` | Connect to an already running service. |
| `--allow-external` | `OPENWORK_ALLOW_EXTERNAL=1` | Required for `--opencode-bin`, `--openwork-server-bin`, `--opencode-router-bin` and external services. |
| `--sidecar-source`, `--opencode-source` (`auto` \| `bundled` \| `downloaded` \| `external`) | `OPENWORK_SIDECAR_SOURCE`, `OPENWORK_OPENCODE_SOURCE` | Where binaries are resolved from. |
| `--sidecar-dir`, `--sidecar-base-url`, `--sidecar-manifest` | `OPENWORK_SIDECAR_DIR`, `OPENWORK_SIDECAR_BASE_URL`, `OPENWORK_SIDECAR_MANIFEST_URL` | Download cache and SHA-256 manifest location. The default manifest is upstream OpenWork's GitHub release for this version. |
| `--opencode-router-required` | `OPENWORK_OPENCODE_ROUTER_REQUIRED=1` | Exit if the router stops; otherwise the router is optional. |
| `--no-opencode-router` | | Do not run the router. |
| `--opencode-hot-reload`, `--no-opencode-hot-reload`, `--opencode-hot-reload-debounce-ms` (700), `--opencode-hot-reload-cooldown-ms` (1500) | `OPENWORK_OPENCODE_HOT_RELOAD`, `..._DEBOUNCE_MS`, `..._COOLDOWN_MS` | OpenCode hot reload; on by default. |
| `--data-dir` | `OPENWORK_DATA_DIR` | Orchestrator and router state. |
| `--log-format json`, `--run-id` | `OPENWORK_LOG_FORMAT`, `OPENWORK_RUN_ID` | One log stream for all services; JSON is OpenTelemetry-friendly, the run id correlates it. |
| `--verbose` | `OPENWORK_VERBOSE=1` | Extra diagnostics about resolved binaries. |
| `--detach` | `OPENWORK_DETACH` | Leave services running and exit the dashboard. |

The upstream container options (`--sandbox`, `--sandbox-image`, `--sandbox-persist-dir`,
`--sandbox-mount` and their `OPENWORK_SANDBOX*` variables) were removed; setting any of them fails
at start with an error naming it.

## Build

`pnpm --filter openwork-orchestrator build:bin` compiles `dist/bin/openwork`. That binary is
multi-call: invoked as (or hard-linked to) `openwork-server` or `opencode-router`, or given that
role as its first argument, it runs that CLI instead (`src/runtime-entry.ts`). Use hard links:
role selection reads `basename(process.execPath)`, which a symlink loses. The Windows payload
(`scripts/native-backend/build-native-backend.ps1`) builds `openwork.exe`, `openwork-server.exe`
and `opencode-router.exe` separately.

## Test

```powershell
pnpm --filter openwork-orchestrator test:ci        # typecheck + bun tests (excludes test/smoke)
pnpm --filter openwork-orchestrator test:router    # router daemon smoke
```

## File-size exception

`src/cli.ts` is above the 1500-line maximum. It passes the intent-classifier endpoint and
credential explicitly to the classifier, openwork-server and router; splitting `runStart` is a
separate change.
