import { Index, Show, type JSX } from "solid-js";
import { Github, Loader2, Search } from "lucide-solid";

import ToggleSwitch from "~/shared/ui/toggle-switch";
import { t } from "../../i18n";
import { GmailIcon, SlackIcon, TelegramIcon } from "./identities.channel-icons";
import { CONNECTION_SEARCH_ANCHORS, type ConnectionId, type ConnectionRow, type ConnectionStatus } from "./identities.connection-rows";

export type ConnectionNotice = { tone: "info" | "error"; text: string };

const ICONS: Record<ConnectionId, () => JSX.Element> = {
  slack: () => <SlackIcon size={20} />,
  telegram: () => <TelegramIcon size={20} />,
  github: () => <Github size={18} class="text-dls-panel-icon" />,
  tavily: () => <Search size={18} class="text-dls-panel-icon" />,
  gmail: () => <GmailIcon size={20} />,
};

const DOT: Record<Exclude<ConnectionStatus, "loading">, string> = {
  connected: "bg-dls-success-dot",
  paused: "bg-dls-secondary",
  not_connected: "bg-dls-panel-dot",
  attention: "bg-dls-warning-dot",
  unavailable: "bg-dls-panel-dot",
};

const TEXT: Record<ConnectionStatus, string> = {
  connected: "text-dls-success-text",
  paused: "text-dls-secondary",
  not_connected: "text-dls-secondary",
  attention: "text-dls-warning-text",
  unavailable: "text-dls-secondary",
  loading: "text-dls-secondary",
};

export const connectionName = (id: ConnectionId) => t(`connections.name_${id}`);

/** One row per connection, as the MCP list has: name, status and a toggle. The row opens setup; the toggle does not. */
export default function ConnectionList(props: {
  rows: ConnectionRow[];
  busy: ConnectionId | null;
  notices: Partial<Record<ConnectionId, ConnectionNotice>>;
  onOpen: (id: ConnectionId) => void;
  onToggle: (id: ConnectionId, next: boolean) => void;
}) {
  return (
    <div class="overflow-hidden rounded-card border border-dls-panel-border bg-dls-panel-bg" data-testid="connection-list">
      <div class="hidden h-9 items-center gap-4 border-b border-dls-border px-4 text-tiny font-medium uppercase text-dls-secondary md:flex">
        <span class="min-w-0 flex-1 pl-8">{t("common.name")}</span>
        <span class="w-36">{t("connections.status_label")}</span>
        <span class="w-16" />
      </div>
      <Index each={props.rows}>
        {(row) => {
          const name = () => connectionName(row().id);
          const busy = () => props.busy === row().id;
          const notice = () => props.notices[row().id];
          return (
            <div class="border-b border-dls-border last:border-b-0">
              <div
                role="button"
                tabindex="0"
                data-testid={`connection-row-${row().id}`}
                data-settings-anchor={CONNECTION_SEARCH_ANCHORS[row().id]}
                data-status={row().status}
                aria-label={`${t("connections.open_setup")} ${name()}`}
                class="flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-dls-hover/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.3)]"
                onClick={() => props.onOpen(row().id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  props.onOpen(row().id);
                }}
              >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center">{ICONS[row().id]()}</span>
                <span class="min-w-0 flex-1 truncate text-body-lg font-medium text-dls-text">{name()}</span>
                <span class="flex w-28 shrink-0 items-center gap-2 md:w-36">
                  <Show
                    when={!busy() && row().status !== "loading"}
                    fallback={<Loader2 size={13} class="shrink-0 animate-spin text-dls-secondary" />}
                  >
                    <span class={`h-2 w-2 shrink-0 rounded-pill ${DOT[row().status as keyof typeof DOT]}`} />
                  </Show>
                  <span class={`truncate text-label font-medium ${TEXT[row().status]}`} data-testid={`connection-status-${row().id}`}>
                    {t(`connections.status_${row().status}`)}
                  </span>
                </span>
                <span class="flex w-16 shrink-0 justify-end">
                  <Show
                    when={row().status !== "loading"}
                    fallback={<span class="h-8 w-16" data-testid={`connection-toggle-pending-${row().id}`} />}
                  >
                    <ToggleSwitch
                      data-testid={`connection-toggle-${row().id}`}
                      checked={row().enabled}
                      aria-label={`${t("connections.toggle_label")} ${name()}`}
                      disabled={!row().switchable || busy()}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(next) => props.onToggle(row().id, next)}
                    />
                  </Show>
                </span>
              </div>
              <Show when={notice()}>
                {(value) => (
                  <div
                    data-testid={`connection-notice-${row().id}`}
                    class={`px-4 pb-2.5 pl-[3.25rem] text-label ${value().tone === "error" ? "text-dls-danger-text" : "text-dls-secondary"}`}
                  >
                    {value().text}
                  </div>
                )}
              </Show>
            </div>
          );
        }}
      </Index>
    </div>
  );
}
