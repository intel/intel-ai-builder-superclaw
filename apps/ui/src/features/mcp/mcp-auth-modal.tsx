import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { CheckCircle2, Loader2, RefreshCcw, X } from "lucide-solid";
import Button from "~/shared/ui/button";
import { recordMcpDiagnostic } from "./mcp-diagnostics";
import { startMcpOauthListener, stopMcpOauthListener } from "~/shared/platform/tauri";
import { mcpServerKey } from "./mcp";
import {
  MCP_AUTH_DISCOVERY_POLL_INTERVAL_MS,
  MCP_AUTH_DISCOVERY_TIMEOUT_MS,
  MCP_AUTH_STATUS_POLL_INTERVAL_MS,
  MCP_AUTH_STATUS_TIMEOUT_MS,
  MCP_OAUTH_CALLBACK_TIMEOUT_SECONDS,
} from "~/shared/platform/mcp-timing";
import { t } from "../../i18n";
import { isTauriRuntime } from "~/shared/platform/runtime-env";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { MCP_OAUTH_CALLBACK_EVENT, MCP_OAUTH_CALLBACK_PATH, MCP_OAUTH_CALLBACK_PORT } from "./mcp-auth-modal.oauth-callback";
import type { McpAuthModalProps } from "./mcp-auth-modal.types";

// Re-exported from the extracted helpers so this module's public surface is unchanged.
export type { McpAuthModalProps } from "./mcp-auth-modal.types";

export default function McpAuthModal(props: McpAuthModalProps) {
  const translate = (key: string, replacements?: Record<string, string>) => {
    let result = t(key, props.language);
    if (replacements) {
      Object.entries(replacements).forEach(([placeholder, value]) => {
        result = result.replace(`{${placeholder}}`, value);
      });
    }
    return result;
  };

  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [needsReload, setNeedsReload] = createSignal(false);
  const [alreadyConnected, setAlreadyConnected] = createSignal(false);
  const [authInProgress, setAuthInProgress] = createSignal(false);
  const [statusChecking, setStatusChecking] = createSignal(false);
  const [reloadNotice, setReloadNotice] = createSignal<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = createSignal<string | null>(null);
  const [cliAuthBusy, setCliAuthBusy] = createSignal(false);
  const [awaitingReload, setAwaitingReload] = createSignal(false);
  const [reloadStarting, setReloadStarting] = createSignal(false);
  const [reloadSatisfied, setReloadSatisfied] = createSignal(false);
  const [forceStopBusySessionID, setForceStopBusySessionID] = createSignal<string | null>(null);

  let statusPoll: number | null = null;
  let oauthCaptureUnlisten: UnlistenFn | null = null;

  const stopStatusPolling = () => {
    if (statusPoll !== null) {
      window.clearInterval(statusPoll);
      statusPoll = null;
    }
  };

  const stopOauthCapture = () => {
    if (oauthCaptureUnlisten) {
      oauthCaptureUnlisten();
      oauthCaptureUnlisten = null;
    }
    if (isTauriRuntime()) {
      void stopMcpOauthListener();
    }
  };

  onCleanup(() => stopStatusPolling());
  onCleanup(() => stopOauthCapture());

  const openAuthorizationUrl = async (url: string) => {
    let host = "unknown";
    try {
      host = new URL(url).host || "unknown";
    } catch {
      host = "invalid-url";
    }
    await recordMcpDiagnostic({
      operation: "authorize",
      step: "open-url",
      source: "desktop-ui",
      target: "external-browser",
      mcp: props.entry?.name,
      host,
    }).catch(() => undefined);
    if (isTauriRuntime()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    }

    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const fetchMcpStatus = async (slug: string) => {
    const entry = props.entry;
    if (!entry) return null;

    try {
      return await props.getStatus(slug);
    } catch {
      return null;
    }
  };

  const waitForMcpAvailability = async (slug: string) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < MCP_AUTH_DISCOVERY_TIMEOUT_MS) {
      const status = await fetchMcpStatus(slug);
      if (status) return status;
      await new Promise((resolve) => window.setTimeout(resolve, MCP_AUTH_DISCOVERY_POLL_INTERVAL_MS));
    }
    return null;
  };

  const startStatusPolling = (slug: string) => {
    if (typeof window === "undefined") return;
    stopStatusPolling();
    const startedAt = Date.now();
    statusPoll = window.setInterval(async () => {
      if (Date.now() - startedAt >= MCP_AUTH_STATUS_TIMEOUT_MS) {
        stopStatusPolling();
        setError("Request timed out.");
        void recordMcpDiagnostic({
          operation: "authorize",
          step: "status",
          source: "opencode",
          mcp: slug,
          status: "timeout",
        });
        return;
      }

      const status = await fetchMcpStatus(slug);
      if (status?.status === "connected") {
        setAlreadyConnected(true);
        setError(null);
        stopStatusPolling();
        void recordMcpDiagnostic({
          operation: "authorize",
          step: "status",
          source: "opencode",
          mcp: slug,
          status: "connected",
        });
      }
    }, MCP_AUTH_STATUS_POLL_INTERVAL_MS);
  };

  const startAuth = async (forceRetry = false, allowAutoReload = true) => {
    const entry = props.entry;
    if (!entry) return;

    let slug = "";
    try {
      slug = mcpServerKey(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");
      setError(message);
      setLoading(false);
      setAuthInProgress(false);
      return;
    }

    if (!forceRetry && authInProgress()) {
      return;
    }

    setError(null);
    setNeedsReload(false);
    setAlreadyConnected(false);
    stopStatusPolling();
    setAuthorizationUrl(null);
    setReloadNotice(null);
    setLoading(true);
    setAuthInProgress(true);
    await recordMcpDiagnostic({
      operation: "authorize",
      step: "launch",
      source: "desktop-ui",
      mcp: slug,
    });

    try {
      const statusEntry = await fetchMcpStatus(slug);
      if (props.reloadRequired && !reloadSatisfied() && !statusEntry) {
        setNeedsReload(true);
        setReloadNotice(
          props.reloadBlocked
            ? translate("mcp.auth.reload_blocked")
            : translate("mcp.auth.reload_notice")
        );
        return;
      }

      if (statusEntry?.status === "connected") {
        setAlreadyConnected(true);
        await recordMcpDiagnostic({
          operation: "authorize",
          step: "status",
          source: "opencode",
          mcp: slug,
          status: "connected",
        });
        return;
      }

      await startOauthCapture();

      const authStartedAt = performance.now();
      let authResult;
      try {
        authResult = await props.startAuth(slug);
        await recordMcpDiagnostic({
          operation: "authorize",
          step: "start",
          source: "desktop-ui",
          target: "opencode",
          mcp: slug,
          result: "success",
          durationMs: Math.round(performance.now() - authStartedAt),
        });
      } catch (error) {
        await recordMcpDiagnostic({
          operation: "authorize",
          step: "start",
          source: "desktop-ui",
          target: "opencode",
          mcp: slug,
          result: "failed",
          durationMs: Math.round(performance.now() - authStartedAt),
          error,
        });
        throw error;
      }
      const auth = authResult;

      if (!auth.authorizationUrl) {
        stopOauthCapture();
        setAlreadyConnected(true);
        await recordMcpDiagnostic({
          operation: "authorize",
          step: "status",
          source: "opencode",
          mcp: slug,
          status: "connected",
        });
        return;
      }

      setAuthorizationUrl(auth.authorizationUrl);
      await openAuthorizationUrl(auth.authorizationUrl);
      startStatusPolling(slug);
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");

      if (message.toLowerCase().includes("does not support oauth")) {
        const canAutoReload =
          allowAutoReload && !props.isRemoteWorkspace && !props.reloadBlocked && Boolean(props.onReloadEngine);

        if (canAutoReload && props.onReloadEngine) {
          await recordMcpDiagnostic({
            operation: "authorize",
            step: "reload",
            source: "desktop-ui",
            target: "opencode",
            mcp: slug,
            reason: "oauth-not-supported",
          });
          await props.onReloadEngine();
          await startAuth(true, false);
          return;
        }

        if (props.reloadRequired && !reloadSatisfied()) {
          setReloadNotice(
            props.reloadBlocked
              ? translate("mcp.auth.reload_blocked")
              : translate("mcp.auth.reload_notice")
          );
        } else {
          setError(
            `${message}\n\n` + translate("mcp.auth.oauth_not_supported_hint", { server: slug })
          );
        }
        setNeedsReload(true);
      } else if (message.toLowerCase().includes("not found") || message.toLowerCase().includes("unknown")) {
        setNeedsReload(true);
        setError(translate("mcp.auth.try_reload_engine", { message }));
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
      setAuthInProgress(false);
    }
  };

  const isInvalidRefreshToken = () => {
    const message = error();
    if (!message) return false;
    const normalized = message.toLowerCase();
    return (
      normalized.includes("invalidgranterror") ||
      normalized.includes("invalid refresh token") ||
      normalized.includes("invalid_refresh_token")
    );
  };

  const handleCliReauth = async () => {
    const entry = props.entry;
    if (!entry || cliAuthBusy()) return;

    setCliAuthBusy(true);
    try {
      await startAuth(true);
    } finally {
      setCliAuthBusy(false);
    }
  };

  // Start the OAuth flow when modal opens with an entry
  createEffect(
    on(
      () => [props.open, props.entry, props.reloadRequired] as const,
      ([isOpen, entry, reloadRequired], previous) => {
        if (!isOpen || !entry) {
          return;
        }
        const previousEntry = previous?.[1];
        if (!previous || previousEntry?.name !== entry.name || !previous?.[0]) {
          setReloadSatisfied(false);
        }
        if (reloadRequired && !reloadSatisfied()) {
          setAwaitingReload(true);
          return;
        }
        // Only start auth on initial open, not on every prop change
        startAuth(false);
      },
      { defer: true } // Defer to avoid double-firing on mount
    )
  );

  createEffect(() => {
    if (!props.open || !awaitingReload()) return;
    if (props.reloadBlocked) return;
    const reloadEngine = props.onReloadEngine;
    const entry = props.entry;
    if (!reloadEngine || !entry || reloadStarting()) return;

    void (async () => {
      setReloadStarting(true);
      setError(null);
      setNeedsReload(false);
      setReloadNotice(null);
      try {
        const slug = mcpServerKey(entry);
        await recordMcpDiagnostic({
          operation: "authorize",
          step: "reload",
          source: "desktop-ui",
          target: "opencode",
          mcp: slug,
          reason: "registration-missing",
        });
        await reloadEngine();
        if (!props.open) return;
        const status = await waitForMcpAvailability(slug);
        if (!status) {
          setAwaitingReload(false);
          setNeedsReload(true);
          setReloadNotice(
            props.reloadBlocked
              ? translate("mcp.auth.reload_blocked")
              : translate("mcp.auth.reload_notice")
          );
          return;
        }
        setReloadSatisfied(true);
        setAwaitingReload(false);
        startAuth(false, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : translate("mcp.auth.reload_failed");
        setAwaitingReload(false);
        setNeedsReload(true);
        setError(message);
      } finally {
        setReloadStarting(false);
      }
    })();
  });

  const handleRetry = () => {
    startAuth(true);
  };

  const handleReopenBrowser = () => {
    handleRetry();
  };

  const handleReloadAndRetry = async () => {
    if (!props.onReloadEngine) return;
    if (props.isRemoteWorkspace && typeof window !== "undefined") {
      const proceed = window.confirm(translate("mcp.auth.reload_remote_confirm"));
      if (!proceed) return;
    }
    await recordMcpDiagnostic({
      operation: "authorize",
      step: "reload",
      source: "desktop-ui",
      target: "opencode",
      mcp: props.entry?.name,
      reason: "manual-retry",
    });
    await props.onReloadEngine();
    startAuth(true);
  };

  const handleForceStopSession = async (sessionID: string) => {
    if (!props.onForceStopSession || forceStopBusySessionID()) return;
    setForceStopBusySessionID(sessionID);
    try {
      await props.onForceStopSession(sessionID);
    } finally {
      setForceStopBusySessionID(null);
    }
  };

  const handleClose = () => {
    setError(null);
    setLoading(false);
    setAlreadyConnected(false);
    setNeedsReload(false);
    setAuthInProgress(false);
    setStatusChecking(false);
    setAuthorizationUrl(null);
    setReloadNotice(null);
    setCliAuthBusy(false);
    setAwaitingReload(false);
    setReloadStarting(false);
    setReloadSatisfied(false);
    setForceStopBusySessionID(null);
    stopStatusPolling();
    stopOauthCapture();
    props.onClose();
  };

  const isBusy = () => loading() || statusChecking();
  const isPreparingReload = () => awaitingReload() || reloadStarting();

  const parseAuthCode = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const match = trimmed.match(/[?&]code=([^&]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }

    if (/^https?:\/\//i.test(trimmed) || trimmed.includes("localhost") || trimmed.includes("127.0.0.1")) {
      return null;
    }

    return trimmed;
  };

  const pollForConnected = async (slug: string, timeoutMs = 15_000): Promise<boolean> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const status = await fetchMcpStatus(slug);
      if (status?.status === "connected") {
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    const final = await fetchMcpStatus(slug);
    return final?.status === "connected";
  };

  const submitAuthCallback = async (rawValue: string) => {
    const entry = props.entry;
    if (!entry) return;

    let slug = "";
    try {
      slug = mcpServerKey(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");
      setError(message);
      return;
    }

    const code = parseAuthCode(rawValue);
    if (!code) {
      setError(translate("mcp.auth.callback_invalid"));
      return;
    }

    setError(null);
    stopStatusPolling();
    stopOauthCapture();

    const succeed = async () => {
      setError(null);
      setAlreadyConnected(true);
      await recordMcpDiagnostic({
        operation: "authorize",
        step: "status",
        source: "opencode",
        mcp: slug,
        status: "connected",
      });
      await props.onComplete();
    };

    try {
      let pendingError: string | null = null;
      let verifyConnection = false;
      const callbackStartedAt = performance.now();
      try {
        await props.completeAuth(slug, code);
        await recordMcpDiagnostic({
          operation: "authorize",
          step: "callback",
          source: "desktop-ui",
          target: "instance-runtime",
          mcp: slug,
          status: "accepted",
          durationMs: Math.round(performance.now() - callbackStartedAt),
        });
        pendingError = translate("mcp.auth.authorization_still_required");
        verifyConnection = true;
      } catch (err) {
        pendingError = err instanceof Error ? err.message : translate("mcp.auth.oauth_failed");
        verifyConnection = true;
        await recordMcpDiagnostic({
          operation: "authorize",
          step: "callback",
          source: "desktop-ui",
          target: "opencode",
          mcp: slug,
          result: "failed",
          durationMs: Math.round(performance.now() - callbackStartedAt),
          error: pendingError,
        });
      }

      // The token exchange can succeed even when the immediate post-auth
      // connect attempt errors or times out (e.g. a transient SSE/stream error
      // while the connection is still settling). Confirm the real connection
      // state before surfacing a misleading failure.
      if (verifyConnection && (await pollForConnected(slug))) {
        await succeed();
        return;
      }

      setError(pendingError);
      await recordMcpDiagnostic({
        operation: "authorize",
        step: "status",
        source: "opencode",
        mcp: slug,
        status: "failed",
        error: pendingError,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.oauth_failed");
      setError(message);
    }
  };

  const startOauthCapture = async () => {
    if (!isTauriRuntime()) return;
    stopOauthCapture();
    const startedAt = performance.now();
    try {
      oauthCaptureUnlisten = await listen<string>(MCP_OAUTH_CALLBACK_EVENT, (event) => {
        stopOauthCapture();
        void submitAuthCallback(event.payload);
      });
      await startMcpOauthListener({
        port: MCP_OAUTH_CALLBACK_PORT,
        callbackPath: MCP_OAUTH_CALLBACK_PATH,
        timeoutSecs: MCP_OAUTH_CALLBACK_TIMEOUT_SECONDS,
      });
      await recordMcpDiagnostic({
        operation: "authorize",
        step: "listener",
        source: "desktop-ui",
        target: "oauth-listener",
        mcp: props.entry?.name,
        result: "success",
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      await recordMcpDiagnostic({
        operation: "authorize",
        step: "listener",
        source: "desktop-ui",
        target: "oauth-listener",
        mcp: props.entry?.name,
        result: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        error,
      });
      stopOauthCapture();
      setError("Could not start OAuth listener (port 19876 may be in use). Try again.");
    }
  };

  const handleComplete = async () => {
    const entry = props.entry;
    if (!entry) return;

    setError(null);
    setStatusChecking(true);

    let slug = "";
    try {
      slug = mcpServerKey(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");
      setError(message);
      setStatusChecking(false);
      return;
    }

    const statusEntry = await fetchMcpStatus(slug);
    if (statusEntry?.status === "connected") {
      setAlreadyConnected(true);
      setStatusChecking(false);
      await props.onComplete();
      return;
    }

    if (statusEntry?.status === "needs_client_registration") {
      setError(statusEntry.error ?? translate("mcp.auth.client_registration_required"));
    } else if (statusEntry?.status === "disabled") {
      setError(translate("mcp.auth.server_disabled"));
    } else if (statusEntry?.status === "failed") {
      setError(statusEntry.error ?? translate("mcp.auth.oauth_failed"));
    } else {
      setError(translate("mcp.auth.authorization_still_required"));
    }

    setStatusChecking(false);
  };

  const serverName = () => props.entry?.name ?? "MCP Server";

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Backdrop */}
        <div
          class="absolute inset-0 dls-modal-backdrop"
          onClick={handleClose}
        />

        {/* Modal */}
        <div class="relative w-full max-w-lg bg-dls-surface-raised border border-dls-border-strong rounded-card shadow-2xl overflow-hidden">
          {/* Header */}
          <div class="flex items-center justify-between px-6 py-4 border-b border-dls-border-strong">
            <div>
              <h2 class="text-heading font-semibold text-dls-text">
                  {translate("mcp.auth.connect_server", { server: serverName() })}
              </h2>
              <p class="text-body-lg text-dls-secondary">{translate("mcp.auth.open_browser_signin")}</p>
            </div>
            <button
              type="button"
              class="p-2 text-dls-secondary hover:text-dls-text hover:bg-dls-surface-muted rounded-control transition-colors"
              onClick={handleClose}
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div class="px-6 py-5 space-y-5">
            <Show when={isBusy()}>
              <div class="rounded-inset border border-dls-border-strong bg-dls-panel-inset-bg px-5 py-6 text-center space-y-4">
                <div class="flex items-center justify-center">
                  <Loader2 size={32} class="animate-spin text-dls-secondary" />
                </div>
                <div class="space-y-2">
                  <p class="text-body-lg font-medium text-dls-text">
                    {translate("mcp.auth.waiting_authorization")}
                  </p>
                  <p class="text-caption text-dls-secondary">
                    {translate("mcp.auth.follow_browser_steps")}
                  </p>
                  <button
                    type="button"
                    class="text-caption text-dls-secondary underline underline-offset-2 hover:text-dls-secondary transition-colors"
                    onClick={handleReopenBrowser}
                  >
                    {translate("mcp.auth.reopen_browser_link")}
                  </button>
                </div>
              </div>
            </Show>

            <Show when={!isBusy() && isPreparingReload()}>
              <div class="rounded-inset border border-dls-warning-border bg-dls-warning-bg px-5 py-6 text-center space-y-4">
                <div class="flex items-center justify-center">
                  <Loader2 size={32} class="animate-spin text-dls-warning-text" />
                </div>
                <div class="space-y-2">
                  <p class="text-body-lg font-medium text-dls-text">
                    {props.reloadBlocked
                      ? translate("mcp.auth.waiting_for_conversation_title")
                      : translate("mcp.auth.applying_changes_title")}
                  </p>
                  <p class="text-caption text-dls-secondary">
                    {props.reloadBlocked
                      ? translate("mcp.auth.waiting_for_conversation_body")
                      : translate("mcp.auth.applying_changes_body")}
                  </p>
                </div>
                <Show when={props.reloadBlocked && (props.activeSessions?.length ?? 0) > 0}>
                  <div class="space-y-2 text-left">
                    <For each={props.activeSessions ?? []}>
                      {(session) => (
                        <div class="flex items-center justify-between gap-3 rounded-control border border-dls-warning-border bg-dls-warning-bg px-3 py-2">
                          <span class="text-caption text-dls-secondary">
                            {translate("mcp.auth.waiting_for_session", { session: session.title })}
                          </span>
                          <button
                            type="button"
                            class="text-caption text-dls-warning-text underline underline-offset-2 hover:text-dls-warning-text transition-colors disabled:no-underline disabled:opacity-60"
                            onClick={() => handleForceStopSession(session.id)}
                            disabled={forceStopBusySessionID() === session.id}
                          >
                            {forceStopBusySessionID() === session.id
                              ? translate("mcp.auth.force_stopping")
                              : translate("mcp.auth.force_stop")}
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={!isBusy() && alreadyConnected()}>
              <div class="bg-dls-success-bg border border-dls-success-border rounded-inset p-5 space-y-4">
                <div class="flex items-center gap-3">
                  <div class="flex-shrink-0 w-10 h-10 rounded-pill bg-dls-success-bg flex items-center justify-center">
                    <CheckCircle2 size={24} class="text-dls-success-text" />
                  </div>
                  <div>
                    <p class="text-body-lg font-medium text-dls-text">Already Connected</p>
                    <p class="text-caption text-dls-secondary">
                        {translate("mcp.auth.already_connected_description", { server: serverName() })}
                    </p>
                  </div>
                </div>
                <p class="text-caption text-dls-secondary">
                    {translate("mcp.auth.configured_previously")}
                </p>
              </div>
            </Show>

            <Show when={reloadNotice()}>
              <div class="bg-dls-panel-inset-bg border border-dls-border-strong rounded-inset p-4 space-y-3">
                <p class="text-body-lg text-dls-secondary">{reloadNotice()}</p>

                <div class="flex flex-wrap gap-2 pt-1">
                  <Show when={props.onReloadEngine}>
                    <Button
                      variant="secondary"
                      onClick={handleReloadAndRetry}
                      disabled={props.reloadBlocked}
                      title={props.reloadBlocked ? translate("mcp.reload_banner_blocked_hint") : undefined}
                    >
                      <RefreshCcw size={14} />
                      {translate("mcp.auth.reload_engine_retry")}
                    </Button>
                  </Show>
                  <Button variant="ghost" onClick={handleRetry}>
                    {translate("mcp.auth.retry_now")}
                  </Button>
                </div>
              </div>
            </Show>

            <Show when={error()}>
              <div class="bg-dls-danger-bg border border-dls-danger-border rounded-inset p-4 space-y-3">
                <p class="text-body-lg text-dls-danger-text">{error()}</p>
                
                <Show when={needsReload()}>
                  <div class="flex flex-wrap gap-2 pt-2">
                    <Show when={props.onReloadEngine}>
                      <Button
                        variant="secondary"
                        onClick={handleReloadAndRetry}
                        disabled={props.reloadBlocked}
                        title={props.reloadBlocked ? translate("mcp.reload_banner_blocked_hint") : undefined}
                      >
                        <RefreshCcw size={14} />
                        {translate("mcp.auth.reload_engine_retry")}
                      </Button>
                    </Show>
                    <Button variant="ghost" onClick={handleRetry}>
                      {translate("mcp.auth.retry_now")}
                    </Button>
                  </div>
                </Show>

                <Show when={!needsReload()}>
                  <div class="pt-2">
                    <Button variant="ghost" onClick={handleRetry}>
                      {translate("mcp.auth.retry")}
                    </Button>
                  </div>
                </Show>

                <Show when={isInvalidRefreshToken()}>
                  <div class="pt-2 space-y-2">
                    <p class="text-caption text-dls-danger-text">{translate("mcp.auth.invalid_refresh_token")}</p>
                    <Show when={!props.isRemoteWorkspace}>
                      <Show when={isTauriRuntime()}>
                        <Button variant="secondary" onClick={handleCliReauth} disabled={cliAuthBusy()}>
                          <Show
                            when={cliAuthBusy()}
                            fallback={translate("mcp.auth.reauth_action")}
                          >
                            <Loader2 size={14} class="animate-spin" />
                            {translate("mcp.auth.reauth_running")}
                          </Show>
                        </Button>
                      </Show>
                      <Show when={!isTauriRuntime()}>
                        <div class="text-label text-dls-danger-text">
                          {translate("mcp.auth.reauth_cli_hint", { server: serverName() })}
                        </div>
                      </Show>
                    </Show>
                    <Show when={props.isRemoteWorkspace}>
                      <div class="text-label text-dls-danger-text">
                        {translate("mcp.auth.reauth_remote_hint")}
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={!isBusy() && !isPreparingReload() && !error() && !reloadNotice() && !alreadyConnected()}>
              <div class="space-y-4">
                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-pill bg-dls-surface-muted flex items-center justify-center text-caption font-medium text-dls-secondary">
                    1
                  </div>
                  <div>
                    <p class="text-body-lg font-medium text-dls-text">Opening your browser</p>
                    <p class="text-caption text-dls-secondary mt-1">
                        {translate("mcp.auth.step1_description", { server: serverName() })}
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-pill bg-dls-surface-muted flex items-center justify-center text-caption font-medium text-dls-secondary">
                    2
                  </div>
                  <div>
                    <p class="text-body-lg font-medium text-dls-text">Authorize access</p>
                    <p class="text-caption text-dls-secondary mt-1">
                        {translate("mcp.auth.step2_description")}
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-pill bg-dls-surface-muted flex items-center justify-center text-caption font-medium text-dls-secondary">
                    3
                  </div>
                  <div>
                    <p class="text-body-lg font-medium text-dls-text">Return here when you're done</p>
                    <p class="text-caption text-dls-secondary mt-1">
                        {translate("mcp.auth.step3_description")}
                    </p>
                  </div>
                </div>
              </div>

              <div class="rounded-inset border border-dls-border-strong bg-dls-panel-inset-bg p-4 text-body-lg text-dls-secondary">
                <div class="space-y-3">
                  <p>{translate("mcp.auth.waiting_authorization")}</p>
                  <p class="text-caption text-dls-secondary">
                    {translate("mcp.auth.follow_browser_steps")}
                  </p>
                  <button
                    type="button"
                    class="text-caption text-dls-secondary underline underline-offset-2 hover:text-dls-secondary transition-colors text-left"
                    onClick={handleReopenBrowser}
                  >
                    {translate("mcp.auth.reopen_browser_link")}
                  </button>
                </div>
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-dls-border-strong bg-dls-surface-raised">
            <Show when={alreadyConnected()}>
              <Button variant="primary" onClick={handleComplete}>
                <CheckCircle2 size={16} />
                {translate("mcp.auth.done")}
              </Button>
            </Show>
            <Show when={!alreadyConnected()}>
              <Button variant="ghost" onClick={handleClose}>
                {translate("mcp.auth.cancel")}
              </Button>
              <Button variant="secondary" onClick={handleComplete}>
                <CheckCircle2 size={16} />
                {translate("mcp.auth.im_done")}
              </Button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
