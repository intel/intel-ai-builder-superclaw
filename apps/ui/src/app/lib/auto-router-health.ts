import { createLlmRouterClient } from "./llmrouter-client";
import { readOpenworkServerSettings } from "./openwork-server";
import { ServiceHubHttpError } from "./servicehub";
import type { LocalModelHealthInfo } from "./local-model-availability";

/**
 * Readiness logic for the llmrouter/auto pre-send gate.
 *
 * Extracted from cloud-model-settings.tsx so the pure logic can be unit
 * tested: importing the component pulls in solid-js/lucide-solid, whose
 * module-load side effects throw under the (server-side) test runner.
 */

// ── Health types matching the LRM control-plane checks ─────────────────

/** Per-slot health info used by the UI's LRM readiness checks. */
export type ModelHealthInfo = LocalModelHealthInfo;

// ── Pre-send readiness check ──────────────────────────────────────────

/**
 * Reason a model slot is not ready.
 *
 * - `not_configured` / `unhealthy` come from a SUCCESSFUL health response and
 *   describe a specific model.
 * - `check_failed` means the health call itself did not complete (timeout,
 *   network error, or a 5xx from the orchestrator).  In that case we have no
 *   per-model information, so this reason is applied to BOTH slots and must
 *   not be presented as "this particular model is down".
 */
export type ModelReadyReason = "not_configured" | "unhealthy" | "check_failed";

/** Per-slot readiness result used by the combined auto-router check. */
export type ModelSlotResult = {
  ready: boolean;
  reason: ModelReadyReason | null;
};

/**
 * Combined readiness result for the llmrouter/auto pre-send gate.
 * Reports both local and cloud model status in a single HTTP call.
 */
export type AutoRouterModelsResult = {
  cloud: ModelSlotResult;
  local: ModelSlotResult;
};

/**
 * True when a thrown probe error means "not configured" rather than a
 * transient failure. Prefers the structured `ServiceHubHttpError.code` (e.g.
 * the LRM control plane's `not_configured` error code) over pattern-matching
 * the free-text message, which is fragile — e.g. the cloud-model-health 404
 * message is "no cloud-model is configured", which does NOT contain the
 * substring "not configured".
 */
function isNotConfiguredError(error: unknown): boolean {
  if (error instanceof ServiceHubHttpError && error.code) {
    return error.code === "not_configured";
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("not configured");
}

/** Helper: map a ModelHealthInfo status to a ModelSlotResult. */
function slotFromHealth(info: ModelHealthInfo): ModelSlotResult {
  if (info.status === "unset") return { ready: false, reason: "not_configured" };
  if (info.status === "unhealthy") return { ready: false, reason: "unhealthy" };
  return { ready: true, reason: null };
}

// ── Diagnostics ───────────────────────────────────────────────────────
//
// The pre-send gate can only ever show the user a coarse reason
// ("check_failed" / "not_configured" / "unhealthy").  In a packaged build
// there is no console or DevTools to inspect *why* the probe failed, so we
// stash a human-readable summary of the last probe here.  The UI reads it
// after a refresh and renders it inside the blocking popup.  Kept as a
// module-level side effect (rather than a new return field) so the pure
// return shape — asserted with `toEqual` in the unit tests — is unchanged.
let lastDiagnostics = "";

/** Human-readable summary of the most recent auto-router health probe. */
export function getLastAutoRouterDiagnostics(): string {
  return lastDiagnostics;
}

/** Compact one-line formatter for a cloud/edge probe payload. */
function fmtProbe(
  r: {
    status?: string;
    provider?: string;
    model?: string;
    error?: string;
    http_status?: number;
    detail?: string;
    note?: string;
    latency_ms?: number;
  } | null,
): string {
  if (!r) return "(empty response)";
  const parts: string[] = [];
  if (r.status !== undefined) parts.push(`status=${r.status}`);
  if (r.provider) parts.push(`provider=${r.provider}`);
  if (r.model) parts.push(`model=${r.model}`);
  if (r.error) parts.push(`error=${r.error}`);
  if (r.http_status !== undefined) parts.push(`http=${r.http_status}`);
  if (r.detail) parts.push(`detail=${r.detail}`);
  if (r.note) parts.push(`note=${r.note}`);
  if (r.latency_ms !== undefined) parts.push(`latency=${r.latency_ms}ms`);
  return parts.length ? parts.join(" ") : "(no fields)";
}

/**
 * Combined check for **both** local and cloud model readiness.
 * Checks both `local-model` and `cloud-model` readiness via the LRM control
 * plane. Used by the llmrouter/auto pre-send
 * gate so the user is told exactly which model(s) need configuration.
 */
export async function checkAutoRouterModelsReady(baseUrl: string): Promise<AutoRouterModelsResult> {
  void baseUrl;
  // The health call did not complete (timeout, network error, or 5xx). We have
  // no per-model information, so neither slot can be blamed individually.
  const checkFailedSlot: ModelSlotResult = { ready: false, reason: "check_failed" };
  const settings = readOpenworkServerSettings();
  const hubUrl = settings.hubUrl?.trim() ?? "";
  const hubToken = settings.hubToken?.trim() ?? "";

  const diag: string[] = [];
  diag.push(`auto-route health probe @ ${new Date().toISOString()}`);
  diag.push(`hubUrl: ${hubUrl || "(missing)"}`);
  diag.push(`hubToken: ${hubToken ? "present" : "(missing)"}`);

  if (!hubUrl || !hubToken) {
    diag.push("result: cannot probe — ServiceHub URL/token not delivered to the UI");
    lastDiagnostics = diag.join("\n");
    return { cloud: checkFailedSlot, local: checkFailedSlot };
  }

  const client = createLlmRouterClient({ baseUrl: hubUrl, token: hubToken });

  // Cloud and local readiness are independent probes.  Run them concurrently
  // so the pre-send gate waits on max(cloud, local) latency instead of their
  // sum — the local branch's getEdge -> testEdge round-trip is the slowest
  // step and previously blocked the (already-finished) cloud check.
  let cloudDiag = "";
  let edgeDiag = "";

  const checkCloud = async (): Promise<ModelSlotResult> => {
    try {
      const health = await client.getCloudModelHealth();
      cloudDiag = `cloud  GET /llm-router/v1/cloud/model/health -> ${fmtProbe(health)}`;
      return health.status === "ok"
        ? { ready: true, reason: null }
        : { ready: false, reason: health.error === "not_configured" ? "not_configured" : "unhealthy" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cloudDiag = `cloud  GET /llm-router/v1/cloud/model/health THREW -> ${message}`;
      return isNotConfiguredError(error) ? { ready: false, reason: "not_configured" } : checkFailedSlot;
    }
  };

  const checkLocal = async (): Promise<ModelSlotResult> => {
    try {
      // v1.2: the "local model" is the committed primary bundle. Use the
      // ServiceHub-owned App capability profile — the SAME authoritative source
      // as the main gating — rather than the LRM `/capability/primary-bundle`
      // view, which can briefly report a null primary_bundle during
      // startup/switch windows and cause an intermittent false "Not Configured".
      // Policy (conservative): local is ready ONLY when the profile is `active`.
      // Anything else — still activating (503/loading), recovery, or a
      // transport failure — is "not yet known to be configured", so we block
      // the send with `not_configured` rather than optimistically allowing it.
      const profile = await client.getAppCapabilityProfile();
      edgeDiag = `local  GET /app/capability-profile -> lifecycle_state=${profile.lifecycle_state}`;
      return profile.lifecycle_state === "active"
        ? { ready: true, reason: null }
        : { ready: false, reason: "not_configured" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      edgeDiag = `local  GET /app/capability-profile THREW -> ${message}`;
      // 503 = profile still activating; any error here means we can't confirm
      // the local model is configured → block the send (not_configured).
      return { ready: false, reason: "not_configured" };
    }
  };

  // Both probes run concurrently; collect their diagnostic lines in a fixed
  // (cloud, then edge) order after they settle so the summary is deterministic
  // regardless of which finished first.
  const [cloud, local] = await Promise.all([checkCloud(), checkLocal()]);

  diag.push(cloudDiag);
  diag.push(edgeDiag);
  diag.push(
    `verdict: cloud.ready=${cloud.ready}${cloud.reason ? `(${cloud.reason})` : ""}` +
      `  local.ready=${local.ready}${local.reason ? `(${local.reason})` : ""}`,
  );
  lastDiagnostics = diag.join("\n");
  return { cloud, local };
}
