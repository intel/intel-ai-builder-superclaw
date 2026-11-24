/**
 * Low-signal request paths driven by the UI's own polling timers.
 *
 * Its own module because two unrelated consumers need it and neither should have
 * to import the other: access-log suppression (server.ts) and sidecar
 * availability telemetry (runtime-telemetry.ts), which would otherwise have to
 * reach back into server.ts and create an import cycle.
 */

// UI-driven polling endpoints. The desktop app refreshes these on a short timer
// (every few seconds) and the resulting access lines drown out genuinely useful
// log output in the server log. Suppress only on 2xx/3xx; every 4xx/5xx
// (including 401) still logs so genuine failures surface.
//
// Matched paths:
//   - /workspace/<id>/projects
//     (project list poll, every ~5s)
//   - /workspace/<id>/agentlab/automations
//     (automations list poll, every ~10s)
//   - /workspace/<id>/gmail/credentials/status
//     (Gmail credentials presence poll, ~10s steady-state, bursts to 15+ hits
//      on message-stream reactive renders)
//   - /workspace/<id>/gmail/apis
//     (Gmail setup guide, every 5s, then every 20s after a minute, while it
//      waits for the user to turn the Gmail and Calendar APIs on)
//   - /workspace/<id>/github/status
//     (GitHub connection poll, every 5s for as long as a browser sign-in is
//      pending — up to 15 minutes while the user approves the device code)
//   - /w/<id>/opencode/command
//     (slash-command catalog, fetched alongside the polls above)
const UI_POLL_PATH_RE =
  /^\/workspace\/[^/]+\/(projects|agentlab\/automations|gmail\/credentials\/status|gmail\/apis|github\/status)$|^\/w\/[^/]+\/opencode\/command$/;

export function isUiPollPath(pathname: string): boolean {
  return UI_POLL_PATH_RE.test(pathname);
}
