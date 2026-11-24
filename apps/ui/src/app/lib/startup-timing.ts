import { uiLogInfo } from "./log";

/**
 * `hub.settings.wait` is the resolver-mount to hub-settings-available gap. It is
 * deliberately not called `webview.boot`: measured at 11993 ms on a real launch,
 * because settings only arrive once ServiceHub is ready, so it reports the
 * handshake wait as seen from the UI, not webview startup cost.
 */
export type StartupStep =
  | "hub.settings.wait"
  | "capability.profile"
  | "capability.preflight"
  | "capability.switch"
  | "dataplane.wait"
  | "reveal";

type StartupTimingRecord = {
  step: StartupStep;
  durationMs: number;
  elapsedMs: number | null;
};

type StartupTimingRoot = typeof globalThis & {
  __superclawStartupOrigin?: number;
  __superclawStartupMarks?: Partial<Record<StartupStep, number>>;
  __superclawStartupTimings?: StartupTimingRecord[];
  __superclawStartupClockOffsetMs?: number;
  __superclawStartupCompleted?: boolean;
};

const root = (): StartupTimingRoot => globalThis as StartupTimingRoot;

const nowMs = (): number => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

/**
 * Pin before recording any mark; lazy summary-only pinning makes fast segments
 * report `total_ms=0`.
 */
const pinOrigin = (): void => {
  const r = root();
  if (r.__superclawStartupOrigin === undefined) {
    r.__superclawStartupOrigin = nowMs();
  }
};

const elapsedOnRustAxis = (): number | null => {
  const offset = root().__superclawStartupClockOffsetMs;
  if (offset === undefined) return null;
  return Math.max(0, Math.round(nowMs() + offset));
};

const elapsedField = (elapsedMs: number | null): string =>
  elapsedMs === null ? "" : ` elapsed_ms=${elapsedMs}`;

/**
 * Project webview `performance.now()` onto the Rust monotonic axis. First usable
 * snapshot wins; re-pinning would bake fetch-latency jitter into later marks.
 */
export const bridgeStartupClock = (totalElapsedMs: number | null | undefined): void => {
  if (totalElapsedMs === null || totalElapsedMs === undefined) return;
  if (!Number.isFinite(totalElapsedMs) || totalElapsedMs < 0) return;
  const r = root();
  if (r.__superclawStartupClockOffsetMs !== undefined) return;
  pinOrigin();
  r.__superclawStartupClockOffsetMs = totalElapsedMs - nowMs();
};

export const startStartupStep = (step: StartupStep): void => {
  const r = root();
  pinOrigin();
  const marks = r.__superclawStartupMarks ?? (r.__superclawStartupMarks = {});
  if (marks[step] !== undefined) return;
  marks[step] = nowMs();
};

/**
 * A skipped step is a no-op; measuring it from launch origin would report a
 * phase that never ran. Durations stay in the message, not just structured
 * payload, because `ingest_ui_log` collapses payload attributes and the
 * container pretty logger writes only tag+message.
 */
export const completeStartupStep = (
  step: StartupStep,
  extra?: Record<string, unknown>,
): number | null => {
  const r = root();
  const marks = r.__superclawStartupMarks;
  if (marks === undefined) return null;
  const startedAt = marks[step];
  if (startedAt === undefined) return null;
  delete marks[step];

  const durationMs = Math.max(0, Math.round(nowMs() - startedAt));
  const elapsedMs = elapsedOnRustAxis();
  const timings = r.__superclawStartupTimings ?? (r.__superclawStartupTimings = []);
  timings.push({ step, durationMs, elapsedMs });

  uiLogInfo(
    `startup.ui.${step}`,
    `startup step complete step=${step} duration_ms=${durationMs}${elapsedField(elapsedMs)}`,
    { step, durationMs, elapsedMs, ...extra },
  );
  return durationMs;
};

export const completeStartupTiming = (input: {
  outcome: "runtime_connected";
  connectReason: string | null;
}): void => {
  const r = root();
  if (r.__superclawStartupCompleted) return;
  r.__superclawStartupCompleted = true;
  const totalMs = Math.max(0, Math.round(nowMs() - (r.__superclawStartupOrigin ?? nowMs())));
  const elapsedMs = elapsedOnRustAxis();
  const steps = (r.__superclawStartupTimings ?? [])
    .map((record) => `${record.step}:${record.durationMs}`)
    .join("|");

  uiLogInfo(
    "startup.complete",
    `startup complete outcome=${input.outcome} total_ms=${totalMs} steps=${steps}${elapsedField(elapsedMs)}`,
    { totalMs, elapsedMs, steps, ...input },
  );
};
