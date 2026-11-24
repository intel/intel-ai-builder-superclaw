/**
 * The LLMRouter session-model vocabulary: the three route aliases the picker
 * offers (Auto, Local model, Cloud model), their labels, and the footer line
 * that tells the user which concrete model an alias currently resolves to.
 *
 * Which aliases a Product Profile actually allows is decided by
 * `session-route-policy`, not here — this module only names them.
 */
import { currentLocale, t } from "../i18n";
import type { ModelRef } from "./types";

export const LLMROUTER_SESSION_MODELS = [
  { providerID: "llmrouter", modelID: "auto" },
  { providerID: "llmrouter", modelID: "local-model" },
  { providerID: "llmrouter", modelID: "cloud-model" },
] as const satisfies ModelRef[];

export const FALLBACK_MODEL: ModelRef = {
  providerID: "llmrouter",
  modelID: "auto",
};

export const LLMROUTER_ALIAS_LABELS: Record<string, string> = {
  auto: "Auto",
  "local-model": "Local model",
  "cloud-model": "Cloud model",
};

export const isLlmRouterSessionModel = (model: ModelRef) =>
  model.providerID === "llmrouter" &&
  LLMROUTER_SESSION_MODELS.some(
    (candidate) => candidate.modelID === model.modelID,
  );

/**
 * `resolvedModelName` reports the concrete model an alias points at right now,
 * or `null` when nothing is configured. Auto has no single answer, so it gets
 * no footer at all.
 */
export const formatLlmRouterModelFooter = (
  modelID: string,
  resolvedModelName: (modelID: string) => string | null,
) => {
  if (modelID !== "local-model" && modelID !== "cloud-model") return undefined;
  return (
    resolvedModelName(modelID) ?? t("model.not_configured", currentLocale())
  );
};
