import { Show, createMemo, createSignal } from "solid-js";
import { X } from "lucide-solid";
import type {
  McpToolListResponse, McpToolPolicyResponse, McpToolPolicyUpdateRequest,
} from "@different-ai/openwork-contracts/mcp";
import type { McpServerEntry, McpStatusMap } from "~/shared/types/mcp";
import type { McpDirectoryInfo } from "~/shared/util/constants";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import AddMcpModal, { type LocalCommandBlock } from "./add-mcp-modal";
import type { McpConnectResult, McpPlacement } from "./mcp-host-placement";
import McpCatalogForm from "./mcp-catalog-form";
import McpCatalogGrid from "./mcp-catalog-grid";
import McpServersList from "./mcp-servers-list";
import { toSlug, type McpPendingMap } from "./mcp-view-status";
import { useMcpStatusRefresh } from "./useMcpServers";
import { currentLocale, t } from "../../i18n";

export type McpViewProps = {
  busy: boolean;
  activeWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  mcpServers: McpServerEntry[];
  mcpBrowserSandboxRefusal: boolean;
  dismissMcpBrowserSandboxRefusal: () => void;
  /** A change refused with `mcp_host_execution_disabled`. */
  mcpHostExecutionRefusal?: boolean;
  dismissMcpHostExecutionRefusal?: () => void;
  mcpStdioExitedOnStart: string | null;
  dismissMcpStdioExitedOnStart: () => void;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: McpPendingMap;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => void;
  /** Adds a local command on the host. Absent, or null, when the host MCP gateway is not there. */
  connectMcpPlaced?: ((entry: McpDirectoryInfo, placement: McpPlacement) => Promise<McpConnectResult>) | null;
  reconnectMcp: (entry: McpServerEntry) => void;
  setMcpEnabled: (entry: McpServerEntry, enabled: boolean) => void;
  authorizeMcp: (entry: McpServerEntry) => void;
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
  refreshMcpServers?: () => Promise<void> | void;
  /** Used only by the Product Profile-gated Tools panel. */
  listMcpTools?: (name: string) => Promise<McpToolListResponse>;
  setMcpToolPolicy?: (name: string, request: McpToolPolicyUpdateRequest) => Promise<McpToolPolicyResponse>;
};

function Notice(props: { text: string; onDismiss: () => void }) {
  const tr = (key: string) => t(key, currentLocale());
  return (
    <div role="status" class="relative rounded-control border border-dls-border bg-dls-surface-solid py-3 pl-4 pr-9 text-body-lg text-dls-text">
      {props.text}
      <button
        type="button"
        class="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-subtle text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
        aria-label={tr("mcp.dismiss_status")}
        title={tr("mcp.dismiss_status")}
        onClick={() => props.onDismiss()}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default function McpView(props: McpViewProps) {
  const locale = () => currentLocale();
  const tr = (key: string) => t(key, locale());
  useMcpStatusRefresh(() => props.refreshMcpServers?.());
  const [addMcpModalOpen, setAddMcpModalOpen] = createSignal(false);
  const [catalogEntry, setCatalogEntry] = createSignal<McpDirectoryInfo | null>(null);

  const capability = useCapabilityGate();
  const localCommandBlock = (): LocalCommandBlock =>
    capability.mcpLocalCommandEnabled() ? null : "profile";

  const configuredSlugs = createMemo(() => new Set(props.mcpServers.map((e) => toSlug(e.name))));
  const quickConnectList = createMemo(() =>
    props.quickConnect.filter((entry) =>
      !configuredSlugs().has(toSlug(entry.name))
      && !(localCommandBlock() && entry.command?.length)));

  const selectCatalogEntry = (entry: McpDirectoryInfo) => {
    if (entry.setup?.inputs.length) {
      setCatalogEntry(entry);
    } else {
      props.connectMcp(entry);
    }
  };

  return (
    <section class="flex flex-col gap-8 animate-in fade-in duration-300">
      <Show when={props.mcpBrowserSandboxRefusal}>
        <Notice text={tr("mcp.browser_unsupported_in_sandbox")} onDismiss={props.dismissMcpBrowserSandboxRefusal} />
      </Show>
      <Show when={props.mcpHostExecutionRefusal}>
        <Notice
          text={tr("mcp.host_execution_disabled")}
          onDismiss={() => props.dismissMcpHostExecutionRefusal?.()}
        />
      </Show>
      <Show when={props.mcpStdioExitedOnStart}>
        {(server) => (
          <Notice
            text={tr("mcp.stdio_exited_on_start").replace("{server}", server())}
            onDismiss={props.dismissMcpStdioExitedOnStart}
          />
        )}
      </Show>

      <McpServersList
        busy={props.busy}
        servers={props.mcpServers}
        statuses={props.mcpStatuses}
        connectingName={props.mcpConnectingName}
        lastUpdatedAt={props.mcpLastUpdatedAt}
        onAdd={() => setAddMcpModalOpen(true)}
        reconnectMcp={props.reconnectMcp}
        setMcpEnabled={props.setMcpEnabled}
        authorizeMcp={props.authorizeMcp}
        removeMcp={props.removeMcp}
        listMcpTools={props.listMcpTools}
        setMcpToolPolicy={props.setMcpToolPolicy}
      />

      <McpCatalogGrid
        busy={props.busy}
        entries={quickConnectList()}
        statuses={props.mcpStatuses}
        connectingName={props.mcpConnectingName}
        onSelect={selectCatalogEntry}
      />

      <AddMcpModal
        open={addMcpModalOpen()}
        onClose={() => setAddMcpModalOpen(false)}
        onAdd={(entry) => props.connectMcp(entry)}
        busy={props.busy}
        localCommandBlock={localCommandBlock()}
        onAddPlaced={props.connectMcpPlaced ?? undefined}
        hostExecution={capability.mcpHostExecutionEnabled()}
        hostBrowser={capability.hostBrowserEnabled()}
        language={locale()}
      />

      <McpCatalogForm
        open={catalogEntry() !== null}
        onClose={() => setCatalogEntry(null)}
        onConnect={(entry) => props.connectMcp(entry)}
        entry={catalogEntry()}
        busy={props.busy}
        language={locale()}
      />
    </section>
  );
}
