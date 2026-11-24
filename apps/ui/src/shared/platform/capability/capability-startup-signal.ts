/**
 * Shared, one-way flag: has the CapabilityStartupResolver taken ownership of
 * the startup gate for this app session?
 *
 * Under capability gating (v1.2), `CapabilityStartupResolver` owns the entire
 * startup overlay lifecycle (Phase A/B/C) and only mounts the runtime app once
 * the data plane is reachable. The legacy `app.tsx` `<BackendBootOverlay>`
 * (the V1.1 boot overlay) would otherwise ALSO render for a beat right after
 * the resolver mounts the app — its `backendBootReady` is briefly false while
 * app.tsx runs its own servicehub-ready / snapshot recovery — producing a
 * jarring "enter app → flash the overlay again → enter" flap.
 *
 * When the resolver takes ownership it sets this flag; app.tsx consults it to
 * suppress its own boot overlay, so there is exactly ONE startup overlay owner
 * under gating. Dark-safe: when gating is OFF the resolver passes through
 * without ever setting this, so app.tsx keeps its V1.1 overlay behaviour.
 *
 * A plain module signal (not context) is used deliberately: the resolver and
 * `App` live in sibling positions under different providers, and this is a
 * process-lifetime, set-once fact — a global latch matches its semantics and
 * avoids threading a provider through the runtime tree. It resets naturally on
 * a full app relaunch (fresh JS environment).
 */
import { createSignal, type Accessor } from "solid-js";

const [capabilityStartupHandled, setCapabilityStartupHandledSignal] = createSignal(false);

export { capabilityStartupHandled };

// Starts when the active Profile triggers Sandbox provisioning. The backend
// health schedule alone has a roughly 300s sleep budget; the extra minute
// covers probe and scheduling overhead while preserving a bounded UI fallback.
export const DATA_PLANE_TIMEOUT_MS = 360_000;

// A short grace window opened when the resolver first reveals the app under
// gating. During it, the FIRST workspace activation (the startup handoff that
// runs right after mount and would otherwise flash WorkspaceSwitchOverlay) is
// treated as part of startup and its full-screen switch overlay is suppressed.
// It auto-expires so any LATER, user-initiated workspace switch still shows its
// normal overlay. Set-once open; time-boxed close.
const STARTUP_ACTIVATION_GRACE_MS = 8000;
const [startupActivationGrace, setStartupActivationGrace] = createSignal(false);

export { startupActivationGrace };

// A grace window opened when the resolver reveals the app, during which the
// runtime/worker connection is still being established (opencode worker
// subprocess warmup + first activateWorkspace take a few — sometimes many —
// seconds AFTER reveal, and the time varies run to run). While this window is
// open, startup-only connection failures are presented as "Connecting…" rather
// than red errors. Each surface still disappears as soon as its own readiness
// condition succeeds. The fixed timeout matters because the worker client and
// sidebar session list become ready independently; closing this window on the
// first client connection can expose a red sidebar error while its request is
// still settling. After 60 seconds, the original error states surface normally.
// (60s, up from 30s: older CPU/GPU hosts take longer to warm up the worker.)
const STARTUP_CONNECTING_GRACE_MS = 60_000;
const [startupConnectingGrace, setStartupConnectingGrace] = createSignal(false);

export { startupConnectingGrace };

/**
 * Tracks startup readiness for one UI surface. A surface may show its startup
 * connecting state only until it becomes ready once; a later failure must use
 * the normal error presentation even if the global 60-second window is open.
 */
export function createStartupConnectingState(ready: Accessor<boolean>): Accessor<boolean> {
  let settled = ready();
  return () => {
    if (ready()) settled = true;
    return startupConnectingGrace() && !settled;
  };
}

/** Claim startup-overlay ownership without starting post-reveal grace timers. */
export function markCapabilityStartupHandled(): void {
  setCapabilityStartupHandledSignal(true);
}

/** Start grace timers when the runtime app becomes visible. */
export function armStartupGrace(): void {
  // Open the activation grace window and auto-close it so only the startup
  // handoff activation is covered, not later manual workspace switches.
  setStartupActivationGrace(true);
  setTimeout(() => setStartupActivationGrace(false), STARTUP_ACTIVATION_GRACE_MS);
  // Open the connecting grace while post-reveal backend surfaces settle.
  setStartupConnectingGrace(true);
  setTimeout(() => setStartupConnectingGrace(false), STARTUP_CONNECTING_GRACE_MS);
}

// The owtToken the resolver already fetched during Phase C (before reveal).
// The resolver polls `fetchOwtToken` to decide when the data plane is reachable
// and then reveals the app; that successful token was previously discarded, so
// `app.tsx`'s lazy-fetch effect had to re-fetch it after mounting — an extra
// round-trip (and up-to-one poll interval) during which the session area shows
// "SuperClaw runtime disconnected" because the worker client isn't connected
// yet. Stashing it here lets app.tsx reuse it immediately on mount and connect
// the data plane without a second fetch. Same module-signal rationale as above:
// resolver and App are siblings under different providers, and this is a
// set-once startup fact that resets on relaunch.
const [startupOwtToken, setStartupOwtTokenSignal] = createSignal<string | null>(null);

export { startupOwtToken };

/** Called by the resolver when its Phase C `fetchOwtToken` first succeeds. */
export function setStartupOwtToken(token: string): void {
  setStartupOwtTokenSignal(token);
}
