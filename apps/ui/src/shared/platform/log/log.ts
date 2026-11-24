/**
 * Unified frontend startup logger (2026-07-21 startup-logging unification §4.4).
 *
 * A lightweight logger built on the same in-memory ring-buffer + hot-event
 * throttle pattern as `perf-log.ts`. It stamps a `boot_id` (fetched from the
 * ServiceHub boot snapshot via the existing Tauri command path) and a `stage`
 * onto every line so the frontend timeline correlates with `tauri_*.log` /
 * `servicehub-*.log` under the same key.
 *
 * 2026-07-22 follow-up (persistence): every record is also queued for a
 * best-effort flush to the Rust `ingest_ui_log` command, which routes it
 * through the same `tracing` pipeline as `tauri_*.log` (tagged
 * `component="ui"`). This closes the gap in the original design (§7 decision
 * 2 shipped in-memory-only): a webview crash/reload used to leave zero
 * on-disk evidence of what the UI showed during a failed startup. The ring
 * buffer stays as the synchronous, always-available source of truth (e.g. for
 * devtools export); disk persistence is deliberately best-effort on top of
 * it — a failed/slow flush must never block or drop a log call.
 *
 * Outside a Tauri runtime (web/dev preview, `bun test`) persistence is a
 * silent no-op; only the ring buffer is used, same as before this follow-up.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "~/shared/platform/runtime-env";

export type UiLogLevel = "debug" | "info" | "warn" | "error";
export type UiLogOptions = {
  hot?: boolean;
  aggregate?: { key: string; windowMs: number };
};

export type UiLogRecord = {
  id: number;
  at: string;
  ts: number;
  level: UiLogLevel;
  stage: string;
  bootId: string;
  message: string;
  payload?: Record<string, unknown>;
};

type UiLogRoot = typeof globalThis & {
  __superclawUiLogSeq?: number;
  __superclawUiLogs?: UiLogRecord[];
  __superclawUiBootId?: string;
  __superclawUiLogThrottleAt?: Record<string, number>;
  __superclawUiLogAggregation?: Record<string, { windowStartedAt: number; suppressed: number }>;
  __superclawUiPending?: UiLogRecord[];
  __superclawUiFlushTimer?: ReturnType<typeof setTimeout>;
  __superclawUiFlushing?: boolean;
  __superclawUiFlushRequested?: boolean;
  __superclawUiFlushFailures?: number;
  __superclawUiFlushFailureReported?: boolean;
  __superclawUiDroppedPending?: number;
};

const UI_LOG_LIMIT = 500;
const HOT_EVENT_MIN_INTERVAL_MS = 750;

/** Cap on unflushed records kept for persistence. Same order of magnitude as
 * the ring buffer — if `ingest_ui_log` keeps failing (e.g. called before the
 * Tauri IPC bridge is up) we drop the oldest pending records rather than grow
 * without bound. */
const PENDING_PERSIST_LIMIT = 500;
/** Batches a burst of info/debug lines into one `ingest_ui_log` call instead
 * of round-tripping IPC per line. */
const FLUSH_DEBOUNCE_MS = 1_500;

const wireEntry = (
  record: UiLogRecord,
): { level: UiLogLevel; stage: string; message: string; ts: number; payload?: Record<string, unknown> } => ({
  level: record.level,
  stage: record.stage,
  message: record.message,
  ts: record.ts,
  payload: record.payload,
});

/**
 * Best-effort flush of every pending record to the Rust `ingest_ui_log`
 * command (see `logging.rs::emit_ui_log`). Guarded so overlapping callers
 * (a debounced timer firing while an error-triggered flush is in flight)
 * never send the same record twice or drop one being appended concurrently.
 */
const flushUiLogsToDisk = async (): Promise<void> => {
  const root = globalThis as UiLogRoot;
  if (root.__superclawUiFlushing) {
    // A new immediate flush arrived while the current IPC batch was in flight.
    // Let that batch finish first, then drain records appended during its await.
    root.__superclawUiFlushRequested = true;
    return;
  }
  const pending = root.__superclawUiPending ?? [];
  if (pending.length === 0) return;

  root.__superclawUiFlushing = true;
  const batch = pending.slice();
  let sent = false;
  try {
    await invoke("ingest_ui_log", { entries: batch.map(wireEntry) });
    // Drop only the record objects we captured in `batch`. Positional splice is
    // unsafe when the cap evicts items; ids are unsafe when `clearUiLogs()` resets
    // the seq and a new pending record reuses an id while this IPC is in flight.
    const sentBatch = new Set(batch);
    const current = root.__superclawUiPending ?? [];
    root.__superclawUiPending = current.filter((record) => !sentBatch.has(record));
    sent = true;
  } catch {
    // Backend unreachable (e.g. very early boot, or a non-Tauri preview) —
    // leave the batch queued; the ring buffer already has it either way, and
    // the next scheduled/immediate flush will retry.
    root.__superclawUiFlushFailures = (root.__superclawUiFlushFailures ?? 0) + 1;
    if (!root.__superclawUiFlushFailureReported) {
      // This record joins the pending batch and reaches disk if a later retry
      // succeeds. The guard prevents a broken bridge from filling the queue
      // with failures about its own failures.
      root.__superclawUiFlushFailureReported = true;
      uiLogWarn("log.flush_failed", "UI log persistence failed", {
        failures: root.__superclawUiFlushFailures,
        pending: batch.length,
        dropped: root.__superclawUiDroppedPending ?? 0,
      });
    }
  } finally {
    root.__superclawUiFlushing = false;
    if (sent && ((root.__superclawUiFlushFailures ?? 0) > 0 || (root.__superclawUiDroppedPending ?? 0) > 0)) {
      const failures = root.__superclawUiFlushFailures ?? 0;
      const dropped = root.__superclawUiDroppedPending ?? 0;
      root.__superclawUiFlushFailures = 0;
      root.__superclawUiFlushFailureReported = false;
      root.__superclawUiDroppedPending = 0;
      uiLogWarn("log.flush_recovered", "UI log persistence recovered", {
        failures,
        dropped,
      });
    }
    if (sent && root.__superclawUiFlushRequested) {
      root.__superclawUiFlushRequested = false;
      void flushUiLogsToDisk();
    }
  }
};

const scheduleFlush = (immediate: boolean): void => {
  if (!isTauriRuntime()) return;
  const root = globalThis as UiLogRoot;
  if (immediate) {
    if (root.__superclawUiFlushTimer !== undefined) {
      clearTimeout(root.__superclawUiFlushTimer);
      root.__superclawUiFlushTimer = undefined;
    }
    void flushUiLogsToDisk();
    return;
  }
  if (root.__superclawUiFlushTimer !== undefined) return; // already scheduled
  root.__superclawUiFlushTimer = setTimeout(() => {
    root.__superclawUiFlushTimer = undefined;
    void flushUiLogsToDisk();
  }, FLUSH_DEBOUNCE_MS);
};

/** Manually flush now (e.g. before a window unload). Safe to call outside a
 * Tauri runtime — it's then just a no-op. */
export const flushUiLogsNow = (): Promise<void> => {
  if (!isTauriRuntime()) return Promise.resolve();
  const root = globalThis as UiLogRoot;
  if (root.__superclawUiFlushTimer !== undefined) {
    clearTimeout(root.__superclawUiFlushTimer);
    root.__superclawUiFlushTimer = undefined;
  }
  return flushUiLogsToDisk();
};

// Best-effort safety net: a window close/reload can happen mid-debounce
// (up to `FLUSH_DEBOUNCE_MS` of the most recent info/debug lines still
// unflushed). `pagehide` fires more reliably than `beforeunload` across
// embedders; both are wired since neither is universally guaranteed to fire
// before teardown. No-op outside a browser-like global (bun test, SSR).
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const flushOnUnload = (): void => {
    void flushUiLogsNow();
  };
  window.addEventListener("pagehide", flushOnUnload);
  window.addEventListener("beforeunload", flushOnUnload);
}

/**
 * Record the launch boot_id (from the ServiceHub boot snapshot). Idempotent and
 * safe to call before every log; the first non-empty value wins for the launch.
 */
export const setUiBootId = (bootId: string | null | undefined): void => {
  const trimmed = (bootId ?? "").trim();
  if (!trimmed) return;
  const root = globalThis as UiLogRoot;
  if (root.__superclawUiBootId) return;
  root.__superclawUiBootId = trimmed;
};

const currentBootId = (): string => {
  const root = globalThis as UiLogRoot;
  return root.__superclawUiBootId ?? "-";
};

const consoleFn = (level: UiLogLevel): ((...args: unknown[]) => void) => {
  switch (level) {
    case "warn":
      return console.warn.bind(console);
    case "error":
      return console.error.bind(console);
    default:
      return console.log.bind(console);
  }
};

/**
 * Emit a unified UI log line. `hot` limits console output only. For a noisy
 * diagnostic path, use `aggregate` as well: the first event is retained and
 * later duplicates become one bounded summary per window, preserving room for
 * startup and failure records in both the ring buffer and persisted log.
 */
export const uiLog = (
  level: UiLogLevel,
  stage: string,
  message: string,
  payload?: Record<string, unknown>,
  options?: UiLogOptions,
): void => {
  const root = globalThis as UiLogRoot;
  const bootId = currentBootId();
  const now = Date.now();

  if (options?.aggregate) {
    const { key, windowMs } = options.aggregate;
    const aggregation = root.__superclawUiLogAggregation ?? (root.__superclawUiLogAggregation = {});
    const current = aggregation[key];
    if (current && now - current.windowStartedAt < windowMs) {
      current.suppressed += 1;
      return;
    }
    if (current?.suppressed) {
      uiLog(
        level,
        stage,
        "Repeated UI log events aggregated",
        { aggregationKey: key, suppressedCount: current.suppressed, windowMs },
      );
    }
    aggregation[key] = { windowStartedAt: now, suppressed: 0 };
  }

  const id = (root.__superclawUiLogSeq ?? 0) + 1;
  root.__superclawUiLogSeq = id;

  const entry: UiLogRecord = {
    id,
    at: new Date().toISOString(),
    ts: now,
    level,
    stage,
    bootId,
    message,
    payload,
  };

  const logs = root.__superclawUiLogs ?? [];
  logs.push(entry);
  if (logs.length > UI_LOG_LIMIT) {
    logs.splice(0, logs.length - UI_LOG_LIMIT);
  }
  root.__superclawUiLogs = logs;

  // Persistence (2026-07-22 follow-up): queue every record for a best-effort
  // disk flush. warn/error flush right away — those are exactly the lines a
  // post-mortem needs and most likely to precede a crash/reload that would
  // otherwise wipe the in-memory ring buffer; info/debug batch on a timer.
  const pending = root.__superclawUiPending ?? [];
  pending.push(entry);
  if (pending.length > PENDING_PERSIST_LIMIT) {
    const dropped = pending.length - PENDING_PERSIST_LIMIT;
    pending.splice(0, dropped);
    root.__superclawUiDroppedPending = (root.__superclawUiDroppedPending ?? 0) + dropped;
  }
  root.__superclawUiPending = pending;
  scheduleFlush(level === "warn" || level === "error");

  if (options?.hot) {
    const throttleAt =
      root.__superclawUiLogThrottleAt ?? (root.__superclawUiLogThrottleAt = {});
    const key = `${level}:${stage}`;
    const now = Date.now();
    const last = throttleAt[key] ?? 0;
    if (now - last < HOT_EVENT_MIN_INTERVAL_MS) {
      // Suppress only the console write below — the record is already in the
      // ring buffer and the persistence queue (pushed above).
      return;
    }
    throttleAt[key] = now;
  }

  try {
    const prefix = `[ui] boot_id=${bootId} stage=${stage}`;
    if (payload === undefined) {
      consoleFn(level)(`${prefix} ${message}`);
    } else {
      consoleFn(level)(`${prefix} ${message}`, payload);
    }
  } catch {
    // console unavailable — the ring buffer still captured the record.
  }
};

export const uiLogDebug = (
  stage: string,
  message: string,
  payload?: Record<string, unknown>,
): void => uiLog("debug", stage, message, payload);

export const uiLogInfo = (
  stage: string,
  message: string,
  payload?: Record<string, unknown>,
): void => uiLog("info", stage, message, payload);

export const uiLogWarn = (
  stage: string,
  message: string,
  payload?: Record<string, unknown>,
  options?: UiLogOptions,
): void => uiLog("warn", stage, message, payload, options);

export const uiLogError = (
  stage: string,
  message: string,
  payload?: Record<string, unknown>,
): void => uiLog("error", stage, message, payload);

/** Read the most recent UI log records (newest last), for devtools export. */
export const readUiLogs = (limit = 120): UiLogRecord[] => {
  const root = globalThis as UiLogRoot;
  const logs = root.__superclawUiLogs ?? [];
  if (limit <= 0) return [];
  if (logs.length <= limit) return logs.slice();
  return logs.slice(logs.length - limit);
};

export const clearUiLogs = (): void => {
  const root = globalThis as UiLogRoot;
  root.__superclawUiLogs = [];
  root.__superclawUiLogSeq = 0;
  root.__superclawUiPending = [];
  root.__superclawUiLogAggregation = {};
  root.__superclawUiFlushFailures = 0;
  root.__superclawUiFlushFailureReported = false;
  root.__superclawUiDroppedPending = 0;
  if (root.__superclawUiFlushTimer !== undefined) {
    clearTimeout(root.__superclawUiFlushTimer);
    root.__superclawUiFlushTimer = undefined;
  }
};
