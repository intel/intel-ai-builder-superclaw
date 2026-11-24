import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync } from "node:fs";

type Context = { instance: string; attempt: string; sequence: number };
const context = new AsyncLocalStorage<Context>();
const codes = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT", "EEXIST", "ENOTEMPTY", "EXDEV", "EINVAL", "EIO", "EMFILE", "ENFILE", "ENOSPC"]);
const syscalls = new Set(["rename", "open", "stat", "lstat", "mkdir", "copyfile", "scandir", "unlink", "rmdir", "fsync", "chmod"]);

export function publicationContext<T>(instance: string, attempt: string, operation: () => T): T {
  return context.run({
    instance: /^runtime-instance-[0-9a-f]{32}$/.test(instance) ? instance : "invalid",
    attempt: /^runtime-attempt-[0-9a-f]{32}$/.test(attempt) ? attempt : "invalid",
    sequence: 0,
  }, operation);
}

function errorFields(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const value = error as Record<string, unknown>;
  return {
    code: typeof value.code === "string" && codes.has(value.code) ? value.code : "other",
    errno: typeof value.errno === "number" && Number.isSafeInteger(value.errno) ? value.errno : null,
    syscall: typeof value.syscall === "string" && syscalls.has(value.syscall) ? value.syscall : "other",
  };
}

function emit(stage: string, event: string, fields: Record<string, unknown> = {}): void {
  const current = context.getStore();
  if (!current) return;
  try {
    // No paths, exception message/stack, environment, config content or token values.
    console.error("PUBLICATION_DIAG=" + JSON.stringify({
      instance: current.instance, attempt: current.attempt, pid: process.pid,
      sequence: ++current.sequence, stage, event, ...fields,
    }));
  } catch { /* Diagnostics never decide whether publication succeeded. */ }
}

function observedPath(path: string): Record<string, unknown> {
  try {
    const stat = lstatSync(path);
    return { exists: true, directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), mode: stat.mode };
  } catch (error) {
    return { exists: "unknown", ...errorFields(error) };
  }
}

/**
 * What a stage moved or inspected while it ran.
 *
 * A duration alone cannot separate "many files" from "slow per file", and that is the
 * distinction every publication optimization decision turns on.
 */
export interface PublicationMetrics {
  readonly files?: number;
  readonly directories?: number;
  readonly bytes?: number;
}

export interface PublicationStepOptions<T> {
  /** Observed after a failure only, as evidence; the observation is not atomic with it. */
  readonly paths?: { readonly source: string; readonly destination: string };
  /** Counts taken from the stage's own result, reported with its `end` event. */
  readonly metrics?: (value: T) => PublicationMetrics;
}

function metricFields<T>(extract: ((value: T) => PublicationMetrics) | undefined, value: T): Record<string, unknown> {
  if (!extract) return {};
  try {
    const metrics = extract(value);
    const fields: Record<string, unknown> = {};
    for (const key of ["files", "directories", "bytes"] as const) {
      const count = metrics[key];
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) fields[key] = count;
    }
    return fields;
  } catch {
    return {}; /* Diagnostics never decide whether publication succeeded. */
  }
}

export function publicationStep<T>(stage: string, operation: () => T, options: PublicationStepOptions<T> = {}): T {
  const started = performance.now();
  emit(stage, "begin");
  try {
    const value = operation();
    emit(stage, "end", {
      elapsed_ms: Math.round(performance.now() - started),
      ...metricFields(options.metrics, value),
    });
    return value;
  } catch (error) {
    try {
      // Emit original failure first; subsequent lstat is post-failure evidence, not atomic.
      emit(stage, "failed", { elapsed_ms: Math.round(performance.now() - started), ...errorFields(error) });
      if (options.paths && context.getStore()) emit(stage, "post_failure_observation", {
        source: observedPath(options.paths.source), destination: observedPath(options.paths.destination),
      });
    } catch { /* Preserve the exact original exception even for malformed error objects. */ }
    throw error;
  }
}

export async function publicationAsyncStep<T>(
  stage: string,
  operation: () => Promise<T>,
  options: PublicationStepOptions<T> = {},
): Promise<T> {
  const started = performance.now();
  emit(stage, "begin");
  try {
    const value = await operation();
    emit(stage, "end", {
      elapsed_ms: Math.round(performance.now() - started),
      ...metricFields(options.metrics, value),
    });
    return value;
  } catch (error) {
    try { emit(stage, "failed", { elapsed_ms: Math.round(performance.now() - started), ...errorFields(error) }); } catch { /* Preserve failure. */ }
    throw error;
  }
}

export function publicationDiagnostic(
  stage: string,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  emit(stage, event, fields);
}