import { metrics } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import type { RuntimeTelemetryEvent } from "./runtime-telemetry.js";

let initialized = false;
let agentToolcallCounter = metrics.getMeter("superclaw-runtime-telemetry").createCounter("superclaw_agent_toolcall");
let agentTokensCounter = metrics.getMeter("superclaw-runtime-telemetry").createCounter("superclaw_agent_tokens");
let agentTurnCounter = metrics.getMeter("superclaw-runtime-telemetry").createCounter("superclaw_agent_turn");
let agentRunCounter = metrics.getMeter("superclaw-runtime-telemetry").createCounter("superclaw_agent_run");
let sidecarRequestCounter = metrics
  .getMeter("superclaw-runtime-telemetry")
  .createCounter("superclaw_sidecar_request");
let cachedExportPipelineEnabled: boolean | null = null;
let cachedBaselineTelemetryEnabled: boolean | null = null;
let cachedFullTelemetryCrashExportEnabled: boolean | null = null;
let cachedOtlpHttpBaseUrl: string | null = null;
let cachedServiceVersion: string | null = null;

const TOKEN_EVENT_NAMES = new Set(["assistant_turn_completed"]);
const AGENT_TOOLCALL_EVENT_NAMES = new Set(["tool_call_completed", "tool_call_failed"]);
const TURN_COMPLETED_EVENT_NAME = "turn_completed";
const SIDECAR_REQUEST_EVENT_NAME = "sidecar_request";

/**
 * Opt-in full-telemetry consent gate, orthogonal to the debug and
 * baseline telemetry gates. Exported so other modules share one
 * definition of the consent flag.
 */
export function isFullTelemetryEnabled(): boolean {
  return (process.env.SUPERCLAW_FULL_TELEMETRY || "").trim() === "1";
}

/**
 * Baseline telemetry gate. Default-on/opt-out on the host.
 */
export function isBaselineTelemetryEnabled(): boolean {
  return (process.env.SUPERCLAW_BASELINE_TELEMETRY || "").trim() === "1";
}

/**
 * Whether baseline install + usage telemetry may export (consent flag on child env).
 */
export function isBaselineUsageTelemetryEnabled(): boolean {
  if (cachedBaselineTelemetryEnabled !== null) return cachedBaselineTelemetryEnabled;
  cachedBaselineTelemetryEnabled = isBaselineTelemetryEnabled();
  return cachedBaselineTelemetryEnabled;
}

function isOtlpExportConfigured(): boolean {
  return otlpHttpBaseUrl().length > 0;
}

/**
 * Product OTLP pipeline: consent (baseline or full) and a configured collector URL.
 */
export function isExportPipelineEnabled(): boolean {
  if (cachedExportPipelineEnabled !== null) return cachedExportPipelineEnabled;
  const consent =
    isBaselineUsageTelemetryEnabled() || isFullTelemetryEnabled();
  cachedExportPipelineEnabled = consent && isOtlpExportConfigured();
  return cachedExportPipelineEnabled;
}

/**
 * Whether crash telemetry may export (full-telemetry consent on child env).
 */
export function isFullTelemetryCrashExportEnabled(): boolean {
  if (cachedFullTelemetryCrashExportEnabled !== null) {
    return cachedFullTelemetryCrashExportEnabled;
  }
  cachedFullTelemetryCrashExportEnabled = isFullTelemetryEnabled();
  return cachedFullTelemetryCrashExportEnabled;
}

export function getCachedExportPipelineEnabled(): boolean {
  return isExportPipelineEnabled();
}

function otlpHttpBaseUrl(): string {
  if (cachedOtlpHttpBaseUrl !== null) return cachedOtlpHttpBaseUrl;
  cachedOtlpHttpBaseUrl = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "").trim().replace(/\/+$/, "");
  return cachedOtlpHttpBaseUrl;
}

function serviceVersion(): string {
  if (cachedServiceVersion !== null) return cachedServiceVersion;
  cachedServiceVersion = (process.env.SUPERCLAW_APP_VERSION || "unknown").trim() || "unknown";
  return cachedServiceVersion;
}

export function getCachedServiceVersion(): string {
  return serviceVersion();
}

export function resetMetricsConfigCacheForTests(): void {
  cachedExportPipelineEnabled = null;
  cachedBaselineTelemetryEnabled = null;
  cachedFullTelemetryCrashExportEnabled = null;
  cachedOtlpHttpBaseUrl = null;
  cachedServiceVersion = null;
  initialized = false;
}

export function ensureMeterProviderInitialized(): void {
  if (initialized || !isBaselineUsageTelemetryEnabled()) return;
  const otlpBaseUrl = otlpHttpBaseUrl();
  if (!otlpBaseUrl) return;
  initialized = true;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "openwork-server",
    [ATTR_SERVICE_VERSION]: serviceVersion(),
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${otlpBaseUrl}/v1/metrics` }),
    exportIntervalMillis: 10000,
  });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  const meter = metrics.getMeter("superclaw-runtime-telemetry");
  agentToolcallCounter = meter.createCounter("superclaw_agent_toolcall");
  agentTokensCounter = meter.createCounter("superclaw_agent_tokens");
  agentTurnCounter = meter.createCounter("superclaw_agent_turn");
  agentRunCounter = meter.createCounter("superclaw_agent_run");
  sidecarRequestCounter = meter.createCounter("superclaw_sidecar_request");
}

function buildToolcallMetricAttributes(event: RuntimeTelemetryEvent): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "superclaw.event_name": event.event_name,
  };
  for (const key of [
    "app_version",
    "source",
    "tool_name",
    "outcome",
    "provider_id",
    "model_id",
    "bundle_id",
    "agent_type",
  ] as const) {
    const value = event[key];
    if (typeof value === "string" && value) attrs[`superclaw.${key}`] = value;
  }
  if (typeof event.available === "boolean") attrs["superclaw.available"] = event.available;
  return attrs;
}

function buildTotalTokenMetricAttributes(event: RuntimeTelemetryEvent): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of ["app_version", "provider_id", "model_id", "bundle_id", "agent_type"] as const) {
    const value = event[key];
    if (typeof value === "string" && value) attrs[`superclaw.${key}`] = value;
  }
  return attrs;
}

export function buildTurnMetricAttributes(event: RuntimeTelemetryEvent): Record<string, string> {
  const attrs: Record<string, string> = {};
  const terminalState = event.terminal_state;
  attrs["superclaw.terminal_state"] =
    terminalState === "answered" ||
    terminalState === "dispatched" ||
    terminalState === "stalled" ||
    terminalState === "errored" ||
    terminalState === "aborted"
      ? terminalState
      : "unknown";
  for (const key of ["app_version", "provider_id", "model_id", "bundle_id", "agent_type"] as const) {
    const value = event[key];
    if (typeof value === "string" && value) attrs[`superclaw.${key}`] = value;
  }
  return attrs;
}

export function buildAgentRunMetricAttributes(event: RuntimeTelemetryEvent): Record<string, string> {
  return buildTurnMetricAttributes(event);
}

export function buildSidecarRequestMetricAttributes(
  event: RuntimeTelemetryEvent,
): Record<string, string | boolean> {
  const attrs: Record<string, string | boolean> = {};
  for (const key of ["app_version", "bundle_id", "source", "sidecar_name"] as const) {
    const value = event[key];
    if (typeof value === "string" && value) attrs[`superclaw.${key}`] = value;
  }
  if (typeof event.available === "boolean") attrs["superclaw.available"] = event.available;
  return attrs;
}

export function recordMetricEvent(event: RuntimeTelemetryEvent): void {
  // Usage telemetry: consent + OTLP config (ensureMeterProvider also checks URL).
  if (!isBaselineUsageTelemetryEnabled() || !isOtlpExportConfigured()) return;
  ensureMeterProviderInitialized();

  if (AGENT_TOOLCALL_EVENT_NAMES.has(event.event_name)) {
    agentToolcallCounter.add(1, buildToolcallMetricAttributes(event));
  }
  if (TOKEN_EVENT_NAMES.has(event.event_name)) {
    if (typeof event.total_tokens === "number") {
      agentTokensCounter.add(event.total_tokens, buildTotalTokenMetricAttributes(event));
    }
  }
  if (event.event_name === TURN_COMPLETED_EVENT_NAME) {
    agentTurnCounter.add(1, buildTurnMetricAttributes(event));
    agentRunCounter.add(1, buildAgentRunMetricAttributes(event));
  }
  if (event.event_name === SIDECAR_REQUEST_EVENT_NAME) {
    sidecarRequestCounter.add(1, buildSidecarRequestMetricAttributes(event));
  }
}
