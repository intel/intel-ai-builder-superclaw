import type {
  ModelRef,
  ProviderListItem,
} from "~/shared/types/models";

export function formatModelRef(model: ModelRef) {
  return `${model.providerID}/${model.modelID}`;
}

export function parseModelRef(raw: string | null): ModelRef | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [providerID, ...rest] = trimmed.split("/");
  if (!providerID || rest.length === 0) return null;
  return { providerID, modelID: rest.join("/") };
}

export function modelEquals(a: ModelRef, b: ModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

/**
 * Providers that route to the same local model infrastructure.
 * When grouping token usage by model, these should all be treated as
 * equivalent so that usage isn't split across multiple entries for the
 * same underlying model.
 */
export const LOCAL_PROVIDER_ALIASES = new Set(["llmrouter", "local-llm", "local"]);

export const INTERNAL_PROVIDER_PREFIXES = ["llmrouter", "superrouter", "local-llm"];

export type ModelRouteAlias = "auto" | "local-model" | "cloud-model";

export type ModelBadgeDescriptor =
  | { kind: "model"; value: string; source?: "local" | "cloud" }
  | { kind: "route"; alias: ModelRouteAlias }
  | { kind: "source"; source: "local" | "cloud" | "hybrid" };

const MODEL_ROUTE_LABELS: Record<ModelRouteAlias, string> = {
  auto: "Auto",
  "local-model": "Local",
  "cloud-model": "Cloud",
};

export function getModelRouteAlias(value: string): ModelRouteAlias | null {
  const normalized = value.trim().toLowerCase();
  const routeValue = normalized.split("/").at(-1)?.trim() ?? normalized;
  const withoutLegacyPrefix = routeValue.replace(/^llmrouter\s*·\s*/, "");

  if (withoutLegacyPrefix === "auto") return "auto";
  if (withoutLegacyPrefix === "local" || withoutLegacyPrefix === "local-model" || withoutLegacyPrefix === "local model") {
    return "local-model";
  }
  if (withoutLegacyPrefix === "cloud" || withoutLegacyPrefix === "cloud-model" || withoutLegacyPrefix === "cloud model") {
    return "cloud-model";
  }
  return null;
}

export function formatModelRouteLabel(value: string): string | null {
  const alias = getModelRouteAlias(value);
  return alias ? MODEL_ROUTE_LABELS[alias] : null;
}

export function isInternalProviderID(providerID: string): boolean {
  const normalized = providerID.trim().toLowerCase();
  return INTERNAL_PROVIDER_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`),
  );
}

export function formatInternalProviderModelLabel(
  providerID: string,
  modelID: string,
): string {
  const trimmedProvider = providerID.trim();
  const trimmedModel = modelID.trim();
  if (!trimmedModel) return trimmedProvider;

  const routeValue = trimmedModel.split("/").at(-1)?.trim() ?? trimmedModel;
  const routeLabel = formatModelRouteLabel(routeValue);
  if (routeLabel) return routeLabel;

  if (!isInternalProviderID(trimmedProvider)) return routeValue;

  const [modelNamespace, ...modelName] = trimmedModel.split("/");
  const hasInternalNamespace = INTERNAL_PROVIDER_PREFIXES.some(
    (prefix) => modelNamespace.trim().toLowerCase() === prefix,
  );
  return hasInternalNamespace && modelName.length > 0
    ? modelName.join("/").trim()
    : trimmedModel;
}

/**
 * Normalize provider+model into a canonical key for token usage grouping.
 * Multiple providers (llmrouter, local-llm) can route to the same physical
 * model — this returns a single canonical providerID so stats aren't split
 * across duplicate entries.
 */
export function normalizeModelKey(
  providerID: string,
  modelID: string,
): { providerID: string; modelID: string } {
  const pid = providerID.trim().toLowerCase();
  const mid = modelID.trim();
  if (LOCAL_PROVIDER_ALIASES.has(pid)) {
    const routedModel = parseModelRef(mid);
    if (routedModel) {
      return routedModel;
    }
    if (mid.toLowerCase() === "cloud-model") {
      return { providerID: "cloud", modelID: mid };
    }
    return { providerID: "local", modelID: mid };
  }
  return { providerID: pid, modelID: mid };
}

/** Model IDs that are generic placeholders, not real model names. */
const GENERIC_MODEL_IDS = new Set([
  "auto",
  "local-model",
  "cloud-model",
]);

/**
 * Filter out generic placeholder model IDs with zero usage.
 * Prevents transient auto-routing placeholders from appearing in the UI.
 *
 * @param entries - Array of model entries with token usage stats
 * @returns Filtered array (only entries with usage OR non-generic model IDs)
 */
export function filterZeroUsagePlaceholders<
  T extends { modelID: string } & (
    | { inputTokens: number; outputTokens: number; cost: number }
    | { input: number; output: number }
  ),
>(entries: T[]): T[] {
  return entries.filter((entry) => {
    const isGeneric = GENERIC_MODEL_IDS.has(entry.modelID.toLowerCase());
    // Handle both naming conventions: inputTokens/outputTokens (session.tsx) or input/output (token-usage.tsx)
    const hasUsage =
      ("inputTokens" in entry &&
        (entry.inputTokens > 0 || entry.outputTokens > 0 || entry.cost > 0)) ||
      ("input" in entry && (entry.input > 0 || entry.output > 0));
    return !isGeneric || hasUsage;
  });
}

/**
 * Merge local-provider entries that share a generic placeholder modelID
 * (e.g. "local-model", "auto") into an entry with a resolved real model name.
 *
 * Takes a Map keyed by `providerID|||modelID` (or `providerID/modelID`),
 * where values have at least `{ providerID, modelID }` plus numeric token fields.
 * Mutates the map in place.
 */
export function mergeGenericLocalEntries<
  T extends { providerID: string; modelID: string },
>(modelMap: Map<string, T>, mergeStats: (target: T, source: T) => void): void {
  // Find local entries
  const localEntries: Array<{ key: string; entry: T; isGeneric: boolean }> = [];
  for (const [key, entry] of modelMap) {
    if (entry.providerID === "local") {
      localEntries.push({
        key,
        entry,
        isGeneric: GENERIC_MODEL_IDS.has(entry.modelID.toLowerCase()),
      });
    }
  }
  if (localEntries.length < 2) return;

  const realEntries = localEntries.filter((e) => !e.isGeneric);
  const genericEntries = localEntries.filter((e) => e.isGeneric);
  if (realEntries.length === 0 || genericEntries.length === 0) return;

  // Merge all generic entries into the first real entry
  const target = realEntries[0];
  for (const generic of genericEntries) {
    mergeStats(target.entry, generic.entry);
    modelMap.delete(generic.key);
  }
}

/**
 * Strip a leading `[<model-id>] ` prefix from responses recorded while
 * legacy prefix injection was enabled. Preserves common bracket prose
 * (`[Note] …`, `[1] …`) via the shape check.
 */
export function stripModelPrefix(text: string): string {
  return text.replace(/^\s*\[([^\]\s\n]{2,80})\]\s/, (match, token) => {
    const hasLetter = /[a-zA-Z]/.test(token);
    const hasDistinctive = /[-_.:\/0-9]/.test(token);
    return hasLetter && hasDistinctive ? "" : match;
  });
}

// litellm inserts this when an assistant turn has no text, which can happen
// during tool-only calls. If the next real answer reuses that text part, this
// placeholder appears at the start of the user-visible message.
export const LITELLM_EMPTY_CONTENT_PLACEHOLDER =
  "[System: Empty message content sanitised to satisfy protocol]";

/**
 * Remove litellm's leading empty-content placeholder from display text.
 * Call after `stripModelPrefix` so `[model] [placeholder] answer` becomes
 * `[placeholder] answer` first, then just `answer`.
 */
export function stripEmptyContentPlaceholder(text: string): string {
  if (!text.startsWith(LITELLM_EMPTY_CONTENT_PLACEHOLDER)) return text;
  return text.slice(LITELLM_EMPTY_CONTENT_PLACEHOLDER.length).replace(/^\s+/, "");
}

const FRIENDLY_PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
};

const humanizeModelLabel = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (normalized && FRIENDLY_PROVIDER_LABELS[normalized]) {
    return FRIENDLY_PROVIDER_LABELS[normalized];
  }

  const cleaned = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return value;

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (/\d/.test(word) || word.length <= 3) {
        return word.toUpperCase();
      }
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
};

export function formatModelLabel(
  model: ModelRef,
  providers: ProviderListItem[] = [],
) {
  const provider = providers.find((p) => p.id === model.providerID);
  const modelInfo = provider?.models?.[model.modelID];

  if (isInternalProviderID(model.providerID)) {
    const routeLabel = formatInternalProviderModelLabel(model.providerID, model.modelID);
    if (routeLabel === model.modelID) {
      return modelInfo?.name ?? model.modelID;
    }
    return routeLabel;
  }

  const providerLabel = provider?.name ?? humanizeModelLabel(model.providerID);
  const modelLabel = modelInfo?.name ?? humanizeModelLabel(model.modelID);

  return `${providerLabel} · ${modelLabel}`;
}
