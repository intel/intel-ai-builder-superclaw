/**
 * Pre-warm opencode's lazily-initialized data-plane endpoints.
 *
 * `client.global.health()` returning healthy only proves opencode's HTTP
 * server is up. The first request to /config, /session, /provider, /command,
 * and /config/providers can each take 5-19s while opencode discovers
 * providers, indexes sessions, and builds the command catalog. UIs that
 * connect immediately after readiness see those calls time out.
 *
 * This function fires those GETs in parallel. Per-endpoint failures are
 * non-fatal warnings (a single slow/absent endpoint shouldn't fail startup),
 * but if EVERY endpoint fails we surface a single elevated warning — that
 * usually indicates a misconfiguration (wrong auth, bad base URL) which would
 * otherwise be hidden by the per-endpoint warning noise and make /health
 * appear "ready" while every real call is broken.
 *
 * `timeoutMs` is per endpoint; observed worst-case cold start is ~19s, so 30s
 * gives ~50% safety margin without stalling startup a full minute on a hung
 * endpoint.
 */
export async function prewarmOpencode(
  baseUrl: string,
  authHeaders: Record<string, string>,
  logger: { info: (msg: string, meta?: Record<string, unknown>, scope?: string) => void; warn: (msg: string, meta?: Record<string, unknown>, scope?: string) => void; debug: (msg: string, meta?: Record<string, unknown>, scope?: string) => void },
  timeoutMs = 30_000,
): Promise<void> {
  const endpoints = ["/config", "/session", "/provider", "/command", "/config/providers"];
  const base = baseUrl.replace(/\/$/, "");
  const start = Date.now();
  logger.info("Pre-warming endpoints", { endpoints, timeoutMs }, "opencode");

  const warmOne = async (path: string): Promise<{ path: string; ok: boolean; status: number; durationMs: number; error?: string }> => {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // egress-surface: supervisor_health_opencode
      const response = await fetch(`${base}${path}`, {
        method: "GET",
        headers: { Accept: "application/json", ...authHeaders },
        signal: controller.signal,
      });
      // Drain body so the connection can be reused / closed cleanly. On a failure the drained
      // body is kept: for opencode a 5xx carries its reason only there, so discarding it leaves
      // "all endpoints failed" with nothing to act on.
      let body: string | undefined;
      try {
        const text = await response.text();
        if (!response.ok && text) body = text.slice(0, 512);
      } catch { /* ignore */ }
      return { path, ok: response.ok, status: response.status, durationMs: Date.now() - t0, error: body };
    } catch (error) {
      return { path, ok: false, status: 0, durationMs: Date.now() - t0, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  };

  const results = await Promise.all(endpoints.map(warmOne));
  const totalMs = Date.now() - start;
  for (const result of results) {
    if (result.ok) {
      logger.info("Pre-warm hit", { path: result.path, status: result.status, durationMs: result.durationMs }, "opencode");
    } else {
      logger.warn("Pre-warm endpoint failed (non-fatal)", { path: result.path, status: result.status, durationMs: result.durationMs, error: result.error }, "opencode");
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  if (okCount === 0) {
    logger.warn(
      "Pre-warm: all endpoints failed — opencode may be misconfigured (auth headers, base URL, or process not ready)",
      { totalMs, endpointCount: endpoints.length, statuses: results.map((r) => ({ path: r.path, status: r.status, error: r.error })) },
      "opencode",
    );
  }
  logger.info(`Pre-warm complete total_ms=${totalMs}`, { totalMs, endpointCount: endpoints.length, okCount }, "opencode");
}
