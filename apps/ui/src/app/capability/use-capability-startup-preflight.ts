/**
 * Capability startup preflight: owns the local-LLM eligibility probe and the
 * resulting edge-server gate bypass decision so the app shell can stay thin.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";

import { resolveEdgeGateBypass } from "../edge-gate-policy";
import { isTransientHubError } from "../lib/servicehub";

export type CapabilityStartupPreflightDeps = {
  backendBootReady: Accessor<boolean>;
  serviceHubReadyWithoutDataPlane: Accessor<boolean>;
  isTauriRuntime: () => boolean;
  llmRouterClient: Accessor<{
    getHardwareEligibility: () => Promise<{ eligible: boolean }>;
  } | null>;
};

/**
 * Retries the hardware-eligibility probe against transient early-boot
 * failures. Extracted as a plain function (no Solid reactivity) so it can be
 * unit tested directly without depending on createEffect actually running.
 */
export async function probeDeviceEligibility(
  client: { getHardwareEligibility: () => Promise<{ eligible: boolean }> },
  isCancelled: () => boolean,
): Promise<boolean | undefined> {
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 1000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await client.getHardwareEligibility();
      return isCancelled() ? undefined : res.eligible;
    } catch (err) {
      if (isCancelled()) return undefined;
      if (!isTransientHubError(err) || attempt === MAX_ATTEMPTS) {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return undefined;
}

export function useCapabilityStartupPreflight(
  deps: CapabilityStartupPreflightDeps,
) {
  const [deviceCanRunLocal, setDeviceCanRunLocal] = createSignal<
    boolean | undefined
  >(undefined);

  createEffect(() => {
    const ready = deps.backendBootReady();
    const client = deps.llmRouterClient();
    if (!ready || !client) return;

    let cancelled = false;
    void probeDeviceEligibility(client, () => cancelled).then((eligible) => {
      if (!cancelled) setDeviceCanRunLocal(eligible);
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  // The edge-server gate is enforced ONLY when the device cannot run local
  // llama models. It is bypassed when: (a) not the installed Tauri app (plain
  // browser dev has no backend to gate on), (b) ServiceHub came up without a
  // data plane, or (c) the device is proven eligible for a local model.
  // While eligibility is still unknown the gate stays closed (fail-closed).
  const edgeGateBypass = createMemo(() =>
    resolveEdgeGateBypass({
      isTauri: deps.isTauriRuntime(),
      serviceHubReadyWithoutDataPlane: deps.serviceHubReadyWithoutDataPlane(),
      deviceCanRunLocal: deviceCanRunLocal(),
    }),
  );

  const persistEdgeProvider = createMemo(() => deviceCanRunLocal() === false);

  return {
    deviceCanRunLocal,
    edgeGateBypass,
    persistEdgeProvider,
  };
}
