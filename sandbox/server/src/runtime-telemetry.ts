import {
  getCachedExportPipelineEnabled,
  getCachedServiceVersion,
  isBaselineUsageTelemetryEnabled,
  isExportPipelineEnabled,
  recordMetricEvent,
  resetMetricsConfigCacheForTests,
} from "./otel-metrics.js";
import { recordLogEvent, resetLogsConfigCacheForTests } from "./otel-logs.js";
import { isUiPollPath } from "./ui-poll-paths.js";

// Shared telemetry envelope for plugin- and server-originated runtime events.
//
// Keep this shape flat because event_name-specific fields are forwarded into
// low-cardinality OTEL metric attributes in otel-metrics.ts. Different events
// only fill the subset they need, so prefer adding optional top-level fields
// here only when the value is reused across multiple event types or exported as
// a stable metric attribute. One-off payload details can stay as extra keys.
export type RuntimeTelemetryEvent = {
  // Required event discriminator. Routes the event to one of:
  // - superclaw_agent_toolcall
  // - superclaw_agent_tokens
  // - superclaw_agent_turn
  // - superclaw_sidecar_request
  // Also exported as an attribute on superclaw_agent_toolcall.
  event_name: string;
  // Attribute on: superclaw_agent_toolcall, superclaw_agent_tokens, superclaw_sidecar_request.
  app_version?: string;
  // Attribute on: superclaw_agent_toolcall, superclaw_sidecar_request.
  source?: string;
  // Attribute on: superclaw_sidecar_request.
  sidecar_name?: string;
  // Attribute on: superclaw_agent_toolcall.
  tool_name?: string;
  // Attribute on: superclaw_agent_toolcall, superclaw_agent_tokens.
  provider_id?: string;
  // Attribute on: superclaw_agent_toolcall, superclaw_agent_tokens.
  model_id?: string;
  // Stable product Bundle/SKU attribution. Callers cannot author this field:
  // normalizeMetricEvent replaces it with the committed Bundle projection.
  bundle_id?: string;
  // Attribute on: superclaw_agent_toolcall, superclaw_agent_tokens, superclaw_agent_turn.
  agent_type?: string;
  // Attribute on: superclaw_sidecar_request.
  // Also forwarded to superclaw_agent_toolcall if a caller supplies it.
  available?: boolean;
  // Value source for superclaw_agent_tokens counter; not exported as an attribute.
  total_tokens?: number;
  // Attribute on: superclaw_agent_turn. Bounded terminal-state enum for the
  // turn-completion counter: "answered" | "dispatched" | "stalled" | "errored"
  // | "aborted". Classified plugin-side so only the low-cardinality label ships.
  terminal_state?: "answered" | "dispatched" | "stalled" | "errored" | "aborted" | "unknown";
  // Attribute on: superclaw_agent_toolcall.
  outcome?: string;
  // Baseline telemetry fields, carried only by the active_install event.
  // install_id is LOGS-ONLY: it rides the baseline log body and MUST NEVER be
  // mapped into any metric attribute builder (that would make a random
  // pseudonymous ID a metric dimension). os/channel are low-cardinality baseline
  // attributes.
  install_id?: string;
  os?: string;
  channel?: string;
  // Extra event-specific payload. Not exported as a metric attribute unless
  // otel-metrics.ts is explicitly updated to map it.
  [key: string]: unknown;
};

/**
 * Whether the OTLP export pipeline is up at all (any gate). Retained under its
 * historical name for callers that gate "is telemetry plumbing active".
 */
export function isMetricsExportEnabled(): boolean {
  return getCachedExportPipelineEnabled();
}

function normalizeMetricEvent(event: RuntimeTelemetryEvent): RuntimeTelemetryEvent {
  const bundleId = (process.env.SUPERCLAW_BUNDLE_ID || "").trim() || undefined;
  return {
    ...event,
    app_version:
      typeof event.app_version === "string" && event.app_version.trim()
        ? event.app_version
        : getCachedServiceVersion(),
    bundle_id: bundleId,
    install_id:
      typeof event.install_id === "string" && event.install_id.trim()
        ? event.install_id
        : (process.env.SUPERCLAW_INSTALL_ID || "").trim() || undefined,
  };
}

export function recordRuntimeMetricEvent(event: RuntimeTelemetryEvent): void {
  // Admit under any gate: recordMetricEvent self-gates on install + usage telemetry, and
  // recordLogEvent self-gates per event
  // (active_install/tool_call_failed under baseline install + usage telemetry, crash_reported
  // under full telemetry).
  if (!isExportPipelineEnabled()) return;
  const normalized = normalizeMetricEvent(event);
  recordMetricEvent(normalized);
  recordLogEvent(normalized);
}

export function recordSidecarAvailability(input: {
  sidecarName: string;
  available: boolean;
  error?: string;
}): void {
  if (!isBaselineUsageTelemetryEnabled()) return;
  recordRuntimeMetricEvent({
    event_name: "sidecar_request",
    source: "server_proxy",
    available: input.available,
    error: input.error,
    sidecar_name: input.sidecarName,
  });
}

/**
 * Adapts one proxied sidecar request to `recordSidecarAvailability`.
 *
 * UI poll paths are dropped rather than recorded: they fire on a few-second
 * timer, so including them would let a healthy-but-idle sidecar dominate the
 * availability series with samples nobody asked for.
 */
export function recordSidecarAvailabilityFromProxyResponse(input: {
  sidecarName: string;
  pathname: string;
  response?: Response;
  error?: unknown;
}): void {
  if (!isMetricsExportEnabled()) return;
  if (isUiPollPath(input.pathname)) return;
  if (input.error !== undefined) {
    recordSidecarAvailability({
      sidecarName: input.sidecarName,
      available: false,
      error: input.error instanceof Error ? input.error.message : String(input.error),
    });
    return;
  }
  if (!input.response) return;
  if (input.response.status >= 500) {
    recordSidecarAvailability({
      sidecarName: input.sidecarName,
      available: false,
      error: `${input.sidecarName} returned ${input.response.status}`,
    });
    return;
  }
  recordSidecarAvailability({ sidecarName: input.sidecarName, available: true });
}

export function resetRuntimeTelemetryForTests(): void {
  resetMetricsConfigCacheForTests();
  resetLogsConfigCacheForTests();
}
