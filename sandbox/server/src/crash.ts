import { flushLogEvents, recordLogEvent } from "./otel-logs.js";
import type { RuntimeTelemetryEvent } from "./runtime-telemetry.js";

const MAX_ERROR_CHARS = 500;
const MAX_STACK_CHARS = 4000;
let installed = false;

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars
    ? `${value.slice(0, maxChars - 3)}...`
    : value;
}

export function scrubCrashText(input: unknown, maxChars: number): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "unknown";

  const withoutUrlSecrets = raw.replace(/https?:\/\/[^\s)]+/gi, (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return value.replace(/[?#].*$/, "");
    }
  });
  const withoutPaths = withoutUrlSecrets
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "~")
    .replace(/\/(Users|home)\/[^\s\n)]+/g, "~");

  return truncate(withoutPaths, maxChars);
}

export function buildServerCrashRecord(reason: unknown): RuntimeTelemetryEvent {
  const error = reason instanceof Error ? reason : new Error(String(reason ?? "unknown"));
  const release = (process.env.SUPERCLAW_APP_VERSION || "unknown").trim() || "unknown";
  const bundleId = (process.env.SUPERCLAW_BUNDLE_ID || "").trim() || undefined;
  const stack = scrubCrashText(error.stack, MAX_STACK_CHARS);

  return {
    event_name: "crash_reported",
    app_version: release,
    bundle_id: bundleId,
    release,
    runtime: "node",
    service: "openwork-server",
    channel: (process.env.SUPERCLAW_BUILD_CHANNEL || "dev").trim() || "dev",
    outcome: "failed",
    error_class: scrubCrashText(error.name || "Error", 120),
    error: scrubCrashText(error.message, MAX_ERROR_CHARS),
    stack: stack === "unknown" ? undefined : stack,
    install_id: (process.env.SUPERCLAW_INSTALL_ID || "").trim() || undefined,
  };
}

async function flushLogsAndExit(): Promise<void> {
  try {
    await flushLogEvents();
  } catch {
    // Crash export is best-effort; a failed flush must not keep the process alive.
  }
  process.exit(1);
}

export function installServerCrashHandlers(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (error) => {
    recordLogEvent(buildServerCrashRecord(error));
    void flushLogsAndExit();
  });
  process.on("unhandledRejection", (reason) => {
    recordLogEvent(buildServerCrashRecord(reason));
    process.exitCode = 1;
    void flushLogsAndExit();
  });
}
