import { For, Show } from "solid-js";
import { AtSign, File as FileIcon } from "lucide-solid";

import { t } from "../../../i18n";
import type { ComposerMentions } from "./composer.mentions";
import type { MentionOption } from "./composer.types";

/** Splits a file path so the directory greys out behind the file name. */
function splitPath(value: string) {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return {
    dir: slash === -1 ? "" : value.slice(0, slash + 1),
    name: slash === -1 ? value : value.slice(slash + 1),
  };
}

/** The `@` mention popup above the composer. */
export default function MentionPicker(props: { mentions: ComposerMentions }) {
  return (
    <Show when={props.mentions.open()}>
      <div
        ref={props.mentions.setPickerRef}
        class="absolute bottom-full left-[-1px] right-[-1px] z-30"
      >
        <div class="overflow-hidden rounded-t-dialog border border-dls-panel-border border-b-0 bg-dls-surface-solid shadow-[var(--dls-shell-shadow)]">
          <div
            class="max-h-64 overflow-y-auto bg-dls-surface-solid p-2"
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
          >
            <Show
              when={props.mentions.visible().length}
              fallback={
                <div class="px-3 py-2 text-caption text-dls-secondary">
                  {t("composer.no_matches_found")}
                </div>
              }
            >
              <For each={props.mentions.visible()}>
                {(option: MentionOption, index) => {
                  // visible() is a prefix of options(), so a rendered row's
                  // index is already its index in the navigable list.
                  const path = splitPath(option.value);
                  return (
                    <button
                      type="button"
                      class={`w-full flex items-center gap-2 rounded-control px-3 py-2.5 text-left transition-colors ${
                        props.mentions.index() === index()
                          ? "bg-dls-panel-hover-bg text-dls-text"
                          : "text-dls-secondary hover:bg-dls-panel-hover-bg"
                      }`}
                      onMouseDown={(event: MouseEvent) => {
                        event.preventDefault();
                        props.mentions.insert(option);
                      }}
                      onMouseEnter={() => props.mentions.setIndex(index())}
                    >
                      <Show
                        when={option.kind === "agent"}
                        fallback={
                          <>
                            <FileIcon size={14} class="text-dls-secondary" />
                            <div class="flex items-center min-w-0 text-caption">
                              <span class="text-dls-secondary truncate">
                                {path.dir}
                              </span>
                              <span class="font-semibold">
                                {path.name}
                              </span>
                            </div>
                          </>
                        }
                      >
                        <AtSign size={14} class="text-dls-secondary" />
                        <span class="text-caption font-semibold">
                          @{option.label}
                        </span>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
