import { For, Show } from "solid-js";
import { Bot, Mail, Search, Terminal } from "lucide-solid";

import { t } from "../../i18n";
import { Tooltip } from "~/shared/ui/tooltip";
import type { QuickAgent } from "./session.quick-agents";

export function QuickAgentChips(props: {
  agents: QuickAgent[];
  hidden: boolean;
  selectedAgent: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Show when={!props.hidden && props.agents.length > 0}>
      <div class="w-full bg-dls-surface">
        <div class="mx-auto w-full max-w-[900px] px-4 flex items-center justify-center gap-4 pb-2.5 pt-1">
          <For each={props.agents}>
            {(agent) => (
              <Tooltip
                content={
                  agent.id === "build"
                    ? t("composer.hybrid_coding_agent_privacy_tooltip")
                    : t(agent.descriptionKey)
                }
              >
                <button
                  type="button"
                  data-testid={`agent-btn-${agent.id}`}
                  aria-pressed={props.selectedAgent === agent.id}
                  class={`flex items-center gap-2 rounded-pill border px-3.5 py-1.5 text-caption font-medium transition-colors ${
                    props.selectedAgent === agent.id
                      ? "border-dls-border bg-dls-active text-dls-text"
                      : "border-dls-border/60 bg-dls-surface text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                  }`}
                  onClick={() => props.onSelect(agent.id)}
                >
                  <Show when={agent.id === "build"}>
                    <Terminal size={14} />
                  </Show>
                  <Show when={agent.id === "hybrid-deep-research"}>
                    <Search size={14} />
                  </Show>
                  <Show when={agent.id === "email-agent"}>
                    <Mail size={14} />
                  </Show>
                  <Show
                    when={
                      agent.id !== "build" &&
                      agent.id !== "hybrid-deep-research" &&
                      agent.id !== "email-agent"
                    }
                  >
                    <Bot size={14} />
                  </Show>
                  {t(agent.nameKey)}
                  <Show when={agent.badgeKey}>
                    {(badgeKey) => (
                      <span class="rounded-pill bg-dls-hover px-1.5 py-0.5 text-tiny font-semibold leading-none text-dls-secondary">
                        {t(badgeKey())}
                      </span>
                    )}
                  </Show>
                </button>
              </Tooltip>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
