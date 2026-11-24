import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { ExternalLink, Github } from "lucide-solid";
import Button from "./button";
import ConfirmModal from "~/shared/ui/confirm-modal";
import GithubDeviceLoginModal from "./github-device-login-modal";
import { PROVIDER_CARD_CLASS } from "./provider-connection-card";
import { t } from "../../i18n";
import {
  createOpenworkServerClient,
  readOpenworkServerSettings,
} from "../lib/openwork-server";
import type { OpenworkGithubStatus } from "../lib/openwork-server";
import { openUrl } from "../pages/settings.platform-actions";

const TOKEN_SCOPES_URL =
  "https://github.com/settings/tokens/new?scopes=repo,read:org,read:project&description=SuperClaw";

/** Cadence for the device-flow poll, matched to the sandbox's own 5s floor for
 * polling GitHub. Going faster cannot surface a change any sooner and each read
 * spawns a `gh` subprocess. */
const DEVICE_POLL_MS = 5_000;

export type GithubConnectionCardProps = {
  /** OpenWork server base URL. Empty while the backend is still starting. */
  baseUrl: string;
  /** Active workspace id. Empty until a workspace is activated. */
  workspaceId: string;
};

/**
 * Connections card for the GitHub account the sandbox `gh` CLI acts
 * as. Two ways in: approve a device code in the browser, which hands off to
 * `GithubDeviceLoginModal` (the same dialog shape as connecting GitHub Copilot),
 * or paste a personal access token. Either way the token is stored by `gh`
 * inside the sandbox and is never sent back here — this card only ever displays
 * a login name and scopes.
 */
export default function GithubConnectionCard(props: GithubConnectionCardProps): JSX.Element {
  const [status, setStatus] = createSignal<OpenworkGithubStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);
  const [tokenInput, setTokenInput] = createSignal("");
  const [deviceError, setDeviceError] = createSignal<string | null>(null);
  const [awaitingBrowserLogin, setAwaitingBrowserLogin] = createSignal(false);
  const [confirmingClear, setConfirmingClear] = createSignal(false);

  const unavailable = createMemo(() => !props.baseUrl.trim() || !props.workspaceId.trim());

  const client = () => {
    const settings = readOpenworkServerSettings();
    return createOpenworkServerClient({
      baseUrl: props.baseUrl.trim(),
      token: settings.token,
      hostToken: settings.hostToken,
    });
  };

  const describeError = (error: unknown, fallbackKey: string) =>
    error instanceof Error && error.message ? error.message : t(fallbackKey);

  // Bumped by every action that changes what the user is waiting on, so a status
  // read issued before a Cancel cannot land after it and reinstate the dismissed
  // flow.
  let generation = 0;

  // A status read spawns a `gh` subprocess and can outlast the poll interval;
  // skipping a tick while one is in flight stops slow reads from stacking.
  let refreshInFlight = false;

  const refresh = async () => {
    if (unavailable() || refreshInFlight) return;
    const mine = generation;
    refreshInFlight = true;
    try {
      const next = await client().getGithubStatus(props.workspaceId.trim());
      if (mine === generation) setStatus(next);
    } catch {
      // Status is advisory: a backend still coming up should not raise an error
      // banner on a settings tab the user may only be passing through.
    } finally {
      refreshInFlight = false;
    }
  };

  createEffect(() => {
    if (unavailable()) return;
    void refresh();
  });

  const awaitingDevice = createMemo(() => status()?.deviceFlow.status === "awaiting_authorization");
  const scopes = createMemo(() => status()?.scopes ?? []);

  // Poll only while a device login is outstanding, so an idle tab is not talking
  // to the backend on a timer. Armed on `awaitingBrowserLogin` too, not just the
  // flow status: if the status read in startDeviceLogin() fails, nothing else
  // would ever reveal the pending flow. All three exits clear it, so this stops.
  createEffect(() => {
    if (!awaitingDevice() && !awaitingBrowserLogin()) return;
    const id = setInterval(() => void refresh(), DEVICE_POLL_MS);
    onCleanup(() => clearInterval(id));
  });

  // Take a failed sign-in off the server and hold it locally: the sandbox keeps a
  // failed flow until something replaces it, so left there it replays on every
  // later status read. The DELETE is not addressed to a specific flow, so `busy`
  // is held for the round trip to keep a new sign-in from starting into it.
  createEffect(() => {
    const failure = status()?.deviceFlow.error;
    if (!failure) return;
    setDeviceError(failure.message);
    setAwaitingBrowserLogin(false);
    setBusy(true);
    void (async () => {
      try {
        await client().cancelGithubDeviceLogin(props.workspaceId.trim());
        await refresh();
      } catch {
        // Acknowledging is best-effort: the message is already on screen, and a
        // backend that cannot be reached will not be replaying anything either.
      } finally {
        setBusy(false);
      }
    })();
  });

  // The browser path lands asynchronously — the poll notices the account only
  // after the sandbox has stored the token — so it needs its own confirmation.
  // Gated on a login this card actually started, or every visit to a connected
  // tab would re-announce it.
  createEffect(() => {
    if (!awaitingBrowserLogin() || !status()?.authenticated) return;
    setAwaitingBrowserLogin(false);
    setMessage(t("settings.github_connected_toast"));
  });

  const submitToken = async () => {
    const value = tokenInput().trim();
    if (!value) return;
    generation += 1;
    setBusy(true);
    setMessage(null);
    setDeviceError(null);
    try {
      setStatus(await client().setGithubToken(props.workspaceId.trim(), value));
      setTokenInput("");
      setMessage(t("settings.github_connected_toast"));
    } catch (error) {
      setMessage(describeError(error, "settings.github_token_failed"));
    } finally {
      setBusy(false);
    }
  };

  const startDeviceLogin = async () => {
    generation += 1;
    setBusy(true);
    setMessage(null);
    setDeviceError(null);
    try {
      const { deviceFlow } = await client().startGithubDeviceLogin(props.workspaceId.trim());
      setAwaitingBrowserLogin(true);
      // refresh() is what opens the modal, by picking up the now-pending flow.
      await refresh();
      // Its own catch: the code is already live and the modal shows it with a
      // manual open, so a refused open must not report "could not start sign-in".
      if (deviceFlow.verificationUri) {
        try {
          await openUrl(deviceFlow.verificationUri);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[ui] github device auto-open failed, modal still has the URL: ${detail}`);
        }
      }
    } catch (error) {
      setMessage(describeError(error, "settings.github_device_failed"));
    } finally {
      setBusy(false);
    }
  };

  const cancelDeviceLogin = async () => {
    generation += 1;
    setBusy(true);
    setAwaitingBrowserLogin(false);
    try {
      await client().cancelGithubDeviceLogin(props.workspaceId.trim());
      await refresh();
      setMessage(null);
    } catch (error) {
      setMessage(describeError(error, "settings.github_device_failed"));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    generation += 1;
    setBusy(true);
    setMessage(null);
    setDeviceError(null);
    try {
      setStatus(await client().disconnectGithub(props.workspaceId.trim()));
      setMessage(t("settings.github_disconnected_toast"));
    } catch (error) {
      setMessage(describeError(error, "settings.github_disconnect_failed"));
    } finally {
      setBusy(false);
    }
  };

  const disabled = createMemo(() => unavailable() || busy());

  // Withheld until the first status read lands, as the Gmail block does: a
  // backend that is still booting is not an account that is not connected.
  const statusPill = () => (
    <Show when={status()}>
      {(current) => (
        <div
          data-testid="github-connection-status"
          class={`inline-flex items-center gap-2 rounded-pill border px-2.5 py-1 text-label font-medium shrink-0 ${
            current().authenticated
              ? "bg-dls-success-bg text-dls-success-text border-dls-success-border"
              : "bg-dls-panel-badge-bg text-dls-panel-icon border-dls-panel-badge-border"
          }`}
        >
          <span class={`h-2 w-2 rounded-pill ${current().authenticated ? "bg-dls-success-dot" : "bg-dls-panel-dot"}`} />
          {current().authenticated
            ? t("settings.github_connected")
            : t("settings.github_not_connected")}
        </div>
      )}
    </Show>
  );

  return (
    <div class={PROVIDER_CARD_CLASS}>
      <div>
        <div class="flex items-center gap-2">
          <Github size={16} class="text-dls-panel-icon" />
          <div class="text-body-lg font-medium text-dls-panel-text">{t("settings.github_title")}</div>
        </div>
        <div class="text-caption text-dls-secondary mt-1">{t("settings.github_subtitle")}</div>
      </div>

      {/* `=== false` / `!== false`, not truthiness: an unread status (null) shows
          the normal controls rather than accusing the image of being stale. */}
      <Show when={status()?.installed === false}>
        <div
          class="rounded-inset border border-dls-warning-border bg-dls-warning-bg p-3 text-caption text-dls-warning-text"
          data-testid="github-unavailable"
        >
          {status()?.unavailableReason || t("settings.github_cli_missing")}
        </div>
      </Show>

      {/* A sign-in an older build left in the legacy store, which an upgrade keeps.
          Removing it stores nothing, so it stays possible while GitHub sign-in is
          unavailable. Offered only while signed out, because a sign-out removes the
          current sign-in too; a sign-in with this build removes the legacy one itself. */}
      <Show when={status()?.legacyCredential && !status()?.authenticated}>
        <Button
          variant="outline"
          class="text-caption h-9 px-3"
          data-testid="github-remove-legacy"
          onClick={() => void disconnect()}
          disabled={disabled()}
        >
          {t("settings.github_remove_legacy")}
        </Button>
      </Show>

      <Show when={status()?.paused}>
        <div class="rounded-inset border border-dls-panel-inset-border bg-dls-panel-inset-bg p-4 flex items-start justify-between gap-3" data-testid="github-paused">
          <div class="text-caption text-dls-secondary">{t("connections.github_paused_note")}</div>
          <Button
            variant="outline"
            class="text-caption h-9 px-3 shrink-0"
            onClick={() => setConfirmingClear(true)}
            disabled={disabled()}
          >
            {t("settings.clear")}
          </Button>
        </div>
      </Show>

      <Show when={status()?.installed !== false && !status()?.paused}>
        <Show
          when={status()?.authenticated}
          fallback={
            <div class="rounded-inset border border-dls-panel-inset-border bg-dls-panel-inset-bg p-4 space-y-3">
              <div class="flex items-start justify-between gap-3">
                <div class="text-caption text-dls-secondary">{t("settings.github_device_help")}</div>
                {statusPill()}
              </div>
              <Show when={deviceError()}>
                {(text) => (
                  <div class="rounded-control border border-dls-danger-border bg-dls-danger-bg p-2.5 text-caption text-dls-danger-text">
                    {text()}
                  </div>
                )}
              </Show>
              {/* Matches the Gmail block's upload control: the softer panel-inset
                  tokens rather than `outline`, whose full-opacity border reads
                  too heavy in dark mode. */}
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg px-3 py-2 text-caption text-dls-panel-text cursor-pointer transition-colors hover:bg-dls-panel-hover-bg disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => void startDeviceLogin()}
                disabled={disabled()}
              >
                <ExternalLink size={14} class="text-dls-secondary" />
                {t("settings.github_sign_in_browser")}
              </button>

              <div class="pt-1 border-t border-dls-panel-divider space-y-2">
                <div class="text-caption text-dls-secondary">
                  {t("settings.github_token_help")}{" "}
                  <a
                    href={TOKEN_SCOPES_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-dls-accent underline underline-offset-2 hover:opacity-80"
                    onClick={async (event) => {
                      event.preventDefault();
                      await openUrl(TOKEN_SCOPES_URL);
                    }}
                  >
                    {t("settings.github_token_link")}
                  </a>
                  .
                </div>
                <div class="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="password"
                    class="min-w-0 flex-1 rounded-control border border-dls-panel-input-border bg-dls-panel-input-bg px-3 py-2 text-body-lg text-dls-panel-text outline-none focus:border-dls-accent disabled:opacity-60"
                    placeholder={t("settings.github_token_placeholder")}
                    value={tokenInput()}
                    onInput={(event) => setTokenInput((event.target as HTMLInputElement).value)}
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck={false}
                    disabled={disabled()}
                  />
                  <Button
                    variant="secondary"
                    class="text-caption h-9 px-3"
                    onClick={() => void submitToken()}
                    disabled={disabled() || !tokenInput().trim()}
                  >
                    {t("settings.github_connect")}
                  </Button>
                </div>
              </div>
            </div>
          }
        >
          {/* Same anatomy as the configured Tavily panel: identity left, state
              pill top-right, Clear below it. The scopes line is conditional
              because a fine-grained PAT reports no classic scopes, so the login
              has to carry the left column on its own. */}
          <div class="rounded-inset border border-dls-panel-inset-border bg-dls-panel-inset-bg p-4 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <Show when={status()?.login}>
                {(login) => (
                  <div class="text-body-lg font-medium text-dls-panel-text truncate">{login()}</div>
                )}
              </Show>
              <Show when={scopes().length > 0}>
                <div class="text-caption text-dls-secondary mt-1">
                  {t("settings.github_scopes_label")}{" "}
                  <span class="font-mono text-label text-dls-panel-text">{scopes().join(", ")}</span>
                </div>
              </Show>
            </div>
            <div class="flex flex-col items-end gap-2 shrink-0">
              {statusPill()}
              <Button
                variant="outline"
                class="text-caption h-9 px-3"
                data-testid="github-clear"
                onClick={() => setConfirmingClear(true)}
                disabled={disabled()}
              >
                {t("settings.clear")}
              </Button>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={message()}>
        {(text) => <div class="text-caption text-dls-secondary">{text()}</div>}
      </Show>

      <ConfirmModal
        open={confirmingClear()}
        title={t("connections.github_clear_title")}
        message={t("connections.github_clear_message")}
        confirmLabel={t("settings.clear")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        data-testid="github-clear-confirm"
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => {
          setConfirmingClear(false);
          void disconnect();
        }}
      />

      <GithubDeviceLoginModal
        open={awaitingDevice()}
        userCode={status()?.deviceFlow.userCode ?? null}
        verificationUri={status()?.deviceFlow.verificationUri ?? null}
        expiresAt={status()?.deviceFlow.expiresAt ?? null}
        onOpenUrl={(url) => void openUrl(url)}
        onClose={() => void cancelDeviceLogin()}
      />
    </div>
  );
}
