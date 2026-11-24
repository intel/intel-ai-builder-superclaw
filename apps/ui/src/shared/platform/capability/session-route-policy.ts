/**
 * Pure policy for the Session model picker route aliases (`llmrouter/auto`,
 * `llmrouter/local-model`, `llmrouter/cloud-model`) under capability gating.
 *
 * WHY a pure helper (not `<Show>` inside the modal): the same product rule must
 * be enforced at several places — the picker option list, the picker's current
 * selection, and the effective send model — otherwise a persisted `auto` /
 * `local-model` (localStorage session override or config default) would sail
 * past a display-only filter and still be sent as the request model. The modal
 * only renders props; it does not own this policy.
 *
 * Product rule (confirmed 2026-07-21):
 *  - active Lite Product Profile → ONLY `cloud-model`
 *    (Lite has no local chat model; Auto/Local hidden and any residual
 *    Auto/Local is normalized to Cloud).
 *  - every other active profile (incl. Standard 4B) → all three aliases, unchanged.
 *  - no active profile (gating off / loading / recovery) → passthrough: all
 *    three aliases, no normalization. Gating is product behavior, not security.
 *
 * The Product Profile is the entitlement source, independent of hardware/model
 * IDs and whether a primary bundle is present.
 */
import type { ActiveAppCapabilityProfile } from "@different-ai/openwork-contracts/capability";
import type { ModelRef } from "~/shared/types/models";

/** LLMRouter route-mode aliases, in the picker's canonical display order. */
export const LLMROUTER_ROUTE_ALIASES = {
  auto: { providerID: "llmrouter", modelID: "auto" },
  localModel: { providerID: "llmrouter", modelID: "local-model" },
  cloudModel: { providerID: "llmrouter", modelID: "cloud-model" },
} as const satisfies Record<string, ModelRef>;

const ALL_ROUTE_ALIASES: readonly ModelRef[] = [
  LLMROUTER_ROUTE_ALIASES.auto,
  LLMROUTER_ROUTE_ALIASES.localModel,
  LLMROUTER_ROUTE_ALIASES.cloudModel,
];

const CLOUD_ONLY_ROUTE_ALIASES: readonly ModelRef[] = [LLMROUTER_ROUTE_ALIASES.cloudModel];

/**
 * True for the Lite Profile, including a fresh install with no primary bundle.
 */
export function isCloudOnlySessionProfile(
  profile: ActiveAppCapabilityProfile | null | undefined,
): boolean {
  if (!profile) return false;
  return profile.product_profile_id === "lite";
}

/**
 * The LLMRouter route aliases the session picker may show for a profile.
 *  - cloud-only profile → `[cloud-model]`
 *  - anything else (incl. no active profile) → all three aliases.
 */
export function allowedSessionRouteAliases(
  profile: ActiveAppCapabilityProfile | null | undefined,
): readonly ModelRef[] {
  return isCloudOnlySessionProfile(profile) ? CLOUD_ONLY_ROUTE_ALIASES : ALL_ROUTE_ALIASES;
}

/**
 * Fail-safe normalization for the EFFECTIVE send model. Under the cloud-only
 * profile, any LLMRouter `auto` / `local-model` (from a persisted override,
 * config default, or an external `setSessionModel`) is rewritten to
 * `cloud-model`. Non-llmrouter models and every non-restricted profile pass
 * through unchanged — this must never rewrite a real provider/model the user
 * legitimately picked.
 */
export function normalizeSessionRouteForProfile(
  model: ModelRef,
  profile: ActiveAppCapabilityProfile | null | undefined,
): ModelRef {
  if (!isCloudOnlySessionProfile(profile)) return model;
  if (model.providerID !== "llmrouter") return model;
  if (model.modelID === "cloud-model") return model;
  // auto / local-model (or any other llmrouter alias) → Cloud under Lite.
  return LLMROUTER_ROUTE_ALIASES.cloudModel;
}
