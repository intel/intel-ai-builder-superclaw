import { createEffect, createMemo, createSignal, Show, untrack } from "solid-js";
import { Eye, EyeOff, AlertTriangle, Server } from "lucide-solid";

import { t } from "../../i18n";
import BusyButton from "./busy-button";
import Button from "./button";
import ModelCombobox from "./model-combobox";
import { FIELD_LABEL_CLASS } from "./provider-connection-card";
import RestartRequiredDialog, { type BundleSwitchStep } from "~/shared/ui/restart-required-dialog";
import ConfirmModal from "~/shared/ui/confirm-modal";
import { isSameOrigin, stripVersionSegment } from "./edge-server-card-url";

export interface EdgeServerCardProps {
  edgeConfigured: boolean;
  /** True iff the committed primary bundle's backend is "edge" — the single
   *  connected-truth, mutually exclusive with the local (llama) panel. */
  edgeConnected?: boolean;
  edgeBaseUrl: string;
  edgeModelName: string;
  /** Persisted proxy-bypass choice from the backend (default true when absent). */
  edgeBypassProxy?: boolean;
  testing?: boolean;
  error?: string | null;
  testSuccessMessage?: string | null;
  /** Resolves to the trusted Edge chat models the server serves. */
  onTest?: (input: { base_url: string; api_key: string; model_name: string; bypass_proxy: boolean }) => Promise<string[] | void>;
  onConnect: (input: { base_url: string; api_key: string; model_name: string; bypass_proxy: boolean }) => Promise<void>;
  /** Progress line while the model switch is being applied. */
  switchMessage?: string | null;
  /** Error surfaced if applying the switch failed. */
  switchError?: string | null;
  /** Per-step probe checklist (discover / chat / embedding). */
  switchSteps?: BundleSwitchStep[];
  /** Apply the staged switch; true means it completed without an App restart. */
  onApply?: () => Promise<boolean>;
  /** Discard the staged switch and clear its state ("Cancel"). */
  onCancelSwitch?: () => void;
  /** True while the staged model switch is being applied. */
  applying?: boolean;
  canResume?: boolean;
  /** True on Lite hardware while the active Profile is bound to Edge: shows Disconnect. */
  canDisconnect?: boolean;
  /** True while a disconnect runs. */
  disconnecting?: boolean;
  /** Release the Edge server and return to Cloud only. Throws on failure. */
  onDisconnect?: () => Promise<void>;
}

/**
 * Hide a message that was already set when the card mounted. The card mounts
 * again when the user comes back to the tab or picks Edge again, so that
 * message is from an earlier visit. A new message shows as usual.
 */
function createFreshMessage(readMessage: () => string | null | undefined) {
  const [staleMessage, setStaleMessage] = createSignal(untrack(readMessage) ?? null);
  createEffect(() => {
    // Each new attempt clears the message first, so the next one is fresh even with the same text.
    if (!readMessage()) setStaleMessage(null);
  });
  return () => {
    const message = readMessage() ?? null;
    return message && message !== staleMessage() ? message : null;
  };
}

// True when the last edge attempt (Test Connection, Connect or Apply) ended in
// an error. It lives outside the card because the card unmounts when the user
// switches tabs. On the next mount the card starts as a first-time setup.
let lastAttemptFailed = false;

/** Forget a failed attempt, so the next mount shows the saved server. Tests use it to start clean. */
export function resetEdgeAttemptMemory(): void {
  lastAttemptFailed = false;
}

export default function EdgeServerCard(props: EdgeServerCardProps) {
  // After a failed attempt, coming back to the tab shows blank fields instead of the saved server.
  const startBlank = lastAttemptFailed;
  const [edgeUrl, setEdgeUrl] = createSignal(startBlank ? "" : stripVersionSegment(props.edgeBaseUrl || ""));
  const [edgeApiKey, setEdgeApiKey] = createSignal("");
  const [edgeModelName, setEdgeModelName] = createSignal(startBlank ? "" : props.edgeModelName || "");
  const [models, setModels] = createSignal<string[]>([]);
  // The URL last confirmed by a successful Test Connection. While the field
  // still shows it, a single Backspace/Delete clears the whole form, so the
  // clear-all shortcut works after testing a server that was never saved — not
  // only on the saved URL.
  const [lastTestedUrl, setLastTestedUrl] = createSignal<string | null>(null);
  const modelOptions = () => (models().length ? models() : edgeModelName() ? [edgeModelName()] : []);
  const [apiKeyVisible, setApiKeyVisible] = createSignal(false);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [localSuccess, setLocalSuccess] = createSignal<string | null>(null);
  // Bypass HTTP proxy — opt-out (default on), since edge servers are typically
  // intranet endpoints a corporate proxy cannot reach.
  const [bypassProxy, setBypassProxy] = createSignal(startBlank ? true : (props.edgeBypassProxy ?? true));
  // Connecting an Edge server stages a model Binding change. The confirmation
  // dialog applies it and remains open for progress or a resumable failure.
  const [applyDialogOpen, setApplyDialogOpen] = createSignal(false);
  // True while Connect stages the switch, before the Apply dialog opens.
  const [connecting, setConnecting] = createSignal(false);
  // True from the Test Connection click, before the parent sets `testing`.
  const [testRunning, setTestRunning] = createSignal(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = createSignal(false);
  // While Test Connection, Connect or Disconnect runs, one spinner takes the place of the buttons.
  const isBusy = () => Boolean(props.testing || connecting() || testRunning() || props.disconnecting);
  const hasSavedConfig = () => Boolean(props.edgeConnected || props.edgeConfigured);
  // A saved edge config (connected, or kept after switching to Local) means the
  // backend holds the key: a blank key field reuses it, but only for the server
  // it was saved for. Pointing the URL at another host requires a new key.
  const hasSavedKey = () => hasSavedConfig() && isSameOrigin(edgeUrl(), props.edgeBaseUrl);

  // The values the card shows for the saved server before the user types.
  const savedUrl = () => stripVersionSegment(props.edgeBaseUrl || "");
  const savedModelName = () => props.edgeModelName || "";
  const savedBypassProxy = () => props.edgeBypassProxy ?? true;

  // True when the URL field still shows the saved server, unchanged.
  const isSavedUrlShown = () =>
    hasSavedConfig() && edgeUrl() !== "" && edgeUrl() === savedUrl();

  // True when a field differs from what the card showed for the saved server.
  // A typed key always counts: a blank key field means "keep the saved key".
  // Leaving the tab drops the changes: the card mounts again from the saved values.
  const hasChanges = () =>
    hasSavedConfig() &&
    (stripVersionSegment(edgeUrl().trim()) !== savedUrl() ||
      edgeApiKey().trim() !== "" ||
      edgeModelName() !== savedModelName() ||
      bypassProxy() !== savedBypassProxy());

  const error = createFreshMessage(() => props.error);
  const switchError = createFreshMessage(() => props.switchError);
  const testSuccessMessage = createFreshMessage(() => props.testSuccessMessage);

  // One message box at a time, so a new message fades in place instead of one
  // box closing and another opening. An error hides a success from an earlier step.
  type CardMessage = { tone: "error" | "success"; text: string };
  const liveMessage = createMemo<CardMessage | null>(() => {
    const currentError = error() || localError();
    if (currentError) return { tone: "error", text: currentError };
    const currentSwitchError = switchError();
    if (currentSwitchError && !applyDialogOpen()) return { tone: "error", text: currentSwitchError };
    const currentSuccess = localSuccess();
    if (currentSuccess) return { tone: "success", text: currentSuccess };
    return null;
  });
  // Test Connection and Connect clear the old message before they start. Keep
  // showing it while they run, so the box does not close and open again.
  const cardMessage = createMemo<CardMessage | null>(
    (shownMessage) => liveMessage() ?? (isBusy() ? shownMessage : null),
    null,
  );

  // Sync guard: `props` is spread from a large, non-memoized parent props
  // builder (`dashboardProps()` in app.tsx), so Solid's `mergeProps` wraps it
  // in a memo keyed on EVERY signal that builder reads — not just the edge
  // fields. Any unrelated signal write (e.g. `resetBundleSwitchState()`, the
  // first line of `connectEdge`, fired on Connect click) re-triggers this
  // effect with `props.edgeBaseUrl` unchanged, stomping whatever the user just
  // typed. Only push a
  // prop into local state when it actually changed (not merely re-read) so
  // in-flight edits survive unrelated re-renders.
  // A blank start counts the current props as already synced, so the effect
  // below does not fill the saved server back in.
  let syncedBaseUrl: string | undefined = startBlank ? props.edgeBaseUrl : undefined;
  let syncedModelName: string | undefined = startBlank ? props.edgeModelName : undefined;
  let syncedBypassProxy: boolean | undefined = startBlank ? props.edgeBypassProxy : undefined;
  createEffect(() => {
    if (props.edgeBaseUrl && props.edgeBaseUrl !== syncedBaseUrl) {
      syncedBaseUrl = props.edgeBaseUrl;
      setEdgeUrl(stripVersionSegment(props.edgeBaseUrl));
    }
    if (props.edgeModelName && props.edgeModelName !== syncedModelName) {
      syncedModelName = props.edgeModelName;
      setEdgeModelName(props.edgeModelName);
    }
    if (typeof props.edgeBypassProxy === "boolean" && props.edgeBypassProxy !== syncedBypassProxy) {
      syncedBypassProxy = props.edgeBypassProxy;
      setBypassProxy(props.edgeBypassProxy);
    }
  });

  // Remember a failed attempt for the next mount. A success clears it.
  createEffect(() => {
    if (error() || localError() || switchError()) lastAttemptFailed = true;
  });

  createEffect(() => {
    const message = testSuccessMessage();
    if (message) {
      lastAttemptFailed = false;
      setLocalSuccess(message);
      setLocalError(null);
    } else {
      // The parent clears the message (e.g. on Local Connect); drop the stale hint too.
      setLocalSuccess(null);
    }
  });

  // What the form holds now, in the shape Test Connection and Connect send.
  const readFormInput = () => ({
    base_url: edgeUrl().trim(),
    api_key: edgeApiKey().trim(),
    model_name: edgeModelName(),
    bypass_proxy: bypassProxy(),
  });

  // Drop everything tied to one specific server — the key, the tested model
  // list and the Test Connection marker — so none of them outlive the URL they
  // belong to. The four signals must move together; keeping them in one helper
  // stops them drifting apart when a single call site is edited alone.
  const clearTestedServer = () => {
    setEdgeApiKey("");
    setModels([]);
    setEdgeModelName("");
    setLastTestedUrl(null);
  };

  const handleConnect = async () => {
    const input = readFormInput();
    // With a saved config the key may be left blank: the backend reuses it.
    if (!input.base_url || (!input.api_key && !hasSavedKey())) {
      setLocalSuccess(null);
      setLocalError("Edge URL and API key are required.");
      return;
    }
    // Set busy before clearing the old error, so the message box keeps it until the result comes.
    setConnecting(true);
    setLocalError(null);
    // Same process as Connect-Local: every Connect stages a model switch, also
    // on a connected edge, and the "Apply model change" dialog opens only after
    // staging works. Nothing is saved until the user chooses Apply. Cancel
    // discards it.
    try {
      await props.onConnect(input);
    } catch (connectError) {
      // The typed values stay, so the user can fix them and try again.
      setLocalError(connectError instanceof Error ? connectError.message : String(connectError));
      return;
    } finally {
      setConnecting(false);
    }
    setApplyDialogOpen(true);
  };

  // The parent shows the test result through the `error` and `testSuccessMessage` props.
  const handleTest = async () => {
    setTestRunning(true);
    try {
      const served = await props.onTest?.(readFormInput());
      if (served) {
        setModels(served);
        if (served.length === 0) {
          // The server answered but exposes no trusted Chat+Embedding pair, so
          // there is nothing to connect to. Drop any prior selection and tested
          // marker so the picker empties and Connect disables, instead of
          // leaving a stale model with a "success — press Connect" message.
          setEdgeModelName("");
          setLastTestedUrl(null);
          setLocalSuccess(null);
          setLocalError(t("edge.no_served_models"));
          return;
        }
        if (!served.includes(edgeModelName())) setEdgeModelName(served[0] ?? "");
        setLastTestedUrl(edgeUrl().trim());
      }
    } finally {
      setTestRunning(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnectConfirmOpen(false);
    setLocalError(null);
    setLocalSuccess(null);
    try {
      await props.onDisconnect?.();
    } catch (disconnectError) {
      setLocalError(disconnectError instanceof Error ? disconnectError.message : String(disconnectError));
      return;
    }
    // The saved server is gone, so the form starts over as a first-time setup.
    setEdgeUrl("");
    clearTestedServer();
    setBypassProxy(true);
  };

  return (
    // The e2e helpers read data-edge-connected: no button text marks the connected state.
    <div class="space-y-4" data-edge-connected={props.edgeConnected ? "true" : "false"}>
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <Server size={16} class="text-dls-secondary" />
            <div class="text-body-lg font-medium text-dls-text">{t("edge.card_title")}</div>
            <span class="inline-flex items-center rounded-pill border border-dls-border bg-dls-surface-tint px-2 py-0.5 text-tiny font-semibold uppercase tracking-wide text-dls-secondary">
              {t("model.local_label")}
            </span>
          </div>
          <div class="text-caption text-dls-secondary mt-1">{t("edge.card_subtitle")}</div>
        </div>
      </div>

      <Show when={cardMessage()}>
        {(message) => (
          <div
            class="flex items-start gap-2 rounded-inset border p-3 text-body-lg transition-colors duration-300"
            data-testid="edge-message"
            classList={{
              "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text": message().tone === "error",
              "border-dls-success-border bg-dls-success-bg text-dls-success-text": message().tone === "success",
            }}
          >
            <Show when={message().tone === "error"}>
              <AlertTriangle size={14} class="mt-0.5 shrink-0" />
            </Show>
            <span>{message().text}</span>
          </div>
        )}
      </Show>

      {/* Locked while Test Connection or Connect runs: Connect stages the values
          it read at the click, and the Apply dialog must name the same ones. */}
      <fieldset class="space-y-3" disabled={isBusy()}>
        <div class="space-y-1.5">
          <label class={FIELD_LABEL_CLASS}>{t("edge.server_url")}</label>
          <input
            type="text"
            class="w-full bg-dls-panel-input-bg p-2.5 rounded-inset border border-dls-panel-input-border text-body-lg text-dls-text"
            value={edgeUrl()}
            onInput={(event) => {
              setEdgeUrl(event.currentTarget.value);
              // A typed key and the tested models belong to the old server.
              clearTestedServer();
            }}
            onKeyDown={(event) => {
              // While the field still shows a committed URL — the saved server,
              // or one just confirmed by Test Connection — the first Backspace
              // or Delete clears it all, so the user can type a new server at
              // once. This keeps the shortcut after testing an unsaved server.
              const isDeleteKey = event.key === "Backspace" || event.key === "Delete";
              const showsCommittedUrl =
                isSavedUrlShown() ||
                (edgeUrl() !== "" && edgeUrl().trim() === lastTestedUrl());
              if (!isDeleteKey || !showsCommittedUrl) return;
              event.preventDefault();
              setEdgeUrl("");
              clearTestedServer();
            }}
            placeholder="http://server-ip:port"
          />
        </div>

        <div class="space-y-1.5">
          <label class={FIELD_LABEL_CLASS}>{t("edge.connection_key")}</label>
          <div class="relative">
            <input
              type={apiKeyVisible() && !hasSavedKey() ? "text" : "password"}
              class="w-full bg-dls-panel-input-bg p-2.5 pr-9 rounded-inset border border-dls-panel-input-border text-body-lg text-dls-text"
              value={edgeApiKey()}
              onInput={(event) => setEdgeApiKey(event.currentTarget.value)}
              // A blank field with a dotted placeholder means "keep the saved key".
              placeholder={hasSavedKey() ? "••••••••••••" : t("edge.key_enter_placeholder")}
            />
            <Show when={!hasSavedKey()}>
              <button
                type="button"
                class="absolute right-2 top-1/2 -translate-y-1/2 text-dls-secondary hover:text-dls-text transition-colors"
                onClick={() => setApiKeyVisible((value) => !value)}
              >
                {apiKeyVisible() ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </Show>
          </div>
        </div>

        <div class="space-y-1.5">
          <label class={FIELD_LABEL_CLASS}>{t("local.model_label")}</label>
          <ModelCombobox
            testIdPrefix="edge-model"
            aria-label={t("local.model_label")}
            options={modelOptions().map((id) => ({ id, name: id, release_date: "" }))}
            value={edgeModelName()}
            placeholder={t("edge.test_connection_for_models")}
            disabled={!modelOptions().length}
            onChange={setEdgeModelName}
          />
        </div>

        <label class="flex items-center gap-2 cursor-pointer select-none pt-0.5">
          <input
            type="checkbox"
            class="w-3.5 h-3.5 accent-[rgb(var(--dls-accent-rgb)/1)] cursor-pointer"
            checked={bypassProxy()}
            onChange={(event) => setBypassProxy(event.currentTarget.checked)}
          />
          <span class="text-caption text-dls-secondary">{t("edge.bypass_proxy_card_label")}</span>
        </label>
      </fieldset>

      {/* The fields stay editable while connected, so Test Connection remains
          available. On Lite hardware, Disconnect takes Connect's place while
          the configuration is unchanged or has no model to connect.
          Otherwise Connect can stage a changed configuration. */}
      <div class="flex h-8 items-center justify-end gap-2 pt-1">
        <Show when={!isBusy()} fallback={<BusyButton data-testid="edge-busy" />}>
          <Show when={props.onTest}>
            <Button
              type="button"
              variant="outline"
              class="text-caption h-8 py-0 px-4"
              onClick={() => void handleTest()}
              disabled={!edgeUrl().trim() || (!edgeApiKey().trim() && !hasSavedKey())}
            >
              {t("settings.test_connection")}
            </Button>
          </Show>
          <Show
            when={props.canDisconnect && props.onDisconnect && (!props.edgeConnected || !hasChanges() || !edgeModelName())}
            fallback={
              <Button
                type="button"
                variant="outline"
                class="text-caption h-8 py-0 px-4"
                onClick={() => void handleConnect()}
                disabled={!edgeModelName() || (Boolean(props.edgeConnected) && !hasChanges())}
              >
                {t("common.connect")}
              </Button>
            }
          >
            <Button
              type="button"
              variant="outline"
              class="text-caption h-8 py-0 px-4"
              data-testid="edge-disconnect"
              onClick={() => setDisconnectConfirmOpen(true)}
            >
              {t("edge.disconnect")}
            </Button>
          </Show>
        </Show>
      </div>
      <RestartRequiredDialog
        open={applyDialogOpen()}
        bundleLabel={edgeModelName()}
        onNotNow={() => {
          setApplyDialogOpen(false);
          props.onCancelSwitch?.();
        }}
        onApply={async () => {
          if (!(await props.onApply?.())) return;
          setApplyDialogOpen(false);
          // The key is saved now, so a blank field means "keep the saved key" again.
          setEdgeApiKey("");
        }}
        applying={props.applying}
        resume={props.canResume}
        progressMessage={props.switchMessage}
        progressError={props.switchError}
        steps={props.switchSteps}
      />
      <ConfirmModal
        open={disconnectConfirmOpen()}
        title={t("edge.disconnect_confirm_title")}
        message={t("edge.disconnect_confirm_message")}
        confirmLabel={t("edge.disconnect")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        data-testid="edge-disconnect-confirm"
        onConfirm={() => void handleDisconnect()}
        onCancel={() => setDisconnectConfirmOpen(false)}
      />
    </div>
  );
}
