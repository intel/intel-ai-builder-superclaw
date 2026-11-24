/**
 * Deadlines for the network calls sidecar resolution makes (#2888).
 *
 * A `fetch` with no deadline waits for the operating system's connect timeout, which on a machine
 * with no route is tens of seconds, and it did so on the start-up path. Kept out of `cli.ts` for the
 * reason `external-services.ts` states: `cli.ts` runs `main()` when imported, so a test cannot import
 * anything from it.
 */

// A slow first-run network that needs longer than this now lands on the "download failed" path
// instead of waiting the operating system's connect timeout.
export const REMOTE_MANIFEST_TIMEOUT_MS = 10_000;
// Covers the whole transfer including the body. Generous so a slow but progressing download of a large
// binary is not cut off.
export const SIDECAR_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * Runs `operation` with a deadline that covers all of it, including reading a response body.
 *
 * The deadline both aborts the signal handed to the operation and rejects this call directly, so an
 * operation that ignores its signal still cannot hold the caller past the deadline.
 */
export async function runBounded<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    // Started inside the try, after the timer exists, so a synchronous throw from `operation` still
    // clears it. An abandoned operation's late rejection is swallowed rather than left unhandled.
    const running = Promise.resolve().then(() => operation(controller.signal));
    running.catch(() => undefined);
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** GET `url` as JSON under the manifest deadline. Resolves to null on any failure, including a timeout. */
export async function fetchJsonBounded<T>(
  url: string,
  timeoutMs: number = REMOTE_MANIFEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<T | null> {
  try {
    return await runBounded(`fetch ${url}`, timeoutMs, async (signal) => {
      // egress-surface: supervisor_sidecar_download
      const response = await fetchImpl(url, { signal });
      return response.ok ? ((await response.json()) as T) : null;
    });
  } catch {
    return null;
  }
}

/** GET `url` as bytes under the whole-transfer deadline. Throws on an HTTP error or a timeout. */
export async function downloadBounded(
  url: string,
  timeoutMs: number = SIDECAR_DOWNLOAD_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  return runBounded(`download ${url}`, timeoutMs, async (signal) => {
    // egress-surface: supervisor_sidecar_download
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      throw new Error(`Failed to download ${url} (HTTP ${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  });
}
