import { For, Show } from "solid-js";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import { AtSign, Check, ChevronDown } from "lucide-solid";
import { t } from "../../../i18n";
import { Tooltip } from "~/shared/ui/tooltip";

type ComposerAgentPickerProps = {
  busy: boolean;
  agentLabel: string;
  selectedAgent: string | null;
  open: boolean;
  loading: boolean;
  ready: boolean;
  error: string | null;
  options: Agent[];
  displayNames?: Record<string, string>;
  onToggle: () => void;
  onRetry: () => void;
  onSelect: (agent: string | null) => void;
  setRef: (element: HTMLDivElement) => void;
};

export function ComposerAgentPicker(props: ComposerAgentPickerProps) {
  return (
    <div
      class="relative"
      ref={props.setRef}
      data-tour-id="composer-agent"
    >
      <Tooltip
        content={t("dashboard.tab_agent")}
        placement="bottom"
        disabled={props.open}
      >
        <button
          type="button"
          data-testid="agent-picker-toggle"
          data-agent={props.selectedAgent ?? ""}
          class="flex items-center gap-1.5 rounded-control px-2 py-1.5 text-body font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
          onClick={props.onToggle}
          disabled={props.busy}
          aria-expanded={props.open}
        >
          <AtSign size={14} />
          <span class="truncate leading-5">{props.agentLabel}</span>
          <ChevronDown
            size={14}
            class="transition-transform duration-200"
            classList={{ "rotate-180": props.open }}
          />
        </button>
      </Tooltip>

      <Show when={props.open}>
        <div class="absolute left-0 bottom-full z-40 mb-2 w-64 overflow-hidden rounded-dialog border border-dls-border bg-dls-surface-solid shadow-[var(--dls-shell-shadow)]">
          <div class="border-b border-dls-border px-3 pt-2 pb-1 text-tiny font-semibold uppercase tracking-[0.2em] text-dls-secondary">
            {t("dashboard.tab_agent")}
          </div>

          <div
            class="p-2 space-y-1 max-h-64 overflow-y-auto"
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
          >
            <Show
              when={!props.loading || props.ready}
              fallback={
                <div class="px-3 py-2 text-caption text-dls-secondary">
                  {t("composer.loading_agents")}
                </div>
              }
            >
              <Show when={!props.error}>
                <button
                  type="button"
                  class={`w-full flex items-center justify-between rounded-control px-3 py-2 text-left text-caption transition-colors ${
                    !props.selectedAgent
                      ? "bg-dls-hover text-dls-text"
                      : "text-dls-secondary hover:bg-dls-hover/70"
                  }`}
                  onClick={() => props.onSelect(null)}
                >
                  <span>{t("composer.agent_general_default")}</span>
                  <Show when={!props.selectedAgent}>
                    <Check size={14} class="text-dls-secondary" />
                  </Show>
                </button>

                <For each={props.options}>
                  {(agent: Agent) => {
                    const active = () => props.selectedAgent === agent.name;
                    const displayName = () =>
                      props.displayNames?.[agent.name] ?? agent.name;
                    return (
                      <button
                        type="button"
                        data-testid="agent-picker-option"
                        data-agent={agent.name}
                        class={`w-full flex items-center justify-between rounded-control px-3 py-2 text-left text-caption transition-colors ${
                          active()
                            ? "bg-dls-hover text-dls-text"
                            : "text-dls-secondary hover:bg-dls-hover/70"
                        }`}
                        onClick={() => props.onSelect(agent.name)}
                      >
                        <span class="truncate">@{displayName()}</span>
                        <Show when={active()}>
                          <Check size={14} class="text-dls-secondary" />
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </Show>

              <Show when={props.error}>
                <button
                  type="button"
                  class="w-full px-3 py-2 text-caption text-dls-danger-text text-left hover:bg-dls-hover rounded-control transition-colors"
                  onMouseDown={(event: MouseEvent) => {
                    event.preventDefault();
                    props.onRetry();
                  }}
                >
                  {props.error}
                </button>
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
