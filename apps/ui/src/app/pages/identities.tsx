import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  ArrowRight,
  ChevronDown,
  RefreshCcw,
  Shield,
} from "lucide-solid";
import Button from "../components/button";
import { t } from "../../i18n";
import {
  buildOpenworkWorkspaceBaseUrl,
  OpenworkServerError,
  parseOpenworkWorkspaceIdFromUrl,
} from "../lib/openwork-server";
import type {
  OpenworkOpenCodeRouterHealthSnapshot,
  OpenworkOpenCodeRouterIdentityItem,
  OpenworkWorkspaceFileContent,
} from "../lib/openwork-server";
import { OPENCODE_ROUTER_AGENT_FILE_PATH, OPENCODE_ROUTER_AGENT_FILE_TEMPLATE, formatRequestError, getTelegramUsernameFromResult, isOpenCodeRouterIdentities, isOpenCodeRouterSnapshot } from "./identities.channel-guards";
import { StatusPill } from "./identities.channel-icons";
import ConnectionsSection from "./identities.connections";
import type { IdentitiesViewProps } from "./identities.types";
import type { ChannelSendResult } from "@different-ai/openwork-contracts/sandbox-manager-channel-messaging";

// Re-exported from the extracted helpers so this module's public surface is unchanged.
export type { IdentitiesViewProps } from "./identities.types";

export default function IdentitiesView(props: IdentitiesViewProps) {
  const [refreshing, setRefreshing] = createSignal(false);

  const [health, setHealth] = createSignal<OpenworkOpenCodeRouterHealthSnapshot | null>(null);
  const [healthError, setHealthError] = createSignal<string | null>(null);

  const [telegramIdentities, setTelegramIdentities] = createSignal<OpenworkOpenCodeRouterIdentityItem[]>([]);
  const [telegramIdentitiesError, setTelegramIdentitiesError] = createSignal<string | null>(null);

  const [slackIdentities, setSlackIdentities] = createSignal<OpenworkOpenCodeRouterIdentityItem[]>([]);
  const [slackIdentitiesError, setSlackIdentitiesError] = createSignal<string | null>(null);

  const [telegramBotUsername, setTelegramBotUsername] = createSignal<string | null>(null);
  const [channelsLoaded, setChannelsLoaded] = createSignal(false);

  const [activeTab, setActiveTab] = createSignal<"general" | "advanced">("general");

  const [agentLoading, setAgentLoading] = createSignal(false);
  const [agentSaving, setAgentSaving] = createSignal(false);
  const [agentExists, setAgentExists] = createSignal(false);
  const [agentContent, setAgentContent] = createSignal("");
  const [agentDraft, setAgentDraft] = createSignal("");
  const [agentBaseUpdatedAt, setAgentBaseUpdatedAt] = createSignal<number | null>(null);
  const [agentStatus, setAgentStatus] = createSignal<string | null>(null);
  const [agentError, setAgentError] = createSignal<string | null>(null);

  const [sendChannel, setSendChannel] = createSignal<"telegram" | "slack">("telegram");
  const [sendDirectory, setSendDirectory] = createSignal("");
  const [sendPeerId, setSendPeerId] = createSignal("");
  const [sendAutoBind, setSendAutoBind] = createSignal(true);
  const [sendText, setSendText] = createSignal("");
  const [sendBusy, setSendBusy] = createSignal(false);
  const [sendChannelDropdownOpen, setSendChannelDropdownOpen] = createSignal(false);
  const [sendStatus, setSendStatus] = createSignal<string | null>(null);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [sendResult, setSendResult] = createSignal<ChannelSendResult | null>(null);

  const [reconnectStatus, setReconnectStatus] = createSignal<string | null>(null);
  const [reconnectError, setReconnectError] = createSignal<string | null>(null);

  const workspaceId = createMemo(() => {
    const explicitId = props.openworkServerWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseOpenworkWorkspaceIdFromUrl(props.openworkServerUrl) ?? "";
  });

  const scopedOpenworkBaseUrl = createMemo(() => {
    const baseUrl = props.openworkServerUrl.trim();
    if (!baseUrl) return "";
    return buildOpenworkWorkspaceBaseUrl(baseUrl, workspaceId()) ?? baseUrl;
  });

  const openworkServerClient = createMemo(() => props.openworkServerClient);

  const serverReady = createMemo(() => props.openworkServerStatus === "connected" && Boolean(openworkServerClient()));
  const scopedWorkspaceReady = createMemo(() => Boolean(workspaceId()));
  const defaultRoutingDirectory = createMemo(() => props.activeWorkspaceRoot.trim() || t("identities.not_set"));

  let lastResetKey = "";
  let dropdownRef: HTMLDivElement | undefined;

  const statusLabel = createMemo(() => {
    if (healthError()) return t("identities.status_unavailable");
    const snapshot = health();
    if (!snapshot) return t("identities.status_unknown");
    return snapshot.ok ? t("identities.status_running") : t("identities.status_offline");
  });

  const isWorkerOnline = createMemo(() => {
    const snapshot = health();
    return snapshot?.ok === true;
  });

  const connectedChannelCount = createMemo(() => {
    let count = 0;
    if (telegramIdentities().some((i) => i.enabled && i.running)) count++;
    if (slackIdentities().some((i) => i.enabled && i.running)) count++;
    return count;
  });

  const agentDirty = createMemo(() => agentDraft() !== agentContent());

  const messagesToday = createMemo(() => {
    const activity = health()?.activity;
    if (!activity) return null;
    const inbound = typeof activity.inboundToday === "number" ? activity.inboundToday : 0;
    const outbound = typeof activity.outboundToday === "number" ? activity.outboundToday : 0;
    return inbound + outbound;
  });

  const lastActivityAt = createMemo(() => {
    const ts = health()?.activity?.lastMessageAt;
    return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
  });

  const lastActivityLabel = createMemo(() => {
    const ts = lastActivityAt();
    if (!ts) return "\u2014";
    const elapsedMs = Math.max(0, Date.now() - ts);
    if (elapsedMs < 60_000) return t("identities.just_now");
    const minutes = Math.floor(elapsedMs / 60_000);
    if (minutes < 60) return `${minutes}${t("identities.minutes_ago_suffix")}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}${t("identities.hours_ago_suffix")}`;
    const days = Math.floor(hours / 24);
    return `${days}${t("identities.days_ago_suffix")}`;
  });

  const workspaceAgentStatus = createMemo(() => {
    const agent = health()?.agent;
    if (!agent) return null;
    return {
      path: agent.path,
      loaded: agent.loaded,
      selected: agent.selected ?? "",
    };
  });

  const resetAgentState = () => {
    setAgentLoading(false);
    setAgentSaving(false);
    setAgentExists(false);
    setAgentContent("");
    setAgentDraft("");
    setAgentBaseUpdatedAt(null);
    setAgentStatus(null);
    setAgentError(null);
  };

  const loadAgentFile = async () => {
    if (agentLoading()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) {
      resetAgentState();
      setAgentError(t("identities.worker_scope_unavailable"));
      return;
    }
    const client = openworkServerClient();
    if (!client) return;

    setAgentLoading(true);
    setAgentError(null);
    try {
      const result = (await client.readWorkspaceFile(id, OPENCODE_ROUTER_AGENT_FILE_PATH)) as OpenworkWorkspaceFileContent;
      const nextContent = result.content ?? "";
      setAgentExists(true);
      setAgentContent(nextContent);
      setAgentDraft(nextContent);
      setAgentBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
    } catch (error) {
      if (error instanceof OpenworkServerError && error.status === 404) {
        setAgentExists(false);
        setAgentContent("");
        setAgentDraft("");
        setAgentBaseUpdatedAt(null);
        return;
      }
      setAgentError(formatRequestError(error));
    } finally {
      setAgentLoading(false);
    }
  };

  const createDefaultAgentFile = async () => {
    if (agentSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    setAgentSaving(true);
    setAgentStatus(null);
    setAgentError(null);
    try {
      const result = await client.writeWorkspaceFile(id, {
        path: OPENCODE_ROUTER_AGENT_FILE_PATH,
        content: OPENCODE_ROUTER_AGENT_FILE_TEMPLATE,
      });
      setAgentExists(true);
      setAgentContent(OPENCODE_ROUTER_AGENT_FILE_TEMPLATE);
      setAgentDraft(OPENCODE_ROUTER_AGENT_FILE_TEMPLATE);
      setAgentBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
      setAgentStatus(t("identities.created_default_agent_file"));
    } catch (error) {
      setAgentError(formatRequestError(error));
    } finally {
      setAgentSaving(false);
    }
  };

  const saveAgentFile = async () => {
    if (agentSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    setAgentSaving(true);
    setAgentStatus(null);
    setAgentError(null);
    try {
      const result = await client.writeWorkspaceFile(id, {
        path: OPENCODE_ROUTER_AGENT_FILE_PATH,
        content: agentDraft(),
        baseUpdatedAt: agentBaseUpdatedAt(),
      });
      setAgentExists(true);
      setAgentContent(agentDraft());
      setAgentBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
      setAgentStatus(t("identities.saved_messaging_behavior"));
    } catch (error) {
      if (error instanceof OpenworkServerError && error.status === 409) {
        setAgentError(t("identities.file_changed_remotely"));
      } else {
        setAgentError(formatRequestError(error));
      }
    } finally {
      setAgentSaving(false);
    }
  };

  const sendTestMessage = async () => {
    if (sendBusy()) return;
    const text = sendText().trim();
    if (!text) return;
    const channels = props.channelCredentials;
    if (!channels) {
      setSendError(t("identities.host_service_unavailable"));
      return;
    }

    setSendBusy(true);
    setSendStatus(null);
    setSendError(null);
    setSendResult(null);
    try {
      // The operator's own send goes to the host, which holds the router's admin token and never holds a send for
      // approval; openwork-server, which runs as the agent's tier, is not on this path.
      const peerId = sendPeerId().trim();
      const result = await channels.sendChannelMessage(sendChannel(), {
        text,
        ...(peerId ? { peerId } : {}),
        directory: sendDirectory().trim() || props.activeWorkspaceRoot.trim() || undefined,
        ...(sendAutoBind() ? { autoBind: true } : {}),
      });
      setSendResult(result);
      const base = `${t("identities.dispatched")} ${result.sent}/${result.attempted} ${t("identities.messages_suffix")}`;
      setSendStatus(result.reason?.trim() ? `${base} ${result.reason.trim()}` : base);
    } catch (error) {
      setSendError(formatRequestError(error));
    } finally {
      setSendBusy(false);
    }
  };

  const refreshAll = async (options?: { force?: boolean }) => {
    if (refreshing() && !options?.force) return;
    if (!serverReady()) return;
    const client = openworkServerClient();
    if (!client) return;
    const id = workspaceId();

    setRefreshing(true);
    try {
      setHealthError(null);
      setTelegramIdentitiesError(null);
      setSlackIdentitiesError(null);

      if (!id) {
        setHealth(null);
        setTelegramIdentities([]);
        setTelegramBotUsername(null);
        setSlackIdentities([]);
        setHealthError(t("identities.worker_scope_unavailable_reconnect"));
        setTelegramIdentitiesError(t("identities.worker_scope_unavailable"));
        setSlackIdentitiesError(t("identities.worker_scope_unavailable"));
        resetAgentState();
        setSendStatus(null);
        setSendError(null);
        setSendResult(null);
        return;
      }

      const [healthRes, tgRes, slackRes] = await Promise.all([
        client.opencodeRouterHealth(),
        // The router answers these; one that is down is a message under its own channel, not a failed refresh.
        client.getOpenCodeRouterTelegramIdentities(id).catch(() => null),
        client.getOpenCodeRouterSlackIdentities(id).catch(() => null),
      ]);

      // The bot Telegram reports for a running identity, which the router has and the host that saves the token has not.
      setTelegramBotUsername(getTelegramUsernameFromResult(isOpenCodeRouterIdentities(tgRes) ? tgRes.items?.find((item) => item.bot) : null));

      if (isOpenCodeRouterSnapshot(healthRes.json)) {
        setHealth(healthRes.json);
      } else {
        setHealth(null);
        if (!healthRes.ok) {
          const message =
            (healthRes.json && typeof (healthRes.json as any).message === "string")
              ? String((healthRes.json as any).message)
              : `OpenCodeRouter health unavailable (${healthRes.status})`;
          setHealthError(message);
        }
      }

      if (isOpenCodeRouterIdentities(tgRes)) {
        setTelegramIdentities(tgRes.items ?? []);
      } else {
        setTelegramIdentities([]);
        setTelegramIdentitiesError(t("identities.telegram_identities_unavailable"));
      }

      if (isOpenCodeRouterIdentities(slackRes)) {
        setSlackIdentities(slackRes.items ?? []);
      } else {
        setSlackIdentities([]);
        setSlackIdentitiesError(t("identities.slack_identities_unavailable"));
      }
      setChannelsLoaded(true);

      if (!agentDirty() && !agentSaving()) {
        void loadAgentFile();
      }
    } catch (error) {
      const message = formatRequestError(error);
      setHealth(null);
      setTelegramIdentities([]);
      setTelegramBotUsername(null);
      setSlackIdentities([]);
      setHealthError(message);
      setTelegramIdentitiesError(message);
      setSlackIdentitiesError(message);
      setChannelsLoaded(true);
    } finally {
      setRefreshing(false);
    }
  };

  const repairAndReconnect = async () => {
    if (props.openworkReconnectBusy) return;
    setReconnectStatus(null);
    setReconnectError(null);

    const ok = await props.reconnectOpenworkServer();
    if (!ok) {
      setReconnectError(t("identities.reconnect_failed"));
      return;
    }

    setReconnectStatus(t("identities.reconnected_refreshing"));
    await refreshAll({ force: true });
    setReconnectStatus(t("identities.reconnected"));
  };

  createEffect(() => {
    if (!sendChannelDropdownOpen()) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef && !dropdownRef.contains(e.target as Node)) {
        setSendChannelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

  createEffect(() => {
    const baseUrl = scopedOpenworkBaseUrl().trim();
    const id = workspaceId();
    const nextKey = `${baseUrl}|${id}`;
    if (nextKey === lastResetKey) return;
    lastResetKey = nextKey;

    setHealth(null);
    setHealthError(null);
    setTelegramIdentities([]);
    setTelegramIdentitiesError(null);
    setTelegramBotUsername(null);
    setSlackIdentities([]);
    setSlackIdentitiesError(null);
    setChannelsLoaded(false);
    resetAgentState();
    setSendStatus(null);
    setSendError(null);
    setSendResult(null);
    setReconnectStatus(null);
    setReconnectError(null);
    setActiveTab("general");
  });

  onMount(() => {
    void refreshAll({ force: true });
    const interval = window.setInterval(() => void refreshAll(), 10_000);
    onCleanup(() => window.clearInterval(interval));
  });

  return (
    <div class="space-y-6" data-testid="channel-content">

      {/* ---- Header ---- */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h2 class="text-display-lg font-bold text-dls-text">{t("identities.connections_title")}</h2>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              class="h-8 px-3 text-caption"
              onClick={() => void repairAndReconnect()}
              disabled={props.busy || props.openworkReconnectBusy}
            >
              <RefreshCcw size={14} class={props.openworkReconnectBusy ? "animate-spin" : ""} />
              <span class="ml-1.5">{t("identities.repair_and_reconnect")}</span>
            </Button>
            <button
              type="button"
              onClick={() => refreshAll({ force: true })}
              disabled={!serverReady() || refreshing()}
              class={`flex items-center gap-1.5 text-caption font-medium transition-colors px-3 h-8 rounded-control
                ${!serverReady() || refreshing()
                  ? "text-dls-secondary cursor-not-allowed"
                  : "text-dls-secondary hover:text-dls-text cursor-pointer"}
              `}
            >
              <RefreshCcw size={14} class={refreshing() ? "animate-spin" : ""} />
              <span class="ml-1.5">{t("identities.refresh")}</span>
            </button>
          </div>
        </div>
        <Show when={reconnectStatus()}>
          {(value) => <div class="mt-1 text-label text-dls-muted">{value()}</div>}
        </Show>
        <Show when={reconnectError()}>
          {(value) => <div class="mt-1 text-label text-dls-danger-text">{value()}</div>}
        </Show>
      </div>

      {/* ---- Not connected to server ---- */}
      <Show when={!serverReady()}>
        <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg p-5">
          <div class="text-body-lg font-semibold text-dls-text">{t("identities.connect_to_openwork_server")}</div>
          <div class="mt-1 text-caption text-dls-secondary">
            {t("identities.identities_available_when_connected")} (<code class="text-label font-mono bg-dls-active px-1 py-0.5 rounded-compact">openwork</code>).
          </div>
        </div>
      </Show>

      <Show when={serverReady()}>
        <Show when={!scopedWorkspaceReady()}>
          <div class="rounded-inset border border-dls-warning-border bg-dls-warning-bg px-3 py-2 text-caption text-dls-warning-text">
            {t("identities.workspace_id_required_prefix")} <code class="text-label">/w/&lt;workspace-id&gt;</code>{t("identities.workspace_id_required_suffix")}
          </div>
        </Show>

        <div class="hidden items-center gap-2 rounded-inset border border-dls-border bg-dls-surface p-1">
          <button
            class={`flex-1 rounded-control px-3 py-2 text-caption font-semibold transition-colors ${activeTab() === "general"
              ? "bg-dls-text text-dls-surface-solid"
              : "text-dls-secondary hover:bg-dls-hover"
              }`}
            onClick={() => setActiveTab("general")}
          >
            {t("identities.tab_general")}
          </button>
          {/* Advanced tab hidden; re-enable by removing the `hidden` class */}
          <button
            class={`hidden flex-1 rounded-control px-3 py-2 text-caption font-semibold transition-colors ${activeTab() === "advanced"
              ? "bg-dls-text text-dls-surface-solid"
              : "text-dls-secondary hover:bg-dls-hover"
              }`}
            onClick={() => setActiveTab("advanced")}
          >
            {t("identities.tab_advanced")}
          </button>
        </div>

        <Show when={activeTab() === "general"}>

          {/* ---- Worker status card ---- */}
          <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg p-4 space-y-3.5">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2.5">
                <Show
                  when={isWorkerOnline()}
                  fallback={
                    <div class="w-2.5 h-2.5 rounded-pill bg-dls-secondary" />
                  }
                >
                  <div class="w-2.5 h-2.5 rounded-pill bg-dls-success-dot animate-pulse" />
                </Show>
                <span class="text-title leading-title font-semibold text-dls-text">
                  {isWorkerOnline() ? t("identities.worker_online") : healthError() ? t("identities.worker_unavailable") : t("identities.worker_offline")}
                </span>
              </div>
              <span
                class={`rounded-pill border px-2.5 py-0.5 text-label font-semibold ${isWorkerOnline()
                  ? "border-dls-success-border bg-dls-success-bg text-dls-success-text"
                  : healthError()
                    ? "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text"
                    : "border-dls-warning-border bg-dls-warning-bg text-dls-warning-text"
                  }`}
              >
                {statusLabel()}
              </span>
            </div>

            <Show when={healthError()}>
              {(value) => (
                <div class="rounded-control border border-dls-danger-border bg-dls-danger-bg px-3 py-2 text-caption text-dls-danger-text">{value()}</div>
              )}
            </Show>

            <div class="flex gap-3">
              <StatusPill
                label={t("identities.pill_channels")}
                value={`${connectedChannelCount()} ${t("identities.connected_lower")}`}
                ok={connectedChannelCount() > 0}
              />
              <StatusPill
                label={t("identities.pill_messages_today")}
                value={messagesToday() == null ? "\u2014" : String(messagesToday())}
                ok={(messagesToday() ?? 0) > 0}
              />
              <StatusPill
                label={t("identities.pill_last_activity")}
                value={lastActivityLabel()}
                ok={Boolean(lastActivityAt())}
              />
            </div>
          </div>
        </Show>

        <Show when={activeTab() === "advanced"}>

          {/* ---- Message routing ---- */}
          <div>
            <div class="text-label font-semibold text-dls-secondary uppercase tracking-wider mb-2">
              {t("identities.message_routing")}
            </div>
            <p class="text-body text-dls-secondary leading-relaxed mb-3">
              {t("identities.message_routing_description")}
            </p>

            <div class="rounded-inset border border-dls-border bg-dls-hover/50 px-4 py-3.5 space-y-3">
              <div class="flex items-center gap-2">
                <Shield size={16} class="text-dls-secondary" />
                <span class="text-body font-medium text-dls-secondary">{t("identities.default_routing")}</span>
              </div>
              <div class="flex items-center gap-2 pl-6">
                <span class="rounded-subtle bg-dls-active px-2.5 py-1 text-caption font-medium text-dls-secondary">
                  {t("identities.all_channels")}
                </span>
                <ArrowRight size={14} class="text-dls-secondary" />
                <span class="rounded-subtle bg-dls-accent/10 px-2.5 py-1 text-caption font-medium text-dls-accent">
                  {defaultRoutingDirectory()}
                </span>
              </div>
            </div>

            <div class="text-caption text-dls-secondary mt-2.5">
              {t("identities.advanced_dir_prefix")} <code class="text-label font-mono bg-dls-active px-1 py-0.5 rounded-compact">/dir &lt;path&gt;</code> {t("identities.advanced_dir_suffix")}
            </div>
          </div>

          {/* ---- Messaging agent behavior ---- */}
          <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg p-4 space-y-3">
            <div class="flex items-center justify-between gap-2">
              <div>
                <div class="text-body font-semibold text-dls-text">{t("identities.messaging_agent_behavior")}</div>
                <div class="text-caption text-dls-secondary mt-0.5">
                  {t("identities.messaging_agent_behavior_prefix")} <code class="font-mono">@agent &lt;id&gt;</code> {t("identities.messaging_agent_behavior_suffix")}
                </div>
              </div>
              <span class="rounded-subtle border border-dls-border bg-dls-hover/50 px-2 py-1 text-label font-mono text-dls-secondary">
                {OPENCODE_ROUTER_AGENT_FILE_PATH}
              </span>
            </div>

            <Show when={workspaceAgentStatus()}>
              {(value) => (
                <div class="rounded-control border border-dls-border bg-dls-hover/40 px-3 py-2 text-label text-dls-secondary">
                  {t("identities.active_scope_workspace")} · {t("identities.status_label")} {value().loaded ? t("identities.loaded") : t("identities.missing")} · {t("identities.selected_agent_label")} {value().selected || t("identities.none_parenthetical")}
                </div>
              )}
            </Show>

            <Show when={agentLoading()}>
              <div class="text-label text-dls-secondary">{t("identities.loading_agent_file")}</div>
            </Show>

            <Show when={!agentExists() && !agentLoading()}>
              <div class="rounded-control border border-dls-warning-border bg-dls-warning-bg px-3 py-2 text-caption text-dls-warning-text">
                {t("identities.agent_file_not_found")}
              </div>
            </Show>

            <textarea
              class="min-h-[220px] w-full rounded-control border border-dls-border bg-dls-surface px-3 py-2.5 text-body font-mono text-dls-text placeholder:text-dls-secondary"
              placeholder={t("identities.agent_textarea_placeholder")}
              value={agentDraft()}
              onInput={(e) => setAgentDraft(e.currentTarget.value)}
            />

            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                class="h-8 px-3 text-caption"
                onClick={() => void loadAgentFile()}
                disabled={agentLoading() || !workspaceId()}
              >
                {t("identities.reload")}
              </Button>
              <Show when={!agentExists()}>
                <Button
                  variant="outline"
                  class="h-8 px-3 text-caption"
                  onClick={() => void createDefaultAgentFile()}
                  disabled={agentSaving() || !workspaceId()}
                >
                  {t("identities.create_default_file")}
                </Button>
              </Show>
              <Button
                variant="secondary"
                class="h-8 px-3 text-caption"
                onClick={() => void saveAgentFile()}
                disabled={agentSaving() || !workspaceId() || !agentDirty()}
              >
                {agentSaving() ? t("identities.saving") : t("identities.save_behavior")}
              </Button>
              <Show when={agentDirty() && !agentSaving()}>
                <span class="text-label text-dls-muted">{t("identities.unsaved_changes")}</span>
              </Show>
            </div>

            <Show when={agentStatus()}>
              {(value) => <div class="text-label text-dls-secondary">{value()}</div>}
            </Show>
            <Show when={agentError()}>
              {(value) => <div class="text-label text-dls-danger-text">{value()}</div>}
            </Show>
          </div>

          {/* ---- Outbound send test ---- */}
          <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg p-4 space-y-3">
            <div>
              <div class="text-body font-semibold text-dls-text">{t("identities.send_test_message")}</div>
              <div class="text-caption text-dls-secondary mt-0.5">
                {t("identities.send_test_message_description")}
              </div>
            </div>

            <div class="grid gap-2 sm:grid-cols-2">
              <div>
                <label class="text-caption text-dls-secondary block mb-1">{t("identities.channel_label")}</label>
                <div class="relative" ref={dropdownRef}>
                  <button
                    type="button"
                    class="w-full flex items-center justify-between bg-dls-panel-inset-bg dark:bg-dls-panel-inset-bg p-3 rounded-inset border border-dls-border-strong text-body-lg text-dls-text dark:text-dls-text hover:bg-dls-surface-raised dark:hover:bg-dls-surface-raised transition-colors"
                    onClick={() => setSendChannelDropdownOpen(!sendChannelDropdownOpen())}
                    disabled={sendBusy()}
                    aria-haspopup="listbox"
                    aria-expanded={sendChannelDropdownOpen()}
                    aria-controls="send-channel-listbox"
                  >
                    <span>{sendChannel() === "telegram" ? "Telegram" : "Slack"}</span>
                    <ChevronDown size={14} class="text-dls-secondary" />
                  </button>
                  <Show when={sendChannelDropdownOpen()}>
                    <div
                      class="absolute z-50 mt-1 w-full bg-dls-surface-raised dark:bg-dls-surface-raised border border-dls-border-strong rounded-inset shadow-lg overflow-hidden"
                      role="listbox"
                      id="send-channel-listbox"
                    >
                      <For each={["telegram", "slack"] as ("telegram" | "slack")[]}>
                        {(ch) => (
                          <button
                            type="button"
                            class={`w-full text-left px-3 py-2 text-body-lg transition-colors hover:bg-dls-surface-tint dark:hover:bg-dls-surface-tint ${sendChannel() === ch ? "bg-dls-surface-tint text-dls-text dark:bg-dls-surface-tint dark:text-dls-text" : "text-dls-secondary dark:text-dls-secondary"}`}
                            onClick={() => {
                              setSendChannel(ch);
                              setSendChannelDropdownOpen(false);
                            }}
                            role="option"
                            aria-selected={sendChannel() === ch}
                          >
                            {ch === "telegram" ? "Telegram" : "Slack"}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

              </div>
              <div>
                <label class="text-caption text-dls-secondary block mb-1">{t("identities.peer_id_optional")}</label>
                <input
                  class="w-full rounded-control border border-dls-border bg-dls-surface px-3 py-2 text-body-lg text-dls-text placeholder:text-dls-secondary"
                  placeholder={sendChannel() === "telegram" ? t("identities.peer_id_placeholder_telegram") : t("identities.peer_id_placeholder_slack")}
                  value={sendPeerId()}
                  onInput={(e) => setSendPeerId(e.currentTarget.value)}
                />
              </div>
            </div>

            <div class="grid gap-2 sm:grid-cols-2">
              <div>
                <label class="text-caption text-dls-secondary block mb-1">{t("identities.directory_optional")}</label>
                <input
                  class="w-full rounded-control border border-dls-border bg-dls-surface px-3 py-2 text-body-lg text-dls-text placeholder:text-dls-secondary"
                  placeholder={defaultRoutingDirectory()}
                  value={sendDirectory()}
                  onInput={(e) => setSendDirectory(e.currentTarget.value)}
                />
              </div>
              <div class="flex items-end pb-1">
                <label class="flex items-center gap-2 text-caption text-dls-secondary">
                  <input
                    type="checkbox"
                    checked={sendAutoBind()}
                    onChange={(e) => setSendAutoBind(e.currentTarget.checked)}
                  />
                  {t("identities.auto_bind_peer")}
                </label>
              </div>
            </div>

            <div>
              <label class="text-caption text-dls-secondary block mb-1">{t("identities.message_label")}</label>
              <textarea
                class="min-h-[90px] w-full rounded-control border border-dls-border bg-dls-surface px-3 py-2 text-body-lg text-dls-text placeholder:text-dls-secondary"
                placeholder={t("identities.test_message_placeholder")}
                value={sendText()}
                onInput={(e) => setSendText(e.currentTarget.value)}
              />
            </div>

            <div class="flex items-center gap-2">
              <Button
                variant="secondary"
                class="h-8 px-3 text-caption"
                onClick={() => void sendTestMessage()}
                disabled={sendBusy() || !workspaceId() || !sendText().trim()}
              >
                {sendBusy() ? t("identities.sending") : t("identities.send_test_message")}
              </Button>
              <Show when={sendStatus()}>
                {(value) => <span class="text-label text-dls-secondary">{value()}</span>}
              </Show>
            </div>

            <Show when={sendError()}>
              {(value) => <div class="text-label text-dls-danger-text">{value()}</div>}
            </Show>
            <Show when={sendResult()}>
              {(value) => (
                <div class="rounded-control border border-dls-border bg-dls-hover/40 px-3 py-2 text-label text-dls-secondary font-mono space-y-1">
                  <div>
                    sent={value().sent} attempted={value().attempted}
                    <Show when={value().failures?.length}>
                      {(failures) => ` failures=${failures()}`}
                    </Show>
                    <Show when={value().reason?.trim()}>
                      {(reason) => ` reason=${reason()}`}
                    </Show>
                  </div>
                  <Show when={value().failures?.length}>
                    <For each={value().failures ?? []}>
                      {(failure) => (
                        <div class="text-dls-danger-text">
                          {failure.identity_id}/{failure.peer_id}: {failure.error}
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </Show>
          </div>

        </Show>

      </Show>

      <ConnectionsSection
        channelCredentials={props.channelCredentials}
        openworkServerUrl={props.openworkServerUrl}
        openworkServerClient={openworkServerClient()}
        workspaceId={workspaceId()}
        channelsReady={serverReady() && scopedWorkspaceReady()}
        channelsLoaded={channelsLoaded()}
        slackIdentities={slackIdentities()}
        slackIdentitiesError={slackIdentitiesError()}
        telegramIdentities={telegramIdentities()}
        telegramIdentitiesError={telegramIdentitiesError()}
        telegramBotUsername={telegramBotUsername()}
        refreshChannels={() => void refreshAll({ force: true })}
        tavilyKeyView={props.tavilyKeyView}
        tavilyApiKeyStatus={props.tavilyApiKeyStatus}
        refreshTavilyApiKey={props.refreshTavilyApiKey}
        saveTavilyApiKey={props.saveTavilyApiKey}
        clearTavilyApiKey={props.clearTavilyApiKey}
        setTavilyApiKeyEnabled={props.setTavilyApiKeyEnabled}
      />
    </div>
  );
}