import { For, Show, createEffect, createSignal } from "solid-js";
import { Server, X } from "lucide-solid";
import type { McpTool } from "@different-ai/openwork-contracts/mcp";
import Button from "~/shared/ui/button";
import ToggleSwitch from "~/shared/ui/toggle-switch";
import { currentLocale, t } from "../../i18n";

export interface McpToolPolicyModalProps {
  open: boolean;
  serverName: string;
  tools: McpTool[];
  /** Tool names currently allowed. Falls back to every listed tool when omitted. */
  initialEnabledTools?: string[];
  onSave: (enabledToolNames: string[]) => Promise<void> | void;
  onCancel: () => void;
}

/** Per-server allow/deny editor for every listed tool, opened from the server row. */
export default function McpToolPolicyModal(props: McpToolPolicyModalProps) {
  const tr = (key: string) => t(key, currentLocale());
  const [enabledSet, setEnabledSet] = createSignal<Set<string>>(new Set());
  const [expandedSet, setExpandedSet] = createSignal<Set<string>>(new Set());

  createEffect(() => {
    if (props.open) {
      const enabledNames: string[] = props.initialEnabledTools ?? props.tools.map((tool) => tool.name);
      setEnabledSet(new Set<string>(enabledNames));
      setExpandedSet(new Set<string>());
    }
  });

  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!props.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        props.onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const toggleTool = (name: string, checked: boolean) => {
    const next = new Set(enabledSet());
    if (checked) next.add(name);
    else next.delete(name);
    setEnabledSet(next);
  };

  const toggleExpand = (name: string) => {
    const next = new Set(expandedSet());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpandedSet(next);
  };

  const enableAll = () => {
    setEnabledSet(new Set<string>(props.tools.map((tool) => tool.name)));
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center p-4 dls-modal-backdrop"
        data-testid="mcp-tool-policy-modal"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onCancel();
        }}
      >
        <div class="flex max-h-[85vh] w-full max-w-[580px] flex-col border dls-modal-surface">
          {/* Header with Server Rack Squircle */}
          <div class="flex items-center justify-between border-b border-dls-border px-6 py-4">
            <div class="flex items-center gap-3">
              {/* Server Rack Squircle */}
              <div class="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-control border border-dls-border bg-dls-hover text-dls-text shadow-sm">
                <Server size={20} />
              </div>

              {/* Title & Subhead */}
              <div>
                <div class="flex items-center gap-2">
                  <span class="inline-flex h-6 items-center rounded-subtle border border-dls-border bg-dls-hover px-2 font-mono text-body font-semibold text-dls-text">
                    {props.serverName}
                  </span>
                  <span class="rounded-compact bg-dls-hover px-1.5 py-0.5 text-caption font-medium text-dls-secondary">
                    {tr("mcp.tool_policy_tools_count").replace("{count}", String(props.tools.length))}
                  </span>
                </div>
                <p class="mt-0.5 text-caption text-dls-secondary">
                  {tr("mcp.tool_policy_subtitle")}
                </p>
              </div>
            </div>

            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-subtle text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
              onClick={props.onCancel}
              title={`${tr("common.close")} (Esc)`}
            >
              <X size={16} />
            </button>
          </div>

          {/* Tools List */}
          <div class="flex-1 overflow-y-auto px-6 py-4">
            <div class="divide-y divide-dls-border rounded-control border border-dls-border bg-dls-surface">
              <Show when={props.tools.length === 0}>
                <div class="px-3.5 py-6 text-center text-body text-dls-secondary">
                  {tr("mcp.tools_empty")}
                </div>
              </Show>
              <For each={props.tools}>
                {(tool) => {
                  const isEnabled = () => enabledSet().has(tool.name);
                  const isLong = tool.description ? tool.description.length > 115 : false;
                  const isExpanded = () => expandedSet().has(tool.name);

                  return (
                    <div class="flex items-start justify-between gap-4 p-3.5 transition-colors hover:bg-dls-hover/40">
                      <div class="min-w-0 flex-1">
                        <div class="font-mono text-body font-semibold text-dls-text">
                          {tool.name}
                        </div>
                        <div
                          class={`mt-1 text-body leading-relaxed text-dls-secondary ${
                            isLong && !isExpanded() ? "line-clamp-2" : ""
                          }`}
                        >
                          {tool.description || tr("mcp.tool_policy_no_description")}
                        </div>
                        <Show when={isLong}>
                          <button
                            type="button"
                            class="mt-1.5 text-caption font-medium text-dls-accent hover:underline"
                            onClick={() => toggleExpand(tool.name)}
                          >
                            {isExpanded()
                              ? `${tr("mcp.tool_policy_show_less")} ▴`
                              : `${tr("mcp.tool_policy_show_more")} ▾`}
                          </button>
                        </Show>
                      </div>

                      {/* Switch */}
                      <div class="pt-0.5">
                        <ToggleSwitch
                          aria-label={`${tr("mcp.tools_allow_tool")} ${tool.name}`}
                          checked={isEnabled()}
                          onChange={(next) => toggleTool(tool.name, next)}
                        />
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-between border-t border-dls-border px-6 py-3">
            <div class="flex items-center gap-2 text-body text-dls-secondary">
              <span class="h-2 w-2 rounded-pill bg-dls-success-dot" />
              <span>
                {tr("mcp.tool_policy_enabled_count")
                  .replace("{enabled}", String(enabledSet().size))
                  .replace("{total}", String(props.tools.length))}
              </span>
              <span>·</span>
              <button
                type="button"
                class="font-medium text-dls-accent hover:underline"
                onClick={enableAll}
              >
                {tr("mcp.tool_policy_enable_all")}
              </button>
            </div>

            <div class="flex items-center gap-2">
              <Button variant="ghost" onClick={props.onCancel}>
                {tr("common.cancel")}
              </Button>
              <Button variant="secondary" onClick={() => props.onSave(Array.from(enabledSet()))}>
                {tr("common.save")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
