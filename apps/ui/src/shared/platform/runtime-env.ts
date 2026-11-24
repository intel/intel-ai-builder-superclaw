type WindowWithTauri = {
  __TAURI_INTERNALS__?: unknown;
};

type NavigatorWithUaData = {
  userAgentData?: { platform?: string };
};

export function isTauriRuntime() {
  if (typeof window === "undefined") return false;
  const internals = (window as unknown as WindowWithTauri).__TAURI_INTERNALS__;
  return internals != null;
}

export function isWindowsPlatform() {
  if (typeof navigator === "undefined") return false;

  const ua = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  const uaData = (navigator as unknown as NavigatorWithUaData).userAgentData;
  const platform =
    typeof uaData?.platform === "string"
      ? uaData.platform
      : typeof navigator.platform === "string"
        ? navigator.platform
        : "";

  return /windows/i.test(platform) || /windows/i.test(ua);
}

const STARTUP_PREF_KEY = "openwork.startupPref";

const LEGACY_PREF_KEY = "openwork.modePref";

const LEGACY_PREF_KEY_ALT = "openwork_mode_pref";

export function readStartupPreference(): "local" | "server" | null {
  if (typeof window === "undefined") return null;

  try {
    const pref =
      window.localStorage.getItem(STARTUP_PREF_KEY) ??
      window.localStorage.getItem(LEGACY_PREF_KEY) ??
      window.localStorage.getItem(LEGACY_PREF_KEY_ALT);

    if (pref === "local" || pref === "server") return pref;
    if (pref === "host") return "local";
    if (pref === "client") return "server";
  } catch {
    // ignore
  }

  return null;
}

export function writeStartupPreference(nextPref: "local" | "server") {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STARTUP_PREF_KEY, nextPref);
    window.localStorage.removeItem(LEGACY_PREF_KEY);
    window.localStorage.removeItem(LEGACY_PREF_KEY_ALT);
  } catch {
    // ignore
  }
}

export function clearStartupPreference() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(STARTUP_PREF_KEY);
    window.localStorage.removeItem(LEGACY_PREF_KEY);
    window.localStorage.removeItem(LEGACY_PREF_KEY_ALT);
  } catch {
    // ignore
  }
}
