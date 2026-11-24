import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";

import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import { scrubCrashText } from "./crash.js";
import type { RuntimeTelemetryEvent } from "./runtime-telemetry.js";
import {
  isBaselineUsageTelemetryEnabled,
  isExportPipelineEnabled,
  isFullTelemetryCrashExportEnabled,
} from "./otel-metrics.js";

let initialized = false;
let runtimeLogger = logs.getLogger("superclaw-runtime-telemetry");
let loggerProvider: LoggerProvider | null = null;
let cachedOtelLogsEnabled: boolean | null = null;
let cachedOtlpHttpBaseUrl: string | null = null;
let cachedServiceVersion: string | null = null;

const TOOL_CALL_FAILED_EVENT_NAME = "tool_call_failed";
// Baseline install + usage heartbeat: logs-only, no counter. Exports under the
// baseline telemetry gate. The install_id rides the log BODY only, never an attribute.
const ACTIVE_INSTALL_EVENT_NAME = "active_install";
const CRASH_REPORTED_EVENT_NAME = "crash_reported";
const MAX_ERROR_MESSAGE_LENGTH = 500;

function isOtelLogsEnabled(): boolean {
  if (cachedOtelLogsEnabled !== null) return cachedOtelLogsEnabled;
  // Bring the logger up when either baseline install + usage or full telemetry is on.
  cachedOtelLogsEnabled = isExportPipelineEnabled();
  return cachedOtelLogsEnabled;
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

export function resetLogsConfigCacheForTests(): void {
  cachedOtelLogsEnabled = null;
  cachedOtlpHttpBaseUrl = null;
  cachedServiceVersion = null;
  initialized = false;
  loggerProvider = null;
  runtimeLogger = logs.getLogger("superclaw-runtime-telemetry");
}

export function ensureLoggerProviderInitialized(): void {
  if (initialized || !isOtelLogsEnabled()) return;
  const otlpBaseUrl = otlpHttpBaseUrl();
  if (!otlpBaseUrl) return;
  initialized = true;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "openwork-server",
    [ATTR_SERVICE_VERSION]: serviceVersion(),
  });

  loggerProvider = new LoggerProvider({ resource, processors: [
    new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${otlpBaseUrl}/v1/logs` })),
  ] });
  logs.setGlobalLoggerProvider(loggerProvider);

  runtimeLogger = logs.getLogger("superclaw-runtime-telemetry");
}

export async function flushLogEvents(): Promise<void> {
  if (!loggerProvider) return;
  await loggerProvider.forceFlush();
}

function truncateErrorMessage(value: string): string {
  if (value.length <= MAX_ERROR_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...[truncated]`;
}

export function buildToolCallFailureLogAttributes(
  event: RuntimeTelemetryEvent,
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {};
  for (const key of ["app_version", "bundle_id", "tool_name", "agent_type"] as const) {
    const value = event[key];
    if (typeof value === "string" && value) attrs[`superclaw.${key}`] = value;
  }
  return attrs;
}

export function buildCrashLogAttributes(
  event: RuntimeTelemetryEvent,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of ["app_version", "bundle_id", "release", "runtime", "service", "channel"] as const) {
    const value = event[key];
    if (typeof value === "string" && value) attrs[`superclaw.${key}`] = value;
  }
  return attrs;
}

export function buildToolCallFailureLogBody(event: RuntimeTelemetryEvent): string {
  return JSON.stringify({
    event_name: event.event_name,
    app_version: typeof event.app_version === "string" && event.app_version ? event.app_version : undefined,
    source: typeof event.source === "string" && event.source ? event.source : undefined,
    tool_name: typeof event.tool_name === "string" && event.tool_name ? event.tool_name : undefined,
    agent_type: typeof event.agent_type === "string" && event.agent_type ? event.agent_type : undefined,
    provider_id: typeof event.provider_id === "string" && event.provider_id ? event.provider_id : undefined,
    model_id: typeof event.model_id === "string" && event.model_id ? event.model_id : undefined,
    bundle_id: typeof event.bundle_id === "string" && event.bundle_id ? event.bundle_id : undefined,
    outcome: typeof event.outcome === "string" && event.outcome ? event.outcome : undefined,
    error_class: typeof event.error_class === "string" && event.error_class ? event.error_class : undefined,
    error:
      typeof event.error === "string" && event.error
        ? scrubCrashText(event.error, MAX_ERROR_MESSAGE_LENGTH)
        : undefined,
    install_id: typeof event.install_id === "string" && event.install_id ? event.install_id : undefined,
  });
}

/**
 * Attributes for the baseline heartbeat. Deliberately low-cardinality and
 * non-identifying: only version/os/channel. The install_id is NEVER an
 * attribute (it rides the body) so it can never become a metric dimension.
 */
export function buildBaselineLogAttributes(
  event: RuntimeTelemetryEvent,
): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of ["app_version", "bundle_id", "os", "channel"] as const) {
    const value = event[key];
    if (typeof value === "string" && value) attrs[`superclaw.${key}`] = value;
  }
  return attrs;
}

/**
 * Body for the baseline heartbeat signal. This is the
 * only place the install_id is carried, and it is logs-only.
 */
export function buildBaselineLogBody(event: RuntimeTelemetryEvent): string {
  return JSON.stringify({
    event_name: event.event_name,
    install_id:
      typeof event.install_id === "string" && event.install_id ? event.install_id : undefined,
    app_version:
      typeof event.app_version === "string" && event.app_version ? event.app_version : undefined,
    bundle_id: typeof event.bundle_id === "string" && event.bundle_id ? event.bundle_id : undefined,
    os: typeof event.os === "string" && event.os ? event.os : undefined,
    channel: typeof event.channel === "string" && event.channel ? event.channel : undefined,
  });
}

export function buildCrashLogBody(event: RuntimeTelemetryEvent): string {
  return JSON.stringify({
    event_name: CRASH_REPORTED_EVENT_NAME,
    app_version: typeof event.app_version === "string" && event.app_version ? event.app_version : undefined,
    bundle_id: typeof event.bundle_id === "string" && event.bundle_id ? event.bundle_id : undefined,
    release: typeof event.release === "string" && event.release ? event.release : undefined,
    runtime: typeof event.runtime === "string" && event.runtime ? event.runtime : undefined,
    service: typeof event.service === "string" && event.service ? event.service : undefined,
    channel: typeof event.channel === "string" && event.channel ? event.channel : undefined,
    outcome: typeof event.outcome === "string" && event.outcome ? event.outcome : undefined,
    error_class: typeof event.error_class === "string" && event.error_class ? event.error_class : undefined,
    error: typeof event.error === "string" && event.error ? truncateErrorMessage(event.error) : undefined,
    stack: typeof event.stack === "string" && event.stack ? event.stack : undefined,
    install_id: typeof event.install_id === "string" && event.install_id ? event.install_id : undefined,
  });
}

export function recordLogEvent(event: RuntimeTelemetryEvent): void {
  if (!isOtelLogsEnabled()) return;
  ensureLoggerProviderInitialized();

  // Baseline telemetry: active-install heartbeat.
  if (event.event_name === ACTIVE_INSTALL_EVENT_NAME) {
    if (!isBaselineUsageTelemetryEnabled()) return;
    runtimeLogger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: buildBaselineLogBody(event),
      attributes: buildBaselineLogAttributes(event),
    });
    return;
  }

  // Full telemetry: scrubbed crash telemetry.
  if (event.event_name === CRASH_REPORTED_EVENT_NAME) {
    if (!isFullTelemetryCrashExportEnabled()) return;
    runtimeLogger.emit({
      severityNumber: SeverityNumber.FATAL,
      severityText: "FATAL",
      body: buildCrashLogBody(event),
      attributes: buildCrashLogAttributes(event),
    });
    return;
  }

  // Baseline telemetry: tool-call failure log.
  if (event.event_name === TOOL_CALL_FAILED_EVENT_NAME) {
    if (!isBaselineUsageTelemetryEnabled()) return;
    runtimeLogger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      body: buildToolCallFailureLogBody(event),
      attributes: buildToolCallFailureLogAttributes(event),
    });
  }
}
