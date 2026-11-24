// What a click on the update button does in each installer state (#2945). The update takes two
// steps: Download fetches the installer and verifies its signature while the app stays usable;
// Restart and install, after one confirmation, has the shell re-verify it, start it and exit.
// The sidebar button and the Settings update bar both reach this through `otaUpdateStore()`.
import type { UpdateStatus } from "../context/updater";
import { recordPerfLog } from "./perf-log";

type Available = Extract<UpdateStatus, { state: "available" }>;
type Ready = Extract<UpdateStatus, { state: "ready" }>;

export type OtaInstallFlowDeps = {
  status: () => UpdateStatus;
  setStatus: (status: UpdateStatus) => void;
  /** The update check in flight, if any. */
  checkInFlight: () => Promise<void> | null;
  checkForUpdates: () => Promise<void>;
  /** The Restart and install confirmation; false for Later. */
  confirmInstall: () => Promise<boolean>;
  openHomepage: (url: string) => void;
  /** Download the installer and verify its signature; rejects with the reason. */
  download: (installUrl: string, version: string) => Promise<void>;
  /** Re-verify the downloaded installer and start it; rejects with the reason. */
  install: (installParameters: string | null, version: string) => Promise<void>;
  exitApp: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOtaInstallFlow(deps: OtaInstallFlowDeps) {
  let pendingClick: Promise<void> | null = null;

  function fail(version: string, lastCheckedAt: number | null, event: string, error: unknown) {
    const message = errorMessage(error);
    recordPerfLog(true, "app.updater", event, { version, error: message });
    deps.setStatus({ state: "error", lastCheckedAt, message, context: "install", version });
  }

  async function download(status: Available, installUrl: string) {
    const { version, installParameters, lastCheckedAt } = status;
    deps.setStatus({
      state: "downloading",
      startedAt: Date.now(),
      version,
      lastCheckedAt,
      progress: { phase: "download", pct: 0, bytesDownloaded: 0 },
    });
    recordPerfLog(true, "app.updater", "download-clicked", { version });
    try {
      await deps.download(installUrl, version);
    } catch (error) {
      fail(version, lastCheckedAt, "download-failed", error);
      return;
    }
    deps.setStatus({ state: "ready", version, lastCheckedAt, installParameters });
    recordPerfLog(true, "app.updater", "installer-ready", { version });
  }

  async function install(status: Ready) {
    const { version, installParameters, lastCheckedAt } = status;
    deps.setStatus({ state: "launching", version, lastCheckedAt, progress: { phase: "launching", pct: null } });
    recordPerfLog(true, "app.updater", "install-clicked", { version });
    try {
      await deps.install(installParameters, version);
      recordPerfLog(true, "app.updater", "installer-launched", { version });
      // Exit the process, not just the window: the installer relaunches SuperClaw, and a
      // still-running instance turns that launch away as a second instance.
      await deps.exitApp();
    } catch (error) {
      fail(version, lastCheckedAt, "install-failed", error);
    }
  }

  async function run() {
    // A click during a check acts on its result. An error replaced the `available` offer the
    // download needs, so re-check to restore it.
    const inFlight = deps.checkInFlight();
    if (inFlight) await inFlight;
    else if (deps.status().state === "error") await deps.checkForUpdates();

    const status = deps.status();
    if (status.state === "ready") {
      if (await deps.confirmInstall()) await install(status);
    } else if (status.state === "available") {
      const installUrl = status.installUrl?.trim();
      if (installUrl) await download(status, installUrl);
      else if (status.homepage) deps.openHomepage(status.homepage);
    }
  }

  return {
    /** One click at a time, so a double click cannot start two downloads or two confirmations. */
    click(): Promise<void> {
      pendingClick ??= run().finally(() => {
        pendingClick = null;
      });
      return pendingClick;
    },
  };
}
