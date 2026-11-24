/**
 * Per-request timeout budget, shared by every API factory.
 *
 * A module const, not `Record<string, number>`: with `noUncheckedIndexedAccess`
 * off, a widened record makes `timeouts.anyTypo` compile as `number` and be
 * `undefined` at runtime, silently falling back to the 10s default.
 */
export const CLIENT_TIMEOUTS = {
  health: 3_000,
  capabilities: 6_000,
  listWorkspaces: 8_000,
  activateWorkspace: 10_000,
  deleteWorkspace: 10_000,
  deleteSession: 12_000,
  status: 6_000,
  config: 10_000,
  opencodeRouter: 10_000,
  workspaceExport: 30_000,
  workspaceImport: 30_000,
  binary: 60_000,
  // Office -> PDF preview runs headless LibreOffice in the sandbox container.
  // Conversion cost scales with workbook/document size (measured ~4ms per KB
  // for xlsx), so this MUST stay above the server's own conversion cap
  // (OFFICE_PREVIEW_TIMEOUT_MS = 30s in sandbox/server/src/server.ts).
  // Otherwise the client aborts first and reports a generic "Request timed
  // out." for a conversion that either was still succeeding or would have
  // returned an accurate 504 office_conversion_timeout.
  officePreview: 45_000,
  // Connecting a GitHub account makes the sandbox call github.com — minting a
  // device code, or letting `gh auth login --with-token` validate a PAT — under
  // its own 30s FETCH_TIMEOUT_MS. This MUST stay above that, or the client
  // aborts first with a generic "Request timed out." while the server goes on
  // to create a perfectly good device flow whose code the UI never shows.
  githubAuth: 40_000,
} as const;

/** What the per-domain API factories capture from `createOpenworkServerClient`. */
export type OpenworkClientContext = {
  baseUrl: string;
  token: string | undefined;
  hostToken: string | undefined;
  timeouts: typeof CLIENT_TIMEOUTS;
};
