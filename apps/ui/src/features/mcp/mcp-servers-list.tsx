import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  LogIn,
  Plus,
  RotateCw,
  Trash2,
  Unplug,
} from "lucide-solid";
import type {
  McpToolListResponse, McpToolPolicyResponse, McpToolPolicyUpdateRequest,
} from "@different-ai/openwork-contracts/mcp";
import type { McpServerEntry, McpStatusMap } from "~/shared/types/mcp";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { MCP_STATUS_POLL_INTERVAL_MS } from "~/shared/platform/mcp-timing";
import { formatRelativeTime } from "~/shared/util/format";
import Button from "~/shared/ui/button";
import ConfirmModal from "~/shared/ui/confirm-modal";
import ToggleSwitch from "~/shared/ui/toggle-switch";
import { userEnvironmentNames } from "./mcp-config";
import { joinCommand } from "./mcp-input-parse";
import McpToolPolicyModal from "./mcp-tool-policy-modal";
import {
  ownValue, pendingStatus, statusDot, statusLabelKey, type McpPendingMap, type McpStatusKind,
} from "./mcp-view-status";
import { currentLocale, t } from "../../i18n";

export type McpServersListProps = {
  busy: boolean;
  servers: McpServerEntry[];
  statuses: McpStatusMap;
  connectingName: McpPendingMap;
  lastUpdatedAt: number | null;
  onAdd: () => void;
  reconnectMcp: (entry: McpServerEntry) => void;
  setMcpEnabled: (entry: McpServerEntry, enabled: boolean) => void;
  authorizeMcp: (entry: McpServerEntry) => void;
  removeMcp: (name: string) => void;
  listMcpTools?: (name: string) => Promise<McpToolListResponse>;
  setMcpToolPolicy?: (name: string, request: McpToolPolicyUpdateRequest) => Promise<McpToolPolicyResponse>;
};

const STATUS_RANK: Record<McpStatusKind, number> = {
  connected: 0, on_demand: 0, needs_auth: 1, needs_client_registration: 1, failed: 1, connecting: 1, disabled: 2,
};

const ROW_ACTION_CLASS =
  "flex h-8 w-8 items-center justify-center rounded-subtle text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:opacity-50";

const isStdio = (entry: McpServerEntry) =>
  entry.config.type === "local" || Boolean(entry.config.command?.length);

export default function McpServersList(props: McpServersListProps) {
  const tr = (key: string) => t(key, currentLocale());
  const capability = useCapabilityGate();
  const [now, setNow] = createSignal(Date.now());
  const [removeTarget, setRemoveTarget] = createSignal<McpServerEntry | null>(null);
  const [expandedName, setExpandedName] = createSignal<string | null>(null);
  const [selectedServerForPolicy, setSelectedServerForPolicy] = createSignal<McpServerEntry | null>(null);

  createEffect(() => {
    if (MCP_STATUS_POLL_INTERVAL_MS < 5_000 || !props.lastUpdatedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    onCleanup(() => window.clearInterval(timer));
  });

  const resolveStatusEntry = (entry: McpServerEntry) => ownValue(props.statuses, entry.name);

  const resolveStatus = (entry: McpServerEntry): McpStatusKind => {
    if (entry.config.enabled === false) return "disabled";
    const resolved = resolveStatusEntry(entry);
    if (resolved?.status === "connected" && resolved.onDemand) return "on_demand";
    return resolved?.status ?? "connecting";
  };

  const connectedCount = createMemo(() =>
    props.servers.filter((entry) => resolveStatus(entry) === "connected").length,
  );

  const attentionCount = createMemo(() =>
    props.servers.filter((entry) => !["connected", "on_demand"].includes(resolveStatus(entry))).length,
  );

  const sortedServers = createMemo(() =>
    [...props.servers].sort((a, b) =>
      STATUS_RANK[resolveStatus(a)] - STATUS_RANK[resolveStatus(b)]
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  );

  const toolsAccess = () => {
    const { listMcpTools, setMcpToolPolicy } = props;
    if (!capability.mcpToolPermissionsEnabled() || !listMcpTools || !setMcpToolPolicy) return null;
    return { listTools: listMcpTools, setToolPolicy: setMcpToolPolicy };
  };

  // Re-fetches whenever the modal opens for a different server; closing it clears the source.
  const policySource = createMemo(() => {
    const server = selectedServerForPolicy();
    const access = toolsAccess();
    return server && access ? { server, listTools: access.listTools } : null;
  });
  const [policyTools] = createResource(policySource, async (source) => {
    const response = await source.listTools(source.server.name);
    return response.state === "ready" ? response.tools : [];
  });

  const closeToolPolicyModal = () => setSelectedServerForPolicy(null);

  const saveToolPolicy = async (enabledNames: string[]) => {
    const entry = selectedServerForPolicy();
    const access = toolsAccess();
    if (!entry || !access) return;
    const current = policyTools() ?? [];
    const enabled = new Set(enabledNames);
    const toAllow = current.filter((tool) => !tool.allowed && enabled.has(tool.name)).map((tool) => tool.name);
    const toDeny = current.filter((tool) => tool.allowed && !enabled.has(tool.name)).map((tool) => tool.name);
    if (toAllow.length) await access.setToolPolicy(entry.name, { tools: toAllow, action: "allow" });
    if (toDeny.length) await access.setToolPolicy(entry.name, { tools: toDeny, action: "deny" });
    closeToolPolicyModal();
  };

  const details = (entry: McpServerEntry): Array<{ label: string; value: string }> => {
    const { config } = entry;
    const names = (record: Record<string, string> | undefined) => Object.keys(record ?? {}).join(", ");
    const rows = isStdio(entry)
      ? [
        { label: tr("mcp.server_command"), value: joinCommand(config.command ?? []) },
        { label: tr("mcp.env_vars"), value: userEnvironmentNames(config.command, config.environment).join(", ") },
      ]
      : [
        { label: tr("mcp.server_url"), value: config.url ?? "" },
        { label: tr("mcp.http_headers"), value: names(config.headers) },
      ];
    if (config.timeout) {
      rows.push({ label: tr("mcp.timeout_seconds"), value: String(config.timeout / 1000) });
    }
    const resolved = resolveStatusEntry(entry);
    if (
      config.enabled !== false
      && (resolved?.status === "failed" || resolved?.status === "needs_client_registration")
      && resolved.error
    ) {
      // A typed refusal (e.g. the Windows sandbox browser-automation gate) gets localized
      // text; anything else keeps the server's own message, since it has no translation.
      const value = resolved.status === "failed" && resolved.code === "mcp_browser_unsupported_in_sandbox"
        ? tr("mcp.browser_unsupported_in_sandbox")
        : resolved.error;
      rows.push({ label: tr("mcp.error_details"), value });
    }
    return rows.filter((row) => row.value);
  };

  return (
    <div class="space-y-3">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div class="min-w-0">
          <h3 class="text-label font-bold text-dls-secondary uppercase tracking-widest">
            {tr("mcp.your_apps")}
          </h3>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Show when={props.servers.length > 0}>
            <div class="flex items-center gap-3 text-label text-dls-secondary">
              <span class="inline-flex items-center gap-1.5">
                <span class="h-1.5 w-1.5 rounded-pill bg-dls-success-dot" />
                {connectedCount()} {tr("mcp.connected")}
              </span>
              <Show when={attentionCount() > 0}>
                <span class="inline-flex items-center gap-1.5 text-dls-warning-text">
                  <AlertCircle size={12} />
                  {attentionCount()} {tr("mcp.needs_attention")}
                </span>
              </Show>
            </div>
          </Show>
          <Show when={MCP_STATUS_POLL_INTERVAL_MS >= 5_000 && props.lastUpdatedAt}>
            <span class="text-label text-dls-secondary tabular-nums">
              {tr("mcp.last_synced")} {formatRelativeTime(props.lastUpdatedAt ?? now(), now())}
            </span>
          </Show>
          <Button variant="secondary" class="h-9 px-3 text-caption" onClick={() => props.onAdd()}>
            <Plus size={14} />
            {tr("mcp.add_mcp")}
          </Button>
        </div>
      </div>

      <Show
        when={props.servers.length}
        fallback={
          <div class="rounded-inset border border-dashed border-dls-border px-5 py-10 text-center">
            <Unplug size={24} class="mx-auto text-dls-secondary/30 mb-3" />
            <div class="text-body-lg font-medium text-dls-secondary">{tr("mcp.no_apps_yet")}</div>
            <div class="text-caption text-dls-secondary/60 mt-1">{tr("mcp.no_apps_hint")}</div>
          </div>
        }
      >
        <div class="overflow-visible rounded-card border border-dls-panel-border bg-dls-panel-bg">
          <div class="hidden h-9 items-center gap-4 border-b border-dls-border px-4 text-tiny font-medium uppercase text-dls-secondary md:flex">
            <span class="min-w-0 flex-1 pl-8">{tr("common.name")}</span>
            <span class="w-32">{tr("mcp.status_label")}</span>
            <span class="w-[8.5rem]" />
          </div>
          <For each={sortedServers()}>
            {(entry) => {
              const status = () => resolveStatus(entry);
              const pendingAction = () => ownValue(props.connectingName, entry.name);
              const isReconnecting = () => pendingAction() !== undefined;
              const statusLabel = () => tr(statusLabelKey(status()));
              const command = () => (entry.config.type === "local" ? entry.config.command : undefined);
              const pending = () => {
                const action = pendingAction();
                return action ? pendingStatus(action, command()) : undefined;
              };
              const statusText = () => {
                const labelKey = pending()?.labelKey;
                return labelKey ? tr(labelKey) : statusLabel();
              };
              const statusTitle = () => {
                const hintKey = pending()?.hintKey;
                return hintKey ? tr(hintKey) : statusLabel();
              };
              const requiresAuthorization = () =>
                status() === "needs_auth" || status() === "needs_client_registration";
              const enabled = () => entry.config.enabled !== false;
              const isProjectSource = () => entry.source === undefined || entry.source === "config.project";
              const toggleLabel = () =>
                `${tr(enabled() ? "mcp.disable_app" : "mcp.enable_app")} ${entry.name}`;
              const expanded = () => expandedName() === entry.name;
              const detailsLabel = () =>
                `${tr(expanded() ? "mcp.hide_details" : "mcp.show_details")} ${entry.name}`;
              const policyEnabled = () => toolsAccess() !== null;

              return (
                <div class="border-b border-dls-border last:border-b-0">
                  <div
                    class={`relative flex min-h-14 items-center gap-3 px-4 py-2.5 hover:bg-dls-hover/70 ${policyEnabled() ? "cursor-pointer" : ""}`}
                    data-testid="mcp-connection-row"
                    onClick={() => {
                      if (policyEnabled()) setSelectedServerForPolicy(entry);
                    }}
                  >
                    <button
                      type="button"
                      class="flex h-6 w-6 shrink-0 items-center justify-center rounded-subtle text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                      aria-expanded={expanded()}
                      aria-label={detailsLabel()}
                      title={detailsLabel()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedName(expanded() ? null : entry.name);
                      }}
                    >
                      <ChevronRight size={14} class={`transition-transform ${expanded() ? "rotate-90" : ""}`} />
                    </button>

                    <div class="flex min-w-0 flex-1 items-center gap-2">
                      <div class="min-w-0 truncate text-body-lg font-medium text-dls-text">{entry.name}</div>
                      <Show when={entry.execution === "host"}>
                        <span
                          data-testid="mcp-host-badge"
                          title={tr("mcp.host.badge_hint")}
                          class="shrink-0 rounded-pill border border-dls-warning-border bg-dls-warning-bg px-2 py-0.5 text-tiny font-medium text-dls-warning-text"
                        >
                          {tr("mcp.host.badge")}
                        </span>
                      </Show>
                    </div>

                    <div class="flex w-28 shrink-0 items-center gap-2 md:w-32">
                      <Show when={isReconnecting()} fallback={<span class={`h-2 w-2 shrink-0 rounded-pill ${statusDot(status())}`} />}>
                        <Loader2 size={13} class="shrink-0 animate-spin text-dls-secondary" />
                      </Show>
                      <span
                        class={`truncate text-label font-medium ${status() === "connected" ? "text-dls-success-text" : status() === "disabled" || status() === "connecting" || status() === "on_demand" ? "text-dls-secondary" : "text-dls-warning-text"}`}
                        title={statusTitle()}
                      >
                        {statusText()}
                      </span>
                    </div>

                    <div class="flex w-[8.5rem] shrink-0 items-center justify-end gap-1">
                      <ToggleSwitch
                        checked={enabled()}
                        aria-label={toggleLabel()}
                        title={isProjectSource() ? toggleLabel() : tr("mcp.toggle_global_config")}
                        disabled={props.busy || isReconnecting() || !isProjectSource()}
                        onChange={(next) => props.setMcpEnabled(entry, next)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div class="flex w-8 shrink-0 justify-center">
                        <Show when={requiresAuthorization()}>
                          <button
                            type="button"
                            class={ROW_ACTION_CLASS}
                            aria-label={`${tr("mcp.login_action")} ${entry.name}`}
                            title={`${tr("mcp.login_action")} ${entry.name}`}
                            disabled={props.busy || isReconnecting()}
                            onClick={(e) => {
                              e.stopPropagation();
                              props.authorizeMcp(entry);
                            }}
                          >
                            <Show when={isReconnecting()} fallback={<LogIn size={16} />}>
                              <Loader2 size={16} class="animate-spin" />
                            </Show>
                          </button>
                        </Show>
                        <Show when={status() === "failed"}>
                          <button
                            type="button"
                            class={ROW_ACTION_CLASS}
                            aria-label={`${tr("mcp.reconnect_action")} ${entry.name}`}
                            title={`${tr("mcp.reconnect_action")} ${entry.name}`}
                            disabled={props.busy || isReconnecting()}
                            onClick={(e) => {
                              e.stopPropagation();
                              props.reconnectMcp(entry);
                            }}
                          >
                            <Show when={isReconnecting()} fallback={<RotateCw size={16} />}>
                              <Loader2 size={16} class="animate-spin" />
                            </Show>
                          </button>
                        </Show>
                      </div>
                      <button
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-subtle text-dls-secondary transition-colors hover:bg-dls-danger-bg hover:text-dls-danger-text disabled:opacity-50"
                        aria-label={`${tr("mcp.remove_app")} ${entry.name}`}
                        title={isProjectSource() ? `${tr("mcp.remove_app")} ${entry.name}` : tr("mcp.remove_global_config")}
                        disabled={!isProjectSource()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRemoveTarget(entry);
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>

                  <Show when={expanded()}>
                    <dl
                      class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 bg-dls-hover/40 px-4 py-3 pl-[3.25rem] text-label"
                      data-testid="mcp-connection-details"
                    >
                      <For each={details(entry)}>
                        {(row) => (
                          <>
                            <dt class="text-dls-secondary">{row.label}</dt>
                            <dd class="min-w-0 break-all font-mono text-dls-text">{row.value}</dd>
                          </>
                        )}
                      </For>
                    </dl>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      <ConfirmModal
        open={removeTarget() !== null}
        title={tr("mcp.remove_modal_title")}
        message={
          <div class="space-y-3">
            <p>{tr("mcp.remove_modal_message").replace("{server}", removeTarget()?.name ?? "")}</p>
          </div>
        }
        confirmLabel={tr("mcp.remove_app")}
        cancelLabel={tr("common.cancel")}
        variant="danger"
        size="md"
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget();
          if (target) props.removeMcp(target.name);
          setRemoveTarget(null);
        }}
      />

      <McpToolPolicyModal
        open={selectedServerForPolicy() !== null}
        serverName={selectedServerForPolicy()?.name ?? ""}
        tools={policyTools() ?? []}
        initialEnabledTools={(policyTools() ?? []).filter((tool) => tool.allowed).map((tool) => tool.name)}
        onSave={saveToolPolicy}
        onCancel={closeToolPolicyModal}
      />
    </div>
  );
}
