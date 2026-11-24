// Pure decision logic for the edge-server startup gate.
//
// The gate blocks the app behind an edge-model connection form. It is enforced
// ONLY when the device cannot run a local llama model, so a user on ineligible
// hardware must configure an edge model before the workbench opens. This module
// isolates that "bypass vs. enforce" decision so it can be unit-tested without
// rendering the app; app.tsx feeds it live signals.

export interface EdgeGateInputs {
  /** True only in the installed Tauri app. Plain browser dev has no backend to
   * gate on, so the gate is always bypassed there. */
  isTauri: boolean;
  /** ServiceHub came up without an OpenWork data plane (transition mode) — the
   * OpenWork-dependent gate cannot run, so it is bypassed. */
  serviceHubReadyWithoutDataPlane: boolean;
  /** Strict local-LLM eligibility verdict from GET /system/hardware-eligibility.
   *   true      → device can run a local model → bypass the gate.
   *   false     → device cannot → enforce the gate.
   *   undefined → verdict not yet known → enforce the gate (fail-closed). */
  deviceCanRunLocal: boolean | undefined;
}

export interface EdgeCapabilityBundle {
  bundle_id: string;
  backend: string;
  chat_model_label: string;
}

export interface EdgePrimaryBundle {
  backend: string;
  bundle_id: string;
  state: string;
}

export function isSavedEdgeModelSupported(
  modelName: string | undefined,
  bundles: readonly EdgeCapabilityBundle[],
): boolean {
  return Boolean(
    modelName &&
      bundles.some(
        (bundle) =>
          bundle.backend === "edge" && bundle.chat_model_label === modelName,
      ),
  );
}

export function isSavedEdgeModelCommitted(
  modelName: string | undefined,
  bundles: readonly EdgeCapabilityBundle[],
  primaryBundle: EdgePrimaryBundle | undefined,
  primaryEdgeConfigMatches: boolean,
): boolean {
  if (
    !modelName ||
    !primaryEdgeConfigMatches ||
    primaryBundle?.backend !== "edge" ||
    primaryBundle.state !== "ready"
  ) {
    return false;
  }
  return bundles.some(
    (bundle) =>
      bundle.backend === "edge" &&
      bundle.chat_model_label === modelName &&
      bundle.bundle_id === primaryBundle.bundle_id,
  );
}

/**
 * Decide whether the edge-server startup gate should be bypassed (app opens) or
 * enforced (app blocked until an edge model is set).
 *
 * Bypass when ANY of:
 *   - not the installed Tauri app,
 *   - ServiceHub is up without a data plane,
 *   - the device is PROVEN able to run a local model (`=== true`).
 *
 * Otherwise enforce — including while eligibility is still unknown, so the app
 * stays gated until the device is proven eligible (fail-closed).
 */
export function resolveEdgeGateBypass(inputs: EdgeGateInputs): boolean {
  return (
    !inputs.isTauri ||
    inputs.serviceHubReadyWithoutDataPlane ||
    inputs.deviceCanRunLocal === true
  );
}
