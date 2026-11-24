import { McpView, type McpViewProps } from "~/features/mcp";
import { t } from "../../i18n";

export type ExtensionsViewProps = McpViewProps & {
    setDashboardTab?: (tab: "mcp") => void;
  };

export default function ExtensionsView(props: ExtensionsViewProps) {
  return (
    <section class="space-y-6 animate-in fade-in duration-300" data-testid="mcp-content">
      <h2 class="text-display-lg font-bold text-dls-text">{t("mcp.extensions")}</h2>

      <div class="space-y-4">
        <McpView
          busy={props.busy}
          activeWorkspaceRoot={props.activeWorkspaceRoot}
          isRemoteWorkspace={props.isRemoteWorkspace}
          mcpServers={props.mcpServers}
          mcpBrowserSandboxRefusal={props.mcpBrowserSandboxRefusal}
          dismissMcpBrowserSandboxRefusal={props.dismissMcpBrowserSandboxRefusal}
          mcpHostExecutionRefusal={props.mcpHostExecutionRefusal}
          dismissMcpHostExecutionRefusal={props.dismissMcpHostExecutionRefusal}
          mcpStdioExitedOnStart={props.mcpStdioExitedOnStart}
          dismissMcpStdioExitedOnStart={props.dismissMcpStdioExitedOnStart}
          mcpLastUpdatedAt={props.mcpLastUpdatedAt}
          mcpStatuses={props.mcpStatuses}
          mcpConnectingName={props.mcpConnectingName}
          quickConnect={props.quickConnect}
          connectMcp={props.connectMcp}
          connectMcpPlaced={props.connectMcpPlaced}
          reconnectMcp={props.reconnectMcp}
          setMcpEnabled={props.setMcpEnabled}
          authorizeMcp={props.authorizeMcp}
          logoutMcpAuth={props.logoutMcpAuth}
          removeMcp={props.removeMcp}
          refreshMcpServers={props.refreshMcpServers}
          listMcpTools={props.listMcpTools}
          setMcpToolPolicy={props.setMcpToolPolicy}
        />
      </div>
    </section>
  );
}
