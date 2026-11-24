/**
 * Pure policy for the AUTO-routing balance (`perf_weight`) default that should
 * be applied when the active primary bundle changes.
 *
 * The 4B bundle leans further toward Cloud than the capable local tiers.
 *
 * The default is graded by how much the local model can actually carry, since
 * `perf_weight` is "how far toward cloud" (higher = more cloud routing):
 *
 *   local-4b   → { perfWeight: 0.85, hideBalance: false }  // weak local: lean on cloud
 *   local-gemma-4e4b → same as local-4b                     // 4B-class, same hardware gate
 *   any other  → { perfWeight: 0.7,  hideBalance: false }  // 35B / edge-80B carry more locally
 *
 * `local-4b` sits at 0.85 rather than 0.7 because a 4B is materially weaker than
 * the 35B/edge tiers the 0.7 default was tuned for — at 0.7 too much work stays
 * on a model that cannot carry it. The capable tiers keep 0.7 so they stay
 * local-leaning (cost + privacy), which is the whole point of running them.
 *
 * This is intentionally keyed on the target BUNDLE, applied ONLY at a bundle
 * migration boundary (a successful switch), never on every mount/restart — so
 * a user's hand-picked non-default value on a normal grade is preserved across
 * ordinary relaunches.
 *
 * Backend fallback remains 0.7 (LatencyRouterAdapter._DEFAULT_PERF_WEIGHT) — it
 * has no bundle awareness and only applies before the UI persists a value at the
 * switch boundary. The 0.7 rule still covers a future 9B re-entering the registry
 * without a special branch (the handoff's recommended strategy).
 */

/** The 4B local bundle. */
export const MINIMAL_4B_BUNDLE_ID = "local-4b";

/** The optional Gemma 4 E4B local bundle — 4B-class, so it shares the 4B weight. */
export const GEMMA_E4B_BUNDLE_ID = "local-gemma-4e4b";

/** Backend/router default perf_weight for any router-eligible bundle. */
export const DEFAULT_PERF_WEIGHT = 0.7;

/**
 * perf_weight for the 4B local bundle — higher (more cloud) than the 0.7 the
 * capable 35B/edge tiers use, because a 4B cannot carry as much of the work.
 */
export const LOCAL_4B_PERF_WEIGHT = 0.85;

export type RoutingDefaults = {
  /** perf_weight to persist for the target bundle. */
  perfWeight: number;
  /** Whether the Routing Balance control should be hidden for this bundle. */
  hideBalance: boolean;
};

/**
 * The Routing Balance defaults for the bundle that just became primary.
 * `null` when there is no target bundle (nothing to reset — leave the current
 * persisted value untouched).
 */
export function routingDefaultsForBundle(
  bundleId: string | null | undefined,
): RoutingDefaults | null {
  if (!bundleId) return null;
  if (bundleId === MINIMAL_4B_BUNDLE_ID || bundleId === GEMMA_E4B_BUNDLE_ID) {
    return { perfWeight: LOCAL_4B_PERF_WEIGHT, hideBalance: false };
  }
  return { perfWeight: DEFAULT_PERF_WEIGHT, hideBalance: false };
}
