/**
 * The right pane of the Settings dialog while its search has a query (#3836):
 * matching settings grouped by section, or a line saying nothing matched.
 *
 * The rows are the options of a listbox the search field drives through
 * `aria-activedescendant`, so focus stays in the field while the arrow keys
 * move the highlight; a press on a row is kept from taking focus for the same
 * reason.
 */
import { For, Show } from "solid-js";

import { t } from "../../i18n";
import { entryPath, type SettingsSearchEntry, type SettingsSearchGroup } from "./settings-search.registry";

export type SettingsSearchResultsProps = {
  query: string;
  groups: SettingsSearchGroup[];
  activeId: string | null;
  listboxId: string;
  optionId: (entryId: string) => string;
  onActivate: (entryId: string) => void;
  onPick: (entry: SettingsSearchEntry) => void;
};

export default function SettingsSearchResults(props: SettingsSearchResultsProps) {
  const count = () => props.groups.reduce((total, group) => total + group.results.length, 0);

  return (
    <div class="h-full overflow-y-auto bg-dls-surface-solid" data-testid="settings-search-results">
      <div class="mx-auto w-full max-w-[1100px] p-6 md:p-8">
        <p class="sr-only" aria-live="polite">
          {t("settings_search.result_count").replace("{count}", String(count()))}
        </p>
        <Show
          when={count() > 0}
          fallback={
            <div class="py-16 text-center" data-testid="settings-search-empty">
              <div class="text-body-lg font-medium text-dls-text">
                {t("settings_search.no_results").replace("{query}", props.query.trim())}
              </div>
              <div class="mt-1 text-caption text-dls-secondary">{t("settings_search.no_results_hint")}</div>
            </div>
          }
        >
          <div
            role="listbox"
            id={props.listboxId}
            aria-label={t("settings_search.results_label")}
            class="space-y-6"
          >
            <For each={props.groups}>
              {(group) => (
                <div role="group" aria-label={t(group.section.labelKey)} class="space-y-1">
                  <div
                    aria-hidden="true"
                    class="px-3 pb-1 text-label font-semibold uppercase tracking-wider text-dls-secondary"
                  >
                    {t(group.section.labelKey)}
                  </div>
                  <For each={group.results}>
                    {(result) => {
                      const active = () => props.activeId === result.entry.id;
                      const path = () => entryPath(result.entry).join(" › ");
                      return (
                        <div
                          role="option"
                          id={props.optionId(result.entry.id)}
                          aria-selected={active()}
                          data-testid={`settings-search-result-${result.entry.id}`}
                          class={`cursor-pointer rounded-control px-3 py-2 transition-colors duration-150 ${
                            active() ? "bg-dls-active" : "hover:bg-dls-hover"
                          }`}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseMove={() => {
                            if (!active()) props.onActivate(result.entry.id);
                          }}
                          onClick={() => props.onPick(result.entry)}
                        >
                          <div class="text-body-lg font-medium text-dls-text">{t(result.entry.labelKey)}</div>
                          <Show when={path()}>
                            <div class="text-caption text-dls-secondary">{path()}</div>
                          </Show>
                          <Show when={result.entry.descriptionKey}>
                            {(key) => <div class="mt-0.5 truncate text-caption text-dls-secondary">{t(key())}</div>}
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
