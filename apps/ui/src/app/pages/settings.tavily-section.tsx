import { Show, createSignal } from "solid-js";
import { Search } from "lucide-solid";
import type { TavilyKeyRequestStatus, TavilyKeyView } from "~/features/tavily-api-key";
import { t } from "../../i18n";
import TavilyKeyRow from "./settings.tavily-key-row";

export type TavilySectionProps = {
  view: TavilyKeyView;
  status: TavilyKeyRequestStatus;
  save: (apiKey: string) => Promise<void>;
  clear: () => Promise<void>;
  retry: () => Promise<void>;
};

/** Web search on the Connections page: the Tavily key the host holds. */
export default function TavilySection(props: TavilySectionProps) {
  const [status, setStatus] = createSignal<string | null>(null);

  return (
    <div class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-4">
      <div>
        <div class="flex items-center gap-2">
          <Search size={16} class="text-dls-secondary" />
          <div class="text-body-lg font-medium text-dls-text">
            {t("settings.search_title")}
          </div>
        </div>
      </div>

      <TavilyKeyRow
        view={props.view}
        status={props.status}
        save={props.save}
        clear={props.clear}
        retry={props.retry}
        onStatus={setStatus}
      />
      <Show when={status()}>
        {(message) => <div class="text-caption text-dls-secondary">{message()}</div>}
      </Show>
    </div>
  );
}
