import { createEffect, createMemo, createSignal, on, Show, untrack } from "solid-js";
import { AlertTriangle, Loader2, Trash2 } from "lucide-solid";

import type { ProviderListItem } from "../types";
import { checkAutoRouterModelsReady, getLastAutoRouterDiagnostics } from "../lib/auto-router-health";
import type { LlmRouterCloudModel, LlmRouterProviderModel } from "../lib/llmrouter-client";
import type { LocalModelHealthInfo } from "../lib/local-model-availability";
import BusyButton from "./busy-button";
import Button from "./button";
import ConfirmModal from "./confirm-modal";
import Dropdown from "~/shared/ui/dropdown";
import ModelCombobox from "./model-combobox";
import RemoveProviderDialog from "./remove-provider-dialog";
import { FIELD_LABEL_CLASS } from "./provider-connection-card";
import { t } from "../../i18n";

export { checkAutoRouterModelsReady, getLastAutoRouterDiagnostics };

export type CloudModelSettingsProps = {
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  cloudModel: LlmRouterCloudModel | null;
  cloudModelHealthError?: string | null;
  loading?: boolean;
  deleting?: boolean;
  testing?: boolean;
  localModelHealth?: LocalModelHealthInfo | null;
  edgeConfigured?: boolean;
  edgeModelName?: string;
  onOpenProviderAuth?: () => void;
  onLoadModels?: (provider: string) => Promise<LlmRouterProviderModel[]>;
  onSave: (input: { provider: string; model: string; max_tokens?: number; context_limit?: number }) => Promise<void>;
  onDelete: () => Promise<void>;
  onTest?: (input: { provider: string; model?: string }) => Promise<void>;
  /** Test the provider with this model and reject if it cannot be reached. Connect
   *  calls it before saving, so it must not show the Test Connection banner. */
  onCheckModel?: (input: { provider: string; model: string }) => Promise<void>;
  onDisconnectProvider?: (providerId: string) => Promise<string | void>;
  onTestSuccessMessage?: string | null;
  onConfigureEdgeServer?: () => void;
  /** Retained for compatibility; the Local status is now owned by a dedicated panel. */
  hideLocalRow?: boolean;
};

const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_CONTEXT_LIMIT = 196608;
const ADD_PROVIDER_VALUE = "__add_provider__";

// Each provider's last loaded model list. It lives outside the card because
// the card unmounts when the user switches tabs, so coming back can show the
// list at once instead of "Loading models".
const modelListCache = new Map<string, LlmRouterProviderModel[]>();

/** Forget every cached model list. Tests use it to start clean. */
export function clearCloudModelListCache(): void {
  modelListCache.clear();
}

// The last model connected on each provider, so picking a provider again
// fills its model back in. Only ids are kept, no keys.
const REMEMBERED_MODELS_KEY = "openwork.cloud-model-by-provider.v1";

function readRememberedModels(): Record<string, string> {
  try {
    const raw = localStorage.getItem(REMEMBERED_MODELS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writeRememberedModel(providerId: string, model: string | null): void {
  try {
    const models = readRememberedModels();
    if (model) models[providerId] = model;
    else delete models[providerId];
    localStorage.setItem(REMEMBERED_MODELS_KEY, JSON.stringify(models));
  } catch {
    // Storage unavailable: the provider just comes back with no model.
  }
}

// Saves and deletes run one after another, so a delete started by a provider
// removal never lands after a later Connect. The queue lives outside the card
// because the card unmounts on a tab switch or a trip to chat while a write can
// still be running, and the card that mounts next must queue behind it.
let cloudModelWrite: Promise<void> = Promise.resolve();
function queueCloudModelWrite(write: () => Promise<void>): Promise<void> {
  const next = cloudModelWrite.then(write);
  cloudModelWrite = next.catch(() => undefined);
  return next;
}

/** Drop the write queue. Tests use it, so a write one test leaves hanging does not block the next. */
export function resetCloudModelWriteQueue(): void {
  cloudModelWrite = Promise.resolve();
}

// The provider mid-removal (clear-then-disconnect), from outside the card for the
// same reason as the write queue above: the card unmounts on a tab switch or a
// trip to chat while a removal is still running, and the card that mounts next
// must still see it as busy, not start a Connect that could save a model on the
// provider being signed out.
const [removingProviderId, setRemovingProviderId] = createSignal<string | null>(null);

// A Connect in flight (test, then save), outside the card for the same reason:
// a Connect started on a card that then unmounts still saves when its test
// passes, so the card that mounts next must stay locked, or it could remove
// that provider and the old Connect's save would land after the removal's delete.
const [connecting, setConnecting] = createSignal(false);

/** Forget an in-flight removal or Connect. Tests use it, so one test's unresolved write does not block the next. */
export function resetCloudModelRemoval(): void {
  setRemovingProviderId(null);
  setConnecting(false);
}

export default function CloudModelSettings(props: CloudModelSettingsProps) {
  const [selectedProvider, setSelectedProvider] = createSignal("");
  const [selectedModel, setSelectedModel] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);
  const [cloudTestResult, setCloudTestResult] = createSignal<{
    state: "testing" | "healthy" | "unhealthy";
    provider: string;
    model: string;
  } | null>(null);
  const [models, setModels] = createSignal<LlmRouterProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = createSignal(false);
  const [modelsError, setModelsError] = createSignal<string | null>(null);
  const [disconnectingId, setDisconnectingId] = createSignal<string | null>(null);
  const [disconnectError, setDisconnectError] = createSignal<{ message: string; showClearHint: boolean } | null>(null);
  // The provider whose dustbin was clicked, waiting on the confirm dialog.
  const [removeCandidate, setRemoveCandidate] = createSignal<ProviderListItem | null>(null);
  // Holds the provider dropdown, where focus returns when the confirm closes.
  let providerSectionRef: HTMLDivElement | undefined;

  const connectedProviders = createMemo(() => {
    const ids = new Set(props.providerConnectedIds);
    return props.providers.filter((provider) => ids.has(provider.id));
  });

  const hasConnectedProviders = createMemo(() => connectedProviders().length > 0);

  // The connected provider of the saved cloud model: the one chat uses. A saved
  // model on a provider that is no longer connected is not in use, so no tag.
  const inUseProvider = createMemo(() => {
    const savedId = props.cloudModel?.provider;
    return savedId ? connectedProviders().find((provider) => provider.id === savedId) : undefined;
  });

  // The provider of the saved cloud model goes first in the menu, so the one in use is easy to find.
  const providerMenuOrder = createMemo(() => {
    const inUseId = props.cloudModel?.provider;
    const providers = connectedProviders();
    const inUse = providers.filter((provider) => provider.id === inUseId);
    return [...inUse, ...providers.filter((provider) => provider.id !== inUseId)];
  });

  createEffect(() => {
    const saved = props.cloudModel;
    if (saved?.provider && saved.model) writeRememberedModel(saved.provider, saved.model);
  });

  createEffect(() => {
    const message = props.onTestSuccessMessage;
    if (message) {
      setSuccess(message);
      setError(null);
    }
  });

  // Seed the selection from the saved cloud model or the first connected
  // provider, once providers are known.
  let initialized = false;
  createEffect(() => {
    const connected = connectedProviders();
    if (initialized) return;
    if (props.cloudModel?.provider) {
      setSelectedProvider(props.cloudModel.provider);
      setSelectedModel(props.cloudModel.model ?? "");
      initialized = true;
    } else if (connected.length > 0) {
      setSelectedProvider(connected[0].id);
      initialized = true;
    }
  });

  let knownProviderIds: string[] = [];
  createEffect(() => {
    const ids = connectedProviders().map((provider) => provider.id);
    const added = ids.find((id) => !knownProviderIds.includes(id));
    const hadProviders = knownProviderIds.length > 0;
    const currentSelection = untrack(selectedProvider);
    knownProviderIds = ids;
    if (!added) return;
    // A saved cloud model can point at a provider that is no longer connected
    // (removed, or its sign-in ended). Then the card has nothing to show, so
    // move to the newly connected provider. `ids` holds only connected
    // providers, so an empty selection also counts as not connected.
    if (hadProviders || !ids.includes(currentSelection)) {
      untrack(() => showProvider(added));
    }
  });

  const selectedProviderConnected = createMemo(() => {
    const provider = selectedProvider();
    if (!provider || provider === ADD_PROVIDER_VALUE) return false;
    return props.providerConnectedIds.includes(provider);
  });

  createEffect(
    on([selectedProvider, selectedProviderConnected] as const, ([provider, connected]) => {
      const loadModels = props.onLoadModels;
      if (!provider || provider === ADD_PROVIDER_VALUE || !connected || !loadModels) {
        setModels([]);
        setModelsError(null);
        setModelsLoading(false);
        return;
      }
      // Show a cached list at once and refresh it quietly. Only a provider
      // with no cached list shows "Loading models".
      const cached = modelListCache.get(provider);
      setModelsLoading(!cached);
      setModelsError(null);
      setModels(cached ?? []);
      loadModels(provider)
        .then((items) => {
          modelListCache.set(provider, items);
          if (selectedProvider() !== provider || !selectedProviderConnected()) return;
          setModels(items);
        })
        .catch((nextError) => {
          if (selectedProvider() !== provider || !selectedProviderConnected()) return;
          // A failed quiet refresh keeps the cached list.
          if (cached) return;
          setModels([]);
          setModelsError(nextError instanceof Error ? nextError.message : String(nextError));
        })
        .finally(() => {
          if (selectedProvider() !== provider || !selectedProviderConnected()) return;
          setModelsLoading(false);
        });
    }),
  );

  // Ensure the currently-saved model stays selectable even if the provider's
  // endpoint didn't return it in the list — but only for the provider that
  // model actually belongs to, so a model saved on another provider never
  // leaks into this provider's list.
  const modelOptions = createMemo(() => {
    const list = models();
    const saved = props.cloudModel;
    const current = saved?.model?.trim();
    if (current && saved?.provider === selectedProvider() && !list.some((model) => model.id === current)) {
      const savedModel: LlmRouterProviderModel = {
        id: current,
        name: current,
        release_date: "",
      };
      return [savedModel, ...list];
    }
    return list;
  });

  // Picking a model only selects it. Connect tests it, then saves it.
  const commitModel = (model: string) => {
    setSelectedModel(model);
    setError(null);
    setSuccess(null);
  };

  // True when a model is picked that is not the saved one yet, so Connect has work to do.
  const hasUnsavedSelection = createMemo(() => {
    const model = selectedModel();
    if (!model) return false;
    const saved = props.cloudModel;
    return saved?.provider !== selectedProvider() || saved?.model !== model;
  });

  // Test the picked model first, so a model that cannot be reached is never saved.
  // The message box is left untouched while this runs: whatever it showed before
  // Connect (the "click Connect" hint, or an earlier Test Connection success)
  // stays up with no blank gap, then the outcome below replaces it. The save goes
  // through the write queue, so a delete from a provider removal that is still
  // running cannot land after it and clear the model just connected.
  const handleConnect = async () => {
    const provider = selectedProvider();
    const model = selectedModel();
    if (!provider || provider === ADD_PROVIDER_VALUE || !model) return;
    setConnecting(true);
    try {
      await props.onCheckModel?.({ provider, model });
      await queueCloudModelWrite(() =>
        props.onSave({
          provider,
          model,
          max_tokens: DEFAULT_MAX_TOKENS,
          context_limit: DEFAULT_CONTEXT_LIMIT,
        }),
      );
      setError(null);
      setSuccess(t("model.cloud_saved"));
    } catch (nextError) {
      setSuccess(null);
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const disconnect = props.onDisconnectProvider;
    if (!disconnect || disconnectingId()) return;
    setDisconnectingId(providerId);
    try {
      await disconnect(providerId);
      // A provider that is added again may list other models.
      modelListCache.delete(providerId);
      writeRememberedModel(providerId, null);
      if (selectedProvider() === providerId) {
        // One provider left: select it. Several left: back to the placeholder so the user picks.
        const remaining = providerMenuOrder().filter((provider) => provider.id !== providerId);
        if (remaining.length === 1) {
          showProvider(remaining[0].id);
        } else {
          setSelectedProvider("");
          setSelectedModel("");
        }
      }
      // No message on success: the provider leaving the menu shows it was removed.
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      // Only the LRM "in_use" guard (409, DELETE blocked because the cloud
      // model still references this provider) is fixable by clearing the
      // model. Other failures (network, ServiceHub down, invalid id) get the
      // raw message without the potentially-misleading clear-model hint.
      const code = (nextError as { code?: string }).code;
      const status = (nextError as { status?: number }).status;
      const showClearHint = code === "in_use" || status === 409;
      setDisconnectError({ message, showClearHint });
    } finally {
      setDisconnectingId(null);
    }
  };

  const handleProviderSelect = (value: string) => {
    // A menu opened before Connect or a removal started stays open; a pick
    // from it must not change the provider while that runs.
    if (isBusy()) return;
    if (value === ADD_PROVIDER_VALUE) {
      // "Add provider" is only an entry point — never a selectable value. Open
      // the shared connect modal; the auto-select effect switches to the new
      // provider if one is actually added. The dropdown keeps showing the
      // current selection because it is fully controlled by selectedProvider().
      props.onOpenProviderAuth?.();
      return;
    }
    if (value === selectedProvider()) return;
    showProvider(value);
  };

  // Picking a provider only changes the card: it fills in the model last
  // connected on it, if any. The saved cloud model, and so every chat on Cloud,
  // stays as it is until Connect tests and saves the new pick.
  function showProvider(providerId: string) {
    setSelectedProvider(providerId);
    // Setting the selection is enough to set the text in the box: the
    // combobox mirrors `value` whenever the user is not mid-type.
    setSelectedModel(readRememberedModels()[providerId] ?? "");
    setSuccess(null);
    setError(null);
  }

  // The dustbin on a provider row. The backend refuses to remove a provider
  // that the saved cloud model still uses, so that model is cleared first.
  // Only that provider's model is cleared: the card can show a provider that
  // was picked but never connected, while chat uses another one.
  // `removingProviderId` holds for the whole clear-then-disconnect, outside the
  // card so the lock survives a remount: Connect and the pickers
  // stay locked until both are done, or a Connect started on the new instance
  // could save a model on the provider still being signed out.
  const handleRemoveProvider = async (providerId: string) => {
    // A confirm dialog opened before a Connect started stays open; its
    // confirm must not start a removal while that Connect can still save.
    if (removingProviderId() || connecting()) return;
    setRemovingProviderId(providerId);
    setError(null);
    setSuccess(null);
    try {
      if (props.cloudModel?.provider === providerId) {
        try {
          await queueCloudModelWrite(() => props.onDelete());
        } catch (nextError) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
          return;
        }
      }
      await handleDisconnectProvider(providerId);
    } finally {
      setRemovingProviderId(null);
    }
  };

  // The model the confirm dialog names: the saved one if it is on this
  // provider, else the one remembered for it. Removing forgets both.
  const modelRemovedWith = (providerId: string | undefined): string | null => {
    if (!providerId) return null;
    const saved = props.cloudModel;
    if (saved?.provider === providerId && saved.model) return saved.model;
    return readRememberedModels()[providerId] || null;
  };

  // The old message stays up while the test runs. A success arrives through
  // `onTestSuccessMessage`, which the effect above shows.
  const handleTest = async () => {
    if (!props.onTest) return;
    const provider = selectedProvider();
    const model = selectedModel().trim();
    setCloudTestResult({ state: "testing", provider, model });
    try {
      await props.onTest({
        provider,
        model: model || undefined,
      });
      setCloudTestResult({ state: "healthy", provider, model });
    } catch (nextError) {
      setCloudTestResult({ state: "unhealthy", provider, model });
      setSuccess(null);
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  // While Test Connection or Connect runs, one spinner takes the place of both
  // buttons, and the provider and model pickers are locked. Connect saves the
  // values it read when clicked, so a change made while it runs would show a
  // selection that was never saved. Removing a provider locks the same way, so
  // no Connect starts while a provider is being signed out. `removingProviderId`
  // and `connecting` are module-level, so this stays locked even across a
  // remount mid-removal or mid-Connect.
  const isBusy = () => Boolean(props.testing || connecting() || removingProviderId());

  const hasRealProvider = createMemo(() => {
    const provider = selectedProvider();
    return Boolean(provider) && provider !== ADD_PROVIDER_VALUE && selectedProviderConnected();
  });

  // One message box at a time. An error comes first, then the health warning,
  // then a success, then the "click Connect" hint. Nothing here is cleared when
  // Connect starts, so whatever showed before (the hint, or an earlier Test
  // Connection success) stays up with no gap until the Connect outcome replaces it.
  type CardMessage = { tone: "error" | "health" | "success" | "hint"; text: string };
  const cardMessage = createMemo<CardMessage | null>(() => {
    const currentError = error();
    if (currentError) return { tone: "error", text: currentError };
    if (props.cloudModelHealthError) return { tone: "health", text: props.cloudModelHealthError };
    const currentSuccess = success();
    if (currentSuccess) return { tone: "success", text: currentSuccess };
    if (hasRealProvider() && hasUnsavedSelection()) {
      return { tone: "hint", text: t("model.cloud_selected_click_connect") };
    }
    return null;
  });

  return (
    // Mirror the server-confirmed selection (props.cloudModel is fed by the
    // GET that follows the PUT) onto the root node so e2e can wait for what was
    // actually persisted after Connect instead of scraping a localized banner.
    <div
      class="space-y-4"
      data-testid="cloud-model-settings"
      data-cloud-provider={props.cloudModel?.provider ?? ""}
      data-cloud-model={props.cloudModel?.model ?? ""}
      data-cloud-test-state={cloudTestResult()?.state ?? "idle"}
      data-cloud-test-provider={cloudTestResult()?.provider ?? ""}
      data-cloud-test-model={cloudTestResult()?.model ?? ""}
    >
      {/* Provider selector: connected providers + "Add provider". */}
      <div class="space-y-2.5" ref={providerSectionRef}>
        {/* Same tag as the Local card. It shows what chat uses, so it moves only
            when Connect saves, not when a provider is picked. */}
        <div class="flex items-center gap-2">
          <label class={FIELD_LABEL_CLASS}>{t("model.cloud_provider")}</label>
          <Show when={inUseProvider()}>
            {(provider) => (
              <span
                class="inline-flex items-center gap-1.5 rounded-pill border border-dls-success-border bg-dls-success-bg px-2 py-0.5 text-tiny font-semibold text-dls-success-text"
                data-testid="cloud-provider-in-use"
              >
                <span class="h-1.5 w-1.5 rounded-pill bg-dls-success-dot" aria-hidden="true" />
                {t("model.provider_in_use")} {provider().name ?? provider().id}
              </span>
            )}
          </Show>
        </div>
        {/* Keyed on whether any provider is connected. When the last one is
            removed, the dropdown remounts, so its menu closes and the card looks
            as it did before any provider was added. */}
        <Show when={{ hasProviders: hasConnectedProviders() }} keyed>
          {(_providerPresence) => (
            <Dropdown
              class="max-w-md"
              data-testid="cloud-provider-dropdown-trigger"
              value={selectedProvider()}
              placeholder={t("model.select_provider")}
              // The trigger shows the picked provider, so its row needs no check mark.
              hideSelectedCheck
              disabled={isBusy()}
              options={[
                ...providerMenuOrder().map((provider) => ({
                  value: provider.id,
                  label: provider.name ?? provider.id,
                  // A green dot marks the provider chat uses: the one of the saved model.
                  // Picking a provider does not move it. Only a Connect that saves does.
                  marker:
                    provider.id === inUseProvider()?.id ? (
                      <span
                        class="h-2 w-2 shrink-0 rounded-pill bg-dls-success-dot"
                        data-testid="cloud-provider-selected"
                        aria-label={t("model.provider_in_use")}
                      />
                    ) : undefined,
                  // Every row has the dustbin. On the green-dot row it takes the dot's place on hover.
                  // It only asks first: removing signs the provider out, and getting it back means
                  // going through sign-in again.
                  action:
                    props.onDisconnectProvider
                      ? {
                          // Each row removes a different account, so the name says which.
                          label: t("model.remove_provider_named").replace("{provider}", provider.name ?? provider.id),
                          icon: <Trash2 size={13} />,
                          onAction: () => setRemoveCandidate(provider),
                          busy: removingProviderId() === provider.id || disconnectingId() === provider.id,
                          disabled: removingProviderId() !== null || disconnectingId() !== null || connecting() || props.deleting,
                        }
                      : undefined,
                })),
                { value: ADD_PROVIDER_VALUE, label: t("model.add_provider"), testId: "add-provider-option" },
              ]}
              onChange={(value) => handleProviderSelect(value)}
            />
          )}
        </Show>
      </div>

      <Show
        when={hasRealProvider()}
        fallback={
          <Show when={!hasConnectedProviders()}>
            <div class="text-caption text-dls-secondary">{t("model.connect_provider_start")}</div>
          </Show>
        }
      >
        {/* Cloud model selection */}
        <div class="space-y-2.5">
          <label class={FIELD_LABEL_CLASS}>{t("settings.session_model")}</label>
          {/* One status message (below the label, above the dropdown; matches dropdown width) */}
          <Show when={cardMessage()}>
            {(message) => (
              <div
                class="max-w-md rounded-inset border p-3 text-body-lg transition-colors duration-300"
                data-testid="cloud-model-message"
                role={message().tone === "error" ? "alert" : undefined}
                classList={{
                  "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text": message().tone === "error" || message().tone === "health",
                  "border-dls-success-border bg-dls-success-bg text-dls-success-text": message().tone === "success",
                  "border-dls-warning-border bg-dls-warning-bg text-dls-warning-text": message().tone === "hint",
                }}
              >
                <Show when={message().tone === "health"} fallback={message().text}>
                  <div class="flex items-start gap-2">
                    <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                    <div>
                      <span class="font-medium">{t("model.cloud_unavailable")}</span> {message().text}
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </Show>
          {/* The combobox itself lives in `model-combobox.tsx`, shared with the
              dictation clean-up card. What stays here is what this card owns:
              which model is selected, that picking only selects it (Connect
              saves it), and the three fetch-state lines below. The control
              cannot know any of these. */}
          <ModelCombobox
            class="max-w-md"
            testIdPrefix="cloud-model"
            options={modelOptions()}
            value={selectedModel()}
            placeholder={t("model.select_model")}
            disabled={!selectedProvider() || isBusy()}
            onChange={(model) => commitModel(model)}
            status={
              <>
                <Show when={modelsLoading()}>
                  <div class="mt-1 flex items-center gap-1.5 text-label text-dls-secondary">
                    <Loader2 size={11} class="animate-spin" />
                    {t("model.loading_models")}
                  </div>
                </Show>
                <Show when={!modelsLoading() && modelsError()}>
                  <div class="mt-1 text-label text-dls-warning-text">{t("model.load_models_failed")}</div>
                </Show>
                <Show when={!modelsLoading() && !modelsError() && modelOptions().length === 0}>
                  <div class="mt-1 text-label text-dls-secondary">{t("model.no_models")}</div>
                </Show>
              </>
            }
          />
        </div>

        <div class="flex h-8 items-center justify-end gap-2 pt-1">
          <Show
            when={!isBusy()}
            fallback={<BusyButton data-testid="cloud-model-busy" />}
          >
            <Show when={props.onTest}>
              <Button
                type="button"
                variant="outline"
                class="text-caption h-8 py-0 px-4"
                data-testid="cloud-model-test-button"
                onClick={() => void handleTest()}
                disabled={!selectedProvider()}
              >
                {t("settings.test_connection")}
              </Button>
            </Show>
            <Button
              type="button"
              variant="outline"
              class="text-caption h-8 py-0 px-4"
              data-testid="cloud-model-connect-button"
              onClick={() => void handleConnect()}
              disabled={!hasUnsavedSelection()}
            >
              {t("common.connect")}
            </Button>
          </Show>
        </div>
      </Show>

      {/* With no provider shown, the health warning has no message box above, so it shows here. */}
      <Show when={!hasRealProvider() && props.cloudModelHealthError}>
        <div class="flex items-start gap-2.5 px-3 py-2.5 rounded-inset border border-dls-danger-border bg-dls-danger-bg text-caption text-dls-danger-text">
          <AlertTriangle size={14} class="mt-0.5 shrink-0" />
          <div>
            <span class="font-medium">{t("model.cloud_unavailable")}</span> {props.cloudModelHealthError}
          </div>
        </div>
      </Show>

      <RemoveProviderDialog
        providerName={removeCandidate() ? (removeCandidate()?.name ?? removeCandidate()?.id ?? "") : null}
        modelName={modelRemovedWith(removeCandidate()?.id)}
        onConfirm={() => {
          const provider = removeCandidate();
          setRemoveCandidate(null);
          if (provider) void handleRemoveProvider(provider.id);
        }}
        onCancel={() => setRemoveCandidate(null)}
        returnFocusTo={() => providerSectionRef?.querySelector<HTMLElement>("[aria-haspopup='listbox']") ?? undefined}
      />

      <ConfirmModal
        open={disconnectError() !== null}
        variant="warning"
        title={t("model.disconnect_failed_title")}
        message={
          <div class="space-y-2">
            <p>{disconnectError()?.message}</p>
            <Show when={disconnectError()?.showClearHint}>
              <p>{t("model.disconnect_clear_model_hint")}</p>
            </Show>
          </div>
        }
        confirmLabel={t("common.close")}
        onConfirm={() => setDisconnectError(null)}
      />
    </div>
  );
}
