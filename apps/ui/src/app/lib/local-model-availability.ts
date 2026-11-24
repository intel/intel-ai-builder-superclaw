import type { ModelRef } from "../types";

/**
 * Local model health types and availability helpers.
 *
 * The shape matches the UI's local-slot availability snapshot.
 */

export interface LocalModelHealthInfo {
  status: "healthy" | "unhealthy" | "unset";
  model: string | null;
  provider?: string;
  latency_ms?: number;
  error?: string;
}

/**
 * Returns `true` when the local model slot (native GGUF or edge-override)
 * is both healthy and backed by a concrete model name.
 */
export function isLocalModelAvailable(
  local: LocalModelHealthInfo | null | undefined,
): boolean {
  return local?.status === "healthy" && Boolean(local.model?.trim());
}

/**
 * Returns `true` when a local model is configured: a concrete model name is
 * set AND the slot is not in the `unset` state. Health is not considered, so a
 * configured-but-`unhealthy` model still counts as "configured" (but not
 * "available"). A model name with `status: "unset"` is treated as unconfigured.
 */
export function isLocalModelConfigured(
  local: LocalModelHealthInfo | null | undefined,
): boolean {
  return local?.status !== "unset" && Boolean(local?.model?.trim());
}

export type ServingProviderStatus = "in_use" | "not_ready" | "unreachable" | "not_serving";

/**
 * Status of the committed local provider for the Settings badge, or `null`
 * when nothing local is committed. The committed binding outlives the server
 * behind it, so it is only `in_use` while LRM still serves it: an `unset`
 * health means LRM has no active local provider (e.g. the saved edge config
 * no longer matches the committed binding's fingerprint), and an `unhealthy`
 * edge failed its probe. Unknown health (`null`) does not demote it.
 */
export function servingProviderStatus(
  primary: { backend: string; state: string } | null | undefined,
  local: LocalModelHealthInfo | null | undefined,
): { provider: "edge" | "llama"; status: ServingProviderStatus } | null {
  if (primary?.backend !== "edge" && primary?.backend !== "llama") return null;
  const provider = primary.backend;
  if (primary.state !== "ready") return { provider, status: "not_ready" };
  if (local?.status === "unset") return { provider, status: "not_serving" };
  if (provider === "edge" && local?.status === "unhealthy") return { provider, status: "unreachable" };
  return { provider, status: "in_use" };
}

export function shouldFallbackFromLocalModelRef(
  model: ModelRef,
  local: LocalModelHealthInfo | null | undefined,
): boolean {
  if (isLocalModelAvailable(local)) return false;
  if (!local) return false;
  return model.providerID === "local-llm" || (model.providerID === "llmrouter" && model.modelID === "local-model");
}
