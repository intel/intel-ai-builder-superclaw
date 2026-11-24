// App-wide owner of the sidebar update button's state. The button renders inside the version
// panel, which has no access to the updater, so the system state owner feeds the installer
// status in here. The pure view lives in `ota-update-state.ts`; this module only performs the
// side effects.
import { createMemo, createRoot, createSignal } from "solid-js";

import { uiLogInfo } from "./log";
import { deriveOtaButtonView } from "./ota-update-state";
import { recordPerfLog } from "./perf-log";
import type { AvailableUpdate } from "~/shared/util/update-manifest";
import type { UpdateStatus } from "../context/updater";

function createOtaUpdateStore() {
  const [offeredVersion, setOfferedVersion] = createSignal<string | null>(null);
  const [shown, setShown] = createSignal(false);
  const [installerStatus, setInstallerStatus] = createSignal<UpdateStatus>({
    state: "idle",
    lastCheckedAt: null,
  });
  const view = createMemo(() => deriveOtaButtonView(offeredVersion(), installerStatus(), shown()));
  const [installConfirm, setInstallConfirm] = createSignal<{ activeRuns: boolean } | null>(null);

  const loggedOffers = new Set<string>();
  let installerHandler: (() => void) | null = null;
  let checkHandler: (() => void) | null = null;
  let resolveInstallConfirm: ((confirmed: boolean) => void) | null = null;

  function answerInstallConfirm(confirmed: boolean) {
    const resolve = resolveInstallConfirm;
    resolveInstallConfirm = null;
    setInstallConfirm(null);
    resolve?.(confirmed);
  }

  /** Ask through the single app-level dialog; a newer request declines the pending one. */
  function confirmInstall(activeRuns: boolean): Promise<boolean> {
    answerInstallConfirm(false);
    setInstallConfirm({ activeRuns });
    return new Promise((resolve) => {
      resolveInstallConfirm = resolve;
    });
  }

  function setDecision(update: AvailableUpdate | null) {
    setOfferedVersion(update?.version ?? null);
    if (!update || loggedOffers.has(update.version)) return;
    loggedOffers.add(update.version);
    uiLogInfo("ota", `ota decision=offered version=${update.version} reason=newer_version`);
    if (update.installUrlRefused) {
      uiLogInfo("ota", `ota decision=refused version=${update.version} reason=untrusted_install_url`);
    }
    recordPerfLog(true, "app.updater", "ota-offered", {
      version: update.version,
      installUrlRefused: update.installUrlRefused,
    });
  }

  /** Perform the click action for the current button state. */
  function activate() {
    switch (view().kind) {
      case "idle":
      case "upToDate":
      case "checkFailed":
        checkHandler?.();
        return;
      case "available":
      case "ready":
      case "failed":
        installerHandler?.();
        return;
      case "checking":
      case "downloading":
      case "verifying":
      case "launching":
      case "hidden":
        return;
    }
  }

  return {
    view,
    setDecision,
    activate,
    /** The full-installer flow (#2246), registered by the system state owner. */
    setInstallerHandler: (handler: (() => void) | null) => {
      installerHandler = handler;
    },
    /** Manual check from the sidebar button, registered by the system state owner. */
    setCheckHandler: (handler: (() => void) | null) => {
      checkHandler = handler;
    },
    setShown,
    setInstallerStatus,
    /** The pending install confirmation, rendered by `UpdateInstallConfirmModal`. */
    installConfirm,
    confirmInstall,
    answerInstallConfirm,
  };
}

export type OtaUpdateStore = ReturnType<typeof createOtaUpdateStore>;

let store: OtaUpdateStore | null = null;

export function otaUpdateStore(): OtaUpdateStore {
  store ??= createRoot(() => createOtaUpdateStore());
  return store;
}
