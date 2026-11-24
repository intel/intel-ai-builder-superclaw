# browser

The visible host browser: a dedicated Edge the gateway launches as the user, and the filtered CDP
relay `@playwright/mcp` (in the tier) drives it through.

- **Ownership:** host MCP execution lane, visible browser.
- **Contract:** `shared/contracts/src/host-mcp-api.ts`: `HostBrowserConfigRequest`, `HostBrowserView`,
  the relay routes, and `HOST_MCP_RULES["cdp"]` (the filter's domain, method and scheme lists, read
  from the generated `contracts.host_mcp_api_data`).
- **Allowed dependencies:** the standard library, `starlette` (WebSocket), `loguru`, the generated
  `contracts` package, and `mcp_host_manager.job` / `mcp_host_manager.stdio_host` (Job Objects and
  the scrubbed child environment). No FastAPI app code: `app.py` mounts the routes.
- **Tests:** `uv run pytest tests/browser` from `host/mcp_host_manager`. Tests that launch a real,
  visible Edge are opt-in: set `SUPERCLAW_TEST_HOST_EDGE=1` on a Windows desktop.
  `tests/browser/e2e_playwright_relay.py` is a dev script that drives the relay with
  `playwright-core` and `@playwright/mcp`; re-run it on new Edge builds (see "Residual").

## Modules

- `edge.py`: finds `msedge.exe` (the two Program Files installs, then the machine App Paths entry;
  never the per-user one) and launches it only if `authenticode.py` confirms a valid Microsoft
  signature. It starts Edge with `--remote-debugging-pipe` and a dedicated `--user-data-dir`,
  suspended, in a `HostJob` with no limits, then resumes it, with `--no-startup-window` and no
  start-up URL, so no window opens in the default context (the pipe keeps Edge running with no
  window, measured on Edge 156). The contract's `edge_required_args` restrict ambient Windows
  authentication (`--auth-server-allowlist=none.invalid`,
  `--auth-negotiate-delegate-allowlist=none.invalid`) and carry the launch's only
  `--disable-features` (Chromium reads just the last one): `msEdgeSidebarV2,msImplicitSignin`. The DevTools pipe is CRT descriptors 3
  and 4, handed over in `STARTUPINFOW.lpReserved2`; only those two handles are inherited. No
  DevTools TCP port exists, and Chromium's own sandbox is untouched. Memory is bounded: one message
  from Edge is at most 64 MiB (beyond that the client is closed with 1009 and Edge is replaced on
  the next connection), and each direction queues at most 128 MiB (reading stops until the relay
  catches up; a client that outruns Edge is closed with 1009).
- `cdp_filter.py`: the decision for each client command: forward, rewrite (downloads, upload
  paths), refuse, resolve the host first (private-network destinations), or ask about an origin.
  Every destination the client supplies (`Page.navigate`, `Target.createTarget`,
  `Fetch.continueRequest`, and a `Location` header written by `Fetch.fulfillRequest` or
  `Fetch.continueResponse`) gets the same policy: only `http`, `https` and exactly `about:blank`,
  normalized as Chromium does; the contract's blocked schemes; no private-network destination; a
  host that does not resolve is refused; then the origin policy. A host is IDNA-encoded before its
  trailing dots are stripped (so `。` and `．` cannot hide one) and must then be a plain
  `[a-z0-9._-]` name. A response the client writes may not carry a `Refresh` header.
  `Network.loadNetworkResource` and `Network.continueInterceptedRequest` are refused outright. A key
  event that would paste from the host clipboard (Ctrl/Meta+V, Shift+Insert, the Paste key, matched
  in any case) or run an editing command is refused, and key codes above 0xFF or modifiers above
  0xFFFF are refused outright, because Edge truncates them (65622 with Ctrl is Ctrl+V). Upload path
  lists are capped (64 paths, 4096 characters each) and checked in a worker thread.
  `Target.createBrowserContext` may carry only `disposeOnDetach`, so no proxy or universal network
  access.
- `relay.py`: one client WebSocket to the pipe. No client id reaches Edge: the relay's own commands
  use ids from `2**30` up and their answers never reach the client, and each forwarded client
  command goes out under a wire id from `1.5 * 2**30` up (below `2**31`: Chromium's ids are signed
  32-bit), unique on the pipe, with the client's id put back on the answer. So an answer pairs with
  the connection that asked, and a departed client's late answer reaches no one. The relay keeps
  only each waiting command's method, session and named context or target, at most 256 per client. It keeps every
  client out of the default context (see below). The default context's downloads are locked before
  the client's first command. The relay sends a client's `Target.createBrowserContext` under its own
  id, so the answer pairs with that connection whatever ids a later client reuses; the new
  context's id reaches the client only after its download lock succeeded, and a context whose
  client left first, or that an answer names unasked, is disposed. `Target.createTarget` in any
  other context is refused. A client command reusing an id still in flight is refused, and an
  answer is read with the request it answers. At most 16 navigations per client may wait on DNS or
  the user, and at most 4 context creations on Edge; a creation and its download lock go to the
  pipe under the same byte cap as the client's own commands. A target on a blocked
  scheme (browser UI such as `edge://downloads-hub`, built-in extension pages and workers) is
  detached the moment it is attached, closed if it is a page, and refused to the client afterwards:
  some of them cannot be closed, and their privileged bindings must never take a client command.
- `host_browser.py`: `HostBrowser`, the object `app.py` holds: configuration in `browser.json` in
  the state directory (validated on load like the API request; anything invalid reads as not set
  up), lazy launch on the first CDP connection, one client at a time, stop. Every launch also opens
  and disposes of one off-the-record context; an Edge that cannot is stopped and reported
  unavailable. When Edge's pipe closes, Edge is disposed before the client is closed, so a reconnect
  never overlaps the old Edge. The gateway's pause is checked before every launch step and after
  every await (close 1013). Unconfigure clears the configuration before it stops Edge, under the
  same lock as a launch, so no relay can start Edge after it.
- `identity_guard.py`: whether Edge can be served. Before every launch: Edge policy
  `InPrivateModeAvailability=1` (HKLM or HKCU, a DWORD or a string) makes the browser unavailable,
  since clients get only InPrivate contexts; so does a policy that is there but cannot be read. After launch: an account in the profile's `Preferences` or
  `Local State` (a file that exists but cannot be read never counts as a clean check, and five such
  polls in a row refuse), read before the first client is served, after a 10 s settle window, and
  every 2 s after. A finding kills Edge (close 1011, audited as `browser_refused_identity` with at
  most the account's email domain) and refuses the browser until it is configured again.
- `authenticode.py`: `WinVerifyTrust` without network retrieval, then the signer must be
  "Microsoft Corporation" under a "Microsoft Root Certificate Authority" root.

## Off-the-record only

On an Entra-joined device the default context signs in to Microsoft 365 by itself: Edge attaches
the device's Entra PRT to `login.microsoftonline.com` requests there (`x-ms-RefreshTokenCredential`,
`x-ms-DeviceCredential`), with or without an account in the profile. An off-the-record context
(`Target.createBrowserContext`, which `@playwright/mcp --isolated` makes) gets neither: a sign-in
prompt, no SSO headers, no `ESTSAUTH*` cookies (measured, Edge 156). So a client reaches only the
contexts it created on its own connection, and the default context is unreachable by construction:

- Root-session commands are an allow-list; `Fetch`, `Security`, `Runtime` and the rest are refused
  there, because on the browser target they act on every context.
- A `browserContextId` must be one the client created; a context command with none
  (`Target.createTarget`, `Browser.resetPermissions` / `cancelDownload` / `grantPermissions` /
  `setPermission`, `Storage` cookies) means the default context and is refused on any session.
  `Browser.setDownloadBehavior` for the default context is answered without being sent:
  Playwright's `connectOverCDP` does not connect if it fails, and the relay locked it already.
- A `targetId`, `sessionId` or `windowId`, in a command or a wrapped `sendMessageToTarget`, must be
  one the relay tied to a client context (from Target events and answers).
- Events about other contexts are dropped, as is every other root event; a target the browser
  auto-attaches outside them is resumed if it waits for a debugger and detached by the relay.
  `getTargets` and `getBrowserContexts` answers are filtered, and download events pass only for the
  client's frames.
- A wrapped `Target.sendMessageToTarget` message may not carry a `sessionId` of its own and gets
  the same context, target and browser-UI checks as a direct one.
- A context the client disposes is no longer its own (naming it again is refused), though its
  targets' teardown events still reach it; the rest of its contexts are disposed when it leaves,
  and the next client starts with none.

Edge's implicit sign-in (`msImplicitSignin`) is turned off at launch. With it on, Edge signs the
dedicated profile in to the work account, and Edge 156 crashes (0xC0000005) 2-3 s after an
off-the-record context leaves a Microsoft login page (9 of 9 runs; 0 of 7 with it off).
`msImplicitSignin` is an undocumented Edge-internal feature name, and a later Edge may rename or
drop it. The profile account check is the tripwire: an account in the profile means the switch no
longer works, and Edge is refused.

## Residual

Only destinations the client names are checked. Navigations a page starts itself (link clicks,
scripts, redirects the server sends) and its subresource requests are not origin- or
private-network-checked, and the relay resolves a host once while Edge resolves it again (DNS
rebinding). Closing that needs a network-level filtering proxy in front of Edge.

The default context still signs in to Microsoft 365. Edge opens no window in it at start-up, and no
client can reach it, but a user who opens a normal Edge window from that process (a new window
from the taskbar, say) browses there as themselves. That the
off-the-record context carries no device SSO is measured on Edge 156, not documented by Microsoft.
