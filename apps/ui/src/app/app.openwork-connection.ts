/**
 * Talking to an OpenWork server: probing one for reachability, applying a
 * settings change, reconnecting after a restart, opening the right settings
 * surface for a worker, reloading a worker's engine, and renaming one.
 *
 * The probe is pure and exported on its own — it builds its own client from
 * the arguments and touches no app state, which is why both the settings test
 * and the reconnect path can share it.
 *
 * The rest are handlers moved out of `App()` unchanged. They are grouped
 * because they all write the same four connection signals (status,
 * capabilities, checked-at, reconnect-busy); splitting them would mean handing
 * the same setters to several factories.
 */
import type { Accessor, Setter } from "solid-js";

import {
  createOpenworkServerClient,
  OpenworkServerError,
  normalizeOpenworkServerUrl,
  type OpenworkServerCapabilities,
  type OpenworkServerSettings,
  type OpenworkServerStatus,
} from "~/shared/platform/transport/openwork-server";
import {
  openworkServerInfo,
  type OpenworkServerInfo,
} from "~/shared/platform/tauri";
import type { useOpenworkConnection } from "~/features/openwork-connection";
import { isTauriRuntime } from "~/shared/platform/runtime-env";
import { waitForHealthy } from "~/shared/platform/transport/opencode";
import type { SettingsSection } from "./pages/settings-dialog.sections";
import type { Client, WorkspaceDisplay } from "./types";
import { addOpencodeCacheHint, safeStringify } from "./utils";

type OpenworkConnection = ReturnType<typeof useOpenworkConnection>;

export type OpenworkServerProbeResult = {
  status: OpenworkServerStatus;
  capabilities: OpenworkServerCapabilities | null;
};

/**
 * Ask an OpenWork server what we can do with it.
 *
 * `limited` rather than `disconnected` is the answer whenever the server is
 * reachable but the credentials are not accepted, and also when no token was
 * supplied at all: the host is there, we just cannot see its capabilities. Only
 * an unreachable host — or a failure that is not an auth failure — counts as
 * disconnected.
 */
export const checkOpenworkServer = async (
  url: string,
  token?: string,
  hostToken?: string,
): Promise<OpenworkServerProbeResult> => {
  const client = createOpenworkServerClient({ baseUrl: url, token, hostToken });
  try {
    await client.health();
  } catch (error) {
    if (
      error instanceof OpenworkServerError &&
      (error.status === 401 || error.status === 403)
    ) {
      return { status: "limited", capabilities: null };
    }
    return { status: "disconnected", capabilities: null };
  }

  if (!token) {
    return { status: "limited", capabilities: null };
  }

  try {
    const caps = await client.capabilities();
    return { status: "connected", capabilities: caps };
  } catch (error) {
    if (
      error instanceof OpenworkServerError &&
      (error.status === 401 || error.status === 403)
    ) {
      return { status: "limited", capabilities: null };
    }
    return { status: "disconnected", capabilities: null };
  }
};

export type OpenworkConnectionActionsDeps = {
  client: Accessor<Client | null>;
  setError: Setter<string | null>;
  openSettings: (section: SettingsSection) => void;

  openworkReconnectBusy: Accessor<boolean>;
  setOpenworkReconnectBusy: Setter<boolean>;
  openworkServerAuth: OpenworkConnection["openworkServerAuth"];
  openworkServerBaseUrl: OpenworkConnection["openworkServerBaseUrl"];
  openworkServerClient: OpenworkConnection["openworkServerClient"];
  openworkServerHostInfo: Accessor<OpenworkServerInfo | null>;
  setOpenworkServerHostInfo: Setter<OpenworkServerInfo | null>;
  openworkServerSettings: OpenworkConnection["openworkServerSettings"];
  updateOpenworkServerSettings: OpenworkConnection["updateOpenworkServerSettings"];
  setOpenworkServerCapabilities: Setter<OpenworkServerCapabilities | null>;
  setOpenworkServerCheckedAt: Setter<number | null>;
  openworkServerStatus: Accessor<OpenworkServerStatus>;
  setOpenworkServerStatus: Setter<OpenworkServerStatus>;
  openworkServerWorkspaceId: Accessor<string | null>;
  startupPreference: Accessor<"local" | "server" | null>;

  setEditRemoteWorkspaceError: Setter<string | null>;
  setEditRemoteWorkspaceId: Setter<string | null>;
  setEditRemoteWorkspaceOpen: Setter<boolean>;

  setRenameWorkspaceBusy: Setter<boolean>;
  setRenameWorkspaceId: Setter<string | null>;
  setRenameWorkspaceName: Setter<string>;
  setRenameWorkspaceOpen: Setter<boolean>;
  renameWorkspaceBusy: Accessor<boolean>;
  renameWorkspaceId: Accessor<string | null>;
  renameWorkspaceName: Accessor<string>;

  /** True only for a local worker on the desktop build. */
  canReloadLocalEngine: () => boolean;
  refreshMcpServers: () => Promise<unknown>;
  refreshProviders: (options?: { dispose?: boolean }) => Promise<unknown>;
  setWorkspaceConfigVersion: Setter<number>;
  workspaceStore: {
    activateWorkspace: (workspaceId: string) => Promise<boolean>;
    activeWorkspaceDisplay: Accessor<WorkspaceDisplay>;
    activeWorkspaceId: Accessor<string>;
    createRemoteWorkspaceFlow: (input: {
      openworkHostUrl: string;
      openworkToken: string | null;
    }) => Promise<unknown>;
    reloadWorkspaceEngine: () => Promise<boolean>;
    updateWorkspaceDisplayName: (
      workspaceId: string,
      name: string,
    ) => Promise<boolean>;
    workspaces: Accessor<WorkspaceDisplay[]>;
  };
};

export const createOpenworkConnectionActions = (
  deps: OpenworkConnectionActionsDeps,
) => {
  // `deps` is a plain object of accessors built once by `App()`, not a Solid
  // props proxy, so destructuring copies function references without
  // collapsing reactivity.
  const {
    client,
    setError,
    openSettings,
    openworkReconnectBusy,
    setOpenworkReconnectBusy,
    openworkServerAuth,
    openworkServerBaseUrl,
    openworkServerClient,
    openworkServerHostInfo,
    setOpenworkServerHostInfo,
    openworkServerSettings,
    updateOpenworkServerSettings,
    setOpenworkServerCapabilities,
    setOpenworkServerCheckedAt,
    openworkServerStatus,
    setOpenworkServerStatus,
    openworkServerWorkspaceId,
    startupPreference,
    setEditRemoteWorkspaceError,
    setEditRemoteWorkspaceId,
    setEditRemoteWorkspaceOpen,
    setRenameWorkspaceBusy,
    setRenameWorkspaceId,
    setRenameWorkspaceName,
    setRenameWorkspaceOpen,
    renameWorkspaceBusy,
    renameWorkspaceId,
    renameWorkspaceName,
    canReloadLocalEngine,
    refreshMcpServers,
    refreshProviders,
    setWorkspaceConfigVersion,
    workspaceStore,
  } = deps;

  /** Record a probe result against the connection signals. */
  const applyProbe = (result: OpenworkServerProbeResult) => {
    setOpenworkServerStatus(result.status);
    setOpenworkServerCapabilities(result.capabilities);
    setOpenworkServerCheckedAt(Date.now());
    return result.status === "connected" || result.status === "limited";
  };

  const markDisconnected = () => {
    setOpenworkServerStatus("disconnected");
    setOpenworkServerCapabilities(null);
    setOpenworkServerCheckedAt(Date.now());
  };

  const saveRenameWorkspace = async () => {
    const workspaceId = renameWorkspaceId();
    if (!workspaceId) return;
    const nextName = renameWorkspaceName().trim();
    if (!nextName) return;
    if (renameWorkspaceBusy()) return;

    setRenameWorkspaceBusy(true);
    setError(null);
    try {
      const ok = await workspaceStore.updateWorkspaceDisplayName(
        workspaceId,
        nextName,
      );
      if (!ok) return;
      setRenameWorkspaceOpen(false);
      setRenameWorkspaceId(null);
      setRenameWorkspaceName("");
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setError(addOpencodeCacheHint(message));
    } finally {
      setRenameWorkspaceBusy(false);
    }
  };

  const testOpenworkServerConnection = async (
    next: OpenworkServerSettings,
  ) => {
    const derived = normalizeOpenworkServerUrl(next.urlOverride ?? "");
    if (!derived) {
      markDisconnected();
      return false;
    }
    const ok = applyProbe(
      await checkOpenworkServer(
        derived,
        next.token,
        openworkServerAuth().hostToken,
      ),
    );
    if (ok && !isTauriRuntime()) {
      const active = workspaceStore.activeWorkspaceDisplay();
      const shouldAttach =
        !client() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "openwork";
      if (shouldAttach) {
        await workspaceStore
          .createRemoteWorkspaceFlow({
            openworkHostUrl: derived,
            openworkToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectOpenworkServer = async () => {
    if (openworkReconnectBusy()) return false;
    setOpenworkReconnectBusy(true);
    try {
      let hostInfo = openworkServerHostInfo();
      if (isTauriRuntime()) {
        try {
          hostInfo = await openworkServerInfo();
          setOpenworkServerHostInfo(hostInfo);
        } catch {
          hostInfo = null;
          setOpenworkServerHostInfo(null);
        }
      }

      // Repair stale local token state by syncing settings token from the live host.
      const liveToken = hostInfo?.clientToken?.trim();
      if (liveToken && startupPreference() !== "server") {
        const settings = openworkServerSettings();
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateOpenworkServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = openworkServerBaseUrl().trim();
      const auth = openworkServerAuth();
      if (!url) {
        markDisconnected();
        return false;
      }

      const ok = applyProbe(
        await checkOpenworkServer(url, auth.token, auth.hostToken),
      );
      if (ok) {
        setWorkspaceConfigVersion((v) => v + 1);
        // Force opencode to drop its per-directory cache before re-reading
        // providers — the OAuth flows pass dispose:true for the same reason.
        // Without dispose, opencode's cached directory state can return the
        // pre-restart provider list even though /provider proxies through to
        // a freshly-restarted opencode process. This is why the picker stayed
        // stale after Clear/Apply until something else (OAuth complete, etc.)
        // happened to trigger a dispose-backed refresh.
        void refreshProviders({ dispose: true }).catch(() => undefined);
      }
      return ok;
    } finally {
      setOpenworkReconnectBusy(false);
    }
  };

  const openWorkspaceConnectionSettings = (workspaceId: string) => {
    const workspace =
      workspaceStore.workspaces().find((item) => item.id === workspaceId) ??
      null;
    // Every remote worker edits through the same dialog; a local one has no
    // connection to edit, so it goes to the config tab instead.
    if (workspace?.workspaceType === "remote") {
      setEditRemoteWorkspaceId(workspace.id);
      setEditRemoteWorkspaceError(null);
      setEditRemoteWorkspaceOpen(true);
      return;
    }
    openSettings("config");
  };

  const reloadWorkspaceEngineFromUi = async () => {
    if (canReloadLocalEngine()) {
      return workspaceStore.reloadWorkspaceEngine();
    }

    if (workspaceStore.activeWorkspaceDisplay().workspaceType !== "remote") {
      return false;
    }

    const owClient = openworkServerClient();
    const workspaceId = openworkServerWorkspaceId();
    if (!owClient || !workspaceId || openworkServerStatus() !== "connected") {
      setError("Connect to this worker before applying runtime changes.");
      return false;
    }

    try {
      await owClient.reloadEngine(workspaceId);
      // reloadEngine fires OpenCode's hot-reload signal and returns immediately
      // while OpenCode restarts asynchronously. Wait for it to be healthy before
      // reconnecting, otherwise activateWorkspace races against the restart and
      // causes "Worker disconnected / Request timed out" errors.
      const openCodeClient = client();
      if (openCodeClient) {
        try {
          await waitForHealthy(openCodeClient, { timeoutMs: 20_000 });
        } catch {
          // health check timed out; fall through and let activateWorkspace
          // surface the real error rather than swallowing it silently
        }
      }
      await workspaceStore.activateWorkspace(
        workspaceStore.activeWorkspaceId(),
      );
      await refreshMcpServers();
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to apply runtime changes.";
      setError(message);
      return false;
    }
  };

  return {
    openWorkspaceConnectionSettings,
    reconnectOpenworkServer,
    reloadWorkspaceEngineFromUi,
    saveRenameWorkspace,
    testOpenworkServerConnection,
  };
};
