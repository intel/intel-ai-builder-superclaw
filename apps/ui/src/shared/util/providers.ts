import type { Provider as ConfigProvider, ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import MODEL_ROUTING from "@different-ai/openwork-contracts/data/model-routing.json";

type ProviderListItem = ProviderListResponse["all"][number];
type ProviderListModel = ProviderListItem["models"][string];

const PINNED_PROVIDER_ORDER = ["opencode", "openai", "anthropic"] as const;

/**
 * Provider/model classification tables come from the wire-schema spine
 * (Seam A): shared/contracts/src/model-routing.ts. SuperRouter is intentionally
 * not in local_provider_ids — it is checked per-model below, since it can proxy
 * to either local or cloud models. Used to determine whether PII detection is needed.
 */
const LOCAL_PROVIDER_IDS = new Set(MODEL_ROUTING.local_provider_ids);

/**
 * Returns true when the provider/model combination keeps data local (on-device
 * or on-premise).
 *
 * @param id       Provider ID (e.g. "superrouter", "ollama", "openai")
 * @param modelID  Optional model ID — required for accurate SuperRouter routing
 */
export const isLocalProvider = (id: string, modelID?: string): boolean => {
  const provider = id.trim().toLowerCase();
  const model = (modelID ?? "").trim().toLowerCase();

  if (LOCAL_PROVIDER_IDS.has(provider)) return true;

  if (provider === "superrouter") {
    // Cloud proxy check takes priority
    if (model && MODEL_ROUTING.cloud_model_prefixes.some((prefix) => model.startsWith(prefix))) {
      return false;
    }
    // Known local (Intel on-premise) model
    if (model && MODEL_ROUTING.superrouter_local_models.some((prefix) => model.includes(prefix))) {
      return true;
    }
    // Unknown SuperRouter model — default to local (Intel internal infra)
    return true;
  }

  return false;
};

const providerPriorityRank = (id: string) => {
  const normalized = id.trim().toLowerCase();
  const index = PINNED_PROVIDER_ORDER.indexOf(
    normalized as (typeof PINNED_PROVIDER_ORDER)[number],
  );
  return index === -1 ? PINNED_PROVIDER_ORDER.length : index;
};

export const compareProviders = (
  a: { id: string; name?: string },
  b: { id: string; name?: string },
) => {
  const rankDiff = providerPriorityRank(a.id) - providerPriorityRank(b.id);
  if (rankDiff !== 0) return rankDiff;

  const aName = (a.name ?? a.id).trim();
  const bName = (b.name ?? b.id).trim();
  return aName.localeCompare(bName);
};

// As of @opencode-ai/sdk 1.17.x the config-provider shape and the provider-list
// response shape were unified: `ProviderListResponse["all"]` is `Provider[]` and
// `Provider["models"][string]` is `Model` — the same `Model` the config exposes.
// So this mapping is now (almost) identity; we only apply defensive fallbacks for
// the required string fields in case the runtime payload is partial.
const mapModel = (model: ConfigProvider["models"][string]): ProviderListModel => ({
  ...model,
  name: model.name ?? model.id,
  release_date: model.release_date ?? "",
});

export const mapConfigProvidersToList = (providers: ConfigProvider[]): ProviderListResponse["all"] =>
  providers.map((provider) => ({
    ...provider,
    name: provider.name ?? provider.id,
    env: provider.env ?? [],
    models: Object.fromEntries(
      Object.entries(provider.models ?? {}).map(([key, model]) => [key, mapModel(model)]),
    ),
  }));