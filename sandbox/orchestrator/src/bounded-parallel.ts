import * as os from "node:os";

/**
 * How many file operations publication runs at once when it copies or reads a whole tree.
 *
 * Like the flush (`FLUSH_CONCURRENCY` in `profile-deployment.ts`), these passes pay a per-file
 * latency - the first open or the create and close of each file, which is where on-access
 * scanning runs - not bandwidth. Measured with Defender real-time protection on: copying the
 * 3,975-file, 57 MB Runtime dependency tree took 4.2-4.9 s median serial against 2.1-2.6 s at
 * 8, with 16 slower than 8; reading the 96 freshly written files of the `pro` Profile took
 * 582 ms serial against 93 ms at 8. That was a 16-core machine, so the bound is also capped at
 * the machine's parallelism: a smaller SKU never runs more of them than it has cores.
 */
const FILE_CONCURRENCY = 8;

function machineParallelism(): number {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
}

/** `FILE_CONCURRENCY`, capped at `parallelism` (the machine's by default) and never below 1. */
export function fileConcurrency(parallelism = machineParallelism()): number {
  return Math.max(1, Math.min(FILE_CONCURRENCY, parallelism));
}

/**
 * Run `operation` over every item, at most `limit` at once. After a failure no further
 * operation starts, and the first error is thrown only once every operation in flight has
 * settled, so a caller that cleans up on failure never races an operation still running.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        await operation(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  }));
  if (failure !== undefined) throw failure.error;
}
