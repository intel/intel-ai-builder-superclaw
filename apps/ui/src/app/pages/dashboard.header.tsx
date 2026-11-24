import { Show } from "solid-js";
import { ArrowLeft, Menu } from "lucide-solid";

import { t } from "../../i18n";

export type DashboardHeaderProps = {
  title: string;
  /** Advanced and Data & Usage: Back replaces the sidebar toggle. */
  focused: boolean;
  onBack: () => void;
  /** Gets the toggle, which stays mounted while the drawer it opens comes and goes. */
  onOpenNavigation: (trigger: HTMLElement) => void;
  developerMode: boolean;
  headerStatus: string;
  busyHint: string | null;
};

export default function DashboardHeader(props: DashboardHeaderProps) {
  return (
    <header class="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-dls-border bg-dls-surface px-4 md:px-6">
      <div class="flex min-w-0 items-center gap-3">
        <Show
          when={!props.focused}
          fallback={
            <button
              type="button"
              data-testid="dashboard-back-to-sessions"
              class="-ml-2 flex h-8 shrink-0 items-center gap-[9px] rounded-control px-2 text-body font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={() => props.onBack()}
              aria-label={t("dashboard.back")}
            >
              <ArrowLeft size={18} />
              {t("dashboard.back")}
            </button>
          }
        >
          {/* Sidebar toggle – visible only on small screens */}
          <button
            type="button"
            class="lg:hidden flex h-8 w-8 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={(event) => props.onOpenNavigation(event.currentTarget)}
            aria-label={t("dashboard.open_navigation")}
            title={t("dashboard.navigation")}
          >
            <Menu size={18} />
          </button>
        </Show>
        <h1 class="truncate text-title leading-title font-semibold text-dls-text">{props.title}</h1>

        <Show when={props.developerMode}>
          <span class="hidden text-caption text-dls-secondary lg:inline">{props.headerStatus}</span>
        </Show>
        <Show when={props.busyHint}>
          <span class="hidden text-caption text-dls-secondary lg:inline">{props.busyHint}</span>
        </Show>
      </div>
    </header>
  );
}
