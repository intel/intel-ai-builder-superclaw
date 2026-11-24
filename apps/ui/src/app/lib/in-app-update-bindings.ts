import type { Accessor } from "solid-js";

import type { UpdateStatus } from "../context/updater";
import type { UpdaterEnvironment } from "./tauri";
import { openUpdateDownloadPage } from "./open-update-download-page";

/** Shared update handlers passed into settings, dashboard, and session surfaces. */
export type InAppUpdateBindings = {
  updateStatus: Accessor<UpdateStatus>;
  updateEnv: Accessor<UpdaterEnvironment | null>;
  checkForUpdates: () => void;
  openUpdateDownloadPage: (url: string) => void;
};

export function createInAppUpdateBindings(options: {
  updateStatus: Accessor<UpdateStatus>;
  updateEnv: Accessor<UpdaterEnvironment | null>;
  checkForUpdates: () => void | Promise<void>;
}): InAppUpdateBindings {
  return {
    updateStatus: options.updateStatus,
    updateEnv: options.updateEnv,
    checkForUpdates: () => {
      void options.checkForUpdates();
    },
    openUpdateDownloadPage: (url: string) => {
      void openUpdateDownloadPage(url);
    },
  };
}
