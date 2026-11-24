# `features/tavily-api-key/`

Whether a Tavily API key is saved on the host, and saving or clearing it, for the Settings
page and the session page's default-agent warning. `tavily-key-view.ts` turns the request
state into what those surfaces show.

**Public surface:** `index.ts` — `useTavilyApiKey`, and the view helpers `tavilyKeyView`,
`tavilyKeyControls`, `tavilySessionWarning` with their `TavilyKeyView` and
`TavilyKeyRequestStatus` types.

**Depends on:** `solid-js` and `~/shared/platform/transport/instance-api`. No `fetch`, no
openwork-server client.

**Contract:** leaf UI slice ([`../README.md`](../README.md)); consumes
`shared/contracts/src/sandbox-manager-host-api.ts` (`TavilyApiKeyStatus` and the error table)
only through `~/shared/platform/transport/instance-api`.

**Still in `app/`:** the Settings row (`app/pages/settings.tavily-key-row.tsx`) and the
session-page warning in `app/pages/session.tsx`.

**Verify:** from `apps/ui`, `pnpm test src/features/tavily-api-key`.
