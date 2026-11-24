import { Show } from "solid-js";
import { Plus, Search } from "lucide-solid";

import { t } from "../../../i18n";
import { useSessionGlobalSearchOpen } from "~/features/session-global-search";

const rowClass =
  "flex w-full items-center justify-start gap-2 rounded-dialog border border-transparent bg-transparent px-[7px] py-2.5 text-left text-caption transition-colors hover:border-dls-border hover:bg-dls-hover hover:shadow-[var(--dls-card-shadow)] focus-visible:border-dls-border focus-visible:bg-dls-hover focus-visible:outline-none";

export function SidebarNewTaskRow(props: { label: string; disabled: boolean; onCreate: () => void }) {
  const openGlobalSessionSearch = useSessionGlobalSearchOpen();
  return (
    <div class="shrink-0 pb-2 space-y-1">
      <button
        type="button"
        class={`${rowClass} font-medium text-dls-secondary`}
        onClick={() => props.onCreate()}
        disabled={props.disabled}
        aria-label={props.label}
        data-testid="new-project-btn"
      >
        <Plus size={14} />
        {props.label}
      </button>
      <Show when={openGlobalSessionSearch}>
        <button
          type="button"
          data-testid="session-global-search-open"
          class={`${rowClass} text-dls-secondary hover:text-dls-text`}
          onClick={() => openGlobalSessionSearch?.()}
        >
          <Search size={14} class="shrink-0" />
          <span>{t("session.global_search_sidebar_label")}</span>
        </button>
      </Show>
    </div>
  );
}
