import { createMemo, createSignal, type Accessor } from "solid-js";
import {
  clearOpenworkServerSettings,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  writeOpenworkServerSettings,
  type OpenworkServerClient,
  type OpenworkServerSettings,
} from "~/shared/platform/transport/openwork-server";
import type { OpenworkServerInfo } from "~/shared/platform/tauri";
import type { StartupPreference } from "~/shared/types/preferences";

export type UseOpenworkConnectionDeps = {
  startupPreference: Accessor<StartupPreference | null>;
  openworkServerHostInfo: Accessor<OpenworkServerInfo | null>;
  initialSettings?: OpenworkServerSettings;
};

export function useOpenworkConnection(deps: UseOpenworkConnectionDeps) {
  const [openworkServerSettings, setOpenworkServerSettings] =
    createSignal<OpenworkServerSettings>(deps.initialSettings ?? {});

  const openworkServerBaseUrl = createMemo(() => {
    const pref = deps.startupPreference();
    const hostInfo = deps.openworkServerHostInfo();
    const settingsUrl =
      normalizeOpenworkServerUrl(openworkServerSettings().urlOverride ?? "") ??
      "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  });

  const openworkServerAuth = createMemo(
    () => {
      const pref = deps.startupPreference();
      const hostInfo = deps.openworkServerHostInfo();
      const settingsToken = openworkServerSettings().token?.trim() ?? "";
      const clientToken = hostInfo?.clientToken?.trim() ?? "";
      const hostToken = hostInfo?.hostToken?.trim() ?? "";

      if (pref === "local") {
        return {
          token: clientToken || undefined,
          hostToken: hostToken || undefined,
        };
      }
      if (pref === "server") {
        const settingsHostToken =
          openworkServerSettings().hostToken?.trim() ?? "";
        return {
          token: settingsToken || undefined,
          hostToken: settingsHostToken || undefined,
        };
      }
      if (hostInfo?.baseUrl) {
        return {
          token: clientToken || undefined,
          hostToken: hostToken || undefined,
        };
      }
      return { token: settingsToken || undefined, hostToken: undefined };
    },
    undefined,
    {
      equals: (prev, next) =>
        prev?.token === next.token && prev?.hostToken === next.hostToken,
    },
  );

  const openworkServerClient = createMemo<OpenworkServerClient | null>(() => {
    const baseUrl = openworkServerBaseUrl().trim();
    if (!baseUrl) return null;
    const auth = openworkServerAuth();
    return createOpenworkServerClient({
      baseUrl,
      token: auth.token,
      hostToken: auth.hostToken,
    });
  });

  const updateOpenworkServerSettings = (next: OpenworkServerSettings) => {
    const stored = writeOpenworkServerSettings(next);
    setOpenworkServerSettings(stored);
  };

  const resetOpenworkServerSettings = () => {
    clearOpenworkServerSettings();
    setOpenworkServerSettings({});
  };

  return {
    openworkServerSettings,
    setOpenworkServerSettings,
    openworkServerBaseUrl,
    openworkServerAuth,
    openworkServerClient,
    updateOpenworkServerSettings,
    resetOpenworkServerSettings,
  };
}
