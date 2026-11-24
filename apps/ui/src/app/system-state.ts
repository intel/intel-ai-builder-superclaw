import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";

import type { Session } from "@opencode-ai/sdk/v2/client";
import type { ProviderListItem } from "./types";

import type {
  Client,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
} from "./types";
import { isTauriRuntime, safeStringify } from "./utils";
import { mapConfigProvidersToList } from "~/shared/util/providers";
import {
  afterFailedQuietCheck,
  createUpdaterState,
  holdsUpdateCheck,
} from "./context/updater";
import {
  resetOpencodeCache,
  checkAppUpdate,
  downloadAppUpdate,
  getAppUpdateProgress,
  installAppUpdate,
} from "./lib/tauri";
import { selectAvailableUpdate } from "~/shared/util/update-manifest";
import {
  mergeAppUpdateProgressIntoStatus,
} from "./lib/app-update-progress";
import { createOtaInstallFlow } from "./lib/ota-install-flow";
import { otaUpdateStore } from "./lib/ota-update-store";
import { openUpdateDownloadPage } from "./lib/open-update-download-page";
import { unwrap, waitForHealthy } from "./lib/opencode";
import { recordPerfLog } from "./lib/perf-log";

export function createSystemState(options: {
  client: Accessor<Client | null>;
  sessions: Accessor<Session[]>;
  sessionStatusById: Accessor<Record<string, string>>;
  refreshPlugins: (scopeOverride?: PluginScope) => Promise<void>;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshMcpServers?: () => Promise<void>;
  reloadWorkspaceEngine?: () => Promise<boolean>;
  canReloadWorkspaceEngine?: () => boolean;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setError: (value: string | null) => void;
}) {
  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [reloadReasons, setReloadReasons] = createSignal<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = createSignal<number | null>(null);
  const [reloadLastFinishedAt, setReloadLastFinishedAt] = createSignal<number | null>(null);
  const [reloadTrigger, setReloadTrigger] = createSignal<ReloadTrigger | null>(null);
  const [reloadBusy, setReloadBusy] = createSignal(false);
  const [reloadError, setReloadError] = createSignal<string | null>(null);

  const [cacheRepairBusy, setCacheRepairBusy] = createSignal(false);
  const [cacheRepairResult, setCacheRepairResult] = createSignal<string | null>(null);

  const updater = createUpdaterState();
  const {
    updateAutoCheck,
    setUpdateAutoCheck,
    updateStatus,
    setUpdateStatus,
    updateEnv,
    setUpdateEnv,
  } = updater;

  const ota = otaUpdateStore();
  let inFlightCheck: Promise<void> | null = null;
  let manualCheckRequested = false;
  const installFlow = createOtaInstallFlow({
    status: updateStatus,
    setStatus: setUpdateStatus,
    checkInFlight: () => inFlightCheck,
    checkForUpdates: () => checkForUpdates(),
    confirmInstall: () => ota.confirmInstall(anyActiveRuns()),
    openHomepage: (url) => void openUpdateDownloadPage(url),
    download: downloadInstallerWithProgress,
    install: installAppUpdate,
    exitApp: async () => {
      const { exit } = await import("@tauri-apps/plugin-process");
      await exit(0);
    },
  });
  ota.setInstallerHandler(() => {
    if (isTauriRuntime()) void installFlow.click();
  });
  ota.setCheckHandler(() => {
    void checkForUpdates();
  });
  createEffect(() => ota.setInstallerStatus(updateStatus()));
  createEffect(() => {
    const env = updateEnv();
    ota.setShown(isTauriRuntime() && env?.supported !== false);
  });

  const anyActiveRuns = createMemo(() => {
    const statuses = options.sessionStatusById();
    return options.sessions().some((s) => statuses[s.id] === "running");
  });

  function markReloadRequired(reason: ReloadReason, trigger?: ReloadTrigger) {
    setReloadRequired(true);
    setReloadLastTriggeredAt(Date.now());
    setReloadReasons((current) => (current.includes(reason) ? current : [...current, reason]));
    if (trigger) {
      setReloadTrigger(trigger);
    } else {
      setReloadTrigger({
        type:
          reason === "plugins"
            ? "plugin"
            : reason === "skills"
              ? "skill"
              : reason === "agents"
                ? "agent"
                : reason === "commands"
                  ? "command"
                  : reason,
      });
    }
  }

  function clearReloadRequired() {
    setReloadRequired(false);
    setReloadReasons([]);
    setReloadError(null);
    setReloadTrigger(null);
  }

  const reloadCopy = createMemo(() => {
    const reasons = reloadReasons();
    if (!reasons.length) {
      return {
        title: "Reload required",
        body: "SuperClaw detected changes that require reloading the OpenCode instance.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "plugins") {
      return {
        title: "Reload required",
        body: "OpenCode loads npm plugins at startup. Reload the engine to apply opencode.json changes.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "skills") {
      return {
        title: "Reload required",
        body: "OpenCode can cache skill discovery/state. Reload the engine to make newly installed skills available.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "agents") {
      return {
        title: "Reload required",
        body: "OpenCode loads agents at startup. Reload the engine to make updated agents available.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "commands") {
      return {
        title: "Reload required",
        body: "OpenCode loads commands at startup. Reload the engine to make updated commands available.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "config") {
      return {
        title: "Reload required",
        body: "OpenCode reads opencode.json at startup. Reload the engine to apply configuration changes.",
      };
    }

    if (reasons.length === 1 && reasons[0] === "mcp") {
      return {
        title: "Reload required",
        body: "OpenCode loads MCP servers at startup. Reload the engine to activate the new connection.",
      };
    }

    return {
      title: "Reload required",
      body: "SuperClaw detected OpenCode configuration changes. Reload the engine to apply them.",
    };
  });

  const canReloadEngine = createMemo(() => {
    if (!reloadRequired()) return false;
    if (reloadBusy()) return false;
    const override = options.canReloadWorkspaceEngine?.();
    if (override === true) return true;
    if (override === false) return false;
    if (!options.client()) return false;
    return true;
  });

  // Keep this mounted so the reload banner UX remains in the app.
  createEffect(() => {
    reloadRequired();
  });

  async function reloadEngineInstance() {
    const initialClient = options.client();
    if (!initialClient) return;

    const override = options.canReloadWorkspaceEngine?.();
    if (override === false) {
      setReloadError("Reload is unavailable for this worker.");
      return;
    }

    // if (anyActiveRuns()) {
    //   setReloadError("Waiting for active tasks to complete before reloading.");
    //   return;
    // }

    setReloadBusy(true);
    setReloadError(null);

    try {
      if (options.reloadWorkspaceEngine) {
        const ok = await options.reloadWorkspaceEngine();
        if (ok === false) {
          setReloadError("Failed to reload the engine.");
          return;
        }
      } else {
        unwrap(await initialClient.instance.dispose());
      }

      const nextClient = options.client();
      if (!nextClient) {
        throw new Error("OpenCode client unavailable after reload.");
      }

      await waitForHealthy(nextClient, { timeoutMs: 12_000 });

      try {
        const providerList = unwrap(await nextClient.provider.list());
        options.setProviders(providerList.all);
        options.setProviderDefaults(providerList.default);
        options.setProviderConnectedIds(providerList.connected);
      } catch {
        try {
          const cfg = unwrap(await nextClient.config.providers());
          options.setProviders(mapConfigProvidersToList(cfg.providers));
          options.setProviderDefaults(cfg.default);
          options.setProviderConnectedIds([]);
        } catch {
          options.setProviders([]);
          options.setProviderDefaults({});
          options.setProviderConnectedIds([]);
        }
      }

      await options.refreshPlugins("project").catch(() => undefined);
      await options.refreshSkills({ force: true }).catch(() => undefined);
      await options.refreshMcpServers?.().catch(() => undefined);

      clearReloadRequired();
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setReloadBusy(false);
      setReloadLastFinishedAt(Date.now());
    }
  }

  async function reloadWorkspaceEngine() {
    await reloadEngineInstance();
  }

  async function repairOpencodeCache() {
    if (!isTauriRuntime()) {
      setCacheRepairResult("Cache repair requires the desktop app.");
      return;
    }

    if (cacheRepairBusy()) return;

    setCacheRepairBusy(true);
    setCacheRepairResult(null);
    options.setError(null);

    try {
      const result = await resetOpencodeCache();
      if (result.errors.length) {
        setCacheRepairResult(result.errors[0]);
        return;
      }

      if (result.removed.length) {
        setCacheRepairResult("OpenCode cache repaired. Restart the engine if it was running.");
      } else {
        setCacheRepairResult("No OpenCode cache found. Nothing to repair.");
      }
    } catch (e) {
      setCacheRepairResult(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setCacheRepairBusy(false);
    }
  }

  /** Concurrent callers share the check; manual requests make quiet failures visible. */
  function checkForUpdates(optionsCheck?: { quiet?: boolean }): Promise<void> {
    if (!optionsCheck?.quiet) manualCheckRequested = true;
    inFlightCheck ??= runUpdateCheck(optionsCheck).finally(() => {
      inFlightCheck = null;
      manualCheckRequested = false;
    });
    return inFlightCheck;
  }

  async function runUpdateCheck(optionsCheck?: { quiet?: boolean }) {
    if (!isTauriRuntime()) return;
    if (holdsUpdateCheck(updateStatus())) return;

    const env = updateEnv();
    if (env && !env.supported) {
      if (!optionsCheck?.quiet) {
        setUpdateStatus({
          state: "error",
          lastCheckedAt:
            updateStatus().state === "idle"
              ? (updateStatus() as { state: "idle"; lastCheckedAt: number | null }).lastCheckedAt
              : null,
          message: env.reason ?? "Updates are not supported in this environment.",
          context: "check",
        });
      }
      return;
    }

    const prev = updateStatus();
    setUpdateStatus({ state: "checking", startedAt: Date.now() });

    try {
      const manifest = await checkAppUpdate();
      const update = selectAvailableUpdate(manifest.xml, manifest.installedVersion, {
        releasesRepo: manifest.releasesRepo,
        allowLocalhost:
          (typeof __BUILD_DEBUG__ !== "undefined" && __BUILD_DEBUG__) ||
          (typeof __OTA_TEST_CHANNEL__ !== "undefined" && __OTA_TEST_CHANNEL__),
      });
      ota.setDecision(update);
      const checkedAt = Date.now();

      if (!update) {
        recordPerfLog(true, "app.updater", "check-success", {
          updateAvailable: false,
          channel: manifest.channel,
        });
        setUpdateStatus({ state: "idle", lastCheckedAt: checkedAt, lastSuccessfulNoUpdateAt: checkedAt });
        return;
      }

      const notes = update.releaseNotes ?? undefined;
      recordPerfLog(true, "app.updater", "check-success", {
        updateAvailable: true,
        version: update.version,
        hasNotes: !!notes,
        channel: manifest.channel,
      });
      setUpdateStatus({
        state: "available",
        lastCheckedAt: checkedAt,
        version: update.version,
        notes,
        homepage: update.homepage,
        forceUpdate: update.forceUpdate,
        installUrl: update.installUrl,
        installParameters: update.installParameters,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      const quietFailure = !!optionsCheck?.quiet && !manualCheckRequested;
      recordPerfLog(true, "app.updater", "check-failed", {
        error: message,
        quiet: quietFailure,
      });

      if (quietFailure) {
        setUpdateStatus(afterFailedQuietCheck(prev, Date.now()));
        return;
      }

      setUpdateStatus({ state: "error", lastCheckedAt: null, message, context: "check" });
    }
  }

  /** Download and verify the installer; progress events also arrive, this poll fills gaps. */
  async function downloadInstallerWithProgress(installUrl: string, version: string) {
    const pollProgress = () => {
      void getAppUpdateProgress().then((payload) => {
        const current = updateStatus();
        const next = mergeAppUpdateProgressIntoStatus(current, payload);
        if (next !== current) {
          setUpdateStatus(next);
        }
      });
    };

    pollProgress();
    const progressPollId = window.setInterval(pollProgress, 250);
    try {
      await downloadAppUpdate(installUrl, version);
    } finally {
      window.clearInterval(progressPollId);
    }
  }

  return {
    reloadRequired,
    reloadReasons,
    reloadLastTriggeredAt,
    reloadLastFinishedAt,
    setReloadLastFinishedAt,
    reloadTrigger,
    reloadBusy,
    reloadError,
    reloadCopy,
    canReloadEngine,
    markReloadRequired,
    clearReloadRequired,
    reloadEngineInstance,
    reloadWorkspaceEngine,
    cacheRepairBusy,
    cacheRepairResult,
    repairOpencodeCache,
    updateAutoCheck,
    setUpdateAutoCheck,
    updateStatus,
    setUpdateStatus,
    updateEnv,
    setUpdateEnv,
    checkForUpdates,
    anyActiveRuns,
  };
}
