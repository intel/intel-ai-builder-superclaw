import { Match, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { channelIdentityIdForWorkspace } from "~/shared/platform/transport/instance-api";
import GithubConnectionCard from "../components/github-connection-card";
import type { OpenworkGithubStatus, OpenworkOpenCodeRouterIdentityItem, OpenworkServerClient } from "../lib/openwork-server";
import { t } from "../../i18n";
import { applyErrorMessage, classifySlackSaveError, formatRequestError } from "./identities.channel-guards";
import ConnectionDialog from "./identities.connection-dialog";
import ConnectionList, { connectionName, type ConnectionNotice } from "./identities.connection-list";
import {
  CONNECTION_ORDER,
  channelRow,
  githubRow,
  gmailRow,
  switchedIdentity,
  tavilyRow,
  toggleIntent,
  withRemembered,
  type ConnectionId,
  type ConnectionRow,
} from "./identities.connection-rows";
import SlackPanel from "./identities.slack-panel";
import TelegramPanel from "./identities.telegram-panel";
import type { ChannelCredentialsClient, IdentitiesViewProps } from "./identities.types";
import { createGmailCredentials, gmailSettingsVisible } from "./settings.gmail-credentials";
import GmailCredentialsSection from "./settings.gmail-credentials-section";
import TavilySection from "./settings.tavily-section";

type TavilyProps = Pick<
  IdentitiesViewProps,
  "tavilyKeyView" | "tavilyApiKeyStatus" | "refreshTavilyApiKey" | "saveTavilyApiKey" | "clearTavilyApiKey" | "setTavilyApiKeyEnabled"
>;

export type ConnectionsSectionProps = TavilyProps & {
  channelCredentials: ChannelCredentialsClient | null;
  openworkServerUrl: string;
  openworkServerClient: OpenworkServerClient | null;
  workspaceId: string;
  /** The router can be asked about channels: the server is connected and a workspace is active. */
  channelsReady: boolean;
  /** The first channel read since the workspace changed has landed. */
  channelsLoaded: boolean;
  slackIdentities: OpenworkOpenCodeRouterIdentityItem[];
  slackIdentitiesError: string | null;
  telegramIdentities: OpenworkOpenCodeRouterIdentityItem[];
  telegramIdentitiesError: string | null;
  telegramBotUsername: string | null;
  refreshChannels: () => void;
};

/** Waits before each new GitHub status read after a failed one; the last repeats until one lands. */
const GITHUB_RETRY_MS = [2_000, 5_000, 10_000, 30_000];

/** Outlives the page, which the settings dialog unmounts whenever another tab is selected. Keyed by workspace. */
const rememberedRows = new Map<string, Partial<Record<ConnectionId, ConnectionRow>>>();

/** The Connections list: one row per connection, and the in-app dialog each row opens. */
export default function ConnectionsSection(props: ConnectionsSectionProps) {
  const capability = useCapabilityGate();
  const gmail = createGmailCredentials({
    serverUrl: () => props.openworkServerUrl,
    workspaceId: () => props.workspaceId || null,
  });
  const [github, setGithub] = createSignal<OpenworkGithubStatus | null>(null);
  const [open, setOpen] = createSignal<ConnectionId | null>(null);
  const [busy, setBusy] = createSignal<ConnectionId | null>(null);
  const [notices, setNotices] = createSignal<Partial<Record<ConnectionId, ConnectionNotice>>>({});

  const identityId = createMemo(() => (props.workspaceId ? channelIdentityIdForWorkspace(props.workspaceId) : null));
  const githubReady = () => Boolean(props.openworkServerUrl.trim() && props.workspaceId && props.openworkServerClient);
  const gmailVisible = () => gmailSettingsVisible(capability);

  /** A GitHub status read for a client or workspace that has since changed is dropped, not shown. */
  const setGithubFor = (client: OpenworkServerClient, workspaceId: string, status: OpenworkGithubStatus) => {
    if (client === props.openworkServerClient && workspaceId === props.workspaceId) setGithub(status);
  };

  /** False only when the read failed, so the caller can try again. */
  const refreshGithub = async (): Promise<boolean> => {
    const client = props.openworkServerClient;
    const workspaceId = props.workspaceId;
    if (!client || !workspaceId) return true;
    try {
      setGithubFor(client, workspaceId, await client.getGithubStatus(workspaceId));
      return true;
    } catch {
      // Advisory, as on the GitHub card: a backend still starting is shown as loading, not as an error.
      return false;
    }
  };

  createEffect(
    on(
      () => [props.openworkServerClient, props.workspaceId] as const,
      () => {
        setGithub(null);
        setNotices({});
        // Until a read lands the row is loading and its toggle unusable, so a failed read is tried again.
        let retry: ReturnType<typeof setTimeout> | undefined;
        let attempt = 0;
        let stopped = false;
        const load = async () => {
          if ((await refreshGithub()) || stopped) return;
          retry = setTimeout(() => void load(), GITHUB_RETRY_MS[Math.min(attempt++, GITHUB_RETRY_MS.length - 1)]);
        };
        void load();
        onCleanup(() => {
          stopped = true;
          clearTimeout(retry);
        });
      },
    ),
  );

  const freshRows = createMemo<ConnectionRow[]>(() => {
    const channel = (id: "slack" | "telegram") =>
      channelRow(id, {
        ready: props.channelsReady,
        loaded: props.channelsLoaded,
        items: id === "slack" ? props.slackIdentities : props.telegramIdentities,
        error: id === "slack" ? props.slackIdentitiesError : props.telegramIdentitiesError,
        workspaceIdentityId: identityId(),
      });
    const all: Record<ConnectionId, ConnectionRow> = {
      slack: channel("slack"),
      telegram: channel("telegram"),
      github: githubRow({ ready: githubReady(), status: github() }),
      tavily: tavilyRow(props.tavilyKeyView),
      gmail: gmailRow({ ready: Boolean(props.openworkServerUrl.trim() && props.workspaceId), status: gmail.status() }),
    };
    return CONNECTION_ORDER.filter((id) => id !== "gmail" || gmailVisible()).map((id) => all[id]);
  });

  const rows = createMemo<ConnectionRow[]>(() => {
    const remembered = rememberedRows.get(props.workspaceId);
    return freshRows().map((fresh) => withRemembered(fresh, remembered?.[fresh.id]));
  });

  createEffect(() => {
    const workspaceId = props.workspaceId;
    const known = { ...rememberedRows.get(workspaceId) };
    for (const fresh of freshRows()) {
      if (fresh.status !== "loading") known[fresh.id] = fresh;
    }
    rememberedRows.set(workspaceId, known);
  });

  const notify = (id: ConnectionId, notice: ConnectionNotice | null) =>
    setNotices((current) => {
      const next = { ...current };
      if (notice) next[id] = notice;
      else delete next[id];
      return next;
    });

  const switchChannel = async (channel: "slack" | "telegram", enabled: boolean) => {
    const client = props.channelCredentials;
    const items = channel === "slack" ? props.slackIdentities : props.telegramIdentities;
    const identity = switchedIdentity(items, identityId());
    if (!client) throw new Error(t("identities.host_service_unavailable"));
    if (!identity) return;
    try {
      const result =
        channel === "slack"
          ? await client.setSlackIdentityEnabled(identity.id, enabled)
          : await client.setTelegramIdentityEnabled(identity.id, enabled);
      if (result.apply_error) notify(channel, { tone: "error", text: applyErrorMessage(result.apply_error) });
    } catch (error) {
      // Slack no longer takes the kept tokens (the app was deleted or reinstalled), so only a new setup helps.
      if (channel === "slack" && classifySlackSaveError(error).kind === "invalid_token") {
        throw new Error(t("identities.slack_switch_rejected"));
      }
      throw error;
    } finally {
      props.refreshChannels();
    }
  };

  const switchGithub = async (enabled: boolean) => {
    const client = props.openworkServerClient;
    const workspaceId = props.workspaceId;
    if (!client || !workspaceId) throw new Error(t("connections.github_unavailable"));
    setGithubFor(client, workspaceId, await client.setGithubEnabled(workspaceId, enabled));
  };

  const switchGmail = async (enabled: boolean) => {
    await gmail.setEnabled(enabled);
    const failure = gmail.error();
    if (failure) throw new Error(failure);
  };

  const toggle = async (id: ConnectionId, next: boolean) => {
    const target = rows().find((candidate) => candidate.id === id);
    if (!target || busy()) return;
    const intent = toggleIntent(target, next);
    if (intent === "open_setup") {
      setOpen(id);
      return;
    }
    if (intent === "none") return;
    setBusy(id);
    notify(id, null);
    try {
      if (id === "slack" || id === "telegram") await switchChannel(id, next);
      else if (id === "github") await switchGithub(next);
      else if (id === "tavily") await props.setTavilyApiKeyEnabled(next);
      else await switchGmail(next);
    } catch (error) {
      notify(id, { tone: "error", text: formatRequestError(error) });
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    const was = open();
    setOpen(null);
    if (was === "github") void refreshGithub();
  };

  return (
    <div class="space-y-3">
      <div class="text-label font-semibold text-dls-secondary uppercase tracking-wider">{t("connections.title")}</div>
      <ConnectionList
        rows={rows()}
        busy={busy()}
        notices={notices()}
        onOpen={setOpen}
        onToggle={(id, next) => void toggle(id, next)}
      />

      <ConnectionDialog
        open={open() !== null}
        title={open() ? connectionName(open() as ConnectionId) : ""}
        onClose={close}
        data-testid={open() ? `connection-dialog-${open()}` : undefined}
      >
        <Switch>
          <Match when={open() === "slack"}>
            <SlackPanel
              client={props.channelCredentials}
              identityId={identityId()}
              identities={props.slackIdentities}
              identitiesError={props.slackIdentitiesError}
              refresh={props.refreshChannels}
            />
          </Match>
          <Match when={open() === "telegram"}>
            <TelegramPanel
              client={props.channelCredentials}
              identityId={identityId()}
              identities={props.telegramIdentities}
              identitiesError={props.telegramIdentitiesError}
              botUsername={props.telegramBotUsername}
              refresh={props.refreshChannels}
            />
          </Match>
          <Match when={open() === "github"}>
            {/* Not capability-gated: the `github` skill is registered in every Profile. */}
            <GithubConnectionCard baseUrl={props.openworkServerUrl ?? ""} workspaceId={props.workspaceId} />
          </Match>
          <Match when={open() === "tavily"}>
            <TavilySection
              view={props.tavilyKeyView}
              status={props.tavilyApiKeyStatus}
              save={props.saveTavilyApiKey}
              clear={props.clearTavilyApiKey}
              retry={props.refreshTavilyApiKey}
            />
          </Match>
          <Match when={open() === "gmail" && gmailVisible()}>
            <GmailCredentialsSection gmail={gmail} />
          </Match>
        </Switch>
      </ConnectionDialog>
    </div>
  );
}
