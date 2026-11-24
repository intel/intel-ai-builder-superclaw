/**
 * Health-wait helper for the opencode HTTP server.
 *
 * Extracted from cli.ts so it can be unit-tested in isolation (cli.ts runs
 * main() on import and exports nothing).
 *
 * Each attempt is raced against a per-try deadline. Without it a single hung
 * `health()` request (connection established, response never delivered — seen
 * live as an idle ESTABLISHED socket to opencode:4096 that never retried) would
 * block `await client.global.health()` forever: the loop only re-checks the
 * overall deadline *between* awaits, so it was never reached. When the per-try
 * deadline fires we abort the request (tearing down that half-open connection
 * so the next poll opens a fresh one) and reject the race, guaranteeing the
 * loop makes progress regardless of the request's fate.
 */

interface HealthResult {
  data?: { healthy?: boolean } & Record<string, unknown>;
  error?: unknown;
}

/** Minimal slice of the opencode SDK client this helper needs. */
export interface OpencodeHealthClient {
  global: {
    health: (options?: { signal?: AbortSignal }) => Promise<HealthResult>;
  };
}

// After generation publication, SM starts Connector, HDR and Runtime (30s
// launcher deadline each) and waits up to 300s for HDR. Add 30s for config
// sealing, the final in-flight HDR probe/poll and Runtime HTTP startup.
// Publication precedes this CLI wait; this is a finite observer cap, not an owner.
export const EXTERNAL_HDR_RUNTIME_TIMEOUT_MS = (3 * 30 + 300 + 30) * 1_000;

export interface WaitForOpencodeHealthyOptions {
  /** Overall deadline for reaching a healthy state. */
  timeoutMs?: number;
  /** Delay between attempts. */
  pollMs?: number;
  /** Per-attempt request timeout; a hung request is aborted after this. */
  perTryMs?: number;
  /**
   * Direct HTTP fallback, tried on each attempt after the SDK call fails.
   *
   * The opencode SDK client expects a JSON body from `/health`. With Basic
   * auth configured, some opencode builds answer `/health` with a 200 HTML
   * page instead of JSON, which the SDK can't parse as healthy even though
   * the server is genuinely up. When set, a plain authenticated `GET
   * {baseUrl}/health` that returns any 2xx status is accepted as healthy.
   */
  fallback?: { baseUrl: string; headers?: Record<string, string> };
}

export async function waitForOpencodeHealthy(
  client: OpencodeHealthClient,
  { timeoutMs = 10_000, pollMs = 250, perTryMs = 3_000, fallback }: WaitForOpencodeHealthyOptions = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const result = await raceWithTimeout(client, Math.min(perTryMs, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      if (result.data !== undefined) {
        if (result.data.healthy) return result.data;
        lastError = "Server reported unhealthy";
      } else {
        const message =
          result.error instanceof Error
            ? result.error.message
            : typeof result.error === "string"
              ? result.error
              : JSON.stringify(result.error);
        lastError = message || "Unknown error";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (fallback && Date.now() < deadline) {
      try {
        // egress-surface: supervisor_health_opencode
        const response = await fetch(`${fallback.baseUrl.replace(/\/$/, "")}/health`, {
          headers: fallback.headers,
          signal: AbortSignal.timeout(Math.min(2_000, Math.max(0, deadline - Date.now()))),
        });
        if (response.ok) return { healthy: true };
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
    }
  }
  throw new Error(lastError ?? "Timed out waiting for OpenCode health");
}

/**
 * Run one health() attempt with a hard per-try deadline.
 *
 * The timeout uses a ref'd setTimeout (not AbortSignal.timeout, whose timer is
 * unref'd and would not fire when the only pending work is a hung request) so
 * the race always settles. When it fires we also abort the request's signal so
 * the underlying fetch tears down its (possibly half-open) connection.
 */
async function raceWithTimeout(client: OpencodeHealthClient, perTryMs: number): Promise<HealthResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("health probe per-try timeout"));
    }, perTryMs);
  });
  try {
    return await Promise.race([client.global.health({ signal: controller.signal }), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
