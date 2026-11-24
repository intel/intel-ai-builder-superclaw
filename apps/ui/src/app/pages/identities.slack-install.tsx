import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Link } from "lucide-solid";

import Button from "~/shared/ui/button";
import type { SlackInstallStatus } from "@different-ai/openwork-contracts/sandbox-manager-host-api";
import { t } from "../../i18n";
import { usePlatform } from "../context/platform";
import { applyErrorMessage, classifySlackSaveError, formatRequestError } from "./identities.channel-guards";
import type { ChannelCredentialsClient } from "./identities.types";

const SLACK_APPS_URL = "https://api.slack.com/apps";
const POLL_MS = 2_000;
const CONFIGURATION_TOKEN_PREFIX = "xoxe.xoxp-";
const APP_TOKEN_PREFIX = "xapp-";

/** The app's Socket Mode page, or its Basic Information page when Slack did not name the workspace. */
const socketModeSettingsUrl = (appId: string, teamId: string | undefined): string =>
  teamId
    ? `https://app.slack.com/app-settings/${encodeURIComponent(teamId)}/${encodeURIComponent(appId)}/socket-mode`
    : `${SLACK_APPS_URL}/${encodeURIComponent(appId)}/general`;

/** The pasted text when it looks like the token the field asks for, so the step can go on without a click. */
const pastedToken = (event: ClipboardEvent, prefix: string): string | null => {
  const text = event.clipboardData?.getData("text")?.trim() ?? "";
  return text.startsWith(prefix) ? text : null;
};

type InstallClient = Pick<
  ChannelCredentialsClient,
  "startSlackInstall" | "slackInstallStatus" | "completeSlackInstall" | "cancelSlackInstall"
>;

const INPUT_CLASS =
  "w-full rounded-control bg-dls-panel-input-bg text-dls-panel-text border px-3 py-2 text-body-lg placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.3)] focus:border-[var(--dls-accent)] transition-all";
const INPUT_BORDER = "border-dls-panel-input-border";
const INPUT_INVALID_BORDER = "border-dls-danger-border";

const FAILURE_TEXT = {
  denied: "identities.slack_install_denied",
  expired: "identities.slack_install_expired",
  exchange_failed: "identities.slack_install_exchange_failed",
} as const;

/**
 * Connect Slack (#3787). The host creates SuperClaw's app in the user's workspace from a configuration token, the
 * user approves the install in the browser, and the bot token comes back to the host. The user pastes only the
 * app-level token, which no Slack API creates.
 */
export default function SlackInstallPanel(props: {
  client: InstallClient | null;
  identityId: string | null;
  /** A connection is saved, on or off. */
  connected: boolean;
  /** What to tell the user, and why the bot is not live yet when it is not. */
  onConnected: (notice: string, applyError: string | null) => void;
}) {
  const platform = usePlatform();
  const [status, setStatus] = createSignal<SlackInstallStatus>({ state: "none" });
  const [configurationToken, setConfigurationToken] = createSignal("");
  const [appToken, setAppToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [appTokenInvalid, setAppTokenInvalid] = createSignal(false);
  const [unreachable, setUnreachable] = createSignal(false);
  // Connecting again replaces the app, so the form is offered only once the current connection is removed.
  const showForm = () => !props.connected && (status().state === "none" || status().state === "failed");

  const refresh = async () => {
    const client = props.client;
    if (!client) return;
    const asked = status();
    try {
      const answer = await client.slackInstallStatus();
      // A start, finish or cancel that ran meanwhile set a newer status than this answer.
      if (!busy() && status() === asked) setStatus(answer);
    } catch (err) {
      setError(formatRequestError(err));
    }
  };

  onMount(() => {
    // An install begun before this page was opened carries on where it was.
    void refresh();
    // Both waiting steps can run out on the host, which then deletes the app; polling shows that here.
    const interval = window.setInterval(() => {
      if (busy()) return;
      const state = status().state;
      if (state === "awaiting_authorization" || state === "awaiting_app_token") void refresh();
    }, POLL_MS);
    onCleanup(() => window.clearInterval(interval));
  });

  const run = async (action: (client: InstallClient) => Promise<void>) => {
    const client = props.client;
    if (!client || busy()) return;
    setBusy(true);
    setError(null);
    setAppTokenInvalid(false);
    setUnreachable(false);
    try {
      await action(client);
    } catch (err) {
      // Same placement as the token form this replaces: a refused app token is flagged on its field, an unreachable
      // Slack below the button, anything else as text.
      const failure = classifySlackSaveError(err);
      if (failure.kind === "slack_unreachable") setUnreachable(true);
      else if (failure.kind === "invalid_token" && failure.field === "app") setAppTokenInvalid(true);
      else if (failure.kind === "invalid_token") setError(t("identities.slack_invalid_bot_token"));
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async (client) => {
      const identityId = props.identityId;
      const token = configurationToken().trim();
      if (!identityId || !token) return;
      const started = await client.startSlackInstall(identityId, token);
      setConfigurationToken("");
      setStatus({ state: "awaiting_authorization", ...started });
      await platform.openLink(started.authorize_url);
    });

  const complete = () =>
    run(async (client) => {
      const token = appToken().trim();
      if (!token) return;
      const result = await client.completeSlackInstall({ appToken: token });
      setAppToken("");
      setStatus({ state: "none" });
      props.onConnected(
        result.identity.applied ? t("identities.slack_install_done") : t("identities.saved_pending_apply"),
        result.identity.apply_error ? applyErrorMessage(result.identity.apply_error) : null,
      );
    });

  const cancel = () =>
    run(async (client) => {
      setStatus(await client.cancelSlackInstall());
    });

  return (
    <div data-testid="slack-install" class="space-y-2.5">
      <Show when={showForm()}>
        <Show when={status().failure}>
          {(failure) => <div class="text-label text-dls-danger-text">{t(FAILURE_TEXT[failure()])}</div>}
        </Show>
        <div class="text-label text-dls-secondary">
          {t("identities.slack_install_step_config_token")}{" "}
          <button
            type="button"
            class="font-semibold text-dls-link hover:text-dls-link-hover hover:underline"
            onClick={() => void platform.openLink(SLACK_APPS_URL)}
          >
            {t("identities.slack_install_open_slack")}
          </button>
        </div>
        <input
          data-testid="slack-configuration-token-input"
          class={`${INPUT_CLASS} ${INPUT_BORDER}`}
          placeholder="xoxe.xoxp-..."
          type="password"
          value={configurationToken()}
          onInput={(e) => setConfigurationToken(e.currentTarget.value)}
          onPaste={(e) => {
            const token = pastedToken(e, CONFIGURATION_TOKEN_PREFIX);
            if (!token) return;
            e.preventDefault();
            setConfigurationToken(token);
            void start();
          }}
        />
        <button
          data-testid="slack-connect-button"
          onClick={() => void start()}
          disabled={busy() || !props.client || !props.identityId || !configurationToken().trim()}
          class={`flex items-center gap-2 rounded-control px-4 py-2.5 text-body-lg font-semibold text-white border-none transition-opacity ${busy() || !props.client || !props.identityId || !configurationToken().trim() ? "opacity-50 cursor-not-allowed" : "opacity-100 cursor-pointer hover:opacity-90"}`}
          style={{ background: "var(--dls-provider-slack-brand)" }}
        >
          <Link size={15} />
          {busy() ? t("identities.connecting") : t("identities.connect_slack")}
        </button>
      </Show>

      <Show when={status().state === "awaiting_authorization"}>
        <div data-testid="slack-install-waiting" class="text-label text-dls-secondary">
          {t("identities.slack_install_waiting")}
        </div>
        <div class="flex flex-wrap gap-2">
          <Show when={status().authorize_url}>
            {(url) => (
              <Button variant="outline" class="h-7 px-2.5 text-label" onClick={() => void platform.openLink(url())}>
                {t("identities.slack_install_reopen")}
              </Button>
            )}
          </Show>
          <Button variant="outline" class="h-7 px-2.5 text-label" disabled={busy()} onClick={() => void cancel()}>
            {t("identities.slack_install_cancel")}
          </Button>
        </div>
      </Show>

      <Show when={status().state === "awaiting_app_token"}>
        <div class="text-label text-dls-secondary">
          {t("identities.slack_install_step_app_token")}{" "}
          <Show when={status().app_id}>
            {(appId) => (
              <button
                type="button"
                class="font-semibold text-dls-link hover:text-dls-link-hover hover:underline"
                onClick={() => void platform.openLink(socketModeSettingsUrl(appId(), status().team_id))}
              >
                {t("identities.slack_install_open_app")}
              </button>
            )}
          </Show>
        </div>
        <div>
          <label class="mb-1 block text-caption font-medium text-dls-secondary">{t("identities.app_token")}</label>
          <Show when={appTokenInvalid()}>
            <div data-testid="slack-app-token-error" class="mb-1 text-caption font-semibold text-dls-danger-text">
              {t("identities.slack_invalid_app_token")}
            </div>
          </Show>
          <input
            data-testid="slack-app-token-input"
            class={`${INPUT_CLASS} ${appTokenInvalid() ? INPUT_INVALID_BORDER : INPUT_BORDER}`}
            placeholder="xapp-..."
            type="password"
            value={appToken()}
            onInput={(e) => {
              setAppToken(e.currentTarget.value);
              setAppTokenInvalid(false);
            }}
            onPaste={(e) => {
              const token = pastedToken(e, APP_TOKEN_PREFIX);
              if (!token) return;
              e.preventDefault();
              setAppToken(token);
              setAppTokenInvalid(false);
              void complete();
            }}
          />
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            data-testid="slack-install-complete-button"
            onClick={() => void complete()}
            disabled={busy() || !appToken().trim()}
            class={`flex items-center gap-2 rounded-control px-4 py-2.5 text-body-lg font-semibold text-white border-none transition-opacity ${busy() || !appToken().trim() ? "opacity-50 cursor-not-allowed" : "opacity-100 cursor-pointer hover:opacity-90"}`}
            style={{ background: "var(--dls-provider-slack-brand)" }}
          >
            <Link size={15} />
            {busy() ? t("identities.connecting") : t("identities.slack_install_finish")}
          </button>
          <Button variant="outline" class="h-auto px-3 text-label" disabled={busy()} onClick={() => void cancel()}>
            {t("identities.slack_install_cancel")}
          </Button>
        </div>
      </Show>

      <Show when={unreachable()}>
        <div
          data-testid="slack-network-error"
          class="flex items-start gap-2 rounded-control border border-dls-danger-border bg-dls-danger-bg px-3 py-2.5 text-caption font-semibold text-dls-danger-text"
        >
          <span>{t("identities.slack_network_unreachable")}</span>
        </div>
      </Show>
      <Show when={error()}>
        {(value) => <div data-testid="slack-install-error" class="text-label text-dls-danger-text">{value()}</div>}
      </Show>
      <Show when={props.connected}>
        <div class="text-label text-dls-secondary">{t("identities.slack_install_disconnect_note")}</div>
      </Show>
    </div>
  );
}
