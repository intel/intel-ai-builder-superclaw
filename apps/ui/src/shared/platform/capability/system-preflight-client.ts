/**
 * System preflight client — reads the LRM hardware/resource preflight through
 * the ServiceHub transparent proxy (same transport + hub token as the other
 * capability calls).
 *
 *   GET /llm-router/v1/system/preflight?bundle_id=<id> → { ready, checks[], hardware }
 *
 * The startup resolver calls this between fetching the primary-bundle
 * capability (step 2) and starting the bundle switch (step 3), passing the
 * ceiling bundle_id so LRM sizes the model-memory / disk checks against the
 * exact bundle this launch will activate (PR #1503).
 *
 * ServiceHub gates this route on its own activation-coordinator boot recovery
 * (423 `system_preflight_recovery_in_progress`, same shape as
 * `/app/capability-profile`): a recovery sweep can resume a leftover
 * activation and start consuming memory for a model load fully independently
 * of the App, and sampling free RAM mid-sweep would read memory it already
 * consumed as "insufficient" against the true idle baseline. Treated as just
 * another fail-open condition below rather than retried — enforcement only
 * ever matters pre-`primary_bundle`, and the actual activation POST has its
 * own recovery gate regardless of what preflight saw.
 *
 * Fail-open: any transport error / timeout / 404 unknown_bundle / recovery
 * 423 returns `null` so the caller keeps booting. Only a successful response
 * with a hard resource failure (interpreted by `evaluateHardwarePreflight`)
 * ever blocks startup.
 */
import { requestServiceHubJson, ServiceHubHttpError, type ServiceHubSettings } from "~/shared/platform/transport/servicehub";
import type { PreflightResponse } from "./preflight-policy";

export const SYSTEM_PREFLIGHT_PATH = "/llm-router/v1/system/preflight";
const PREFLIGHT_TIMEOUT_MS = 8_000;

/**
 * Fetch the system preflight for a specific bundle. `bundleId` scopes the
 * model-memory / disk checks to the bundle this launch will activate; when
 * omitted, LRM falls back to legacy active-selection scoping.
 *
 * Returns `null` on any failure (fail-open) — a flaky probe or an unknown
 * bundle (404) must never block startup; only a successful response with a
 * hard resource failure does.
 */
export async function fetchSystemPreflight(
  settings: ServiceHubSettings,
  bundleId?: string | null,
  signal?: AbortSignal,
): Promise<PreflightResponse | null> {
  const path = bundleId
    ? `${SYSTEM_PREFLIGHT_PATH}?bundle_id=${encodeURIComponent(bundleId)}`
    : SYSTEM_PREFLIGHT_PATH;
  try {
    const raw = await requestServiceHubJson<PreflightResponse>(
      settings.baseUrl,
      path,
      settings.token,
      { timeoutMs: PREFLIGHT_TIMEOUT_MS, signal },
    );
    return raw && typeof raw === "object" ? raw : null;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    // 404 unknown_bundle / 423 recovery-in-progress (or any transport error) is fail-open: never block.
    if (!(err instanceof ServiceHubHttpError)) {
      // eslint-disable-next-line no-console
      console.warn("[capability-resolver] preflight fetch failed (fail-open)", err);
    }
    return null;
  }
}
