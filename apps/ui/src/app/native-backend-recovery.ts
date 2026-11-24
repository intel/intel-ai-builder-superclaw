import { createSignal, type Accessor } from "solid-js";

import type { Platform } from "./context/platform";
import { uiLogError } from "./lib/log";
import { retryServiceHubBoot, stopServiceHub } from "./lib/tauri";
import { isTauriRuntime } from "./utils";
import {
  NATIVE_RECOVERY_PRESENTATIONS,
  classifyNativeRecovery,
  fetchAppReadinessBestEffort,
  type NativeRecoveryPresentation,
  type ServiceHubSettings,
} from "~/shared/platform/transport/servicehub";

type ColdRestartDeps = {
  stopServiceHub: () => Promise<unknown>;
  restartApp: () => Promise<void>;
  logError: (message: string, error: unknown) => void;
};

export type NativeRecoveryReadResult =
  | { status: "available"; recovery: NativeRecoveryPresentation | null }
  | { status: "unavailable" };

export function nextNativeRecoveryPresentation(
  current: NativeRecoveryPresentation | null,
  result: NativeRecoveryReadResult,
): NativeRecoveryPresentation | null {
  return result.status === "available" ? result.recovery : current;
}

export async function restartAfterServiceHubStop(deps: {
  development: boolean;
  restartServiceHub: () => Promise<unknown>;
  restartApp: () => Promise<void>;
}): Promise<void> {
  if (deps.development) {
    await deps.restartServiceHub();
  }
  await deps.restartApp();
}

export function createColdRestartController(deps: ColdRestartDeps) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let inFlight: Promise<void> | null = null;

  const restart = (): Promise<void> => {
    if (inFlight) return inFlight;

    setBusy(true);
    setError(null);
    const run = (async () => {
      try {
        await deps.stopServiceHub();
      } catch (cause) {
        setError("SuperClaw couldn't stop the current backend. Try again.");
        deps.logError("Failed to stop ServiceHub before native recovery restart", cause);
        return;
      }

      try {
        await deps.restartApp();
      } catch (cause) {
        setError("SuperClaw couldn't restart. Try again.");
        deps.logError("App restart failed after ServiceHub stopped", cause);
      }
    })();

    const tracked = run.finally(() => {
      if (inFlight === tracked) {
        inFlight = null;
        setBusy(false);
      }
    });
    inFlight = tracked;
    return tracked;
  };

  return { busy, error, restart };
}

export function createNativeBackendRecovery(
  serviceHubSettings: Accessor<ServiceHubSettings | null>,
  platform: Pick<Platform, "restart">,
) {
  const controller = createColdRestartController({
    stopServiceHub,
    restartApp: () => restartAfterServiceHubStop({
      development: isTauriRuntime() && import.meta.env.DEV,
      restartServiceHub: retryServiceHubBoot,
      restartApp: () => platform.restart(),
    }),
    logError: (message, cause) => {
      uiLogError("runtime.recovery", message, {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });

  const read = async (): Promise<NativeRecoveryReadResult> => {
    if (!isTauriRuntime()) return { status: "available", recovery: null };
    const settings = serviceHubSettings();
    if (!settings) return { status: "unavailable" };
    const readiness = await fetchAppReadinessBestEffort(settings.baseUrl, settings.token);
    if (!readiness) return { status: "unavailable" };
    const classification = classifyNativeRecovery(readiness);
    if (classification.status === "unavailable") return classification;
    return {
      status: "available",
      recovery: classification.reason
        ? NATIVE_RECOVERY_PRESENTATIONS[classification.reason]
        : null,
    };
  };

  return { ...controller, read };
}

export type NativeBackendRecovery = ReturnType<typeof createNativeBackendRecovery>;