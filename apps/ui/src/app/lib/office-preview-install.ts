import {
  createServiceHubClient,
  toInstallStatus,
  type OptionalPackageInstallFailureCode,
  type OptionalPackageInstallPhase,
  type OptionalPackageStatus,
  type ServiceHubOperation,
} from "~/shared/platform/transport/servicehub";

/** Package id the sandbox manager knows the LibreOffice converter by. */
const OFFICE_PREVIEW_PACKAGE = "libreoffice-preview";
const POLL_INTERVAL_MS = 1_000;
/** The install has no client-side deadline; only a poll that keeps failing ends it early. */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/** What the sandbox manager says about a running install. */
export type OfficeInstallProgress = {
  phase?: OptionalPackageInstallPhase;
  /** When the install began, in epoch milliseconds. */
  startedAt?: number;
};

/**
 * What the preview modal shows in place of the preview while the offer is open.
 * `manual` is the way out without winget: how to install LibreOffice by hand.
 * `unreachable` is the sandbox manager not answering, which says nothing about winget.
 * `installed_elsewhere` is LibreOffice in a folder the preview does not look in.
 */
export type OfficeInstallState =
  | { step: "offer" }
  | { step: "manual" }
  | { step: "unreachable" }
  | { step: "installed_elsewhere" }
  | { step: "declined" }
  | ({ step: "installing" } & OfficeInstallProgress)
  | { step: "failed" };

export class OfficeInstallError extends Error {
  constructor(readonly code: OptionalPackageInstallFailureCode) {
    super(code);
    this.name = "OfficeInstallError";
  }
}

/** The slice of the ServiceHub client the installer needs. */
type InstallHub = {
  optionalPackage: (packageId: string) => Promise<OptionalPackageStatus>;
  installOptionalPackage: (packageId: string) => Promise<OptionalPackageStatus>;
  operation: (operationId: string) => Promise<ServiceHubOperation>;
};

/**
 * What the sandbox manager says about LibreOffice: the install running now, whether winget could run
 * one, and whether LibreOffice is there now (an install finished after the preview failed).
 * `unreachable` when it could not be asked, which tells nothing of any of them.
 */
export type OfficePackageStatus =
  | { operationId: string | null; canInstall: boolean; installed?: boolean; unreachable?: false }
  | { unreachable: true };

/** What the preview controller gets: start or follow the install, and ask what is possible. */
export type OfficeInstaller = {
  /** Starts an install, or, given `operationId`, follows that run without starting one. */
  install: (
    onProgress: (progress: OfficeInstallProgress) => void,
    isStale?: () => boolean,
    operationId?: string,
  ) => Promise<void>;
  status: () => Promise<OfficePackageStatus>;
};

/** A request that fails (a 401, a 503, a timeout) is `unreachable`, not "no winget": the reply it lost may have named a running install. */
export async function officePackageStatus(hub: Pick<InstallHub, "optionalPackage">): Promise<OfficePackageStatus> {
  try {
    const status = await hub.optionalPackage(OFFICE_PREVIEW_PACKAGE);
    return {
      operationId: status.state === "installing" ? (status.operation_id ?? null) : null,
      canInstall: status.can_install === true,
      installed: status.installed === true,
    };
  } catch {
    return { unreachable: true };
  }
}

/**
 * Installs LibreOffice through the sandbox manager, or follows the install
 * already running (the backend's answer to a second POST, or `operationId`),
 * and resolves once it is in place. Rejects with an {@link OfficeInstallError}
 * carrying the backend's stable failure code; any other failure (network,
 * malformed reply) counts as `install_failed`. `onProgress` hears the phase
 * and the start time the backend reports on every poll while the install runs.
 *
 * Polls until the backend reports a terminal state, however long that takes,
 * and gives up early only after {@link MAX_CONSECUTIVE_POLL_FAILURES} failed
 * polls in a row. Once `isStale()` is true it stops polling and resolves; the
 * install itself keeps running on the server. Following `operationId` never
 * starts an install: if that run fails, a new one is the user's call.
 */
export async function installOfficePreview(
  hub: InstallHub,
  onProgress: (progress: OfficeInstallProgress) => void,
  pollMs = POLL_INTERVAL_MS,
  isStale: () => boolean = () => false,
  operationId?: string,
): Promise<void> {
  try {
    if (!operationId) {
      const started = await hub.installOptionalPackage(OFFICE_PREVIEW_PACKAGE);
      if (started.installed) return;
      if (!started.operation_id) throw new OfficeInstallError("install_failed");
      operationId = started.operation_id;
    }

    let failedPolls = 0;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (isStale()) return;
      let status: ReturnType<typeof toInstallStatus>;
      try {
        status = toInstallStatus(await hub.operation(operationId));
      } catch {
        if (++failedPolls >= MAX_CONSECUTIVE_POLL_FAILURES) throw new OfficeInstallError("install_failed");
        continue;
      }
      failedPolls = 0;
      if (status.state === "done") return;
      if (status.state === "failed") throw new OfficeInstallError(status.code);
      onProgress({ phase: status.phase, startedAt: status.startedAt });
    }
  } catch (error) {
    throw error instanceof OfficeInstallError ? error : new OfficeInstallError("install_failed");
  }
}

/**
 * True when the server that converts the preview runs on this machine, which is the only case the
 * installer can fix. A workspace the app opens through the bundled server is still typed "remote",
 * so the type says nothing; the URL the preview is fetched from does.
 */
export function isThisMachine(serverUrl: string | undefined): boolean {
  const url = serverUrl?.trim() ?? "";
  if (!url) return true;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The installer for the preview controller, or null when there is no control plane to ask. */
export function officeInstallerFor(settings: { hubUrl?: string; hubToken?: string }): OfficeInstaller | null {
  const baseUrl = settings.hubUrl?.trim() ?? "";
  const token = settings.hubToken?.trim() ?? "";
  if (!baseUrl || !token) return null;
  const hub = createServiceHubClient({ baseUrl, token });
  return {
    install: (onProgress, isStale, operationId) =>
      installOfficePreview(hub, onProgress, POLL_INTERVAL_MS, isStale, operationId),
    status: () => officePackageStatus(hub),
  };
}
