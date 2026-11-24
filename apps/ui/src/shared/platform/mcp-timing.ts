/**
 * SuperClaw UI timing for MCP operations.
 *
 * Values ending in `_MS` are milliseconds. The OAuth listener API is the one
 * exception: it accepts whole seconds, so that setting ends in `_SECONDS`.
 *
 * This file does not control OpenCode's own MCP connection timeout or the
 * desktop Rust Windows listener probe. Those run in different processes.
 */

/** Maximum time the UI waits for an MCP add, connect, or disconnect request. */
export const MCP_ACTION_REQUEST_TIMEOUT_MS = 300_000;

/** Maximum time the UI waits for one MCP status HTTP response. */
export const MCP_STATUS_REQUEST_TIMEOUT_MS = 10_000;

/** Delay after a background status check finishes before starting the next one. */
export const MCP_STATUS_POLL_INTERVAL_MS = 3_000;

/** Delay between status checks immediately after an explicit connect request. */
export const MCP_CONNECT_STATUS_POLL_INTERVAL_MS = 500;

/** Total time spent checking for a final status after an explicit connect request. */
export const MCP_CONNECT_STATUS_POLL_TIMEOUT_MS = 10_000;

/** Maximum time the UI HTTP client waits for an MCP authentication request. */
export const MCP_AUTH_REQUEST_TIMEOUT_MS = 90_000;

/** Delay between status checks while an MCP authentication flow is active. */
export const MCP_AUTH_STATUS_POLL_INTERVAL_MS = 2_000;

/** Total time the authentication modal waits for the MCP to become connected. */
export const MCP_AUTH_STATUS_TIMEOUT_MS = 90_000;

/** Delay between checks for a newly registered MCP during authentication setup. */
export const MCP_AUTH_DISCOVERY_POLL_INTERVAL_MS = 500;

/** Total time spent waiting for a newly registered MCP to appear during authentication setup. */
export const MCP_AUTH_DISCOVERY_TIMEOUT_MS = 15_000;

/** Maximum lifetime, in seconds, of the desktop OAuth callback listener. */
export const MCP_OAUTH_CALLBACK_TIMEOUT_SECONDS = 300;