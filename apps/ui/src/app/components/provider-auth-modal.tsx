import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2/client";
import { Check, CheckCircle2, Copy, Loader2, X } from "lucide-solid";
import type { ProviderListItem } from "../types";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { isTauriRuntime } from "../utils";
import { compareProviders } from "~/shared/util/providers";
import { t } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";

type ProviderAuthMethod = { type: "oauth" | "api"; label: string };
type ProviderAuthEntry = {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  connected: boolean;
  env: string[];
};

export type ProviderOAuthStartResult = {
  methodIndex: number;
  authorization: Omit<ProviderAuthAuthorization, "method" | "instructions"> & {
    // Device flow (github_copilot) adds "device" to the SDK's "auto" | "code",
    // and the user types userCode at verificationUri.
    method?: ProviderAuthAuthorization["method"] | "device";
    instructions?: string;
    userCode?: string;
    verificationUri?: string;
  };
  // Client-side deadline (ms since epoch) for the "auto" polling flow —
  // modal times out before LRM's 600s expiry. Absent for "code" flows.
  expiresAtMs?: number;
};

type ProviderOAuthSession = ProviderOAuthStartResult & {
  providerId: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
};

export type ProviderAuthModalProps = {
  open: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  providers: ProviderListItem[];
  connectedProviderIds: string[];
  authMethods: Record<string, ProviderAuthMethod[]>;
  onSelect: (providerId: string) => Promise<ProviderOAuthStartResult>;
  onSubmitApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  onSubmitOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string
  ) => Promise<{ connected: boolean; pending?: boolean; terminated?: boolean; message?: string }>;
  onCancelOAuth?: (providerId: string) => Promise<void>;
  onRefreshProviders?: () => Promise<unknown>;
  onClose: () => void;
};

export default function ProviderAuthModal(props: ProviderAuthModalProps) {
  const formatProviderName = (id: string, fallback?: string) => {
    const named = fallback?.trim();
    if (named) return named;

    const normalized = id.trim();
    const mapped = PROVIDER_LABELS[normalized.toLowerCase()];
    if (mapped) return mapped;

    const cleaned = normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return id;

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

  const entries = createMemo<ProviderAuthEntry[]>(() => {
    const methods = props.authMethods ?? {};
    const connected = new Set(props.connectedProviderIds ?? []);
    const providers = props.providers ?? [];

    return Object.keys(methods)
      .map((id): ProviderAuthEntry => {
        const provider = providers.find((item) => item.id === id);
        return {
          id,
          name: formatProviderName(id, provider?.name),
          methods: methods[id] ?? [],
          connected: connected.has(id),
          env: Array.isArray(provider?.env) ? provider.env : [],
        };
      })
      .sort(compareProviders);
  });

  const methodLabel = (method: ProviderAuthMethod) =>
    method.label || (method.type === "oauth" ? "OAuth" : "API key");

  const actionDisabled = () => props.loading || props.submitting;

  const [view, setView] = createSignal<"list" | "method" | "api" | "oauth-code" | "oauth-auto" | "oauth-device">("list");
  const [codeCopied, setCodeCopied] = createSignal(false);
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [selectedProviderId, setSelectedProviderId] = createSignal<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = createSignal("");
  const [oauthCodeInput, setOauthCodeInput] = createSignal("");
  const [oauthSession, setOauthSession] = createSignal<ProviderOAuthSession | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [activeEntryIndex, setActiveEntryIndex] = createSignal(0);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [pollingBusy, setPollingBusy] = createSignal(false);
  const [oauthAutoBusy, setOauthAutoBusy] = createSignal(false);
  const [loginCompleted, setLoginCompleted] = createSignal(false);
  let searchInputEl: HTMLInputElement | undefined;
  let providerPoll: number | null = null;
  let oauthAutoPoll: number | null = null;

  const selectedEntry = createMemo(() =>
    entries().find((entry) => entry.id === selectedProviderId()) ?? null,
  );

  const resolvedView = createMemo(() => (selectedEntry() ? view() : "list"));
  const errorMessage = createMemo(() => localError() ?? props.error);

  const filteredEntries = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return entries();
    return entries().filter((entry) => {
      const methodText = entry.methods.map((method) => methodLabel(method)).join(" ");
      return `${entry.name} ${entry.id} ${methodText}`.toLowerCase().includes(query);
    });
  });

  const oauthInstructions = createMemo(() => oauthSession()?.authorization.instructions?.trim() ?? "");

  const oauthDisplayCode = createMemo(() => {
    const instructions = oauthInstructions();
    if (!instructions) return "";
    const matched = instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0];
    if (matched) return matched;
    if (instructions.includes(":")) {
      return instructions.split(":").slice(1).join(":").trim();
    }
    return instructions;
  });

  const oauthDeviceCode = createMemo(() => oauthSession()?.authorization.userCode?.trim() ?? "");
  const oauthDeviceUri = createMemo(() => oauthSession()?.authorization.verificationUri?.trim() ?? "");

  const oauthRemainingSeconds = createMemo(() => {
    const deadline = oauthSession()?.expiresAtMs;
    if (!deadline) return null;
    return Math.max(0, Math.floor((deadline - nowMs()) / 1000));
  });

  const oauthRemainingLabel = createMemo(() => {
    const secs = oauthRemainingSeconds();
    if (secs === null) return "";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  });

  const resetState = () => {
    setView("list");
    setSelectedProviderId(null);
    setApiKeyInput("");
    setOauthCodeInput("");
    setOauthSession(null);
    setSearchQuery("");
    setActiveEntryIndex(0);
    setLocalError(null);
    setLoginCompleted(false);
    setCodeCopied(false);
  };

  const copyDeviceCode = async () => {
    const code = oauthDeviceCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      setCodeCopied(false);
    }
  };

  createEffect(() => {
    if (!props.open || resolvedView() !== "oauth-device") return;
    setNowMs(Date.now());
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000);
    onCleanup(() => window.clearInterval(tick));
  });

  createEffect(() => {
    if (!props.open) {
      resetState();
    }
  });

  createEffect(() => {
    if (!props.open || resolvedView() !== "list") return;
    const total = filteredEntries().length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => Math.max(0, Math.min(current, total - 1)));
  });

  createEffect(() => {
    if (!props.open || resolvedView() !== "list") return;
    queueMicrotask(() => {
      searchInputEl?.focus();
    });
  });

  const hasMethod = (entry: ProviderAuthEntry | null, type: ProviderAuthMethod["type"]) =>
    !!entry?.methods?.some((method) => method.type === type);

  const handleClose = () => {
    void props.onRefreshProviders?.();
    // Release LRM's callback port if mid-flow (auto-poll or manual code entry) —
    // the browser may never deliver the callback and LRM holds the port for 600s.
    // Device flow has NO callback port: cancelling it just kills the background
    // poll that would otherwise complete once the user authorizes, so leave it
    // running and let it finish (or expire) on its own.
    if (isOauthView() && !isDeviceFlow()) {
      const providerId = activeProviderId();
      if (providerId) void props.onCancelOAuth?.(providerId);
    }
    if (oauthAutoPoll !== null) {
      window.clearInterval(oauthAutoPoll);
      oauthAutoPoll = null;
    }
    if (providerPoll !== null) {
      window.clearInterval(providerPoll);
      providerPoll = null;
    }
    resetState();
    props.onClose();
  };

  onCleanup(() => {
    if (oauthAutoPoll !== null) {
      window.clearInterval(oauthAutoPoll);
      oauthAutoPoll = null;
    }
    if (providerPoll !== null) {
      window.clearInterval(providerPoll);
      providerPoll = null;
    }
  });

  const isOauthView = () =>
    resolvedView() === "oauth-code" ||
    resolvedView() === "oauth-auto" ||
    resolvedView() === "oauth-device";
  const activeProviderId = () => oauthSession()?.providerId ?? selectedProviderId();
  const isDeviceFlow = () => oauthSession()?.authorization.method === "device";

  const isActiveProviderConnected = () => {
    const id = activeProviderId();
    if (!id) return false;
    // During an in-flight OAuth flow, a session may ALREADY exist on disk (a
    // re-login while connected). Do NOT auto-close on that stale session; it
    // would cancel the flow and tear down the localhost callback server before
    // the browser delivers the code (ERR_CONNECTION_REFUSED). Only THIS flow's
    // authoritative completion (status poll -> "complete") counts.
    if (isOauthView()) return loginCompleted();
    return (props.connectedProviderIds ?? []).includes(id);
  };

  const pollProviders = async () => {
    const id = activeProviderId();
    if (!id) return;
    if (pollingBusy()) return;
    setPollingBusy(true);
    try {
      await props.onRefreshProviders?.();
    } finally {
      setPollingBusy(false);
    }
    if (isActiveProviderConnected()) {
      handleClose();
    }
  };

  const startProviderPolling = () => {
    if (typeof window === "undefined") return;
    if (providerPoll !== null) return;
    void pollProviders();
    providerPoll = window.setInterval(() => {
      void pollProviders();
    }, 2000);
  };

  const stopProviderPolling = () => {
    if (providerPoll !== null) {
      window.clearInterval(providerPoll);
      providerPoll = null;
    }
  };

  createEffect(() => {
    if (!props.open || !isOauthView()) {
      stopProviderPolling();
      return;
    }
    if (isActiveProviderConnected()) {
      handleClose();
      return;
    }
    startProviderPolling();
  });

  createEffect(() => {
    const pollingView = resolvedView() === "oauth-auto" || resolvedView() === "oauth-device";
    if (!props.open || !pollingView || !oauthSession()) {
      stopOauthAutoPolling();
      return;
    }
    startOauthAutoPolling();
  });

  const openOauthUrl = async (url: string) => {
    if (!url) return;
    let host = "unknown";
    try {
      host = new URL(url).host || "unknown";
    } catch {
      host = "invalid-url";
    }
    console.info(`[ui] external open intent source=provider-oauth host=${host}`);
    if (isTauriRuntime()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const submitOauth = async (providerId: string, methodIndex: number, code?: string) => {
    const trimmedCode = code?.trim();
    setLocalError(null);
    try {
      const result = await props.onSubmitOAuth(providerId, methodIndex, trimmedCode || undefined);
      if (result?.connected) {
        setLoginCompleted(true);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to complete OAuth";
      setLocalError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  };

  const stopOauthAutoPolling = () => {
    if (oauthAutoPoll !== null) {
      window.clearInterval(oauthAutoPoll);
      oauthAutoPoll = null;
    }
  };

  const attemptOauthAutoCompletion = async () => {
    const session = oauthSession();
    if (!session || oauthAutoBusy()) return;
    // Client-side deadline — covers providers that show an in-browser error
    // page instead of redirecting to our callback.
    if (session.expiresAtMs && Date.now() > session.expiresAtMs) {
      stopOauthAutoPolling();
      setLocalError("OAuth login timed out. Close this dialog and try again.");
      void props.onCancelOAuth?.(session.providerId);
      return;
    }
    setOauthAutoBusy(true);
    try {
      const result = await submitOauth(session.providerId, session.methodIndex);
      if (result?.connected || result?.terminated) {
        stopOauthAutoPolling();
      }
    } finally {
      setOauthAutoBusy(false);
    }
  };

  const startOauthAutoPolling = () => {
    if (typeof window === "undefined") return;
    if (oauthAutoPoll !== null) return;
    void attemptOauthAutoCompletion();
    oauthAutoPoll = window.setInterval(() => {
      void attemptOauthAutoCompletion();
    }, 2000);
  };

  const startOauth = async (entry: ProviderAuthEntry) => {
    if (actionDisabled()) return;
    setLocalError(null);
    setOauthCodeInput("");
    setOauthSession(null);
    setLoginCompleted(false);
    try {
      const started = await props.onSelect(entry.id);
      const nextSession: ProviderOAuthSession = {
        providerId: entry.id,
        methodIndex: started.methodIndex,
        authorization: started.authorization,
        expiresAtMs: started.expiresAtMs,
      };
      setOauthSession(nextSession);
      setCodeCopied(false);
      await openOauthUrl(started.authorization.url);

      if (started.authorization.method === "device") {
        setView("oauth-device");
        return;
      }

      if (started.authorization.method === "code") {
        setView("oauth-code");
        return;
      }

      setView("oauth-auto");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start OAuth";
      setLocalError(message);
    }
  };

  const handleEntrySelect = (entry: ProviderAuthEntry) => {
    if (actionDisabled()) return;
    setLocalError(null);
    setSelectedProviderId(entry.id);

    const hasOauth = hasMethod(entry, "oauth");
    const hasApi = hasMethod(entry, "api");

    if (hasOauth && !hasApi) {
      void startOauth(entry);
      return;
    }

    if (hasApi && !hasOauth) {
      setView("api");
      return;
    }

    if (hasApi && hasOauth) {
      setView("method");
      return;
    }

    setLocalError(`No authentication methods available for ${entry.name}.`);
  };

  const handleMethodSelect = (method: ProviderAuthMethod["type"]) => {
    const entry = selectedEntry();
    if (!entry || actionDisabled()) return;
    setLocalError(null);

    if (method === "oauth") {
      void startOauth(entry);
      return;
    }

    setView("api");
  };

  const handleApiSubmit = async () => {
    const entry = selectedEntry();
    if (!entry || actionDisabled()) return;

    const trimmed = apiKeyInput().trim();
    if (!trimmed) {
      setLocalError("API key is required.");
      return;
    }

    setLocalError(null);
    try {
      await props.onSubmitApiKey(entry.id, trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save API key";
      setLocalError(message);
    }
  };

  const handleOauthCodeSubmit = async () => {
    const entry = selectedEntry();
    const session = oauthSession();
    if (!entry || !session || actionDisabled()) return;

    const trimmed = oauthCodeInput().trim();
    if (!trimmed) {
      setLocalError("Authorization code is required.");
      return;
    }

    await submitOauth(entry.id, session.methodIndex, trimmed);
  };

  const handleBack = () => {
    if (isOauthView()) {
      const providerId = activeProviderId();
      // Device flow: don't cancel — let the background poll finish/expire (see
      // handleClose). PKCE flows cancel to release the callback port.
      if (providerId && !isDeviceFlow()) void props.onCancelOAuth?.(providerId);
      if (hasMethod(selectedEntry(), "api")) {
        setView("method");
      } else {
        setView("list");
      }
      setOauthSession(null);
      setOauthCodeInput("");
      setCodeCopied(false);
      setLocalError(null);
      return;
    }

    if (resolvedView() === "api" && hasMethod(selectedEntry(), "oauth")) {
      setView("method");
      setApiKeyInput("");
      setLocalError(null);
      return;
    }
    resetState();
  };

  const submittingLabel = () => {
    if (!props.submitting) return null;
    if (resolvedView() === "api") return t("provider_auth.submitting_api_key");
    if (resolvedView() === "oauth-code") return t("provider_auth.submitting_oauth_code");
    if (resolvedView() === "oauth-auto") return t("provider_auth.submitting_oauth_auto");
    if (resolvedView() === "oauth-device") return t("provider_auth.submitting_oauth_device");
    return t("provider_auth.submitting_opening");
  };

  const stepEntryIndex = (delta: number) => {
    const total = filteredEntries().length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + delta + total) % total;
    });
  };

  const handleListKeyDown = (event: KeyboardEvent) => {
    if (resolvedView() !== "list") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      stepEntryIndex(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      stepEntryIndex(-1);
      return;
    }
    if (event.key === "Enter") {
      if (event.isComposing || (event as KeyboardEvent & { keyCode?: number }).keyCode === 229) return;
      const entry = filteredEntries()[activeEntryIndex()];
      if (!entry) return;
      event.preventDefault();
      handleEntrySelect(entry);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
    }
  };

  return (
    <Show when={props.open}>
        <div
          class="fixed inset-0 z-[60] dls-modal-backdrop flex items-center justify-center p-4 overflow-y-auto"
          data-testid="provider-auth-modal"
        >
        <div class="border w-full max-w-lg overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col dls-modal-surface">
          <div class="px-6 pt-6 pb-4 border-b border-dls-border/50 flex items-start justify-between gap-4">
            <div>
              <h3 class="text-heading font-semibold text-dls-text">{t("provider_auth.title")}</h3>
              <p class="text-body-lg text-dls-secondary mt-1">{t("provider_auth.subtitle")}</p>
            </div>
            <Button
              variant="ghost"
              class="!p-2 rounded-pill"
              onClick={handleClose}
              aria-label={t("common.close")}
              data-testid="modal-dismiss-btn"
            >
              <X size={16} />
            </Button>
          </div>

          <div class="px-6 py-4 flex flex-col gap-4 min-h-0">
            <div class="min-h-[36px]">
              <Show when={errorMessage() || props.loading}>
                <Show
                  when={errorMessage()}
                  fallback={
                    <div class="rounded-inset border border-dls-border bg-dls-panel-input-bg px-4 py-3 text-body-lg text-dls-secondary animate-pulse">
                      {t("provider_auth.loading")}
                    </div>
                  }
                >
                  <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-3 py-2 text-caption text-dls-danger-text">
                    {errorMessage()}
                  </div>
                </Show>
              </Show>
            </div>

            <Show when={!props.loading}>
              <div class="flex-1 space-y-2 overflow-y-auto pr-1 -mr-1">
                <Show when={resolvedView() === "list"}>
                  <div class="space-y-3" onKeyDown={handleListKeyDown}>
                    <TextInput
                      ref={searchInputEl}
                      data-testid="provider-auth-search-input"
                      label={t("provider_auth.search_label")}
                      type="text"
                      placeholder={t("provider_auth.search_placeholder")}
                      value={searchQuery()}
                      onInput={(event) => {
                        setSearchQuery(event.currentTarget.value);
                        setActiveEntryIndex(0);
                      }}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck={false}
                      disabled={actionDisabled()}
                    />

                    <Show
                      when={filteredEntries().length}
                      fallback={
                        <div class="text-body-lg text-dls-secondary">
                          {entries().length ? t("provider_auth.no_match") : t("provider_auth.none_available")}
                        </div>
                      }
                    >
                      <For each={filteredEntries()}>
                        {(entry, index) => {
                          const idx = () => index();
                          return (
                            <button
                              type="button"
                              data-testid="provider-auth-entry"
                              class={`w-full rounded-inset border px-4 py-3 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                                idx() === activeEntryIndex()
                                  ? "border-dls-border bg-dls-surface-solid/80"
                                  : "border-dls-border bg-dls-panel-inset-bg hover:bg-dls-hover/70"
                              }`}
                              disabled={actionDisabled()}
                              onMouseEnter={() => setActiveEntryIndex(idx())}
                              onClick={() => handleEntrySelect(entry)}
                            >
                              <div class="flex items-center justify-between gap-3">
                                <div class="min-w-0">
                                  <div class="text-body-lg font-medium text-dls-text truncate">{entry.name}</div>
                                  <div class="text-label text-dls-secondary font-mono truncate">{entry.id}</div>
                                </div>
                                <div class="flex items-center justify-end gap-2 shrink-0 min-w-[108px]">
                                  <Show
                                    when={entry.connected}
                                    fallback={<span class="text-caption text-dls-muted">{t("provider_auth.connect_label")}</span>}
                                  >
                                    <div class="flex items-center gap-1 text-label text-dls-success-text bg-dls-success-bg border border-dls-success-border px-2 py-1 rounded-pill">
                                      <CheckCircle2 size={12} />
                                      {t("status.connected")}
                                    </div>
                                  </Show>
                                </div>
                              </div>
                              <div class="mt-2 flex flex-wrap gap-2">
                                <For each={entry.methods}>
                                  {(method) => (
                                    <span
                                      class={`text-tiny uppercase tracking-[0.2em] px-2 py-1 rounded-pill border ${
                                        method.type === "oauth"
                                          ? "bg-dls-selection/15 text-dls-selection-text border-dls-selection/30"
                                          : "bg-dls-surface-tint text-dls-secondary border-dls-border"
                                      }`}
                                    >
                                      {methodLabel(method)}
                                    </span>
                                  )}
                                </For>
                              </div>
                            </button>
                          );
                        }}
                      </For>
                    </Show>

                    <div class="text-label text-dls-muted">{t("provider_auth.keyboard_hint")}</div>
                  </div>
                </Show>

                <Show when={resolvedView() === "method" && selectedEntry()}>
                  <div class="rounded-inset border border-dls-border/60 bg-dls-panel-inset-bg p-4 space-y-4">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <div class="text-body-lg font-medium text-dls-text">{selectedEntry()!.name}</div>
                        <div class="text-caption text-dls-secondary mt-1">{t("provider_auth.method_subtitle")}</div>
                      </div>
                      <Button variant="ghost" onClick={handleBack} disabled={actionDisabled()}>
                        {t("provider_auth.back")}
                      </Button>
                    </div>
                    <div class="grid gap-2">
                      <Show when={hasMethod(selectedEntry(), "oauth")}>
                        <Button
                          variant="secondary"
                          onClick={() => void handleMethodSelect("oauth")}
                          disabled={actionDisabled()}
                        >
                          {t("provider_auth.oauth_button")}
                        </Button>
                      </Show>
                      <Show when={hasMethod(selectedEntry(), "api")}>
                        <Button
                          variant="outline"
                          onClick={() => handleMethodSelect("api")}
                          disabled={actionDisabled()}
                        >
                          {t("provider_auth.api_key_button")}
                        </Button>
                      </Show>
                    </div>
                  </div>
                </Show>

                <Show when={resolvedView() === "api" && selectedEntry()}>
                  <div class="rounded-inset border border-dls-border/60 bg-dls-panel-inset-bg p-4 space-y-4">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <div class="text-body-lg font-medium text-dls-text">{selectedEntry()!.name}</div>
                        <div class="text-caption text-dls-secondary mt-1">{t("provider_auth.api_subtitle")}</div>
                      </div>
                      <Button variant="ghost" onClick={handleBack} disabled={actionDisabled()}>
                        {t("provider_auth.back")}
                      </Button>
                    </div>
                    <TextInput
                      label={t("provider_auth.api_key_label")}
                      type="password"
                      placeholder="sk-..."
                      value={apiKeyInput()}
                      onInput={(event) => {
                        setApiKeyInput(event.currentTarget.value);
                        if (localError()) setLocalError(null);
                      }}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck={false}
                      disabled={actionDisabled()}
                    />
                    <Show when={selectedEntry()!.env.length > 0}>
                      <div class="text-label text-dls-muted">
                        Env vars: <span class="font-mono">{selectedEntry()!.env.join(", ")}</span>
                      </div>
                    </Show>
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-label text-dls-muted">
                        {t("provider_auth.keys_stored_locally")}
                      </div>
                      <Button
                        variant="secondary"
                        data-testid="provider-auth-save-key-button"
                        onClick={handleApiSubmit}
                        disabled={actionDisabled() || !apiKeyInput().trim()}
                      >
                        {props.submitting ? t("provider_auth.saving") : t("provider_auth.save_key")}
                      </Button>
                    </div>
                  </div>
                </Show>

                <Show when={resolvedView() === "oauth-code" && selectedEntry() && oauthSession()}>
                  <div class="rounded-inset border border-dls-border/60 bg-dls-panel-inset-bg p-4 space-y-4">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <div class="text-body-lg font-medium text-dls-text">{selectedEntry()!.name}</div>
                        <div class="text-caption text-dls-secondary mt-1">{t("provider_auth.oauth_code_subtitle")}</div>
                      </div>
                      <Button variant="ghost" onClick={handleBack} disabled={actionDisabled()}>
                        {t("provider_auth.back")}
                      </Button>
                    </div>
                    <div class="text-caption text-dls-muted">
                      {t("provider_auth.oauth_code_instruction")}
                    </div>
                    <Show when={oauthInstructions()}>
                      <div class="rounded-control border border-dls-border/60 bg-dls-panel-input-bg px-3 py-2 text-label text-dls-muted font-mono break-all">
                        {oauthInstructions()}
                      </div>
                    </Show>
                    <TextInput
                      label={t("provider_auth.auth_code_label")}
                      type="text"
                      placeholder={t("provider_auth.paste_code_placeholder")}
                      value={oauthCodeInput()}
                      onInput={(event) => {
                        setOauthCodeInput(event.currentTarget.value);
                        if (localError()) setLocalError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        void handleOauthCodeSubmit();
                      }}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck={false}
                      disabled={actionDisabled()}
                    />
                    <div class="flex items-center justify-between gap-3">
                      <Button
                        variant="outline"
                        onClick={() => {
                          const url = oauthSession()?.authorization.url ?? "";
                          void openOauthUrl(url);
                        }}
                        disabled={actionDisabled()}
                      >
                        {t("provider_auth.open_browser_again")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => void handleOauthCodeSubmit()}
                        disabled={actionDisabled() || !oauthCodeInput().trim()}
                      >
                        {props.submitting ? t("provider_auth.verifying") : t("provider_auth.complete_connection")}
                      </Button>
                    </div>
                  </div>
                </Show>

                <Show when={resolvedView() === "oauth-auto" && selectedEntry() && oauthSession()}>
                  <div class="rounded-inset border border-dls-border/60 bg-dls-panel-inset-bg p-4 space-y-4">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <div class="text-body-lg font-medium text-dls-text">{selectedEntry()!.name}</div>
                        <div class="text-caption text-dls-secondary mt-1">{t("provider_auth.oauth_auto_subtitle")}</div>
                      </div>
                      <Button variant="ghost" onClick={handleBack} disabled={actionDisabled()}>
                        {t("provider_auth.back")}
                      </Button>
                    </div>
                    <div class="text-caption text-dls-muted">{t("provider_auth.oauth_auto_instruction")}</div>
                    <Show when={oauthDisplayCode()}>
                      <TextInput label={t("provider_auth.confirmation_code_label")} value={oauthDisplayCode()} readOnly class="font-mono" />
                    </Show>
                    <div class="flex items-center gap-2 text-caption text-dls-muted">
                      <Loader2 size={14} class={props.submitting || pollingBusy() || oauthAutoBusy() ? "animate-spin" : ""} />
                      <span>{t("provider_auth.checking_status")}</span>
                    </div>
                    <div class="flex items-center justify-between gap-3">
                      <Button
                        variant="outline"
                        onClick={() => {
                          const url = oauthSession()?.authorization.url ?? "";
                          void openOauthUrl(url);
                        }}
                        disabled={actionDisabled()}
                      >
                        {t("provider_auth.open_browser_again")}
                      </Button>
                      <div class="text-label text-dls-muted text-right">{t("provider_auth.window_closes_note")}</div>
                    </div>
                  </div>
                </Show>

                <Show when={resolvedView() === "oauth-device" && selectedEntry() && oauthSession()}>
                  <div class="rounded-inset border border-dls-border/60 bg-dls-panel-inset-bg p-4 space-y-4">
                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <div class="text-body-lg font-medium text-dls-text">{selectedEntry()!.name}</div>
                        <div class="text-caption text-dls-secondary mt-1">{t("provider_auth.oauth_device_subtitle")}</div>
                      </div>
                      <Button variant="ghost" onClick={handleBack} disabled={actionDisabled()}>
                        {t("provider_auth.back")}
                      </Button>
                    </div>

                    <ol class="space-y-3 text-caption text-dls-secondary">
                      <li class="flex gap-2">
                        <span class="text-dls-muted">1.</span>
                        <span>
                          {t("provider_auth.device_step_open")}{" "}
                          <button
                            type="button"
                            class="underline font-medium text-dls-link hover:text-dls-link-hover transition-colors"
                            onClick={() => void openOauthUrl(oauthDeviceUri())}
                          >
                            {oauthDeviceUri() || t("provider_auth.device_open_link")}
                          </button>
                        </span>
                      </li>
                      <li class="flex flex-col gap-2">
                        <div class="flex gap-2">
                          <span class="text-dls-muted">2.</span>
                          <span>{t("provider_auth.device_step_code")}</span>
                        </div>
                        <div class="flex items-center gap-2 pl-4">
                          <div class="flex-1 rounded-subtle border border-dls-border/70 bg-dls-surface-solid/70 px-4 py-3 text-center font-mono text-heading-lg tracking-[0.3em] text-dls-text select-all">
                            {oauthDeviceCode() || "········"}
                          </div>
                          <Button
                            variant="outline"
                            class="!px-3 h-11 shrink-0"
                            onClick={() => void copyDeviceCode()}
                            disabled={!oauthDeviceCode()}
                            aria-label={t("provider_auth.device_copy_code")}
                          >
                            <Show when={codeCopied()} fallback={<Copy size={16} />}>
                              <Check size={16} class="text-dls-success-text" />
                            </Show>
                          </Button>
                        </div>
                      </li>
                      <li class="flex gap-2">
                        <span class="text-dls-muted">3.</span>
                        <span>{t("provider_auth.device_step_authorize")}</span>
                      </li>
                    </ol>

                    <div class="flex items-center justify-between gap-3 border-t border-dls-border/40 pt-3">
                      <div class="flex items-center gap-2 text-caption text-dls-muted">
                        <Loader2 size={14} class={props.submitting || pollingBusy() || oauthAutoBusy() ? "animate-spin" : ""} />
                        <span>{t("provider_auth.checking_status")}</span>
                      </div>
                      <Show when={oauthRemainingLabel()}>
                        <div
                          class={`text-label font-mono ${
                            (oauthRemainingSeconds() ?? 0) <= 30 ? "text-dls-danger-text" : "text-dls-muted"
                          }`}
                        >
                          {(oauthRemainingSeconds() ?? 0) > 0
                            ? `${t("provider_auth.device_expires_in")} ${oauthRemainingLabel()}`
                            : t("provider_auth.device_expired")}
                        </div>
                      </Show>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          <div class="px-6 pt-4 pb-6 border-t border-dls-border/50 flex flex-col gap-3">
            <div class="min-h-[16px] text-caption text-dls-secondary">
              <Show when={props.submitting}>{submittingLabel()}</Show>
            </div>
            <Button variant="ghost" onClick={handleClose} disabled={actionDisabled()}>
              {t("common.close")}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
