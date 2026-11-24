import { For, Show, createMemo } from "solid-js";
import { Terminal } from "lucide-solid";

import { t } from "../../../i18n";
import type { SlashCommandOption } from "../../types";
import type { ComposerSlash } from "./composer.slash";

/** The `/command` popup above the composer. */
export default function SlashPicker(props: { slash: ComposerSlash }) {
  return (
    <Show when={props.slash.open()}>
      <div class="absolute bottom-full left-[-1px] right-[-1px] z-30">
        <div class="overflow-hidden rounded-t-dialog border border-dls-panel-border border-b-0 bg-dls-surface-solid shadow-[var(--dls-shell-shadow)]">
          <div
            class="max-h-64 overflow-y-auto bg-dls-surface-solid p-2"
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
          >
            <Show
              when={props.slash.filtered().length}
              fallback={
                <div class="px-3 py-2 text-caption text-dls-secondary">
                  {props.slash.loading()
                    ? t("composer.loading_commands")
                    : t("composer.no_commands_found")}
                </div>
              }
            >
              <For each={props.slash.filtered()}>
                {(cmd: SlashCommandOption, index) => (
                  <button
                    type="button"
                    class={`w-full flex items-center justify-between gap-4 rounded-control px-3 py-2.5 text-left transition-colors ${
                      props.slash.index() === index()
                        ? "bg-dls-panel-hover-bg text-dls-text"
                        : "text-dls-secondary hover:bg-dls-panel-hover-bg"
                    }`}
                    onMouseDown={(event: MouseEvent) => {
                      event.preventDefault();
                      props.slash.select(cmd);
                    }}
                    onMouseEnter={() => props.slash.setIndex(index())}
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <Terminal size={14} class="text-dls-secondary shrink-0" />
                      <span class="text-caption font-semibold whitespace-nowrap">
                        /{cmd.name}
                      </span>
                      <Show when={cmd.description}>
                        <span class="text-caption truncate">
                          {cmd.description}
                        </span>
                      </Show>
                    </div>
                    <Show when={cmd.source && cmd.source !== "command"}>
                      <span class="text-tiny uppercase tracking-wider shrink-0">
                        {cmd.source === "skill" ? "Skill" : "MCP"}
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
