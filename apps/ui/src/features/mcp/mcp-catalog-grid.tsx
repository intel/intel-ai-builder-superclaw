import { For, Show, createMemo, createSignal } from "solid-js";
import { ChevronDown, Loader2 } from "lucide-solid";
import type { McpStatusMap } from "~/shared/types/mcp";
import type { McpDirectoryInfo } from "~/shared/util/constants";
import { statusBadgeStyle, statusLabelKey, toSlug } from "./mcp-view-status";
import { currentLocale, t } from "../../i18n";

export type McpCatalogGridProps = {
  busy: boolean;
  /** Catalog entries not yet configured. */
  entries: McpDirectoryInfo[];
  statuses: McpStatusMap;
  connectingName: Record<string, string>;
  onSelect: (entry: McpDirectoryInfo) => void;
};

const MCP_CATALOG_PREVIEW_COUNT = 3;

export default function McpCatalogGrid(props: McpCatalogGridProps) {
  const tr = (key: string) => t(key, currentLocale());
  const [expanded, setExpanded] = createSignal(false);

  const visibleEntries = createMemo(() =>
    expanded() ? props.entries : props.entries.slice(0, MCP_CATALOG_PREVIEW_COUNT),
  );

  const entryStatus = (name: string) => props.statuses[toSlug(name)] ?? props.statuses[name];

  return (
    <Show when={props.entries.length > 0}>
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-label font-bold text-dls-secondary uppercase tracking-widest">
            {tr("mcp.available_apps")}
          </h3>
          <Show when={props.entries.length > MCP_CATALOG_PREVIEW_COUNT}>
            <button
              type="button"
              class="flex h-8 items-center gap-1.5 rounded-subtle px-2.5 text-caption font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-expanded={expanded()}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded()
                ? tr("mcp.show_fewer_catalog")
                : tr("mcp.show_all_catalog").replace("{count}", String(props.entries.length))}
              <ChevronDown size={14} class={`transition-transform ${expanded() ? "rotate-180" : ""}`} />
            </button>
          </Show>
        </div>

        <div class="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 animate-in fade-in slide-in-from-top-1 duration-200">
          <For each={visibleEntries()}>
            {(entry) => {
              const connecting = () => props.connectingName[toSlug(entry.name)] !== undefined;

              return (
                <button
                  type="button"
                  data-testid="mcp-catalog-card"
                  disabled={props.busy || connecting()}
                  onClick={() => props.onSelect(entry)}
                  class="group text-left rounded-control border border-dls-panel-border bg-dls-panel-bg p-3.5 transition-all hover:bg-dls-hover hover:shadow-[var(--dls-card-shadow-grid-hover)]"
                >
                  <div class="flex items-start gap-3">
                    <div class="w-9 h-9 rounded-subtle flex items-center justify-center shrink-0 border border-dls-border bg-white">
                      <Show
                        when={!connecting()}
                        fallback={<Loader2 size={18} class="animate-spin text-dls-secondary" />}
                      >
                        <img
                          src={entry.logo}
                          alt=""
                          class="h-5 w-5 object-contain"
                        />
                      </Show>
                    </div>

                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <h4 class="text-body-lg font-semibold text-dls-text">{entry.name}</h4>
                        <Show when={entryStatus(entry.name)}>
                          {(status) => (
                            <span class={`text-tiny font-medium px-1.5 py-0.5 rounded-subtle ${statusBadgeStyle(status().status)}`}>
                              {tr(statusLabelKey(status().status))}
                            </span>
                          )}
                        </Show>
                      </div>
                      <p class="text-caption text-dls-secondary mt-0.5 line-clamp-2">
                        {entry.description}
                      </p>
                      <Show when={!connecting()}>
                        <div class="mt-2 text-label font-medium text-dls-info-text group-hover:text-dls-info-text transition-colors">
                          {tr("mcp.tap_to_connect")}
                        </div>
                      </Show>
                    </div>
                  </div>
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}
