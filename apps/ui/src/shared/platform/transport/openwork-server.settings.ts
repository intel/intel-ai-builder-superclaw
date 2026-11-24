import type { OpenworkServerSettings } from "./openwork-server.types";
import { normalizeOpenworkServerUrl } from "./openwork-server.url";

export const DEFAULT_OPENWORK_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "openwork.server.urlOverride";

const STORAGE_PORT_OVERRIDE = "openwork.server.port";

const STORAGE_TOKEN = "openwork.server.token";

const STORAGE_HOST_TOKEN = "openwork.server.hostToken";

const STORAGE_HUB_URL = "openwork.server.hubUrl";

const STORAGE_HUB_TOKEN = "openwork.server.hubToken";

// In-memory token store — avoids persisting credentials to localStorage
// (Coverity LOCALSTORAGE_WRITE). Tokens are re-injected on every app launch
// by backend-manager events (Tauri) or VITE env vars (web).
let _inMemoryToken: string | undefined;

let _inMemoryHostToken: string | undefined;

let _inMemoryHubToken: string | undefined;

export function readOpenworkServerSettings(): OpenworkServerSettings {
  if (typeof window === "undefined") return {};
  const token = _inMemoryToken?.trim() || undefined;
  const hostToken = _inMemoryHostToken?.trim() || undefined;
  const hubToken = _inMemoryHubToken?.trim() || undefined;
  try {
    const urlOverride = normalizeOpenworkServerUrl(
      window.localStorage.getItem(STORAGE_URL_OVERRIDE) ?? "",
    );
    const hubUrl = normalizeOpenworkServerUrl(
      window.localStorage.getItem(STORAGE_HUB_URL) ?? "",
    );
    const portRaw = window.localStorage.getItem(STORAGE_PORT_OVERRIDE) ?? "";
    const portOverride = portRaw ? Number(portRaw) : undefined;
    return {
      urlOverride: urlOverride ?? undefined,
      hubUrl: hubUrl ?? undefined,
      portOverride: Number.isNaN(portOverride) ? undefined : portOverride,
      token,
      hostToken,
      hubToken,
    };
  } catch {
    return { token, hostToken, hubToken };
  }
}

export function writeOpenworkServerSettings(next: OpenworkServerSettings): OpenworkServerSettings {
  if (typeof window === "undefined") return next;
  try {
    const urlOverride = normalizeOpenworkServerUrl(next.urlOverride ?? "");
    const portOverride = typeof next.portOverride === "number" ? next.portOverride : undefined;
    const token = next.token?.trim() || undefined;
    const hostTokenVal = next.hostToken?.trim() || undefined;
    const hubUrl = normalizeOpenworkServerUrl(next.hubUrl ?? "") ?? undefined;
    const hubToken = next.hubToken?.trim() || undefined;

    const prevToken = (_inMemoryToken ?? "").trim();

    _inMemoryToken = token;
    _inMemoryHostToken = hostTokenVal;
    _inMemoryHubToken = hubToken;

    try {
      if (urlOverride) {
        window.localStorage.setItem(STORAGE_URL_OVERRIDE, urlOverride);
      } else {
        window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
      }

      if (typeof portOverride === "number" && !Number.isNaN(portOverride)) {
        window.localStorage.setItem(STORAGE_PORT_OVERRIDE, String(portOverride));
      } else {
        window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
      }

      if (hubUrl) {
        window.localStorage.setItem(STORAGE_HUB_URL, hubUrl);
      } else {
        window.localStorage.removeItem(STORAGE_HUB_URL);
      }
    } catch {
      // Token updates are memory-only and must still succeed when browser
      // storage is blocked; URL/port persistence is best-effort.
    }

    // Notify in-process subscribers (ServerProvider, GlobalSDKProvider) that
    // the OpenWork token changed.  localStorage writes do not fire 'storage'
    // events in the same window, so we emit a custom event for same-window
    // reactivity.  This is what makes the SDK client rebuild with the fresh
    // Authorization header when the backend-manager rotates the token.
    const nextToken = token ?? "";
    if (nextToken !== prevToken) {
      try {
        window.dispatchEvent(
          new CustomEvent("openwork:token-changed", { detail: nextToken }),
        );
      } catch {
        // ignore (older browsers / non-DOM env)
      }
    }

    return readOpenworkServerSettings();
  } catch {
    return next;
  }
}

export function hydrateOpenworkServerSettingsFromEnv() {
  if (typeof window === "undefined") return;

  const envUrl = typeof import.meta.env?.VITE_OPENWORK_URL === "string"
    ? import.meta.env.VITE_OPENWORK_URL.trim()
    : "";
  const envPort = typeof import.meta.env?.VITE_OPENWORK_PORT === "string"
    ? import.meta.env.VITE_OPENWORK_PORT.trim()
    : "";
  const envToken = typeof import.meta.env?.VITE_OPENWORK_TOKEN === "string"
    ? import.meta.env.VITE_OPENWORK_TOKEN.trim()
    : "";
  const envHostToken = typeof import.meta.env?.VITE_OPENWORK_HOST_TOKEN === "string"
    ? import.meta.env.VITE_OPENWORK_HOST_TOKEN.trim()
    : "";
  const envHubUrl = typeof import.meta.env?.VITE_SERVICEHUB_URL === "string"
    ? import.meta.env.VITE_SERVICEHUB_URL.trim()
    : "";
  const envHubToken = typeof import.meta.env?.VITE_SERVICEHUB_TOKEN === "string"
    ? import.meta.env.VITE_SERVICEHUB_TOKEN.trim()
    : "";

  if (!envUrl && !envPort && !envToken && !envHostToken && !envHubUrl && !envHubToken) {
    return;
  }

  try {
    const current = readOpenworkServerSettings();
    const next: OpenworkServerSettings = { ...current };
    let changed = false;

    if (envUrl) {
      const normalized = normalizeOpenworkServerUrl(envUrl) ?? undefined;
      if (normalized && current.urlOverride !== normalized) {
        next.urlOverride = normalized;
        changed = true;
      }
    }

    if (envPort) {
      const parsed = Number(envPort);
      if (Number.isFinite(parsed) && parsed > 0 && current.portOverride !== parsed) {
        next.portOverride = parsed;
        changed = true;
      }
    }

    if (envToken && current.token !== envToken) {
      next.token = envToken;
      changed = true;
    }

    if (envHostToken && current.hostToken !== envHostToken) {
      next.hostToken = envHostToken;
      changed = true;
    }

    if (envHubUrl) {
      const normalized = normalizeOpenworkServerUrl(envHubUrl) ?? undefined;
      if (normalized && current.hubUrl !== normalized) {
        next.hubUrl = normalized;
        changed = true;
      }
    }

    if (envHubToken && current.hubToken !== envHubToken) {
      next.hubToken = envHubToken;
      changed = true;
    }

    if (changed) {
      writeOpenworkServerSettings(next);
    }
  } catch {
    // ignore
  }
}

export function clearOpenworkServerSettings() {
  _inMemoryToken = undefined;
  _inMemoryHostToken = undefined;
  _inMemoryHubToken = undefined;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    // Remove any legacy persisted tokens left from earlier versions.
    window.localStorage.removeItem(STORAGE_TOKEN);
    window.localStorage.removeItem(STORAGE_HOST_TOKEN);
    window.localStorage.removeItem(STORAGE_HUB_URL);
    window.localStorage.removeItem(STORAGE_HUB_TOKEN);
  } catch {
    // ignore
  }
}

export function deriveOpenworkServerUrl(
  opencodeBaseUrl: string,
  settings?: OpenworkServerSettings,
) {
  const override = settings?.urlOverride?.trim();
  if (override) {
    return normalizeOpenworkServerUrl(override);
  }

  const base = opencodeBaseUrl.trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    const port = settings?.portOverride ?? DEFAULT_OPENWORK_SERVER_PORT;
    url.port = String(port);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return null;
  }
}
