import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import {
  isTauriRuntime,
  isWindowsPlatform,
  normalizeDirectoryPath,
} from "../utils";
import { createWorkspaceShellLayout } from "../lib/workspace-shell-layout";
import {
  buildOpenworkConnectInviteUrl,
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  parseOpenworkWorkspaceIdFromUrl,
} from "../lib/openwork-server";
import type {
  OpenworkServerClient,
} from "../lib/openwork-server";
import type { WorkspaceInfo } from "../lib/tauri";
import { DEFAULT_OPENWORK_PUBLISHER_BASE_URL, publishOpenworkBundleJson } from "../lib/publisher";
import Button from "../components/button";
import DataUsageView from "./data-usage";
import StatusBar from "../components/status-bar";
import FeedbackModal from "../components/feedback-modal";
import ProviderAuthModal, { type ProviderOAuthStartResult } from "../components/provider-auth-modal";
import ShareWorkspaceModal from "../components/share-workspace-modal";
import WorkspaceSessionList from "../components/session/workspace-session-list";
import { SidebarNewTaskRow } from "../components/session/sidebar-new-task-row";
import SidebarDrawer from "../components/session/sidebar-drawer";
import { backToSessions, hidesSessionSidebar } from "../dashboard-focus";
import {
  SlidersHorizontal,
  ChartColumnIncreasing
} from "lucide-solid";
import { t } from "../../i18n";
import Titlebar from "../components/titlebar";
import type { SkillsSetBundleV1, WorkspaceProfileBundleV1 } from "../types";
import type { DashboardViewProps } from "./dashboard.types";
import DashboardHeader from "./dashboard.header";
import { VersionInfoPanel } from "../components/version-info-panel";

// Re-exported from the extracted helpers so this module's public surface is unchanged.
export type { DashboardViewProps } from "./dashboard.types";

export default function DashboardView(props: DashboardViewProps) {
  const title = createMemo(() => {
    switch (props.tab) {
      case "data":
        return t("dashboard.data_usage");
      default:
        return t("dashboard.advanced");
    }
  });
  const sessionSidebarHidden = () => hidesSessionSidebar(props.tab);

  const workspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    t("dashboard.worker");
  const workspaceKindLabel = (workspace: WorkspaceInfo) =>
    workspace.workspaceType === "remote"
      ? t("dashboard.kind_remote")
      : t("dashboard.kind_local");

  const openSessionFromList = (workspaceId: string, sessionId: string) => {
    setSidebarDrawerOpen(false);
    // Route-driven selection: navigate first and let the route effect own selectSession.
    if (workspaceId === props.activeWorkspaceId) {
      props.setView("session", sessionId);
      return;
    }
    // For different workspace, activate workspace first
    void (async () => {
      await Promise.resolve(props.activateWorkspace(workspaceId));
      props.setView("session", sessionId);
    })();
  };

  const createTaskInWorkspace = (workspaceId: string) => {
    setSidebarDrawerOpen(false);
    const id = workspaceId.trim();
    if (!id) return;
    if (id === props.activeWorkspaceId) {
      props.openNewTask();
      return;
    }
    void (async () => {
      await Promise.resolve(props.activateWorkspace(id));
      props.openNewTask();
    })();
  };

  const [sidebarDrawerOpen, setSidebarDrawerOpen] = createSignal(false);
  let drawerToggleEl: HTMLElement | undefined;
  const [providerAuthActionBusy, setProviderAuthActionBusy] = createSignal(false);
  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(null);

  const {
    leftSidebarWidth,
    rightSidebarExpanded,
    startLeftSidebarResize,
    toggleRightSidebar,
  } = createWorkspaceShellLayout({ expandedRightWidth: 280 });

  // Host-path feedback modal — GitHub issue prefill with mailto fallback (feedback-modal.tsx).
  const [feedbackModalOpen, setFeedbackModalOpen] = createSignal(false);
  const openFeedback = () => setFeedbackModalOpen(true);

  const handleProviderAuthSelect = async (providerId: string): Promise<ProviderOAuthStartResult> => {
    if (providerAuthActionBusy()) {
      throw new Error(t("dashboard.provider_auth_in_progress"));
    }
    setProviderAuthActionBusy(true);
    try {
      return await props.startProviderAuth(providerId);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthOAuth = async (providerId: string, methodIndex: number, code?: string) => {
    if (providerAuthActionBusy()) return { connected: false, pending: true };
    setProviderAuthActionBusy(true);
    try {
      const result = await props.completeProviderAuthOAuth(providerId, methodIndex, code);
      if (result.connected) {
        props.closeProviderAuthModal();
      }
      return result;
    } catch {
      // Errors are surfaced in the modal.
      return { connected: false };
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthApiKey = async (providerId: string, apiKey: string) => {
    if (providerAuthActionBusy()) return;
    setProviderAuthActionBusy(true);
    try {
      await props.submitProviderApiKey(providerId, apiKey);
      props.closeProviderAuthModal();
    } catch {
      // Errors are surfaced in the modal.
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const openConfig = () => {
    props.openSettings(props.developerMode ? "config" : "identities");
  };

  const revealWorkspaceInFinder = async (workspaceId: string) => {
    const workspace = props.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "local") return;
    const target = workspace.path?.trim() ?? "";
    if (!target || !isTauriRuntime()) return;
    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      if (isWindowsPlatform()) {
        await openPath(target);
      } else {
        await revealItemInDir(target);
      }
    } catch (error) {
      console.warn("Failed to reveal workspace", error);
    }
  };

  const shareWorkspace = createMemo(() => {
    const id = shareWorkspaceId();
    if (!id) return null;
    return props.workspaces.find((ws) => ws.id === id) ?? null;
  });

  const shareWorkspaceName = createMemo(() => {
    const ws = shareWorkspace();
    return ws ? workspaceLabel(ws) : "";
  });

  const shareWorkspaceDetail = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "";
    if (ws.workspaceType === "remote") {
      if (ws.remoteType === "openwork") {
        const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
        const mounted = buildOpenworkWorkspaceBaseUrl(hostUrl, ws.openworkWorkspaceId);
        return mounted || hostUrl;
      }
      return ws.baseUrl?.trim() || "";
    }
    return ws.path?.trim() || "";
  });

  const [shareLocalOpenworkWorkspaceId, setShareLocalOpenworkWorkspaceId] = createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] = createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = createSignal<string | null>(null);
  const [shareWorkspaceProfileError, setShareWorkspaceProfileError] = createSignal<string | null>(null);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(null);
  const [shareSkillsSetError, setShareSkillsSetError] = createSignal<string | null>(null);

  createEffect(
    on(shareWorkspaceId, () => {
      setShareWorkspaceProfileBusy(false);
      setShareWorkspaceProfileUrl(null);
      setShareWorkspaceProfileError(null);
      setShareSkillsSetBusy(false);
      setShareSkillsSetUrl(null);
      setShareSkillsSetError(null);
    }),
  );

  // Every tab draws in the same scroll box, and going to chat only hides it, so
  // a page would open at the last page's scroll offset. Start each page at the top.
  let contentScrollEl: HTMLDivElement | undefined;
  createEffect(
    on([() => props.view, () => props.tab], ([view]) => {
      if (view === "dashboard" && contentScrollEl) contentScrollEl.scrollTop = 0;
    }),
  );

  createEffect(() => {
    const ws = shareWorkspace();
    const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
    const token =
      props.openworkServerHostInfo?.ownerToken?.trim() ||
      props.openworkServerHostInfo?.clientToken?.trim() ||
      "";
    const workspacePath = ws?.workspaceType === "local" ? ws.path?.trim() ?? "" : "";

    if (!ws || ws.workspaceType !== "local" || !workspacePath || !baseUrl || !token) {
      setShareLocalOpenworkWorkspaceId(null);
      return;
    }

    let cancelled = false;
    setShareLocalOpenworkWorkspaceId(null);

    void (async () => {
      try {
        const client = createOpenworkServerClient({ baseUrl, token });
        const response = await client.listWorkspaces();
        if (cancelled) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(workspacePath);
        const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
        setShareLocalOpenworkWorkspaceId(match?.id ?? null);
      } catch {
        if (!cancelled) setShareLocalOpenworkWorkspaceId(null);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const shareFields = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) {
      return [] as Array<{
        label: string;
        value: string;
        secret?: boolean;
        placeholder?: string;
        hint?: string;
      }>;
    }

    if (ws.workspaceType !== "remote") {
      const hostUrl =
        props.openworkServerHostInfo?.connectUrl?.trim() ||
        props.openworkServerHostInfo?.lanUrl?.trim() ||
        props.openworkServerHostInfo?.mdnsUrl?.trim() ||
        props.openworkServerHostInfo?.baseUrl?.trim() ||
        "";
      const mountedUrl = shareLocalOpenworkWorkspaceId()
        ? buildOpenworkWorkspaceBaseUrl(hostUrl, shareLocalOpenworkWorkspaceId())
        : null;
      const url = mountedUrl || hostUrl;
      const ownerToken = props.openworkServerHostInfo?.ownerToken?.trim() || "";
      const collaboratorToken = props.openworkServerHostInfo?.clientToken?.trim() || "";
      const inviteToken = ownerToken || collaboratorToken;
      const inviteUrl = buildOpenworkConnectInviteUrl({
        workspaceUrl: url,
        token: inviteToken,
      });
      return [
        {
          label: t("dashboard.openwork_invite_link"),
          value: inviteUrl,
          secret: true,
          placeholder: !isTauriRuntime() ? t("dashboard.desktop_app_required") : t("dashboard.starting_server"),
          hint: ownerToken
            ? t("dashboard.invite_link_owner_hint")
            : t("dashboard.invite_link_collaborator_hint"),
        },
        {
          label: t("dashboard.openwork_worker_url"),
          value: url,
          placeholder: !isTauriRuntime() ? t("dashboard.desktop_app_required") : t("dashboard.starting_server"),
          hint: mountedUrl
            ? t("dashboard.worker_url_hint_phones")
            : hostUrl
              ? t("dashboard.worker_url_resolving_hint")
              : undefined,
        },
        {
          label: t("dashboard.owner_token"),
          value: ownerToken,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : t("dashboard.desktop_app_required"),
          hint: mountedUrl
            ? t("dashboard.worker_url_hint_phones")
            : t("dashboard.owner_token_host_hint"),
        },
        {
          label: t("dashboard.collaborator_token"),
          value: collaboratorToken,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : t("dashboard.desktop_app_required"),
          hint: mountedUrl
            ? t("dashboard.collaborator_token_routine_hint")
            : t("dashboard.collaborator_token_host_hint"),
        },
      ];
    }

    if (ws.remoteType === "openwork") {
      const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const url = buildOpenworkWorkspaceBaseUrl(hostUrl, ws.openworkWorkspaceId) || hostUrl;
      const token =
        ws.openworkToken?.trim() ||
        props.openworkServerSettings.token?.trim() ||
        "";
      const inviteUrl = buildOpenworkConnectInviteUrl({
        workspaceUrl: url,
        token,
      });
      return [
        {
          label: t("dashboard.openwork_invite_link"),
          value: inviteUrl,
          secret: true,
          hint: t("dashboard.invite_link_short_hint"),
        },
        {
          label: t("dashboard.openwork_worker_url"),
          value: url,
        },
        {
          label: t("dashboard.connected_token"),
          value: token,
          secret: true,
          placeholder: token ? undefined : t("dashboard.set_token_in_advanced"),
          hint: t("dashboard.connected_token_hint"),
        },
      ];
    }

    const baseUrl = ws.baseUrl?.trim() || ws.path?.trim() || "";
    const directory = ws.directory?.trim() || "";
    return [
      {
        label: t("dashboard.opencode_base_url"),
        value: baseUrl,
      },
      {
        label: t("dashboard.directory"),
        value: directory,
        placeholder: t("dashboard.directory_auto_placeholder"),
      },
    ];
  });

  const shareNote = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return null;
    if (ws.workspaceType === "local" && props.engineInfo?.runtime === "direct") {
      return t("dashboard.share_note_direct_runtime");
    }
    return null;
  });

  const shareServiceDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return t("dashboard.select_worker_first");
    if (ws.workspaceType === "remote" && ws.remoteType !== "openwork") {
      return t("dashboard.share_links_openwork_only");
    }
    if (ws.workspaceType !== "remote") {
      const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
      const token =
        props.openworkServerHostInfo?.ownerToken?.trim() ||
        props.openworkServerHostInfo?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        return t("dashboard.local_host_not_ready");
      }
    } else {
      const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const token = ws.openworkToken?.trim() || props.openworkServerSettings.token?.trim() || "";
      if (!hostUrl) return t("dashboard.missing_openwork_host");
      if (!token) return t("dashboard.missing_openwork_token");
    }
    return null;
  });

  const resolveShareExportContext = async (): Promise<{
    client: OpenworkServerClient;
    workspaceId: string;
    workspace: WorkspaceInfo;
  }> => {
    const ws = shareWorkspace();
    if (!ws) {
      throw new Error(t("dashboard.select_worker_first"));
    }

    if (ws.workspaceType !== "remote") {
      const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
      const token =
        props.openworkServerHostInfo?.ownerToken?.trim() ||
        props.openworkServerHostInfo?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        throw new Error(t("dashboard.local_host_not_ready"));
      }
      const client = createOpenworkServerClient({ baseUrl, token });

      let workspaceId = shareLocalOpenworkWorkspaceId()?.trim() ?? "";
      if (!workspaceId) {
        const response = await client.listWorkspaces();
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(ws.path?.trim() ?? "");
        const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
        workspaceId = (match?.id ?? "").trim();
        setShareLocalOpenworkWorkspaceId(workspaceId || null);
      }

      if (!workspaceId) {
        throw new Error(t("dashboard.resolve_worker_local_failed"));
      }

      return { client, workspaceId, workspace: ws };
    }

    if (ws.remoteType !== "openwork") {
      throw new Error(t("dashboard.share_links_openwork_only"));
    }

    const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
    const token = ws.openworkToken?.trim() || props.openworkServerSettings.token?.trim() || "";
    if (!hostUrl || !token) {
      throw new Error(t("dashboard.openwork_host_token_required"));
    }

    const client = createOpenworkServerClient({ baseUrl: hostUrl, token });
    let workspaceId =
      ws.openworkWorkspaceId?.trim() ||
      parseOpenworkWorkspaceIdFromUrl(ws.openworkHostUrl ?? "") ||
      parseOpenworkWorkspaceIdFromUrl(ws.baseUrl ?? "") ||
      "";

    if (!workspaceId) {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      const directoryHint = normalizeDirectoryPath(ws.directory?.trim() ?? ws.path?.trim() ?? "");
      const match = directoryHint
        ? items.find((entry) => {
          const entryPath = normalizeDirectoryPath(
            (entry.opencode?.directory ?? entry.directory ?? entry.path ?? "").trim(),
          );
          return Boolean(entryPath && entryPath === directoryHint);
        })
        : (response.activeId ? items.find((entry) => entry.id === response.activeId) : null) ??
        items[0];
      workspaceId = (match?.id ?? "").trim();
    }

    if (!workspaceId) {
      throw new Error(t("dashboard.resolve_worker_host_failed"));
    }

    return { client, workspaceId, workspace: ws };
  };

  const publishWorkspaceProfileLink = async () => {
    if (shareWorkspaceProfileBusy()) return;
    setShareWorkspaceProfileBusy(true);
    setShareWorkspaceProfileError(null);
    setShareWorkspaceProfileUrl(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const exported = await client.exportWorkspace(workspaceId);
      const payload: WorkspaceProfileBundleV1 = {
        schemaVersion: 1,
        type: "workspace-profile",
        name: `${workspaceLabel(workspace)} profile`,
        description: "Full OpenWork workspace profile with config, MCP setup, commands, and skills.",
        workspace: exported,
      };

      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "workspace-profile",
        name: payload.name,
      });

      setShareWorkspaceProfileUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareWorkspaceProfileError(error instanceof Error ? error.message : t("dashboard.publish_profile_failed"));
    } finally {
      setShareWorkspaceProfileBusy(false);
    }
  };

  const publishSkillsSetLink = async () => {
    if (shareSkillsSetBusy()) return;
    setShareSkillsSetBusy(true);
    setShareSkillsSetError(null);
    setShareSkillsSetUrl(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const exported = await client.exportWorkspace(workspaceId);
      const skills = Array.isArray(exported.skills) ? exported.skills : [];
      if (!skills.length) {
        throw new Error(t("dashboard.no_skills_in_workspace"));
      }

      const payload: SkillsSetBundleV1 = {
        schemaVersion: 1,
        type: "skills-set",
        name: `${workspaceLabel(workspace)} skills`,
        description: "Complete skills set from an OpenWork workspace.",
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
        sourceWorkspace: {
          id: workspaceId,
          name: workspaceLabel(workspace),
        },
      };

      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "skills-set",
        name: payload.name,
      });

      setShareSkillsSetUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareSkillsSetError(error instanceof Error ? error.message : t("dashboard.publish_skills_failed"));
    } finally {
      setShareSkillsSetBusy(false);
    }
  };

  const exportDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return t("dashboard.export_local_desktop_only");
    if (ws.workspaceType === "remote") return t("dashboard.export_local_only");
    if (!isTauriRuntime()) return t("dashboard.export_desktop_only");
    if (props.exportWorkspaceBusy) return t("dashboard.export_already_running");
    return null;
  });

  return (
    <div class="h-[100dvh] min-h-screen w-full flex flex-col overflow-hidden bg-[var(--dls-app-bg)] text-dls-text font-sans">
      <Titlebar />
      {/* Sidebar drawer for small screens */}
      <Show when={!sessionSidebarHidden()}>
      <SidebarDrawer open={sidebarDrawerOpen()} onClose={() => setSidebarDrawerOpen(false)}>
        <div class="flex min-h-0 flex-1 flex-col">
          <SidebarNewTaskRow
            label={t("dashboard.new_task_label")}
            disabled={props.newTaskDisabled}
            onCreate={() => { createTaskInWorkspace(props.activeWorkspaceId); setSidebarDrawerOpen(false); }}
          />
          <div class="flex-1 min-h-0 overflow-y-auto">
            <WorkspaceSessionList
              workspaceSessionGroups={props.workspaceSessionGroups}
              activeWorkspaceId={props.activeWorkspaceId}
              selectedSessionId={null}
              sessionStatusById={props.sessionStatusById}
              connectingWorkspaceId={props.connectingWorkspaceId}
              workspaceConnectionStateById={props.workspaceConnectionStateById}
              newTaskDisabled={props.newTaskDisabled}
              importingWorkspaceConfig={props.importingWorkspaceConfig}
              onActivateWorkspace={props.activateWorkspace}
              onOpenSession={(wid, sid) => { openSessionFromList(wid, sid); }}
              onCreateTaskInWorkspace={(wid) => { createTaskInWorkspace(wid); }}
              onOpenRenameWorkspace={props.openRenameWorkspace}
              onShareWorkspace={(workspaceId) => setShareWorkspaceId(workspaceId)}
              onRevealWorkspace={revealWorkspaceInFinder}
              onRecoverWorkspace={props.recoverWorkspace}
              onTestWorkspaceConnection={props.testWorkspaceConnection}
              onEditWorkspaceConnection={props.editWorkspaceConnection}
              onOpenCreateWorkspace={props.openCreateWorkspace}
              onOpenCreateRemoteWorkspace={props.openCreateRemoteWorkspace}
              onImportWorkspaceConfig={props.importWorkspaceConfig}
              hideNewTaskButton
            />
          </div>
        </div>
        {/* Bottom nav */}
        <div class="mt-auto shrink-0 space-y-1 pt-3 border-t border-dls-border/50">
          <button
            type="button"
            class={`w-full flex min-h-11 items-center justify-start gap-2.5 rounded-card px-3.5 border text-body font-medium transition-[background-color,border-color,box-shadow,color] ${props.tab === "data"
              ? "border-dls-border bg-dls-surface text-dls-text shadow-[var(--dls-card-shadow)]"
              : "border-transparent text-dls-secondary hover:border-dls-border hover:bg-dls-surface hover:text-dls-text"
              }`}
            onClick={() => { props.setTab("data"); setSidebarDrawerOpen(false); }}
            aria-label={t("dashboard.data_usage")}
          >
            <ChartColumnIncreasing size={18} />
            {t("dashboard.data_usage")}
          </button>
          <button
            type="button"
            data-testid="advanced-settings-button"
            class={`w-full flex min-h-11 items-center justify-start gap-2.5 rounded-card px-3.5 border text-body font-medium transition-[background-color,border-color,box-shadow,color] ${props.tab !== "data"
              ? "border-dls-border bg-dls-surface text-dls-text shadow-[var(--dls-card-shadow)]"
              : "border-transparent text-dls-secondary hover:border-dls-border hover:bg-dls-surface hover:text-dls-text"
              }`}
            onClick={() => { props.openSettings(undefined, drawerToggleEl); setSidebarDrawerOpen(false); }}
            aria-label={t("dashboard.advanced")}
          >
            <SlidersHorizontal size={18} />
            {t("dashboard.advanced")}
          </button>
          <Show when={isTauriRuntime()}>
            <VersionInfoPanel
              versionLabel={props.versionLabel()}
              debugBuildCommit={props.debugBuildCommit()}
              debugBuildCommitLabel={props.debugBuildCommitLabel()}
              commitCopied={props.commitCopied()}
              onCopyCommit={() => void props.copyDebugBuildCommit()}
            />
          </Show>
        </div>
      </SidebarDrawer>
      </Show>
      <div class="flex flex-1 min-h-0 w-full gap-3 md:gap-4 p-3 md:p-4 pt-1 md:pt-2">
        <Show when={!sessionSidebarHidden()}>
        <aside
          class="group/leftsidebar relative hidden lg:flex shrink-0 flex-col rounded-shell border border-dls-border bg-dls-sidebar p-2.5"
          style={{
            width: `${leftSidebarWidth()}px`,
            "min-width": `${leftSidebarWidth()}px`,
          }}
        >
          <div data-tour-id="sidebar-sessions-area" class="flex min-h-0 flex-1 flex-col">
            <SidebarNewTaskRow
              label={t("dashboard.new_task_label")}
              disabled={props.newTaskDisabled}
              onCreate={() => createTaskInWorkspace(props.activeWorkspaceId)}
            />
            <div class="min-h-0 flex-1 overflow-y-auto">
              <WorkspaceSessionList
                workspaceSessionGroups={props.workspaceSessionGroups}
                activeWorkspaceId={props.activeWorkspaceId}
                selectedSessionId={null}
                sessionStatusById={props.sessionStatusById}
                connectingWorkspaceId={props.connectingWorkspaceId}
                workspaceConnectionStateById={props.workspaceConnectionStateById}
                newTaskDisabled={props.newTaskDisabled}
                importingWorkspaceConfig={props.importingWorkspaceConfig}
                onActivateWorkspace={props.activateWorkspace}
                onOpenSession={openSessionFromList}
                onCreateTaskInWorkspace={createTaskInWorkspace}
                onOpenRenameWorkspace={props.openRenameWorkspace}
                onShareWorkspace={(workspaceId) => setShareWorkspaceId(workspaceId)}
                onRevealWorkspace={revealWorkspaceInFinder}
                onRecoverWorkspace={props.recoverWorkspace}
                onTestWorkspaceConnection={props.testWorkspaceConnection}
                onEditWorkspaceConnection={props.editWorkspaceConnection}
                onOpenCreateWorkspace={props.openCreateWorkspace}
                onOpenCreateRemoteWorkspace={props.openCreateRemoteWorkspace}
                onImportWorkspaceConfig={props.importWorkspaceConfig}
                hideNewTaskButton
              />
            </div>
          </div>
          <div class="mt-auto shrink-0 space-y-1 pt-3 border-t border-dls-border/50">
            <button
              type="button"
              class={`w-full flex min-h-11 items-center justify-start gap-2.5 rounded-card px-3.5 border text-body font-medium transition-[background-color,border-color,box-shadow,color] ${props.tab === "data"
                  ? "border-dls-border bg-dls-surface text-dls-text shadow-[var(--dls-card-shadow)]"
                  : "border-transparent text-dls-secondary hover:border-dls-border hover:bg-dls-surface hover:text-dls-text"
                }`}
              onClick={() => props.setTab("data")}
              aria-label={t("dashboard.data_usage")}
            >
              <ChartColumnIncreasing size={18} />
              {t("dashboard.data_usage")}
            </button>
            <button
              type="button"
              data-testid="advanced-settings-button"
              class={`w-full flex min-h-11 items-center justify-start gap-2.5 rounded-card px-3.5 border text-body font-medium transition-[background-color,border-color,box-shadow,color] ${props.tab !== "data"
                ? "border-dls-border bg-dls-surface text-dls-text shadow-[var(--dls-card-shadow)]"
                : "border-transparent text-dls-secondary hover:border-dls-border hover:bg-dls-surface hover:text-dls-text"
                }`}
              onClick={() => props.openSettings()}
              aria-label={t("dashboard.advanced")}
            >
              <SlidersHorizontal size={18} />
              {t("dashboard.advanced")}
            </button>
            <Show when={isTauriRuntime()}>
              <VersionInfoPanel
                versionLabel={props.versionLabel()}
                debugBuildCommit={props.debugBuildCommit()}
                debugBuildCommitLabel={props.debugBuildCommitLabel()}
                commitCopied={props.commitCopied()}
                onCopyCommit={() => void props.copyDebugBuildCommit()}
              />
            </Show>
          </div>
          <div
            class="group absolute right-0 top-6 z-10 hidden h-[calc(100%-48px)] w-4 translate-x-1/2 cursor-col-resize items-center justify-center rounded-pill transition-colors hover:bg-dls-hover/70 active:bg-dls-hover lg:flex"
            onPointerDown={startLeftSidebarResize}
            aria-label={t("dashboard.resize_workspace_column")}
          >
            <div class="relative h-full w-0.5 rounded-pill bg-dls-border/50 transition-colors duration-150 group-hover:bg-dls-hover">
              <div class="absolute left-1/2 top-1/2 h-24 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-dls-hover transition-colors duration-150 group-hover:bg-dls-hover group-active:bg-dls-hover" />
            </div>
            <div class="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 whitespace-nowrap rounded-control border border-dls-border bg-dls-surface-solid px-2 py-1 text-label text-dls-secondary shadow-[var(--dls-card-shadow)] group-hover:block">
                Drag to resize
            </div>
          </div>
        </aside>
        </Show>

        <main class="relative min-w-0 flex-1 flex flex-col overflow-hidden rounded-shell border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">

          <DashboardHeader
            title={title()}
            focused={sessionSidebarHidden()}
            onBack={() => backToSessions(props)}
            onOpenNavigation={(trigger) => {
              drawerToggleEl = trigger;
              setSidebarDrawerOpen(true);
            }}
            developerMode={props.developerMode}
            headerStatus={props.headerStatus}
            busyHint={props.busyHint}
          />

          <div ref={contentScrollEl} class="relative min-h-0 flex-1 overflow-y-auto">
            <div class="mx-auto w-full max-w-[1100px] space-y-10 p-6 md:p-10">
              <Show when={props.tab === "data"}>
                <DataUsageView
                  workspaceSessionGroups={props.workspaceSessionGroups}
                  opencodeClient={props.opencodeClient}
                  openworkServerClient={props.openworkServerClient}
                  openworkServerWorkspaceId={props.openworkServerWorkspaceId}
                  llmRouterClient={props.llmRouterClient()}
                />
              </Show>
            </div>

            <Show when={props.error}>
              <div class="mx-auto max-w-5xl px-6 md:px-10 pb-24 md:pb-10">
                <div class="rounded-card bg-dls-danger-bg px-5 py-4 text-body-lg text-dls-danger-text border border-dls-danger-border space-y-3">
                  <div>{props.error}</div>
                  <Show when={props.developerMode}>
                    <div class="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        class="text-caption h-8 py-0 px-3"
                        onClick={props.repairOpencodeCache}
                        disabled={props.cacheRepairBusy || !props.developerMode}
                      >
                        {props.cacheRepairBusy ? t("dashboard.repairing_cache") : t("dashboard.repair_cache")}
                      </Button>
                      <Button
                        variant="outline"
                        class="text-caption h-8 py-0 px-3"
                        onClick={props.stopHost}
                        disabled={props.busy}
                      >
                        {t("dashboard.retry")}
                      </Button>
                      <Show when={props.cacheRepairResult}>
                        <span class="text-caption text-dls-danger-text/80">
                          {props.cacheRepairResult}
                        </span>
                      </Show>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

          </div>

          <StatusBar
            clientConnected={props.clientConnected}
            openworkServerStatus={props.openworkServerStatus}
            developerMode={props.developerMode}
            onSendFeedback={openFeedback}
            onOpenMessaging={openConfig}
            onOpenProviders={() => props.openProviderAuthModal()}
            onOpenMcp={() => props.openSettings("mcp")}
            providerConnectedIds={props.providerConnectedIds}
            mcpStatuses={props.mcpStatuses}
          />
          <FeedbackModal
            open={feedbackModalOpen()}
            appVersion={props.appVersion}
            onClose={() => setFeedbackModalOpen(false)}
          />
          <nav class="hidden border-t border-dls-border bg-dls-surface">
            <div class="mx-auto max-w-5xl px-4 py-3 grid gap-2 grid-cols-2">
              <button
                class={`flex flex-col items-center gap-1 text-caption ${props.tab === "data" ? "text-dls-text" : "text-dls-secondary"
                  }`}
                onClick={() => props.setTab("data")}
              >
                <ChartColumnIncreasing size={18} />
                {t("dashboard.data_usage")}
              </button>
              <button
                class={`flex flex-col items-center gap-1 text-caption ${props.tab === "settings" ? "text-dls-text" : "text-dls-secondary"
                  }`}
                onClick={() => props.openSettings()}
              >
                <SlidersHorizontal size={18} />
                {t("dashboard.advanced")}
              </button>
            </div>
          </nav>
        </main>


      </div>

      <ProviderAuthModal
        open={props.providerAuthModalOpen}
        loading={props.providerAuthBusy}
        submitting={providerAuthActionBusy()}
        error={props.providerAuthError}
        providers={props.providers}
        connectedProviderIds={props.providerConnectedIds}
        authMethods={props.providerAuthMethods}
        onSelect={handleProviderAuthSelect}
        onSubmitApiKey={handleProviderAuthApiKey}
        onSubmitOAuth={handleProviderAuthOAuth}
        onCancelOAuth={props.cancelProviderAuthOAuth}
        onRefreshProviders={props.refreshProviders}
        onClose={() => props.closeProviderAuthModal()}
      />

      <ShareWorkspaceModal
        open={Boolean(shareWorkspaceId())}
        onClose={() => setShareWorkspaceId(null)}
        workspaceName={shareWorkspaceName()}
        workspaceDetail={shareWorkspaceDetail()}
        fields={shareFields()}
        note={shareNote()}
        publisherBaseUrl={DEFAULT_OPENWORK_PUBLISHER_BASE_URL}
        onShareWorkspaceProfile={publishWorkspaceProfileLink}
        shareWorkspaceProfileBusy={shareWorkspaceProfileBusy()}
        shareWorkspaceProfileUrl={shareWorkspaceProfileUrl()}
        shareWorkspaceProfileError={shareWorkspaceProfileError()}
        shareWorkspaceProfileDisabledReason={shareServiceDisabledReason()}
        onShareSkillsSet={publishSkillsSetLink}
        onOpenSingleSkillShare={() => {
          setShareWorkspaceId(null);
          props.openSettings("skills");
        }}
        shareSkillsSetBusy={shareSkillsSetBusy()}
        shareSkillsSetUrl={shareSkillsSetUrl()}
        shareSkillsSetError={shareSkillsSetError()}
        shareSkillsSetDisabledReason={shareServiceDisabledReason()}
        onExportConfig={
          exportDisabledReason()
            ? undefined
            : () => {
              const id = shareWorkspaceId();
              if (!id) return;
              props.exportWorkspaceConfig(id);
            }
        }
        exportDisabledReason={exportDisabledReason()}
        onOpenBots={openConfig}
      />

    </div>
  );
}
