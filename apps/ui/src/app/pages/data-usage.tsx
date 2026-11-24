import { createMemo, createSignal, Show } from "solid-js";
import type { WorkspaceSessionGroup, Client } from "../types";
import type { OpenworkServerClient } from "../lib/openwork-server";
import TokenUsageView from "./token-usage";
import { t } from "../../i18n";
import PiiStatsView from "./pii-stats";

import type { LlmRouterClient } from "../lib/llmrouter-client";

type DataSubTab = "tokens" | "pii";

export type DataUsageViewProps = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  opencodeClient?: Client | null;
  openworkServerClient: OpenworkServerClient | null;
  openworkServerWorkspaceId: string | null;
  llmRouterClient?: LlmRouterClient | null;
};

export default function DataUsageView(props: DataUsageViewProps) {
  const [subTab, setSubTab] = createSignal<DataSubTab>("tokens");

  // A signature over the workspace's session ids; changes whenever a session
  // is added or removed so PiiStatsView can refresh its aggregate totals.
  const sessionsSignature = createMemo(() => {
    const ids: string[] = [];
    for (const group of props.workspaceSessionGroups) {
      for (const s of group.sessions) ids.push(s.id);
    }
    ids.sort();
    return ids.join(",");
  });

  return (
    <div class="h-full flex flex-col">
      <div class="flex items-center gap-6 border-b border-dls-border pb-4 mb-4">
        <button
          class={`pb-3 -mb-[17px] text-body-lg font-medium border-b-2 transition-colors ${
            subTab() === "tokens"
              ? "border-dls-accent text-dls-text"
              : "border-transparent text-dls-secondary hover:text-dls-text"
          }`}
          onClick={() => setSubTab("tokens")}
        >
          {t("token.usage_title")}
        </button>
      </div>
      <div class="flex-1">
        <Show when={subTab() === "tokens"}>
          <TokenUsageView
            workspaceSessionGroups={props.workspaceSessionGroups}
            client={props.opencodeClient}
            llmRouterClient={props.llmRouterClient}
          />
        </Show>
      </div>
    </div>
  );
}
