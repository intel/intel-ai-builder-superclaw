/**
 * What the Settings dialog shows for the selected section. Moved out of
 * dashboard.tsx with the agent list, the per-section refresh and the scheduler
 * backdrop, which only the sections here used.
 */
import { Match, Show, Switch, createEffect, createSignal, on } from "solid-js";

import ExtensionsView from "./extensions";
import ScheduledTasksView from "./scheduled";
import ConfigView from "./config";
import SettingsView from "./settings";
import SkillsView from "./skills";
import IdentitiesView from "./identities";
import FilePreviewModal from "../components/file-preview-modal";
import { t } from "../../i18n";
import {
  AgentCreatorView,
  ensureAgentMarkdownMode,
  generateAgentMarkdown,
  type AgentFormData,
  type AgentInfo,
} from "~/features/agent-creator";
import { validateAgentMarkdown } from "~/shared/util/agent-markdown";
import { BUNDLED_SKILL_DESCRIPTIONS } from "../data/bundled-skill-descriptions";
import type { DashboardViewProps } from "./dashboard.types";
import { isSettingsViewPane, type SettingsSection } from "./settings-dialog.sections";

export type SettingsDialogContentProps = DashboardViewProps & {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
};

export default function SettingsDialogContent(props: SettingsDialogContentProps) {
  const [schedulerDetailsOpen, setSchedulerDetailsOpen] = createSignal(false);
  const [agentList, setAgentList] = createSignal<AgentInfo[]>([]);
  const [agentBusy, setAgentBusy] = createSignal(false);
  let agentListRequest = 0;

  const refreshAgentList = async () => {
    const client = props.openworkServerClient;
    const workspaceId = props.openworkServerWorkspaceId?.trim();
    if (!client || !workspaceId) return;
    const request = ++agentListRequest;
    setAgentBusy(true);
    try {
      const result = await client.listAgentFiles(workspaceId);
      if (request !== agentListRequest) return;
      setAgentList(result.items.map((a) => ({ name: a.name, description: a.description })));
    } catch {
      // silent – list stays stale
    } finally {
      if (request === agentListRequest) setAgentBusy(false);
    }
  };

  // Reload the list whenever the agent section is shown, and again when the agent set changes while it is open
  createEffect(
    on(
      () => [props.section === "agent", props.agentsVersion] as const,
      ([onAgentSection]) => {
        if (onAgentSection) void refreshAgentList();
      },
    ),
  );

  const agentReloadAndNotify = async () => {
    const client = props.openworkServerClient;
    const workspaceId = props.openworkServerWorkspaceId?.trim();
    if (client && workspaceId) {
      try { await client.reloadEngine(workspaceId); } catch { /* best-effort */ }
      props.onAgentsChanged?.();
    }
    await refreshAgentList();
  };

  createEffect(
    on(
      () => props.section,
      (section) => {
        void (async () => {
          try {
            if (section === "skills") await props.refreshSkills();
            if (section === "mcp") await props.refreshMcpServers();
            if (section === "scheduled") await props.refreshScheduledJobs();
          } catch (e) {
            console.error("[settings] refresh error:", e);
          }
        })();
      },
    ),
  );

  createEffect(() => {
    if (props.developerMode) return;
    if (props.section !== "config") return;
    props.onSectionChange("identities");
  });

  // Every section draws in the same scroll box; start each one at the top.
  let contentScrollEl: HTMLDivElement | undefined;
  createEffect(
    on(
      () => props.section,
      () => {
        if (contentScrollEl) contentScrollEl.scrollTop = 0;
      },
    ),
  );

  // Without a composited scroller the WebView repaints this box (or its
  // scrollbar) on the main thread every scroll frame. `will-change: scroll-position`
  // composites it without, unlike `transform`, trapping the sections' `fixed`
  // overlays inside it; the opaque background keeps its text LCD-antialiased.
  return (
    <div ref={contentScrollEl} class="relative h-full overflow-y-auto bg-dls-surface-solid [will-change:scroll-position]">
      <Show when={props.section === "scheduled" && schedulerDetailsOpen()}>
        <div
          data-testid="scheduler-content-backdrop"
          aria-hidden="true"
          class="absolute inset-0 z-[998] bg-black/10 backdrop-blur-[2px]"
        />
      </Show>

      <div class="mx-auto w-full max-w-[1100px] space-y-10 p-6 md:p-8">
        <Switch>
          <Match when={props.section === "scheduled"}>
            <ScheduledTasksView
              jobs={props.scheduledJobs}
              source={props.scheduledJobsSource}
              sourceReady={props.scheduledJobsSourceReady}
              status={props.scheduledJobsStatus}
              legacySchedulerSupported={props.legacySchedulerSupported}
              busy={props.scheduledJobsBusy}
              lastUpdatedAt={props.scheduledJobsUpdatedAt}
              refreshJobs={props.refreshScheduledJobs}
              deleteJob={props.deleteScheduledJob}
              isWindows={props.isWindows}
              activeWorkspaceRoot={props.activeWorkspaceRoot}
              openNewTask={props.openNewTask}
              setPrompt={props.setPrompt}
              newTaskDisabled={props.newTaskDisabled}
              schedulerInstalled={props.schedulerPluginInstalled}
              canEditPlugins={props.canEditPlugins}
              addPlugin={props.addPlugin}
              reloadWorkspaceEngine={props.reloadWorkspaceEngine}
              reloadBusy={props.reloadBusy}
              canReloadWorkspace={props.canReloadWorkspace}
              openworkServerClient={props.openworkServerClient}
              openworkServerWorkspaceId={props.openworkServerWorkspaceId}
              selectedModel={props.selectedModel}
              modelOptions={props.modelOptions}
              openProviderAuthModal={props.openProviderAuthModal}
              providerAuthModalOpen={props.providerAuthModalOpen}
              listAgents={props.listAgents}
              sessionStatusById={props.sessionStatusById}
              onDetailsOpenChange={setSchedulerDetailsOpen}
            />
          </Match>
          <Match when={props.section === "skills"}>
            <SkillsView
              workspaceName={props.activeWorkspaceDisplay.name}
              busy={props.busy}
              canInstallSkillCreator={props.canInstallSkillCreator}
              canUseDesktopTools={props.canUseDesktopTools}
              canEditSkill={props.canEditSkill}
              canImportLocalSkill={props.canImportLocalSkill}
              canUninstallSkill={props.canUninstallSkill}
              accessHint={props.skillsAccessHint}
              refreshSkills={props.refreshSkills}
              refreshHubSkills={props.refreshHubSkills}
              skills={props.skills}
              skillsStatus={props.skillsStatus}
              skillsStatusTone={props.skillsStatusTone}
              hubSkills={props.hubSkills}
              hubSkillsStatus={props.hubSkillsStatus}
              hubRepo={props.hubRepo}
              hubRepos={props.hubRepos}
              importLocalSkill={props.importLocalSkill}
              importSkillFile={props.importSkillFile}
              installSkillCreator={props.installSkillCreator}
              installSkillFinder={props.installSkillFinder}
              installHubSkill={props.installHubSkill}
              setHubRepo={props.setHubRepo}
              addHubRepo={props.addHubRepo}
              removeHubRepo={props.removeHubRepo}
              revealSkillsFolder={props.revealSkillsFolder}
              uninstallSkill={props.uninstallSkill}
              readSkill={props.readSkill}
              saveSkill={props.saveSkill}
              openNewTask={props.openNewTask}
              setPrompt={props.setPrompt}
            />
          </Match>

          <Match when={props.section === "mcp"}>
            <ExtensionsView
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
          </Match>

          <Match when={props.section === "identities"}>
            <IdentitiesView
              busy={props.busy}
              openworkServerStatus={props.openworkServerStatus}
              openworkServerUrl={props.openworkServerUrl}
              openworkServerClient={props.openworkServerClient}
              openworkReconnectBusy={props.openworkReconnectBusy}
              reconnectOpenworkServer={props.reconnectOpenworkServer}
              openworkServerWorkspaceId={props.openworkServerWorkspaceId}
              activeWorkspaceRoot={props.activeWorkspaceRoot}
              developerMode={props.developerMode}
              channelCredentials={props.channelCredentials}
              tavilyKeyView={props.tavilyKeyView}
              tavilyApiKeyStatus={props.tavilyApiKeyStatus}
              refreshTavilyApiKey={props.refreshTavilyApiKey}
              saveTavilyApiKey={props.saveTavilyApiKey}
              clearTavilyApiKey={props.clearTavilyApiKey}
              setTavilyApiKeyEnabled={props.setTavilyApiKeyEnabled}
            />
          </Match>

          <Match when={props.section === "config" && props.developerMode}>
            <ConfigView
              busy={props.busy}
              clientConnected={props.clientConnected}
              anyActiveRuns={props.anyActiveRuns}
              openworkServerStatus={props.openworkServerStatus}
              openworkServerUrl={props.openworkServerUrl}
              openworkServerSettings={props.openworkServerSettings}
              openworkServerHostInfo={props.openworkServerHostInfo}
              openworkServerWorkspaceId={props.openworkServerWorkspaceId}
              updateOpenworkServerSettings={props.updateOpenworkServerSettings}
              resetOpenworkServerSettings={props.resetOpenworkServerSettings}
              testOpenworkServerConnection={props.testOpenworkServerConnection}
              canReloadWorkspace={props.canReloadWorkspace}
              reloadWorkspaceEngine={props.reloadWorkspaceEngine}
              reloadBusy={props.reloadBusy}
              reloadError={props.reloadError}
              workspaceAutoReloadAvailable={props.workspaceAutoReloadAvailable}
              workspaceAutoReloadEnabled={props.workspaceAutoReloadEnabled}
              setWorkspaceAutoReloadEnabled={props.setWorkspaceAutoReloadEnabled}
              workspaceAutoReloadResumeEnabled={props.workspaceAutoReloadResumeEnabled}
              setWorkspaceAutoReloadResumeEnabled={props.setWorkspaceAutoReloadResumeEnabled}
              developerMode={props.developerMode}
            />
          </Match>

          <Match when={props.section === "agent"}>
            <AgentCreatorView
              agents={agentList()}
              busy={agentBusy()}
              canEdit={Boolean(props.openworkServerClient && props.openworkServerWorkspaceId?.trim())}
              canDelete={Boolean(props.openworkServerClient && props.openworkServerWorkspaceId?.trim())}
              skillDescription={(name) => BUNDLED_SKILL_DESCRIPTIONS.get(name)}
              filePreview={FilePreviewModal}
              refreshAgents={() => void refreshAgentList()}
              readAgent={async (name: string) => {
                const client = props.openworkServerClient;
                const workspaceId = props.openworkServerWorkspaceId?.trim();
                if (!client || !workspaceId) return null;
                return client.readWorkspaceFile(workspaceId, `.opencode/agents/${name}.md`);
              }}
              saveAgent={async (name: string, content: string) => {
                const client = props.openworkServerClient;
                const workspaceId = props.openworkServerWorkspaceId?.trim();
                if (!client || !workspaceId) throw new Error(t("dashboard.no_server_connection"));
                validateAgentMarkdown(content);
                await client.writeWorkspaceFile(workspaceId, { path: `.opencode/agents/${name}.md`, content });
                await agentReloadAndNotify();
              }}
              loadToolsSkills={async () => {
                const client = props.openworkServerClient;
                const workspaceId = props.openworkServerWorkspaceId?.trim();
                if (!client || !workspaceId) {
                  return { tools: [], skills: [], mcpServers: [], protectedFilePipelineAvailable: false };
                }
                const catalog = await client.listAgentToolSkillCatalog(workspaceId);
                const toSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
                const connectedMcpServers = (catalog.mcpServers ?? []).filter((item) => {
                  const status = props.mcpStatuses[item.name] ?? props.mcpStatuses[toSlug(item.name)];
                  return status?.status === "connected";
                });
                return { ...catalog, mcpServers: connectedMcpServers };
              }}
              watchToolsSkillsChanges={async (since) => {
                const client = props.openworkServerClient;
                const workspaceId = props.openworkServerWorkspaceId?.trim();
                if (!client || !workspaceId) {
                  return { items: [], cursor: since };
                }
                return client.listReloadEvents(workspaceId, typeof since === "number" ? { since } : undefined);
              }}
              deleteAgent={async (name: string) => {
                const client = props.openworkServerClient;
                const workspaceId = props.openworkServerWorkspaceId?.trim();
                if (!client || !workspaceId) throw new Error(t("dashboard.no_server_connection"));
                await client.deleteWorkspaceFile(workspaceId, `.opencode/agents/${name}.md`);
                await agentReloadAndNotify();
              }}
              onSave={async (agent: AgentFormData) => {
                const content = ensureAgentMarkdownMode(generateAgentMarkdown(agent), "primary");
                validateAgentMarkdown(content);
                const filePath = `.opencode/agents/${agent.name}.md`;
                const client = props.openworkServerClient;
                const workspaceId = props.openworkServerWorkspaceId?.trim();
                if (client && workspaceId) {
                  await client.writeWorkspaceFile(workspaceId, { path: filePath, content });
                  await agentReloadAndNotify();
                } else {
                  const blob = new Blob([content], { type: "text/markdown" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${agent.name}.md`;
                  a.click();
                  URL.revokeObjectURL(url);
                }
              }}
            />
          </Match>

          <Match when={isSettingsViewPane(props.section) && props.section}>
            {(pane) => (
              <SettingsView
                busy={props.busy}
                settingsTab={pane()}
                setSettingsTab={props.onSectionChange}
                providers={props.providers}
                providerConnectedIds={props.providerConnectedIds}
                providerAuthBusy={props.providerAuthBusy}
                openProviderAuthModal={props.openProviderAuthModal}
                disconnectProvider={props.disconnectProvider}
                openworkServerStatus={props.openworkServerStatus}
                openworkServerUrl={props.openworkServerUrl}
                refreshProviders={props.refreshProviders}
                cloudModel={props.cloudModel}
                cloudModelHealthError={props.cloudModelHealthError}
                cloudModelLoading={props.cloudModelLoading}
                cloudModelDeleting={props.cloudModelDeleting}
                cloudModelTesting={props.cloudModelTesting}
                localModelHealth={props.localModelHealth}
                saveCloudModel={props.saveCloudModel}
                deleteCloudModel={props.deleteCloudModel}
                testProviderConnection={props.testProviderConnection}
                loadProviderModels={props.loadProviderModels}
                llmRouterClient={props.llmRouterClient}
                edgeConfigured={props.edgeConfigured}
                edgeConnected={props.edgeConnected}
                primaryBundleCapability={props.primaryBundleCapability}
                edgeBaseUrl={props.edgeBaseUrl}
                edgeModelName={props.edgeModelName}
                edgeBypassProxy={props.edgeBypassProxy}
                edgeTesting={props.edgeTesting}
                edgeError={props.edgeError}
                testEdgeConnection={props.testEdgeConnection}
                connectEdge={props.connectEdge}
                connectLocal={props.connectLocal}
                edgeDisconnectAvailable={props.edgeDisconnectAvailable}
                edgeDisconnecting={props.edgeDisconnecting}
                disconnectEdge={props.disconnectEdge}
                bundleSwitchMessage={props.bundleSwitchMessage}
                bundleSwitchError={props.bundleSwitchError}
                bundleSwitchSteps={props.bundleSwitchSteps}
                bundleSwitchApplying={props.bundleSwitchApplying}
                bundleSwitchCanResume={props.bundleSwitchCanResume}
                onApplyBundleSwitch={props.onApplyBundleSwitch}
                onCancelSwitch={props.onCancelSwitch}
                edgeUpdatedMessage={props.edgeUpdatedMessage}
                openworkServerHostInfo={props.openworkServerHostInfo}
                openworkServerWorkspaceId={props.openworkServerWorkspaceId}
                runtimeSettings={props.runtimeSettings}
                runtimeSettingsStatus={props.runtimeSettingsStatus}
                runtimeSettingsError={props.runtimeSettingsError}
                refreshRuntimeSettings={props.refreshRuntimeSettings}
                saveRuntimeSettings={props.saveRuntimeSettings}
                developerMode={props.developerMode}
                toggleDeveloperMode={props.toggleDeveloperMode}
                keepBackendOnExit={props.keepBackendOnExit}
                setKeepBackendOnExit={props.setKeepBackendOnExit}
                fullTelemetryEnabled={props.fullTelemetryEnabled}
                setFullTelemetryEnabled={props.setFullTelemetryEnabled}
                baselineTelemetryEnabled={props.baselineTelemetryEnabled}
                setBaselineTelemetryEnabled={props.setBaselineTelemetryEnabled}
                resetInstallId={props.resetInstallId}
                resetInstallIdFeedback={props.resetInstallIdFeedback}
                defaultModelLabel={props.defaultModelLabel}
                defaultModelRef={props.defaultModelRef}
                openDefaultModelPicker={props.openDefaultModelPicker}
                showThinking={props.showThinking}
                toggleShowThinking={props.toggleShowThinking}
                autoCompactContext={props.autoCompactContext}
                toggleAutoCompactContext={props.toggleAutoCompactContext}
                hideTitlebar={props.hideTitlebar}
                toggleHideTitlebar={props.toggleHideTitlebar}
                modelVariantLabel={props.modelVariantLabel}
                editModelVariant={props.editModelVariant}
                language={props.language}
                setLanguage={props.setLanguage}
                updateAutoCheck={props.updateAutoCheck}
                toggleUpdateAutoCheck={props.toggleUpdateAutoCheck}
                themeMode={props.themeMode}
                setThemeMode={props.setThemeMode}
                updateStatus={props.updateStatus}
                updateEnv={props.updateEnv}
                checkForUpdates={props.checkForUpdates}
                openUpdateDownloadPage={props.openUpdateDownloadPage}
                anyActiveRuns={props.anyActiveRuns}
                repairOpencodeMigration={props.repairOpencodeMigration}
                migrationRepairBusy={props.migrationRepairBusy}
                migrationRepairResult={props.migrationRepairResult}
                migrationRepairAvailable={props.migrationRepairAvailable}
                migrationRepairUnavailableReason={props.migrationRepairUnavailableReason}
                connectRemoteWorkspace={props.connectRemoteWorkspace}
                voice={props.voice}
              />
            )}
          </Match>
        </Switch>

        <Show when={props.error}>
          <div class="rounded-card bg-dls-danger-bg px-5 py-4 text-body-lg text-dls-danger-text border border-dls-danger-border">
            {props.error}
          </div>
        </Show>
      </div>
    </div>
  );
}
