/**
 * How the app shell describes its own connection to the user: the version in
 * the header, the connected/live status line, the busy hint and its elapsed
 * clock, whether a new task can be started, and whether the full-screen
 * workspace-switch overlay is showing and what it says.
 *
 * Everything here is pure. The memos that feed it stay in app.tsx: the one
 * effect in this cluster (the 250ms delay before the switch overlay appears)
 * sits between them, and moving effects past each other would reorder solid's
 * effect queue. Taking the logic and leaving the wiring keeps this a
 * behaviour-preserving move.
 */
import { currentLocale, t } from "../i18n";

/**
 * Developer mode shows which OpenWork build is on the other end; everyone else
 * sees the opencode version we connected to. Falls back to the connected
 * version whenever the developer-mode sources are empty, so the header never
 * goes blank for lack of a `v`.
 */
export const resolveHeaderVersion = (input: {
  developerMode: boolean;
  connectedVersion: string | null;
  appVersion: string | null;
  diagnosticsVersion: string | null;
}): string | null => {
  const fallbackVersion = input.connectedVersion?.trim() ?? "";
  if (!input.developerMode) return fallbackVersion || null;

  const openworkVersion =
    input.appVersion?.trim() || input.diagnosticsVersion?.trim() || "";
  if (!openworkVersion) return fallbackVersion || null;

  const normalizedVersion = openworkVersion.startsWith("v")
    ? openworkVersion
    : `v${openworkVersion}`;
  return `OpenWork ${normalizedVersion}`;
};

export const resolveHeaderStatus = (input: {
  hasClient: boolean;
  headerVersion: string | null;
  sseConnected: boolean;
}): string => {
  const locale = currentLocale();
  if (!input.hasClient || !input.headerVersion)
    return t("status.disconnected", locale);
  const bits = [`${t("status.connected", locale)} · ${input.headerVersion}`];
  if (input.sseConnected) bits.push(t("status.live", locale));
  return bits.join(" · ");
};

export const elapsedSeconds = (startedAt: number | null, now: number): number => {
  if (!startedAt) return 0;
  return Math.max(0, Math.round((now - startedAt) / 1000));
};

export const resolveBusyHint = (input: {
  busy: boolean;
  busyLabel: string | null;
  seconds: number;
}): string | null => {
  if (!input.busy || !input.busyLabel) return null;
  const label = t(input.busyLabel, currentLocale());
  return input.seconds > 0 ? `${label} · ${input.seconds}s` : label;
};

export const isNewTaskDisabled = (input: {
  hasClient: boolean;
  busy: boolean;
  busyLabel: string | null;
}): boolean => {
  if (!input.hasClient) return true;

  // Allow creating a new session even while a run is in progress.
  if (input.busy && input.busyLabel === "status.running") return false;

  return input.busy;
};

export const isWorkspaceSwitchOpen = (input: {
  booting: boolean;
  capabilityStartupHandled: boolean;
  connectingWorkspaceId: string | null;
  startupActivationGrace: boolean;
  modelSwitchApplying: boolean;
  switchDelayElapsed: boolean;
  busy: boolean;
  busyLabel: string | null;
}): boolean => {
  // Under capability gating the CapabilityStartupResolver already gated the
  // whole startup (it only mounts this tree once the data plane is ready), so
  // the initial `booting` window here would just flash this full-screen
  // switch overlay for a beat right after mount. Suppress the boot-driven
  // open in that case. Dark-safe: capabilityStartupHandled is never set on
  // the gating-OFF path, so V1.1 keeps showing the overlay while booting.
  if (input.booting) return !input.capabilityStartupHandled;
  if (input.connectingWorkspaceId) {
    // During the capability startup grace window, the FIRST workspace
    // activation is the startup handoff (right after the resolver reveals the
    // app); suppress its full-screen overlay so it doesn't flash right after
    // entry. Later, user-initiated switches (grace expired) show it normally.
    if (input.startupActivationGrace) return false;
    // Applying a model switch reconnects the workspace with a refreshed token;
    // the Apply dialog already shows progress, so keep the page behind it.
    if (input.modelSwitchApplying) return false;
    return input.switchDelayElapsed;
  }
  if (!input.busy || !input.busyLabel) return false;
  return input.busyLabel === "status.restarting_engine";
};

/**
 * "Preparing" is the default, so the original's trailing `booting` branch
 * returned the same key as the fallthrough and is dropped here. The memo's
 * value is unchanged for every input; only the redundant test is gone.
 */
export const resolveWorkspaceSwitchStatusKey = (input: {
  busyLabel: string | null;
  connectingWorkspaceId: string | null;
}): string => {
  if (input.busyLabel === "status.connecting")
    return "workspace.switching_status_connecting";
  if (input.busyLabel === "status.restarting_engine") {
    return "workspace.switching_status_preparing";
  }
  if (input.busyLabel === "status.loading_session")
    return "workspace.switching_status_loading";
  if (input.connectingWorkspaceId) return "workspace.switching_status_loading";
  return "workspace.switching_status_preparing";
};

/** The engine's own host:port when it reports one, else the base URL's host. */
export const resolveLocalHostLabel = (input: {
  hostname: string | null | undefined;
  port: number | null | undefined;
  baseUrl: string;
}): string => {
  if (input.hostname && input.port) return `${input.hostname}:${input.port}`;

  try {
    if (!input.baseUrl) return "";
    return new URL(input.baseUrl).host;
  } catch {
    return "";
  }
};
