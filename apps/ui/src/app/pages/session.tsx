import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  batch,
} from "solid-js";
import { createStore } from "solid-js/store";
import { tavilySessionWarning } from "~/features/tavily-api-key";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { createStartupConnectingState } from "~/shared/platform/capability/capability-startup-signal";
import { getVisibleQuickAgents } from "~/shared/platform/capability/visible-agent-roster";
import type { NativeRecoveryPresentation } from "~/shared/platform/transport/servicehub";
import { requiresEmailAgentCloudRiskConfirmation } from "../email-agent-cloud-risk";
import type { Session } from "@opencode-ai/sdk/v2/client";
import {
  PENDING_USER_MESSAGE_PREFIX,
  type ComposerDraft,
  type MessageWithParts,
} from "../types";
import type { SettingsSection } from "./settings-dialog.sections";
import { obsidianIsAvailable, type WorkspaceInfo } from "../lib/tauri";
import { usePlatform } from "../context/platform";
import { currentLocale, t } from "../../i18n";
import { uiLogError, uiLogInfo } from "../lib/log";
import { createWorkspaceShellLayout } from "../lib/workspace-shell-layout";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Check,
  Circle,
  Eye,
  ChartColumnIncreasing,
  ListTodo,
  Menu,
  Minimize2,
  RefreshCcw,
  Search,
  Settings,
  SlidersHorizontal,
  X,
  TextAlignJustify,
} from "lucide-solid";
import Button from "../components/button";
import MaskedEntityReviewDialog from "../components/session/masked-entity-review-dialog";
import PermissionApprovalDialog from "../components/session/permission-approval-dialog";
import { parseReviewOperations } from "../components/session/masked-entity-review";
import ConfirmModal from "../components/confirm-modal";
import { SuperClawIcon } from "../components/entry-icon";
import { SuperClawSpinner } from "../components/superclaw-spinner";
import RenameSessionModal from "../components/rename-session-modal";
import ProviderAuthModal, {
  type ProviderOAuthStartResult,
} from "../components/provider-auth-modal";
import ShareWorkspaceModal from "../components/share-workspace-modal";
import FeedbackModal from "../components/feedback-modal";
import StatusBar from "../components/status-bar";
import { DEFAULT_OPENWORK_PUBLISHER_BASE_URL } from "../lib/publisher";
import { retryServiceHubBoot } from "../lib/tauri";
import { isTauriRuntime, localizeSessionTitle } from "../utils";
import { perfNow, recordPerfLog } from "../lib/perf-log";
import {
  trajectoryOriginFor,
  trajectoryPortFrom,
} from "../lib/trajectory-inspector-health";
import { addSessionDeletions } from "~/shared/platform/artifact-deletion-store";
import { Persist, persisted } from "../utils/persist";
import MessageList, {
  type DeepResearchReportSummaryBlock,
} from "../components/session/message-list";
import Composer from "../components/session/session-composer";
import { workspaceSelectionForComposerUpload } from "../components/session/composer-attachment-uploads";
import { VersionInfoPanel } from "../components/version-info-panel";
import WorkspaceSessionList from "../components/session/workspace-session-list";
import { SidebarNewTaskRow } from "../components/session/sidebar-new-task-row";
import FlyoutItem from "../components/flyout-item";
import QuestionPanel from "../components/question-panel";
import { createSessionQuestion } from "../components/session-question";
import WorkspaceFilesPanel from "../components/session/workspace-files-panel";
import FilePreviewModal from "../components/file-preview-modal";
import { base64ToUtf8 } from "~/shared/util/base64-bytes";
import ArtifactsPanel from "../components/session/artifacts-panel";
import Titlebar from "../components/titlebar";
import SidebarDrawer from "../components/session/sidebar-drawer";
import {
  NativeRecoveryBanner,
  SandboxStatusBanner,
} from "../components/status-banner";
import { DevToolsModal } from "../components/dev-tools-modal";
import type { DevToolsTab } from "../components/dev-tools-modal";
import { useStatusDashboard } from "../lib/use-status-dashboard";
import { pillTone } from "../lib/status-view";
import { Tooltip } from "~/shared/ui/tooltip";
import { nextNativeRecoveryPresentation } from "../native-backend-recovery";
import { agentDisplayNames, agentTriggerLabel, QUICK_AGENTS } from "./session.quick-agents";
import { QuickAgentChips } from "./session.quick-agent-chips";
import { selectMentionedAgent } from "./session.agent-mention";
import type { CommandPaletteMode, QuickAgent } from "./session.quick-agents";
import type { SessionViewProps } from "./session.types";
import { RuntimeDisconnectedBanner, blockSendWhileEdgeDegraded, edgeBannerShown } from "./session-disconnected-banner";
import { createJumpScrollAnimator } from "./session.jump-scroll";
import { createFileActions } from "./session.file-actions";
import { createFilePreview } from "./session.file-preview";
import { officeInstallerFor } from "../lib/office-preview-install";
import { createGmailAuth } from "./session.gmail-auth";
import { createSharePublish } from "./session.share-publish";
import { createLocalFiles } from "./session.local-files";
import { createObsidianMirror } from "./session.obsidian-mirror";
import { createTokenUsage } from "./session.token-usage";
import { SessionTokenUsageToggle } from "../components/session/session-token-usage-toggle";

import { createCommandPaletteItems } from "./session.command-palette";
import { createRunLifecycle } from "./session.run-lifecycle";
import { createModelRouting } from "./session.model-routing";
import { createInboxUpload } from "./session.inbox-upload";
import { createPerfTelemetry } from "./session.perf-telemetry";
import { createAgentOptions } from "./session.agent-options";
import { createConfirmDeleteSession } from "./session.delete-session";
import { createFlyouts } from "./session.flyouts";
import { collectReportSummaryCandidates, shouldStartReportSummaryLoad, summarizeReportMarkdown } from "./session.report-summary";
import type { ReportSummaryCandidate } from "./session.report-summary";
import type { PromptNavigationItem } from "./session.message-search";
import { buildReadCandidates, collectTouchedFiles, selectedWorkspacePath, toWorkspaceMentionPaths } from "./session.artifact-paths";
import {
  buildPromptNavigationItems,
  collectSearchHits,
  messageIdFromInfo,
  messageTextForSearch,
  promptNavigationItemsEqual,
} from "./session.message-search";
import {
  searchPositionLabel,
  type SearchNavState,
} from "../components/session/message-list.search-nav";
import {
  INITIAL_MESSAGE_WINDOW,
  JUMP_SCROLL_MAX_DURATION_MS,
  MANUAL_SCROLL_INTENT_WINDOW_MS,
  MANUAL_SCROLL_KEYS,
  MESSAGE_WINDOW_LOAD_CHUNK,
  PINNED_SCROLL_SNAP_EPSILON_PX,
  PINNED_USER_MESSAGE_TOP_GAP_PX,
  PROMPT_NAVIGATION_SCROLL_GUARD_MS,
  RUN_ELAPSED_KEY_PREFIX,
  SMOOTH_SCROLL_GUARD_MS,
  STREAM_RENDER_BATCH_MS,
  STREAM_SCROLL_MIN_INTERVAL_MS,
  TAVILY_WARNING_COOLDOWN_MS,
  automaticPromptPinMotion,
  cleanupStaleRunElapsed,
  parseRunElapsedEntry,
  pinnedSpacerDuringLayout,
  requiredPinnedSpacer,
} from "./session.view-tuning";

// Re-exported from the extracted helpers so this module's public surface is unchanged.
export type { SessionViewProps } from "./session.types";

// Mutable module-level guard. Deliberately NOT moved into session.helpers:
// it is reassigned below, and an importer of a rebound `let` would read a
// stale copy. The flag and its only mutation site stay together.
let _runElapsedCleanupDone = false;

export default function SessionView(props: SessionViewProps) {
  const platform = usePlatform();
  let messagesEndEl: HTMLDivElement | undefined;
  let bottomVisibilityEl: HTMLDivElement | undefined;
  let chatContainerEl: HTMLDivElement | undefined;
  let chatContentEl: HTMLDivElement | undefined;
  let runFooterEl: HTMLDivElement | undefined;
  const refreshRunFooterOffscreen = () => {
    const container = chatContainerEl;
    const footer = runFooterEl;
    // The flag only matters while a pinned run is streaming; skip the layout reads otherwise.
    if (!isGenerating() || !autoPinActive() || !container || !footer?.isConnected) {
      setRunFooterOffscreen(false);
      return;
    }
    setRunFooterOffscreen(
      footer.getBoundingClientRect().top >=
        container.getBoundingClientRect().bottom - 1,
    );
  };
  let scrollMessageIntoViewById:
    | ((messageId: string, behavior?: ScrollBehavior) => boolean)
    | null = null;
  let searchMatchNav: { requestNav: (offset: number) => void } | null = null;
  const [isChatContainerReady, setIsChatContainerReady] = createSignal(false);
  const [chatViewportHeight, setChatViewportHeight] = createSignal(0);
  let agentPickerRef: HTMLDivElement | undefined;
  let searchInputEl: HTMLTextAreaElement | undefined;
  let scrollFrame: number | undefined;
  let pendingScrollBehavior: ScrollBehavior = "auto";
  let lastAutoScrollAt = 0;
  let smoothScrollGuardUntil = 0;
  let lastKnownScrollTop = 0;
  let lastManualScrollIntentAt = 0;
  let scrollbarDragActive = false;
  let promptNavigationScrollUntil = 0;
  let pinnedUserMessageId: string | null = null;
  let pendingPinMessageId: string | null = null;
  let pinRetryFrame: number | undefined;
  let pinnedScrollWaitFrame: number | undefined;
  let completionBottomAnchorFrame: number | undefined;
  const jumpScroll = createJumpScrollAnimator();
  let awaitingNewUserMessagePin = false;
  let retryPinSourceMessageId: string | null = null;
  let pinnedScrollTopThreshold: number | null = null;
  let pinScrollAnimatingUntil = 0;
  // While true, the pin animation is the only scrollTop writer; others settle via its onArrive.
  // A cancelled animation releases the guard at once instead of stranding the pin until expiry.
  const pinScrollAnimating = () =>
    Date.now() < pinScrollAnimatingUntil && jumpScroll.isBusy();
  let historicalPromptScrollReady = false;
  const sessionScrollMemory = new Map<
    string,
    { scrollTop: number; atBottom: boolean }
  >();
  const sessionManualViewportOverride = new Set<string>();
  let isRefreshLoad = !!props.selectedSessionId;
  let needsRefreshAnchor = !!props.selectedSessionId;
  let streamRenderBatchTimer: number | undefined;
  let pendingStreamRenderMessages: MessageWithParts[] | null = null;
  let streamRenderBatchQueuedAt = 0;
  let streamRenderBatchReschedules = 0;
  const topInitializedSessionIds = new Set<string>();

  const [toastMessage, setToastMessage] = createSignal<string | null>(null);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = createSignal(false);
  let navigationToggleEl: HTMLButtonElement | undefined;
  const [devToolsOpen, setDevToolsOpen] = createSignal(false);
  const [feedbackModalOpen, setFeedbackModalOpen] = createSignal(false);
  const openFeedback = () => setFeedbackModalOpen(true);
  const [devToolsTab, setDevToolsTab] = createSignal<DevToolsTab>("trajectory");

  // Debug-only setup: trajectory iframe, runtime status, and dev tools state.
  // All gated behind __BUILD_DEBUG__; tree-shaken from release.
  let runtimeStatus: any = null;
  let runtimeStatusUiVisible: () => boolean = () => false;
  let trajectoryOriginAccessor: () => string = () => "";

  if (__BUILD_DEBUG__) {
    // Loopback-only origin (never window.location.hostname - see #864); the
    // rationale lives with the helper in lib/trajectory-inspector-health.ts.
    // DevToolsModal derives both the iframe src and its postMessage origin check
    // from this same value, so the port has one source of truth.
    const trajectoryOrigin = trajectoryOriginFor(
      trajectoryPortFrom(import.meta.env.VITE_TRAJECTORY_PORT),
    );

    // Listen for postMessage from the trajectory iframe (cross-origin, so
    // window.open / <a download> inside the iframe may be blocked by Tauri).
    // NOTE: trajectory:download is handled by DevToolsModal directly.
    {
      const handler = (e: MessageEvent) => {
        if (e.origin !== trajectoryOrigin) return;
        if (!e.data || typeof e.data !== "object") return;
        if (
          e.data.type === "trajectory:open-url" &&
          typeof e.data.url === "string"
        ) {
          platform.openLink(e.data.url);
        }
      };
      window.addEventListener("message", handler);
      onCleanup(() => window.removeEventListener("message", handler));
    }

    // Developer-only sandbox visibility. The UI entry point is intentionally tied
    // to debug observability so normal users do not see the sandbox status surface
    // in release builds (when __BUILD_DEBUG__ is false).
    runtimeStatus = useStatusDashboard({
      serverBaseUrl: () =>
        props.openworkServerHostInfo?.baseUrl?.trim() ||
        props.openworkServerUrl?.trim() ||
        null,
      serverAuth: () => {
        const token = props.openworkServerSettings.token?.trim() ?? "";
        return token ? { token } : null;
      },
      enabled: () => props.debugObservabilityAvailable,
    });
    runtimeStatusUiVisible = createMemo(
      () => props.debugObservabilityAvailable,
    );
    // A build-time constant, so no createMemo needed.
    trajectoryOriginAccessor = () => trajectoryOrigin;

    createEffect(() => {
      if (!runtimeStatusUiVisible()) setDevToolsOpen(false);
    });
  }
  const [providerAuthActionBusy, setProviderAuthActionBusy] =
    createSignal(false);
  const [renameModalOpen, setRenameModalOpen] = createSignal(false);
  const [renameSessionId, setRenameSessionId] = createSignal<string | null>(
    null,
  );
  const [renameTitle, setRenameTitle] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);
  const [renameReturnFocusToComposer, setRenameReturnFocusToComposer] =
    createSignal(false);

  const [deleteSessionOpen, setDeleteSessionOpen] = createSignal(false);
  const [deleteSessionId, setDeleteSessionId] = createSignal<string | null>(
    null,
  );
  const [deleteSessionBusy, setDeleteSessionBusy] = createSignal(false);
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const agentPicker = createAgentOptions({
    listAgents: () => props.listAgents(),
    agentsVersion: () => props.agentsVersion,
    connectionKey: () => props.agentClient,
    capabilityActive: () => capability.isActive(),
    isAgentAllowed: (name) => capability.isAgentAllowed(name),
    productProfileId: () => capability.productProfileId(),
  });
  const agentOptions = agentPicker.options;
  const agentPickerBusy = agentPicker.busy;
  const agentPickerReady = agentPicker.ready;
  const agentPickerError = agentPicker.error;
  const loadAgentOptions = agentPicker.load;
  const capability = useCapabilityGate();
  const visibleQuickAgents = createMemo<QuickAgent[]>(() =>
    getVisibleQuickAgents(
      QUICK_AGENTS,
      capability.isActive(),
      capability.isAgentAllowed,
      capability.productProfileId(),
      new Set(agentOptions().map((agent) => agent.name)),
    ),
  );
  const [isViewingLatest, setIsViewingLatest] = createSignal(true);
  const [scrollBottomGap, setScrollBottomGap] = createSignal(0);
  const showJumpToLatest = createMemo((prev: boolean) => {
    const gap = scrollBottomGap();
    if (gap > 200) return true;
    if (gap < 100) return false;
    return prev;
  }, false);
  const [bottomSpacerPx, setBottomSpacerPx] = createSignal(0);
  const [autoPinActive, setAutoPinActive] = createSignal(false);
  const [jumpControlsSuppressed, setJumpControlsSuppressed] =
    createSignal(false);
  // While pinned, the run indicator footer scrolls off-screen once output outgrows the viewport.
  // Measured on the footer itself: the list's bottom padding and the pin spacer sit below it,
  // so the scroll bottom gap overstates how far the footer has moved.
  const [runFooterOffscreen, setRunFooterOffscreen] = createSignal(false);
  const runSpinnerVisible = () =>
    isGenerating() &&
    (autoPinActive() ? runFooterOffscreen() : !isViewingLatest());
  const shouldShowJumpControls = createMemo(
    () =>
      props.messages.length > 0 &&
      !jumpControlsSuppressed() &&
      (runSpinnerVisible() ||
        (!isGenerating() && showJumpToLatest())),
  );
  const [promptNavigationHovered, setPromptNavigationHovered] =
    createSignal(false);
  const [promptNavigationFocused, setPromptNavigationFocused] =
    createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchClosing, setSearchClosing] = createSignal(false);
  const [searchPanelVisible, setSearchPanelVisible] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchQueryDebounced, setSearchQueryDebounced] = createSignal("");
  const [searchNavState, setSearchNavState] = createSignal<SearchNavState>({
    activeIndex: 0,
    total: 0,
  });
  let searchCloseTimer: number | undefined;
  let searchPanelEnterOuterFrame: number | undefined;
  let searchPanelEnterFrame: number | undefined;
  const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);

  const cancelSearchPanelEnterFrames = () => {
    if (searchPanelEnterOuterFrame !== undefined) {
      window.cancelAnimationFrame(searchPanelEnterOuterFrame);
      searchPanelEnterOuterFrame = undefined;
    }
    if (searchPanelEnterFrame !== undefined) {
      window.cancelAnimationFrame(searchPanelEnterFrame);
      searchPanelEnterFrame = undefined;
    }
  };

  onCleanup(() => {
    if (searchCloseTimer !== undefined) {
      window.clearTimeout(searchCloseTimer);
    }
    cancelSearchPanelEnterFrames();
  });
  const [commandPaletteMode, setCommandPaletteMode] =
    createSignal<CommandPaletteMode>("root");
  const [commandPaletteQuery, setCommandPaletteQuery] = createSignal("");
  const [commandPaletteActiveIndex, setCommandPaletteActiveIndex] =
    createSignal(0);
  const [historyActionBusy, setHistoryActionBusy] = createSignal<
    "undo" | "redo" | "compact" | "edit" | null
  >(null);
  const [messageWindowStart, setMessageWindowStart] = createSignal(0);
  const [messageWindowSessionId, setMessageWindowSessionId] = createSignal<
    string | null
  >(null);
  const [messageWindowExpanded, setMessageWindowExpanded] = createSignal(false);
  const [initialAnchorPending, setInitialAnchorPending] = createSignal(
    !!props.selectedSessionId,
  );

  const [obsidianAvailable, setObsidianAvailable] = createSignal(false);
  const [modelBreakdownOpen, setModelBreakdownOpen] = createSignal(false);

  const gmailAuth = createGmailAuth({
    selectedSessionAgent: () => props.selectedSessionAgent,
    selectedSessionId: () => props.selectedSessionId,
    sessionStatus: () => props.sessionStatus,
    messages: () => props.messages,
    getMessagesBySessionId: (sessionId) =>
      props.getMessagesBySessionId(sessionId),
    serverSettings: () => props.openworkServerSettings,
    serverHostInfo: () => props.openworkServerHostInfo,
    serverWorkspaceId: () => props.openworkServerWorkspaceId,
    abortSession: (sessionId) => props.abortSession(sessionId),
    setToastMessage,
    openLink: (url) => platform.openLink(url),
  });

  const confirmSelectedEmailAgentCloudRisk = (): Promise<boolean> => {
    if (
      !requiresEmailAgentCloudRiskConfirmation(
        props.selectedSessionAgent,
        props.selectedModel,
      )
    ) {
      return Promise.resolve(true);
    }
    return props.confirmEmailAgentCloudRisk();
  };


  // In Session view the right sidebar is navigation-only; never pre-highlight a
  // dashboard tab here so first-run feels chat-first rather than Automations-first.
  const showRightSidebarSelection = createMemo(() => false);
  let commandPaletteInputEl: HTMLInputElement | undefined;
  const commandPaletteOptionRefs: HTMLButtonElement[] = [];
  const {
    leftSidebarWidth,
    rightSidebarExpanded,
    rightSidebarVisible,
    rightSidebarWidth,
    setRightSidebarExpanded,
    startLeftSidebarResize,
    startRightSidebarResize,
    toggleRightSidebar,
  } = createWorkspaceShellLayout({
    collapsedRightWidth: 0,
    expandedRightWidth: 320,
    minRightWidth: 240,
    maxRightWidth: 540,
  });

  // ── Cloud model readiness (pre-warm for llmrouter/auto) ────────────
  //
  // Background-checks LRM control-plane health on mount, model change,
  // provider change, and every 60 s.  handleSendPrompt reads the cached
  // value (zero latency on happy path) and re-verifies before showing a
  // blocking dialog on the unhappy path.

  const modelRouting = createModelRouting({
    selectedModel: () => props.selectedModel,
    hostInfoBaseUrl: () => props.openworkServerHostInfo?.baseUrl,
    serverUrl: () => props.openworkServerUrl,
    providerConnectedIds: () => props.providerConnectedIds,
    view: () => props.view,
  });
  const cloudModelStatus = modelRouting.cloudStatus;
  const localModelStatus = modelRouting.localStatus;
  const autoRouterDiagnostics = modelRouting.diagnostics;
  const setAutoRouterDiagnostics = modelRouting.setDiagnostics;
  const selectedRouterAlias = modelRouting.selectedRouterAlias;
  const llmrouterBaseUrl = modelRouting.baseUrl;
  const refreshCloudModelStatus = modelRouting.refresh;
  const [cloudModelWarningOpen, setCloudModelWarningOpen] = createSignal(false);
  type ModelWarningReason =
    | "cloud_not_configured"
    | "cloud_unhealthy"
    | "local_not_configured"
    | "local_unhealthy"
    | "both_not_configured"
    | "check_failed";
  const [cloudModelWarningReason, setCloudModelWarningReason] =
    createSignal<ModelWarningReason | null>(null);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = createSignal(false);
  createEffect(() => {
    if (cloudModelWarningOpen()) setDiagnosticsExpanded(false);
  });
  const [defaultAgentTavilyWarningOpen, setDefaultAgentTavilyWarningOpen] =
    createSignal(false);
  const [hybridDeepResearchFileLimitOpen, setHybridDeepResearchFileLimitOpen] =
    createSignal(false);
  const [defaultAgentTavilyPendingDraft, setDefaultAgentTavilyPendingDraft] =
    createSignal<ComposerDraft | null>(null);
  const [
    defaultAgentTavilyAcknowledgedSessionIds,
    setDefaultAgentTavilyAcknowledgedSessionIds,
  ] = createSignal<Set<string>>(new Set());
  type ReportSummaryState = {
    content: string | null;
    loading: boolean;
    error: string | null;
    attemptKey?: string;
  };
  const [reportSummaryById, setReportSummaryById] = createSignal<
    Record<string, ReportSummaryState>
  >({});

  // Rate-limit the Tavily warning: show at most once every 7 days.
  const [
    tavilyWarningDismissedAt,
    setTavilyWarningDismissedAt,
    ,
    tavilyWarningReady,
  ] = persisted(
    Persist.global("tavily-warning-dismissed-at"),
    createStore({ ts: 0 }),
  );
  // "Could not check" has its own cooldown: dismissing it must not hide "not configured", nor the reverse.
  const [
    tavilyUnreadableDismissedAt,
    setTavilyUnreadableDismissedAt,
    ,
    tavilyUnreadableReady,
  ] = persisted(
    Persist.global("tavily-unreadable-warning-dismissed-at"),
    createStore({ ts: 0 }),
  );

  createEffect(() => {
    if (!isTauriRuntime()) {
      setObsidianAvailable(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const available = await obsidianIsAvailable();
        if (!cancelled) setObsidianAvailable(available);
      } catch {
        if (!cancelled) setObsidianAvailable(false);
      }
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });

  const agentLabel = createMemo(() => agentTriggerLabel(props.selectedSessionAgent));
  const workspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    "Worker";
  const todoList = createMemo(() =>
    props.todos.filter((todo) => todo.content.trim()),
  );
  const todoCount = createMemo(() => todoList().length);
  const todoCompletedCount = createMemo(
    () => todoList().filter((todo) => todo.status === "completed").length,
  );

  /** Cumulative PII entity tally for the current session (shown in right sidebar) */
  const [piiStats, setPiiStats] = createSignal<{
    total: number;
    types: Record<string, number>;
  }>({ total: 0, types: {} });
  let piiStatsTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => {
    if (piiStatsTimer) clearTimeout(piiStatsTimer);
  });
  createEffect(
    on(
      () =>
        [
          props.selectedSessionId,
          props.messages.length,
          rightSidebarExpanded(),
        ] as const,
      ([sessionId, , sidebarOpen]) => {
        // Cancel any pending fetch before re-evaluating: prevents a debounced
        // call from firing after the sidebar closes or the session/workspace
        // becomes invalid mid-debounce.
        if (piiStatsTimer) {
          clearTimeout(piiStatsTimer);
          piiStatsTimer = null;
        }
        const client = props.openworkServerClient;
        const workspaceId = props.openworkServerWorkspaceId?.trim();
        if (!client || !workspaceId || !sessionId) {
          setPiiStats({ total: 0, types: {} });
          return;
        }
        if (!sidebarOpen) return;
        piiStatsTimer = setTimeout(() => {
          piiStatsTimer = null;
          void client
            .getPiiStats(workspaceId, sessionId)
            .then((stats) => {
              if (stats) setPiiStats(stats);
            })
            .catch(() => undefined);
        }, 500);
      },
    ),
  );

  const tokenUsage = createTokenUsage({
    messages: () => props.messages,
    selectedSessionId: () => props.selectedSessionId,
    llmRouterClient: () => props.llmRouterClient,
    sessionStatus: () => props.sessionStatus,
    getMessagesBySessionId: props.getMessagesBySessionId,
    providers: () => props.allProviders,
  });

  createEffect(() => {
    const value = searchQuery();
    if (typeof window === "undefined") {
      setSearchQueryDebounced(value);
      return;
    }
    const id = window.setTimeout(() => setSearchQueryDebounced(value), 90);
    onCleanup(() => window.clearTimeout(id));
  });

  const searchMatchMessageIds = createMemo(() => {
    if (!searchOpen()) return new Set<string>();
    const query = searchQueryDebounced().trim().toLowerCase();
    if (!query) return new Set<string>();

    const startedAt = perfNow();
    const { hits, capped } = collectSearchHits(
      props.messages,
      query,
      props.getMessagesBySessionId,
    );
    const out = new Set<string>();
    for (const hit of hits) out.add(hit.messageId);

    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    if (props.developerMode && (elapsedMs >= 8 || capped)) {
      recordPerfLog(true, "session.search", "scan", {
        queryLength: query.length,
        messageCount: props.messages.length,
        hitCount: hits.length,
        capped,
        ms: elapsedMs,
      });
    }

    return out;
  });

  const activeSearchPositionLabel = createMemo(() =>
    searchNavState().scanning
      ? "Searching…"
      : searchNavState().truncated
        ? `Showing first ${searchNavState().total.toLocaleString()} matches`
      : searchPositionLabel(searchNavState().total, searchNavState().activeIndex),
  );

  const searchActive = createMemo(
    () => searchOpen() && searchQuery().trim().length > 0,
  );
  const totalPartCount = createMemo(() =>
    props.messages.reduce((total, message) => total + message.parts.length, 0),
  );

  const renderedMessages = createMemo(() => {
    if (messageWindowExpanded() || searchActive()) return props.messages;

    const start = messageWindowStart();
    if (start <= 0) return props.messages;
    if (start >= props.messages.length) return [];
    return props.messages.slice(start);
  });

  const [batchedRenderedMessages, setBatchedRenderedMessages] =
    createSignal<MessageWithParts[]>(renderedMessages());

  createEffect(() => {
    const next = renderedMessages();
    const sourceMessageCount = props.messages.length;
    const sourcePartCount = totalPartCount();
    if (props.sessionStatus === "idle") {
      if (streamRenderBatchTimer !== undefined) {
        window.clearTimeout(streamRenderBatchTimer);
        streamRenderBatchTimer = undefined;
      }
      pendingStreamRenderMessages = null;
      setBatchedRenderedMessages(next);
      streamRenderBatchQueuedAt = 0;
      streamRenderBatchReschedules = 0;
      return;
    }

    if (streamRenderBatchQueuedAt <= 0) {
      streamRenderBatchQueuedAt = perfNow();
    } else {
      streamRenderBatchReschedules += 1;
    }

    pendingStreamRenderMessages = next;
    if (streamRenderBatchTimer !== undefined) return;

    streamRenderBatchTimer = window.setTimeout(() => {
      const applyStartedAt = perfNow();
      const pendingMessages = pendingStreamRenderMessages ?? next;
      pendingStreamRenderMessages = null;
      setBatchedRenderedMessages(pendingMessages);
      streamRenderBatchTimer = undefined;
      const applyMs = Math.round((perfNow() - applyStartedAt) * 100) / 100;
      const queuedMs =
        streamRenderBatchQueuedAt > 0
          ? Math.round((perfNow() - streamRenderBatchQueuedAt) * 100) / 100
          : 0;
      const reschedules = streamRenderBatchReschedules;
      streamRenderBatchQueuedAt = 0;
      streamRenderBatchReschedules = 0;

      if (props.developerMode) {
        window.requestAnimationFrame(() => {
          const paintMs = Math.round((perfNow() - applyStartedAt) * 100) / 100;
          if (
            queuedMs >= 180 ||
            applyMs >= 8 ||
            paintMs >= 24 ||
            reschedules >= 3
          ) {
            recordPerfLog(true, "session.render", "batch-commit", {
              queuedMs,
              applyMs,
              paintMs,
              reschedules,
              sessionID: props.selectedSessionId,
              status: props.sessionStatus,
              sourceMessageCount,
              sourcePartCount,
              renderedMessageCount: next.length,
            });
          }
        });
      }
    }, STREAM_RENDER_BATCH_MS);
  });

  // Commits the latest batched-render messages immediately.
  // This is used when the user scrolls to the bottom of the message window, so that any queued messages are rendered immediately.
  const flushBatchedRenderNow = () => {
    if (streamRenderBatchTimer !== undefined) {
      window.clearTimeout(streamRenderBatchTimer);
      streamRenderBatchTimer = undefined;
    }
    pendingStreamRenderMessages = null;
    setBatchedRenderedMessages(renderedMessages());
    streamRenderBatchQueuedAt = 0;
    streamRenderBatchReschedules = 0;
  };

  const hiddenMessageCount = createMemo(() => {
    if (messageWindowExpanded() || searchActive()) return 0;
    const hidden = props.messages.length - renderedMessages().length;
    return hidden > 0 ? hidden : 0;
  });

  const nextRevealCount = createMemo(() => {
    const hidden = hiddenMessageCount();
    if (hidden <= 0) return 0;
    return Math.min(hidden, MESSAGE_WINDOW_LOAD_CHUNK);
  });

  const hasServerEarlierMessages = createMemo(
    () =>
      !searchActive() &&
      Boolean(props.selectedSessionId) &&
      props.hasEarlierMessages,
  );

  const revealEarlierMessages = async () => {
    const hidden = hiddenMessageCount();
    if (hidden > 0) {
      const nextStart = Math.max(
        0,
        messageWindowStart() - MESSAGE_WINDOW_LOAD_CHUNK,
      );
      if (props.developerMode) {
        recordPerfLog(true, "session.window", "reveal", {
          sessionID: props.selectedSessionId,
          hiddenBefore: hidden,
          nextStart,
        });
      }
      setMessageWindowStart(nextStart);
      if (nextStart === 0) {
        setMessageWindowExpanded(true);
      }
      return;
    }

    if (!hasServerEarlierMessages()) return;
    if (!props.selectedSessionId) return;
    setMessageWindowExpanded(true);
    setMessageWindowStart(0);
    await props.loadEarlierMessages(props.selectedSessionId);
    if (props.developerMode) {
      recordPerfLog(true, "session.window", "load-earlier", {
        sessionID: props.selectedSessionId,
      });
    }
  };

  createPerfTelemetry({
    developerMode: () => props.developerMode,
    selectedSessionId: () => props.selectedSessionId,
    sessionStatus: () => props.sessionStatus,
    messageCount: () => props.messages.length,
    partCount: totalPartCount,
    batchedRenderedCount: () => batchedRenderedMessages().length,
    renderedMessageCount: () => renderedMessages().length,
    hiddenMessageCount,
    messageWindowExpanded,
    searchActive,
  });

  const canUndoLastMessage = createMemo(() => {
    if (!props.selectedSessionId) return false;
    const revert = props.sessionRevertMessageId;
    for (const message of props.messages) {
      const role = (message.info as { role?: string }).role;
      if (role !== "user") continue;
      const id = messageIdFromInfo(message);
      if (!id) continue;
      if (!revert || id < revert) return true;
    }
    return false;
  });

  const promptNavigationOpen = createMemo(
    () => promptNavigationHovered() || promptNavigationFocused(),
  );

  const promptNavigationItems = createMemo<PromptNavigationItem[]>((prev) => {
    const next = buildPromptNavigationItems(props.messages);
    return promptNavigationItemsEqual(prev, next) ? prev : next;
  }, []);

  const hasPromptNavigation = createMemo(
    () => promptNavigationItems().length > 0,
  );

  const latestUserMessageId = createMemo(() => {
    const messages = props.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if ((message?.info as { role?: string })?.role !== "user") continue;
      const id = messageIdFromInfo(message);
      if (id) return id;
    }
    return null;
  });

  const touchedFiles = createMemo<string[]>(
    (prev) => collectTouchedFiles(props.artifacts, props.workingFiles, prev, props.activeWorkspaceRoot),
    [],
  );

  // ── Async file-existence verification ──────────────────────────────
  const localFiles = createLocalFiles({
    workspaceDisplay: () => props.activeWorkspaceDisplay,
    activeWorkspaceRoot: () => props.activeWorkspaceRoot,
    selectedSessionId: () => props.selectedSessionId,
    artifacts: () => props.artifacts,
    developerMode: () => props.developerMode,
    touchedFiles,
  });
  const { verifiedFiles, setVerifiedFiles, runLocalFileAction } = localFiles;

  const obsidianMirror = createObsidianMirror({
    serverClient: () => props.openworkServerClient,
    serverWorkspaceId: () => props.openworkServerWorkspaceId,
    workspaceDisplayId: () => props.activeWorkspaceDisplay.id,
    workspaceType: () => props.activeWorkspaceDisplay.workspaceType,
    activeWorkspaceRoot: () => props.activeWorkspaceRoot,
    setToastMessage,
  });

  const fileActions = createFileActions({
    workspaceType: () => props.activeWorkspaceDisplay.workspaceType,
    obsidianAvailable,
    // Declared further down the component, so the read must stay deferred.
    isSandboxWorkspace: () => isSandboxWorkspace(),
    setToastMessage,
    resolveHostRoot: localFiles.resolveHostRoot,
    runLocalFileAction,
    mirrorRemoteArtifactForObsidian:
      obsidianMirror.mirrorRemoteArtifactForObsidian,
  });
  const { revealArtifact, openWorkspaceItemInExplorer, openArtifactInObsidian } =
    fileActions;

  const readFileViaServer = async (file: string): Promise<string | null> => {
    const hit = await obsidianMirror.readCandidatesViaSession(
      buildReadCandidates(file, props.activeWorkspaceRoot),
    );
    return hit ? base64ToUtf8(hit.contentBase64) : null;
  };

  const readMarkdownFileForPreview = async (
    file: string,
  ): Promise<string | null> => {
    return readFileViaServer(file);
  };

  const readFileBase64ViaServer = async (
    file: string,
  ): Promise<string | null> => {
    const hit = await obsidianMirror.readCandidatesViaSession(
      buildReadCandidates(file, props.activeWorkspaceRoot),
    );
    return hit?.contentBase64 ?? null;
  };

  const filePreview = createFilePreview({
    workspaceType: () => props.activeWorkspaceDisplay.workspaceType,
    activeWorkspaceRoot: () => props.activeWorkspaceRoot,
    serverClient: () => props.openworkServerClient,
    serverWorkspaceId: () => props.openworkServerWorkspaceId,
    runLocalFileAction,
    readFileViaServer,
    readFileBase64ViaServer,
    officeInstaller: () => officeInstallerFor(props.openworkServerSettings),
  });

  const reportSummaryCandidates = createMemo<ReportSummaryCandidate[]>(() =>
    collectReportSummaryCandidates({
      messages: props.messages,
      artifacts: props.artifacts,
      workingFiles: props.workingFiles,
      activeWorkspaceRoot: props.activeWorkspaceRoot,
    }),
  );

  createEffect(() => {
    const retryKey = `${props.openworkServerWorkspaceId ?? ""}:${props.openworkServerClient ? 1 : 0}:${obsidianMirror.fileSessionId()}`;
    for (const candidate of reportSummaryCandidates()) {
      if (candidate.inlineSummary) continue;
      const current = reportSummaryById()[candidate.id];
      const attemptKey = `${candidate.id}:${retryKey}`;
      if (!shouldStartReportSummaryLoad(current, attemptKey)) continue;

      setReportSummaryById((previous) => ({
        ...previous,
        [candidate.id]: {
          content: null,
          loading: true,
          error: null,
          attemptKey,
        },
      }));

      void readMarkdownFileForPreview(candidate.summaryPath)
        .then((content) => {
          setReportSummaryById((previous) => {
            if (previous[candidate.id]?.attemptKey !== attemptKey) {
              return previous;
            }
            return {
              ...previous,
              [candidate.id]: {
                content:
                  content === null
                    ? ""
                    : candidate.truncateSummary
                      ? summarizeReportMarkdown(content)
                      : content.trim(),
                loading: false,
                error:
                  content === null ? "Could not read report content." : null,
                attemptKey,
              },
            };
          });
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : "Unable to read report.";
          setReportSummaryById((previous) => {
            if (previous[candidate.id]?.attemptKey !== attemptKey) {
              return previous;
            }
            return {
              ...previous,
              [candidate.id]: {
                content: null,
                loading: false,
                error: message,
                attemptKey,
              },
            };
          });
        });
    }
  });

  const reportSummaryBlocks = createMemo<DeepResearchReportSummaryBlock[]>(
    () => {
      const stateById = reportSummaryById();
      return reportSummaryCandidates().map((candidate) => {
        const state = stateById[candidate.id] ?? {
          content: candidate.inlineSummary,
          loading: !candidate.inlineSummary,
          error: null,
        };
        return {
          id: candidate.id,
          afterMessageId: candidate.afterMessageId,
          path: candidate.path,
          summaryPath: candidate.summaryPath,
          displayPath: candidate.displayPath,
          summary: state.content,
          loading: state.loading,
          error: state.error,
        };
      });
    },
  );

  const inboxUpload = createInboxUpload({
    serverClient: () => props.openworkServerClient,
    serverWorkspaceId: () => props.openworkServerWorkspaceId,
    workspaces: () => props.workspaces,
    rightSidebarExpanded,
    setRightSidebarExpanded,
    bumpInboxVersion: () => setInboxVersion((v) => v + 1),
    setSelectedFiles: (update) => setWorkspaceSelectedFiles(update),
    notify: setToastMessage,
  });
  const uploadInboxFiles = inboxUpload.upload;
  const revealWorkspaceInFinder = inboxUpload.revealWorkspaceInFinder;

  const todoLabel = createMemo(() => {
    const total = todoCount();
    if (!total) return "";
    return `${todoCompletedCount()} out of ${total} tasks completed`;
  });
  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(
    null,
  );
  let initialAnchorRafA: number | undefined;
  let initialAnchorRafB: number | undefined;
  let initialAnchorGuardTimer: ReturnType<typeof setTimeout> | undefined;
  let jumpControlsSuppressTimer: ReturnType<typeof setTimeout> | undefined;
  const attachmentsEnabled = createMemo(() => {
    if (props.activeWorkspaceDisplay.workspaceType !== "remote") return true;
    return props.openworkServerStatus === "connected";
  });
  const attachmentsDisabledReason = createMemo(() => {
    if (attachmentsEnabled()) return null;
    if (props.openworkServerStatus === "limited") {
      return "Add a server token to attach files.";
    }
    return "Connect to SuperClaw server to attach files.";
  });

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    const container = chatContainerEl;
    if (!container) return;
    const targetTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight,
    );
    if (behavior === "auto") {
      jumpScroll.cancel();
      container.scrollTop = targetTop;
      lastKnownScrollTop = container.scrollTop;
    } else {
      jumpScroll.animateTo(container, targetTop, () => {
        lastKnownScrollTop = container.scrollTop;
      });
    }
  };

  const pinToLatestNow = () => {
    // A new session's first prompt pins during the initial anchor window; the pin owns the viewport.
    if (isUserMessagePinPending() || pinnedUserMessageId !== null) return;
    setIsViewingLatest(true);
    if (chatContainerEl) {
      chatContainerEl.scrollTop = chatContainerEl.scrollHeight;
      lastKnownScrollTop = chatContainerEl.scrollTop;
    } else {
      messagesEndEl?.scrollIntoView({ behavior: "auto", block: "end" });
      window.requestAnimationFrame(() => {
        if (!chatContainerEl) return;
        lastKnownScrollTop = chatContainerEl.scrollTop;
      });
    }
  };

  const pinToLatestAfterLayout = (behavior: ScrollBehavior = "auto") => {
    if (isUserMessagePinPending() || autoPinActive()) return;
    setIsViewingLatest(true);
    if (chatContainerEl) {
      chatContainerEl.scrollTop = chatContainerEl.scrollHeight;
      lastKnownScrollTop = chatContainerEl.scrollTop;
    } else {
      messagesEndEl?.scrollIntoView({ behavior: "auto", block: "end" });
    }
    window.requestAnimationFrame(() => {
      if (isUserMessagePinPending() || autoPinActive()) return;
      if (chatContainerEl) {
        chatContainerEl.scrollTop = chatContainerEl.scrollHeight;
        lastKnownScrollTop = chatContainerEl.scrollTop;
      } else {
        messagesEndEl?.scrollIntoView({ behavior, block: "end" });
        window.requestAnimationFrame(() => {
          if (!chatContainerEl) return;
          lastKnownScrollTop = chatContainerEl.scrollTop;
        });
      }
    });
  };

  const isUserMessagePinPending = () =>
    awaitingNewUserMessagePin || pendingPinMessageId !== null;

  // A jump to an older prompt owns the viewport until it lands. Self-expiring so
  // a cancelled wait can never strand auto-follow in the off state.
  const promptNavigationScrollActive = () =>
    Date.now() < promptNavigationScrollUntil;

  const scheduleScrollToLatest = (behavior: ScrollBehavior = "auto") => {
    if (isUserMessagePinPending()) return;
    if (promptNavigationScrollActive()) return;
    if (behavior === "smooth") {
      pendingScrollBehavior = "smooth";
    }
    if (scrollFrame !== undefined) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = undefined;
      const nextBehavior = pendingScrollBehavior;
      pendingScrollBehavior = "auto";
      if (
        isUserMessagePinPending() ||
        autoPinActive() ||
        promptNavigationScrollActive()
      ) {
        return;
      }
      const now = Date.now();
      if (
        nextBehavior === "auto" &&
        (now - lastAutoScrollAt < STREAM_SCROLL_MIN_INTERVAL_MS ||
          now < smoothScrollGuardUntil)
      ) {
        return;
      }
      lastAutoScrollAt = now;
      if (nextBehavior === "smooth") {
        smoothScrollGuardUntil = now + SMOOTH_SCROLL_GUARD_MS;
      }
      scrollToLatest(nextBehavior);
    });
  };

  const cancelInitialAnchorFrames = () => {
    if (initialAnchorRafA !== undefined) {
      window.cancelAnimationFrame(initialAnchorRafA);
      initialAnchorRafA = undefined;
    }
    if (initialAnchorRafB !== undefined) {
      window.cancelAnimationFrame(initialAnchorRafB);
      initialAnchorRafB = undefined;
    }
    if (initialAnchorGuardTimer) {
      clearTimeout(initialAnchorGuardTimer);
      initialAnchorGuardTimer = undefined;
    }
  };

  const applyInitialBottomAnchor = (sessionId: string) => {
    cancelInitialAnchorFrames();
    initialAnchorGuardTimer = setTimeout(() => {
      initialAnchorGuardTimer = undefined;
      if (props.selectedSessionId !== sessionId) return;
      setInitialAnchorPending(false);
    }, 600);
    pinToLatestNow();
    initialAnchorRafA = window.requestAnimationFrame(() => {
      initialAnchorRafA = undefined;
      pinToLatestNow();
      initialAnchorRafB = window.requestAnimationFrame(() => {
        initialAnchorRafB = undefined;
        pinToLatestNow();
        if (props.selectedSessionId !== sessionId) {
          setInitialAnchorPending(false);
          return;
        }
        if (batchedRenderedMessages().length > 0) {
          needsRefreshAnchor = false;
          setInitialAnchorPending(false);
        }
      });
    });
  };

  onCleanup(() => {
    cancelInitialAnchorFrames();
    // Not part of the initial anchor: clearing it there left the jump controls
    // suppressed for good when a new session was created within the 300ms window.
    if (jumpControlsSuppressTimer !== undefined) {
      clearTimeout(jumpControlsSuppressTimer);
      jumpControlsSuppressTimer = undefined;
    }
    jumpScroll.cancel();
    if (scrollFrame !== undefined) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    }
    if (pinRetryFrame !== undefined) {
      window.cancelAnimationFrame(pinRetryFrame);
      pinRetryFrame = undefined;
    }
    if (pinnedScrollWaitFrame !== undefined) {
      window.cancelAnimationFrame(pinnedScrollWaitFrame);
      pinnedScrollWaitFrame = undefined;
    }
    if (completionBottomAnchorFrame !== undefined) {
      window.cancelAnimationFrame(completionBottomAnchorFrame);
      completionBottomAnchorFrame = undefined;
    }
    if (streamRenderBatchTimer !== undefined) {
      window.clearTimeout(streamRenderBatchTimer);
      streamRenderBatchTimer = undefined;
    }
    pendingStreamRenderMessages = null;
    streamRenderBatchQueuedAt = 0;
    streamRenderBatchReschedules = 0;
  });

  createEffect(
    on(
      () => [props.selectedSessionId, props.messages.length] as const,
      ([sessionId, count], previous) => {
        const previousSessionId = previous?.[0] ?? null;
        if (sessionId !== previousSessionId) {
          setMessageWindowSessionId(null);
          setMessageWindowExpanded(false);
          setMessageWindowStart(0);
        }

        if (!sessionId) return;
        if (messageWindowExpanded()) return;
        if (count === 0) return;

        const targetStart =
          count > INITIAL_MESSAGE_WINDOW ? count - INITIAL_MESSAGE_WINDOW : 0;
        if (messageWindowSessionId() !== sessionId) {
          setMessageWindowStart(targetStart);
          setMessageWindowSessionId(sessionId);
          return;
        }

        const currentStart = messageWindowStart();
        if (currentStart <= 0 && targetStart > 0) {
          setMessageWindowStart(targetStart);
          return;
        }

        if (isViewingLatest() && targetStart > currentStart) {
          setMessageWindowStart(targetStart);
        }
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const count = props.messages.length;
    const start = messageWindowStart();
    if (start <= count) return;
    setMessageWindowStart(count);
  });

  const [isInitialLoad, setIsInitialLoad] = createSignal(true);
  const [todoExpanded, setTodoExpanded] = createSignal(false);

  const run = createRunLifecycle({
    messages: () => props.messages,
    sessionStatus: () => props.sessionStatus,
    // Indexed read, not hasOwnProperty: only the indexed read subscribes to this key being added to the store.
    sessionStatusKnown: () =>
      props.selectedSessionId !== null &&
      props.sessionStatusById[props.selectedSessionId] !== undefined,
    error: () => props.error,
    totalPartCount,
    selectedSessionId: () => props.selectedSessionId,
    developerMode: () => props.developerMode,
    debugObservabilityAvailable: () => props.debugObservabilityAvailable,
    renderedMessageCount: () => renderedMessages().length,
    hiddenMessageCount,
    lastPromptSent: () => props.lastPromptSent,
    sessionReadOnly: () => sessionReadOnly(),
    notify: setToastMessage,
    notifySessionReadOnly: () => notifySessionReadOnly(),
    abortSession: (sessionId) => props.abortSession(sessionId),
    retryLastPrompt: () => props.retryLastPrompt(),
  });

  const runStartedAt = run.runStartedAt;
  const runPhase = run.phase;
  const runLabel = run.label;
  const showRunIndicator = run.showIndicator;
  const isGenerating = run.isGenerating;
  const responseStarted = run.responseStarted;
  const thinkingStatus = run.thinkingStatus;
  const runElapsedLabel = run.elapsedLabel;
  const runElapsedByMessageId = run.elapsedByMessageId;
  const startRun = run.start;
  const clearPendingRun = run.clearPending;
  const cancelRun = run.cancel;
  const retryRun = () => (blockSendWhileEdgeDegraded(capability.isActive(), setToastMessage) ? Promise.resolve() : run.retry()); // #3531

  const cleanReasoning = (value: string) =>
    value
      .replace(/\[REDACTED\]/g, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();

  onMount(() => {
    setTimeout(() => setIsInitialLoad(false), 2000);
  });

  const jumpToLatest = (behavior: ScrollBehavior = "smooth") => {
    // An explicit jump is user intent; it outranks the prompt-navigation guard,
    // which exists only to stop stream auto-follow from cancelling that jump.
    promptNavigationScrollUntil = 0;
    const container = chatContainerEl;
    // Prevent the spacer from clearing away if user clicks the `Jump to latest` pill
    if (container && pinnedUserMessageId !== null && bottomSpacerPx() > 0) {
      const layout = latestUserMessagePinLayout();
      if (layout && layout.retainedSpacerPx > 0) {
        setBottomSpacerPx(layout.retainedSpacerPx);
        setIsViewingLatest(true);
        setAutoPinActive(true);
        requestAnimationFrame(() => {
          const nextContainer = chatContainerEl;
          if (!nextContainer) return;
          pinnedScrollTopThreshold = layout.targetScrollTop;
          if (behavior === "auto") {
            nextContainer.scrollTo({ top: layout.targetScrollTop, behavior });
            lastKnownScrollTop = nextContainer.scrollTop;
          } else {
            jumpScroll.animateTo(nextContainer, layout.targetScrollTop, () => {
              lastKnownScrollTop = nextContainer.scrollTop;
            });
          }
        });
        return;
      }
    }
    setAutoPinActive(false);
    setIsViewingLatest(true);
    const historicalSpacerPx = bottomSpacerPx();
    if (container && historicalSpacerPx > 0 && behavior === "smooth") {
      historicalPromptScrollReady = false;
      cancelPinnedScrollWait();
      const targetTop = Math.max(
        0,
        container.scrollHeight - historicalSpacerPx - container.clientHeight,
      );
      jumpScroll.animateTo(container, targetTop, () => {
        pinnedScrollTopThreshold = null;
        setBottomSpacerPx(0);
        lastKnownScrollTop = container.scrollTop;
        setScrollBottomGap(0);
      });
      return;
    }
    pinnedScrollTopThreshold = null;
    setBottomSpacerPx(0);
    scheduleScrollToLatest(behavior);
  };

  const scrollToLatestUserMessage = (
    behavior: ScrollBehavior = "auto",
    messageId = latestUserMessageId(),
  ) => {
    const container = chatContainerEl;
    if (!messageId || !container) return false;

    const escapedId = messageId.replace(/["\\]/g, "\\$&");
    const target = container.querySelector(
      `[data-message-id="${escapedId}"]`,
    ) as HTMLElement | null;
    if (!target) return false;

    if (scrollFrame !== undefined) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
      pendingScrollBehavior = "auto";
    }
    jumpScroll.cancel();

    // Stop streaming auto-scroll effects from yanking the view back to bottom.
    setIsViewingLatest(false);

    // Reserve at most one viewport of scroll room below the exchange
    const userMsgHeight = target.getBoundingClientRect().height;
    const reserveSpacerPx = Math.max(
      0,
      container.clientHeight - userMsgHeight - PINNED_USER_MESSAGE_TOP_GAP_PX,
    );
    const requiredSpacerPx = Math.min(
      reserveSpacerPx,
      requiredPinnedSpacerPx(container, target).spacerPx,
    );
    // The spacer reservation belongs to the latest prompt;
    // jumping to an older prompt must not drop it, or the view gets clamped back to the bottom mid-run
    // Guard from now, not from animateTo: the spacer's ResizeObserver can fire before the measure frame and snap scrollTop.
    if (behavior === "smooth") {
      pinScrollAnimatingUntil = Date.now() + JUMP_SCROLL_MAX_DURATION_MS;
    }
    setBottomSpacerPx(
      messageId === latestUserMessageId()
        ? requiredSpacerPx
        : Math.max(bottomSpacerPx(), requiredSpacerPx),
    );

    jumpScroll.scheduleMeasure(() => {
      if (
        chatContainerEl === container &&
        target.isConnected &&
        container.contains(target)
      ) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const maxScrollTop = Math.max(
          0,
          container.scrollHeight - container.clientHeight,
        );
        const targetScrollTop = Math.min(
          maxScrollTop,
          Math.max(
            0,
            container.scrollTop +
              targetRect.top -
              containerRect.top -
              PINNED_USER_MESSAGE_TOP_GAP_PX,
          ),
        );
        pinnedScrollTopThreshold = targetScrollTop;
        const logPinScroll = (stage: string) =>
          recordPerfLog(props.developerMode, "session.pin", stage, {
            messageId,
            behavior,
            targetScrollTop,
            scrollTop: container.scrollTop,
            spacerPx: bottomSpacerPx(),
            animatorBusy: jumpScroll.isBusy(),
            pinnedUserMessageId,
            autoPinActive: autoPinActive(),
            generating: isGenerating(),
          });
        if (behavior === "auto") {
          container.scrollTo({ top: targetScrollTop, behavior });
          pinScrollAnimatingUntil = 0;
          lastKnownScrollTop = container.scrollTop;
          logPinScroll("scroll");
        } else {
          pinScrollAnimatingUntil = Date.now() + JUMP_SCROLL_MAX_DURATION_MS;
          logPinScroll("animate-start");
          jumpScroll.animateTo(
            container,
            targetScrollTop,
            () => {
              pinScrollAnimatingUntil = 0;
              if (chatContainerEl !== container) return;
              lastKnownScrollTop = container.scrollTop;
              logPinScroll("animate-arrive");
              // A run that ended mid-flight skipped its settle; take the
              // settled derivation here instead of the streaming one.
              if (!isGenerating() && pinnedUserMessageId !== null && autoPinActive()) {
                preserveLatestUserMessagePinAfterRun();
                return;
              }
              syncPinnedSpacerToFit();
            },
          );
        }
      } else if (chatContainerEl === container && !target.isConnected) {
        // Target was detached (optimistic row remounted with server ID). Clear
        // autoPinActive so the viewport is not stranded; attemptPinUserMessage's
        // retry loop will re-establish the pin once the new DOM node appears.
        // The latestUserMessageId effect may already have retargeted the pin to
        // the server id in the frame between request and measure; re-arm for
        // that id too, or the pin is left set with autoPinActive off.
        pinScrollAnimatingUntil = 0;
        setAutoPinActive(false);
        const rearmId =
          pinnedUserMessageId === messageId
            ? messageId
            : pinnedUserMessageId !== null &&
                pinnedUserMessageId === latestUserMessageId()
              ? pinnedUserMessageId
              : null;
        recordPerfLog(props.developerMode, "session.pin", "target-detached", {
          messageId,
          rearmId,
          pinnedUserMessageId,
        });
        if (rearmId !== null) {
          pinnedUserMessageId = null;
          pendingPinMessageId = rearmId;
          cancelPinRetry();
          attemptPinUserMessage(rearmId, 45);
        }
      }
    });

    return true;
  };

  const navigateToUserPrompt = (messageId: string, attemptsLeft = 45) => {
    historicalPromptScrollReady = false;
    if (!messageWindowExpanded()) {
      const targetIndex = props.messages.findIndex(
        (message) => messageIdFromInfo(message) === messageId,
      );
      if (targetIndex >= 0 && targetIndex < messageWindowStart()) {
        setMessageWindowStart(targetIndex);
        // A streaming render batch is debounced and re-armed on every token, so
        // the widened window can otherwise miss the retry budget below.
        flushBatchedRenderNow();
      }
    }
    cancelPinRetry();
    cancelPinnedScrollWait();
    pendingPinMessageId = null;
    awaitingNewUserMessagePin = false;
    promptNavigationScrollUntil =
      Date.now() + PROMPT_NAVIGATION_SCROLL_GUARD_MS;
    let mountRequested = false;

    const attemptScroll = (remainingAttempts: number) => {
      if (scrollToLatestUserMessage("smooth", messageId)) {
        const isLatestPrompt = messageId === latestUserMessageId();
        const shouldPinLatestPrompt = isLatestPrompt && isGenerating();
        pinnedUserMessageId = shouldPinLatestPrompt ? messageId : null;
        setAutoPinActive(shouldPinLatestPrompt);
        if (shouldPinLatestPrompt) {
          promptNavigationScrollUntil = 0;
        } else if (isLatestPrompt) {
          schedulePinnedScrollWaitAfterFrame(() => {
            promptNavigationScrollUntil = 0;
            const { retainedSpacer } = preserveLatestUserMessagePinAfterRun();
            pinnedUserMessageId = retainedSpacer
              ? messageId
              : null;
            setAutoPinActive(retainedSpacer);
            historicalPromptScrollReady = !retainedSpacer;
          });
        } else {
          schedulePinnedScrollWaitAfterFrame(() => {
            // Reasserted on arrival: a sentinel callback can land mid-scroll and
            // flip this back on before the guard is lifted below.
            setIsViewingLatest(false);
            promptNavigationScrollUntil = 0;
            historicalPromptScrollReady = true;
          });
        }
        return;
      }
      // The prompt list is built from every message, but virtualization only
      // mounts rows near the viewport. Ask the list to bring this one in so the
      // precise pin scroll above has a node to measure on a later frame.
      if (!mountRequested) {
        mountRequested = true;
        scrollMessageIntoViewById?.(messageId, "auto");
      }
      if (remainingAttempts <= 0) {
        promptNavigationScrollUntil = 0;
        setToastMessage("Could not jump to that prompt.");
        return;
      }
      pinRetryFrame = window.requestAnimationFrame(() => {
        pinRetryFrame = undefined;
        attemptScroll(remainingAttempts - 1);
      });
    };

    attemptScroll(attemptsLeft);
  };

  const restorePinnedUserPrompt = (behavior: ScrollBehavior = "smooth") => {
    const messageId = latestUserMessageId();
    if (!messageId) return;
    historicalPromptScrollReady = false;
    if (!scrollToLatestUserMessage(behavior, messageId)) return;
    pinnedUserMessageId = messageId;
    pendingPinMessageId = null;
    setAutoPinActive(true);
  };

  // Walks back to the prompt that produced `messageId`, skipping user turns that
  // render no row (same rule as promptNavigationItems).
  const pinPromptForMessage = (messageId: string) => {
    const startIndex = props.messages.findIndex(
      (message) => messageIdFromInfo(message) === messageId,
    );
    if (startIndex < 0) return;
    for (let index = startIndex; index >= 0; index -= 1) {
      const message = props.messages[index];
      if (!message) continue;
      if ((message.info as { role?: string }).role !== "user") continue;
      const id = messageIdFromInfo(message);
      if (!id || !messageTextForSearch(message).trim()) continue;
      navigateToUserPrompt(id);
      return;
    }
  };

  const cancelPinRetry = () => {
    if (pinRetryFrame !== undefined) {
      window.cancelAnimationFrame(pinRetryFrame);
      pinRetryFrame = undefined;
    }
  };

  const cancelPinnedScrollWait = () => {
    if (pinnedScrollWaitFrame !== undefined) {
      window.cancelAnimationFrame(pinnedScrollWaitFrame);
      pinnedScrollWaitFrame = undefined;
    }
  };

  const waitForPinnedScrollArrival = (run: () => void, framesLeft = 90) => {
    const container = chatContainerEl;
    if (!container) return;
    if (framesLeft <= 0) {
      pinnedScrollWaitFrame = undefined;
      run();
      return;
    }

    const target = pinnedScrollTopThreshold;
    if (target !== null && Math.abs(container.scrollTop - target) < 1) {
      pinnedScrollWaitFrame = undefined;
      run();
      return;
    }
    pinnedScrollWaitFrame = window.requestAnimationFrame(() => {
      pinnedScrollWaitFrame = undefined;
      waitForPinnedScrollArrival(run, framesLeft - 1);
    });
  };

  const schedulePinnedScrollWaitAfterFrame = (run: () => void) => {
    cancelPinnedScrollWait();
    pinnedScrollWaitFrame = window.requestAnimationFrame(() => {
      pinnedScrollWaitFrame = undefined;
      waitForPinnedScrollArrival(run);
    });
  };

  // Retries the pin across animation frames until the target message is found in the DOM or the attempts run out.
  const attemptPinUserMessage = (messageId: string, attemptsLeft: number) => {
    pinRetryFrame = undefined;
    if (pinnedUserMessageId === messageId) return;
    if (latestUserMessageId() !== messageId) {
      if (pendingPinMessageId === messageId) pendingPinMessageId = null;
      return;
    }
    const pinMotion = automaticPromptPinMotion();
    if (scrollToLatestUserMessage(pinMotion.behavior, messageId)) {
      pinnedUserMessageId = messageId;
      pendingPinMessageId = null;
      setAutoPinActive(true);
      // switch immediately to the tight/short-answer spacer instead of leaving the full one-viewport reservation in place if the run has completed
      // while waiting for the DOM node.
      if (!isGenerating()) {
        schedulePinnedScrollWaitAfterFrame(() => {
          preserveLatestUserMessagePinAfterRun();
        });
      }
      return;
    }
    if (attemptsLeft <= 0) {
      // Don't abandon the pin mid-run. Only give up (clearing the reserved space) once the run is over and the node never showed.
      if (isGenerating() && latestUserMessageId() === messageId) {
        pinRetryFrame = window.requestAnimationFrame(() =>
          attemptPinUserMessage(messageId, 45),
        );
        return;
      }
      // Give up on this pin — prevent leaving stale blank space behind.
      pendingPinMessageId = null;
      setBottomSpacerPx(0);
      return;
    }
    pinRetryFrame = window.requestAnimationFrame(() =>
      attemptPinUserMessage(messageId, attemptsLeft - 1),
    );
  };

  const requiredPinnedSpacerPx = (
    container: HTMLDivElement,
    target: HTMLElement,
  ) =>
    requiredPinnedSpacer({
      container,
      target,
      currentSpacerPx: bottomSpacerPx(),
    });

  const latestUserMessagePinLayout = () => {
    const messageId = latestUserMessageId();
    const container = chatContainerEl;
    if (!messageId || !container) return null;

    const escapedId = messageId.replace(/["\\]/g, "\\$&");
    const target = container.querySelector(
      `[data-message-id="${escapedId}"]`,
    ) as HTMLElement | null;
    if (!target) return null;

    const { targetScrollTop, spacerPx, minimumViewportSpacerPx } = requiredPinnedSpacerPx(
      container,
      target,
    );

    return {
      escapedId,
      messageId,
      retainedSpacerPx: spacerPx,
      minimumViewportSpacerPx,
      targetScrollTop,
    };
  };

  // Replace temporary pinning space with real content height as the run grows.
  // The minimum viewport spacer prevents the browser from clamping scrollTop.
  const syncPinnedSpacerToFit = () => {
    const container = chatContainerEl;
    if (!container) return;
    // Let attemptPin's smooth scroll land before re-deriving spacer/scrollTop
    if (pinScrollAnimating()) return;
    if (pinnedUserMessageId === null) return;
    if (pinnedUserMessageId !== latestUserMessageId()) return;
    // Leave the layout alone while the user reads below the pin.
    if (
      pinnedScrollTopThreshold !== null &&
      container.scrollTop > pinnedScrollTopThreshold + PINNED_SCROLL_SNAP_EPSILON_PX
    ) {
      return;
    }
    const layout = latestUserMessagePinLayout();
    if (!layout) return;
    const nextSpacerPx = pinnedSpacerDuringLayout({
      isGenerating: isGenerating(),
      currentSpacerPx: bottomSpacerPx(),
      requiredSpacerPx: layout.retainedSpacerPx,
      minimumSpacerPx: layout.minimumViewportSpacerPx,
    });
    // Always apply increases so the safety-minimum spacer is never suppressed by
    // the epsilon; only suppress shrinkage smaller than the noise floor.
    const spacerDelta = nextSpacerPx - bottomSpacerPx();
    if (spacerDelta > 0 || spacerDelta < -PINNED_SCROLL_SNAP_EPSILON_PX) {
      setBottomSpacerPx(nextSpacerPx);
    }
    if (
      autoPinActive() &&
      Math.abs(layout.targetScrollTop - container.scrollTop) >
        PINNED_SCROLL_SNAP_EPSILON_PX
    ) {
      container.scrollTop = layout.targetScrollTop;
      lastKnownScrollTop = container.scrollTop;
    }
    pinnedScrollTopThreshold = layout.targetScrollTop;
  };

  const preserveLatestUserMessagePinAfterRun = () => {
    const layout = latestUserMessagePinLayout();
    if (!layout) return { scheduled: false, retainedSpacer: false };

    const { escapedId, retainedSpacerPx } = layout;

    requestAnimationFrame(() => {
      const nextContainer = chatContainerEl;
      if (!nextContainer) return;
      if (pinScrollAnimating()) return;
      const nextTarget = nextContainer.querySelector(
        `[data-message-id="${escapedId}"]`,
      ) as HTMLElement | null;
      if (!nextTarget) return;
      // Re-derive spacer here: the run indicator and expanded
      // streaming blocks are gone by now, so the requirement has grown again.
      const settled = requiredPinnedSpacerPx(nextContainer, nextTarget);
      const settledSpacerPx = Math.max(
        settled.spacerPx,
        settled.minimumViewportSpacerPx,
      );
      if (settledSpacerPx !== bottomSpacerPx()) {
        setBottomSpacerPx(settledSpacerPx);
        // Apply the pin target in the frame after the spacer paints so the
        // browser can reach settled.targetScrollTop before we snap to it.
        requestAnimationFrame(() => {
          if (chatContainerEl !== nextContainer || !autoPinActive()) return;
          if (pinScrollAnimating()) return;
          nextContainer.scrollTop = settled.targetScrollTop;
          pinnedScrollTopThreshold = nextContainer.scrollTop;
          lastKnownScrollTop = nextContainer.scrollTop;
        });
      } else {
        pinnedScrollTopThreshold = nextContainer.scrollTop;
        lastKnownScrollTop = nextContainer.scrollTop;
      }
    });

    return { scheduled: true, retainedSpacer: retainedSpacerPx > 0 };
  };

  const preserveLatestUserMessageSpacerWhileScrolling = () => {
    const layout = latestUserMessagePinLayout();
    if (!layout) {
      pinnedUserMessageId = null;
      pinnedScrollTopThreshold = null;
      setAutoPinActive(false);
      setBottomSpacerPx(0);
      return;
    }

    const { messageId, retainedSpacerPx, targetScrollTop } = layout;

    setBottomSpacerPx(retainedSpacerPx);
    pinnedUserMessageId = retainedSpacerPx > 0 ? messageId : null;
    pinnedScrollTopThreshold = retainedSpacerPx > 0 ? targetScrollTop : null;
    setAutoPinActive(retainedSpacerPx > 0);
  };

  const suppressJumpControlsTemporarily = () => {
    if (jumpControlsSuppressTimer !== undefined) {
      clearTimeout(jumpControlsSuppressTimer);
    }
    setJumpControlsSuppressed(true);
    jumpControlsSuppressTimer = setTimeout(() => {
      jumpControlsSuppressTimer = undefined;
      setJumpControlsSuppressed(false);
    }, 300);
  };

  createEffect(
    on(
      () => props.selectedSessionId,
      (sessionId, previousSessionId) => {
        if (sessionId === previousSessionId) {
          return;
        }

        if (previousSessionId) {
          isRefreshLoad = false;
          needsRefreshAnchor = false;
        }

        if (previousSessionId && chatContainerEl) {
          if (
            !initialAnchorPending() &&
            sessionManualViewportOverride.has(previousSessionId) &&
            !isViewingLatest()
          ) {
            sessionScrollMemory.set(previousSessionId, {
              scrollTop: chatContainerEl.scrollTop,
              atBottom: false,
            });
          } else {
            sessionScrollMemory.delete(previousSessionId);
          }
        }

        setSearchOpen(false);
        setSearchQuery("");
        setSearchQueryDebounced("");
        setWorkspaceSelectedFiles([]);
        gmailAuth.clearRunSession();
        setBottomSpacerPx(0);
        cancelPinRetry();
        cancelPinnedScrollWait();
        jumpScroll.cancel();
        pinScrollAnimatingUntil = 0;
        awaitingNewUserMessagePin = false;
        retryPinSourceMessageId = null;
        pinnedUserMessageId = null;
        pendingPinMessageId = null;
        pinnedScrollTopThreshold = null;
        historicalPromptScrollReady = false;
        setAutoPinActive(false);

        if (!sessionId) {
          isRefreshLoad = false;
          needsRefreshAnchor = false;
          setInitialAnchorPending(false);
          return;
        }

        if (!previousSessionId) {
          isRefreshLoad = true;
          needsRefreshAnchor = true;
        }

        // Restore run elapsed map from localStorage for this session.
        try {
          const raw = window.localStorage.getItem(
            `${RUN_ELAPSED_KEY_PREFIX}${sessionId}`,
          );
          run.loadElapsedByMessageId(
            sessionId,
            raw ? parseRunElapsedEntry(raw).data : {},
          );
        } catch {
          // A failed read says nothing about this session's history, so the
          // map is installed empty and unattributed rather than as the
          // session's own.
          run.loadElapsedByMessageId(null, {});
        }
        // Cleanup stale entries once per page load.
        if (!_runElapsedCleanupDone) {
          _runElapsedCleanupDone = true;
          cleanupStaleRunElapsed();
        }
        setIsViewingLatest(true);
        const firstVisit = !topInitializedSessionIds.has(sessionId);
        topInitializedSessionIds.add(sessionId);

        const savedScroll = sessionScrollMemory.get(sessionId);
        const shouldRestoreSavedScroll =
          !isRefreshLoad &&
          sessionManualViewportOverride.has(sessionId) &&
          savedScroll &&
          !savedScroll.atBottom;
        if (shouldRestoreSavedScroll) {
          needsRefreshAnchor = false;
          setIsViewingLatest(false);
          setInitialAnchorPending(false);
          queueMicrotask(() => {
            if (props.selectedSessionId !== sessionId) return;
            if (chatContainerEl) {
              chatContainerEl.scrollTop = savedScroll!.scrollTop;
              lastKnownScrollTop = savedScroll!.scrollTop;
            }
          });
          return;
        }

        needsRefreshAnchor = true;
        setInitialAnchorPending(true);

        if (!firstVisit) {
          queueMicrotask(() => {
            applyInitialBottomAnchor(sessionId);
          });
          return;
        }

        queueMicrotask(() => {
          applyInitialBottomAnchor(sessionId);
        });
      },
    ),
  );

  createEffect(
    on(
      () =>
        [
          props.selectedSessionId,
          props.messages.length,
          isChatContainerReady(),
          initialAnchorPending(),
          props.selectedSessionId
            ? props.sessionLoadingById(props.selectedSessionId)
            : false,
        ] as const,
      ([sessionId, count, ready, pending, loading]) => {
        if (!pending) return;
        if (!sessionId) {
          setInitialAnchorPending(false);
          return;
        }
        if (!ready) return;
        if (count === 0) {
          if (isRefreshLoad || loading) {
            return;
          }
          setInitialAnchorPending(false);
          return;
        }
        isRefreshLoad = false;
        needsRefreshAnchor = false;
        queueMicrotask(() => applyInitialBottomAnchor(sessionId));
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    focusCommandPaletteInput();
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    const total = commandPaletteItems().length;
    if (total === 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    setCommandPaletteActiveIndex((current) =>
      Math.max(0, Math.min(current, total - 1)),
    );
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    const idx = commandPaletteActiveIndex();
    requestAnimationFrame(() => {
      commandPaletteOptionRefs[idx]?.scrollIntoView({ block: "nearest" });
    });
  });

  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (props.settingsOpen) return;
      const mod = event.metaKey || event.ctrlKey;
      if (
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        if (commandPaletteOpen()) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
        return;
      }

      if (commandPaletteOpen()) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeCommandPalette();
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          stepCommandPaletteIndex(1, commandPaletteItems().length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          stepCommandPaletteIndex(-1, commandPaletteItems().length);
          return;
        }
        if (event.key === "Enter") {
          if (event.isComposing || event.keyCode === 229) return;
          const item = commandPaletteItems()[commandPaletteActiveIndex()];
          if (!item) return;
          event.preventDefault();
          item.action();
          return;
        }
        if (
          event.key === "Backspace" &&
          !commandPaletteQuery().trim() &&
          commandPaletteMode() !== "root"
        ) {
          event.preventDefault();
          returnToCommandRoot();
        }
        return;
      }

      if (mod && !event.altKey && event.key.toLowerCase() === "f") {
        if (!props.messages.length) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        openSearch();
        return;
      }
      if (!searchOpen()) return;
      if (mod && !event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        moveSearchHit(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  createEffect(() => {
    if (!isChatContainerReady()) return;
    const sentinel = bottomVisibilityEl;
    const container = chatContainerEl;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // Following the stream at the bottom re-fires this every batch, so a
          // jump already in flight would be undone the moment its guard lifts.
          if (autoPinActive() || promptNavigationScrollActive()) return;
          setIsViewingLatest(true);
          if (props.selectedSessionId) {
            sessionManualViewportOverride.delete(props.selectedSessionId);
            sessionScrollMemory.delete(props.selectedSessionId);
          }
        }
      },
      { root: container, threshold: 0 },
    );
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (!isChatContainerReady()) return;
    const container = chatContainerEl;
    if (!container) return;

    const updateHeight = () => setChatViewportHeight(container.clientHeight);
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateHeight();
      // A viewport-only resize moves the run footer without a scroll or content resize.
      refreshRunFooterOffscreen();
    });
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  // Content can grow between stream batches. The reservation is re-derived from
  // the rendered height, which also covers growth the batch effect cannot see.
  createEffect(() => {
    if (!isChatContainerReady()) return;
    const content = chatContentEl;
    if (!content) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      syncPinnedSpacerToFit();
      // Content grows without scroll events while pinned.
      const container = chatContainerEl;
      if (container) {
        setScrollBottomGap(
          container.scrollHeight -
            (container.scrollTop + container.clientHeight),
        );
      }
      refreshRunFooterOffscreen();
    });
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });

  createEffect(
    on(
      () => props.sessionStatus,
      (status) => {
        if (status === "running" || status === "retry") {
          startRun();
          const currentUserMessageId = latestUserMessageId();
          const pinClaimed =
            currentUserMessageId !== null &&
            (pendingPinMessageId === currentUserMessageId ||
              pinnedUserMessageId === currentUserMessageId);
          run.markBegun();
          if (!pinClaimed && isViewingLatest()) {
            if (currentUserMessageId) {
              pendingPinMessageId = currentUserMessageId;
              flushBatchedRenderNow();
              attemptPinUserMessage(currentUserMessageId, 45);
            } else {
              pinToLatestAfterLayout();
            }
          }
        }
      },
    ),
  );

  createEffect(() => {
    if (responseStarted()) run.markBegun();
  });

  createEffect(() => {
    if (!isGenerating()) return;
    run.tick();
    if (initialAnchorPending()) return;
    if (!isViewingLatest()) return;
    scheduleScrollToLatest();
  });

  createEffect(() => {
    batchedRenderedMessages();
    if (initialAnchorPending()) {
      return;
    }
    if (needsRefreshAnchor && batchedRenderedMessages().length > 0) {
      // Resolved user message pinning and fresh-session bottom anchoring race
      if (isUserMessagePinPending() || pinnedUserMessageId !== null) {
        needsRefreshAnchor = false;
      } else {
        queueMicrotask(() => {
          if (!chatContainerEl && !messagesEndEl) return;
          pinToLatestAfterLayout();
          needsRefreshAnchor = false;
        });
        return;
      }
    }
    if (isViewingLatest() && isGenerating()) {
      scheduleScrollToLatest();
    }
    // Fallback only: with ResizeObserver present the content observer already
    // re-derives on every height change, in the same frame.
    if (isGenerating() && typeof ResizeObserver === "undefined") {
      requestAnimationFrame(syncPinnedSpacerToFit);
    }
  });

  createEffect(
    on(isGenerating, (running) => {
      if (!running) {
        // Note: this does not cancel an in-flight pin retry. A pin that's
        // still polling for its DOM node (fast response finished before the
        // node rendered) must be allowed to land and self-correct via
        // attemptPinUserMessage's own `!isGenerating()` check.
        // Pin state, not the current spacer height, decides this: a response
        // that consumed the whole reservation mid-run still has to re-derive it
        // once streaming scaffolding collapses, or the prompt loses the top.
        const shouldPreservePinnedPrompt =
          pinnedUserMessageId !== null && autoPinActive();
        const shouldRestoreBottom =
          pinnedUserMessageId === null && isViewingLatest();
        if (shouldPreservePinnedPrompt) {
          // Defer by one frame (mirrors attemptPinUserMessage's fast-run path)
          // so that scrollToLatestUserMessage's own rAF has a chance to set
          // pinnedScrollTopThreshold before we start polling for arrival.
          schedulePinnedScrollWaitAfterFrame(() => {
            if (!preserveLatestUserMessagePinAfterRun().scheduled) {
              setBottomSpacerPx(0);
            }
          });
        } else {
          setBottomSpacerPx(0);
          if (shouldRestoreBottom) {
            const completedAt = Date.now();
            if (completionBottomAnchorFrame !== undefined) {
              window.cancelAnimationFrame(completionBottomAnchorFrame);
            }
            completionBottomAnchorFrame = window.requestAnimationFrame(() => {
              completionBottomAnchorFrame = undefined;
              if (isGenerating() || !isViewingLatest()) return;
              if (lastManualScrollIntentAt > completedAt) return;
              scrollToLatest("auto");
            });
          }
        }
        awaitingNewUserMessagePin = false;
      }
    }),
  );

  createEffect(
    on(latestUserMessageId, (id, prevId) => {
      if (!id || id === prevId) return;
      if (retryPinSourceMessageId !== null && id <= retryPinSourceMessageId) {
        return;
      }
      // Optimistic pending-user id swapped for the server id of the same prompt.
      // The row remounts in place, so just retarget the already-landed pin
      // instead of tearing it down and re-scrolling (a visible double move).
      if (
        retryPinSourceMessageId === null &&
        prevId != null &&
        prevId.startsWith(PENDING_USER_MESSAGE_PREFIX) &&
        !id.startsWith(PENDING_USER_MESSAGE_PREFIX) &&
        pinnedUserMessageId === prevId
      ) {
        pinnedUserMessageId = id;
        if (pendingPinMessageId === prevId) pendingPinMessageId = id;
        return;
      }
      const isRetryReplacement = retryPinSourceMessageId !== null;
      retryPinSourceMessageId = null;
      cancelPinRetry();
      cancelPinnedScrollWait();
      pinnedUserMessageId = null;
      pendingPinMessageId = null;
      pinnedScrollTopThreshold = null;
      setAutoPinActive(false);
      if (
        awaitingNewUserMessagePin ||
        runStartedAt() !== null ||
        isRetryReplacement
      ) {
        awaitingNewUserMessagePin = false;
        pendingPinMessageId = id;
        flushBatchedRenderNow();
        attemptPinUserMessage(id, 45);
      }
    }),
  );

  createEffect(
    on(
      () => [props.messages.length, props.todos.length, totalPartCount()],
      (current, previous) => {
        if (!previous) return;
        const [mLen, tLen, pCount] = current;
        const [prevM, prevT, prevP] = previous;
        if (mLen > prevM || tLen > prevT || pCount > prevP) {
          if (isGenerating()) run.noteProgress();
        }
      },
    ),
  );

  const focusSearchInput = () => {
    queueMicrotask(() => {
      searchInputEl?.focus();
      searchInputEl?.select();
    });
  };

  const focusCommandPaletteInput = () => {
    queueMicrotask(() => {
      commandPaletteInputEl?.focus();
      commandPaletteInputEl?.select();
    });
  };

  const focusComposer = () => {
    if (typeof window === "undefined") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("openwork:focusPrompt"));
      });
    });
  };

  const closeCommandPaletteAndFocusComposer = () => {
    closeCommandPalette();
    focusComposer();
  };

  const openCommandPalette = (mode: CommandPaletteMode = "root") => {
    setCommandPaletteMode(mode);
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    setCommandPaletteOpen(true);
    focusCommandPaletteInput();
  };

  const closeCommandPalette = () => {
    setCommandPaletteOpen(false);
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
  };

  const stepCommandPaletteIndex = (delta: number, total: number) => {
    if (total <= 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    setCommandPaletteActiveIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + delta + total) % total;
    });
  };

  const returnToCommandRoot = () => {
    if (commandPaletteMode() === "root") return;
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    focusCommandPaletteInput();
  };

  const openSearch = () => {
    if (!props.messages.length) return;
    if (searchCloseTimer !== undefined) {
      window.clearTimeout(searchCloseTimer);
      searchCloseTimer = undefined;
    }
    cancelSearchPanelEnterFrames();
    setSearchClosing(false);
    setSearchOpen(true);
    setSearchPanelVisible(false);
    searchPanelEnterOuterFrame = window.requestAnimationFrame(() => {
      searchPanelEnterOuterFrame = undefined;
      searchPanelEnterFrame = window.requestAnimationFrame(() => {
        searchPanelEnterFrame = undefined;
        setSearchPanelVisible(true);
      });
    });
    focusSearchInput();
  };

  const closeSearch = () => {
    if (!searchOpen() && !searchClosing()) return;
    cancelSearchPanelEnterFrames();
    if (searchCloseTimer !== undefined) {
      window.clearTimeout(searchCloseTimer);
    }
    setSearchClosing(true);
    setSearchPanelVisible(false);
    searchCloseTimer = window.setTimeout(() => {
      setSearchOpen(false);
      setSearchClosing(false);
      setSearchQuery("");
      setSearchQueryDebounced("");
      searchCloseTimer = undefined;
    }, 260);
  };

  const moveSearchHit = (offset: number) => {
    searchMatchNav?.requestNav(offset);
  };

  const submitEditedMessage = async (
    messageId: string,
    text: string,
    options?: { optimisticHide?: boolean },
  ) => {
    // Read-only sessions (confirmed subtasks, or any session whose metadata is
    // still loading) must not mutate history. Backstop for stale UI / shortcuts.
    if (sessionReadOnly()) {
      const reason =
        sessionReadOnlyReason() === "loading"
          ? t("session.session_loading_notice")
          : t("session.subagent_readonly_notice");
      setToastMessage(reason);
      throw new Error(reason);
    }
    if (blockSendWhileEdgeDegraded(capability.isActive(), setToastMessage)) throw new Error(t("session.edge_send_blocked")); // #3531, before the history revert
    if (historyActionBusy()) {
      const err = new Error(
        "A history action is already in progress. Please wait and try again.",
      );
      setToastMessage(err.message);
      throw err;
    }
    setHistoryActionBusy("edit");
    try {
      if (options?.optimisticHide === false) {
        awaitingNewUserMessagePin = true;
        retryPinSourceMessageId = messageId;
        restorePinnedUserPrompt("smooth");
      }
      await props.submitEditedUserMessage(messageId, text, options);
    } catch (error) {
      retryPinSourceMessageId = null;
      awaitingNewUserMessagePin = false;
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || "Failed to submit edited message");
      throw error;
    } finally {
      setHistoryActionBusy(null);
    }
  };

  const flyoutController = createFlyouts({
    isInitialLoad,
    todoCount: () => todoCount(),
    workingFileCount: () => props.workingFiles.length,
    lastAssistantElement: () =>
      chatContainerEl?.querySelector(
        '[data-message-role="assistant"]:last-child',
      ) ?? null,
  });
  const flyouts = flyoutController.flyouts;

  function sessionTitleForId(id: string | null | undefined) {
    if (!id) return "";
    for (const group of props.workspaceSessionGroups) {
      const match = group.sessions.find((session) => session.id === id);
      if (match) return match.title ?? "";
    }
    return "";
  }
  const selectedSessionTitle = createMemo(() => {
    const id = props.selectedSessionId;
    if (!id) return "";
    return sessionTitleForId(id);
  });

  const localizedSessionTitle = createMemo(() =>
    localizeSessionTitle(selectedSessionTitle()),
  );

  const shouldHideChatWhileInitializing = createMemo(() => {
    const id = props.selectedSessionId;
    if (!id) return false;
    return initialAnchorPending() && props.messages.length === 0;
  });

  // Detect if currently viewing a child/subagent session and resolve its parent
  const parentSessionId = createMemo(() => {
    const id = props.selectedSessionId;
    if (!id) return null;
    const session = props.getSessionById(id);
    const pid = session?.parentID?.trim();
    return pid || null;
  });

  // Whether the selected session's metadata has actually loaded. `getSessionById`
  // returns null both for an unknown id and for the window between selecting a
  // session (selectedSessionId published) and its `session.get` resolving — the
  // latter is the race on direct navigation / refresh.
  const selectedSessionMetadataResolved = createMemo(() => {
    const id = props.selectedSessionId;
    if (!id) return true; // new-task composer: nothing to resolve
    return props.getSessionById(id) !== null;
  });

  const selectedSessionLoading = createMemo(() => {
    const id = props.selectedSessionId;
    return id ? props.sessionLoadingById(id) : false;
  });

  // Reason the current session is read-only, or null when writable. Fail closed
  // while metadata is unresolved so a fast submission on a directly-navigated
  // child session can't fork the parent's transcript before we know it is a child.
  const sessionReadOnlyReason = createMemo<"subagent" | "loading" | null>(() => {
    if (!props.selectedSessionId) return null;
    if (!selectedSessionMetadataResolved()) return "loading";
    return parentSessionId() ? "subagent" : null;
  });

  const sessionReadOnly = createMemo(() => sessionReadOnlyReason() !== null);

  const notifySessionReadOnly = () => {
    setToastMessage(
      sessionReadOnlyReason() === "loading"
        ? t("session.session_loading_notice")
        : t("session.subagent_readonly_notice"),
    );
  };

  const hasWorkspaceConfigured = createMemo(() => props.workspaces.length > 0);
  const showWorkspaceSetupEmptyState = createMemo(
    () =>
      !hasWorkspaceConfigured() &&
      !props.selectedSessionId &&
      props.messages.length === 0,
  );
  // The toast times itself out, but none is mounted while this hides the composer.
  createEffect(() => {
    if (showWorkspaceSetupEmptyState() && toastMessage()) setToastMessage(null);
  });

  const renameCanSave = createMemo(() => {
    if (renameBusy()) return false;
    const next = renameTitle().trim();
    if (!next) return false;
    return next !== sessionTitleForId(renameSessionId()).trim();
  });

  const finishRenameModal = (
    restoreComposerFocus = renameReturnFocusToComposer(),
  ) => {
    setRenameModalOpen(false);
    setRenameSessionId(null);
    setRenameReturnFocusToComposer(false);
    if (restoreComposerFocus) {
      focusComposer();
    }
  };

  const openRenameModal = (
    requestedSessionId?: string | { returnFocusToComposer?: boolean },
  ) => {
    const options = typeof requestedSessionId === "object" ? requestedSessionId : undefined;
    const sessionId = typeof requestedSessionId === "string" ? requestedSessionId : props.selectedSessionId;
    if (!sessionId) {
      setToastMessage("No session selected");
      if (options?.returnFocusToComposer) {
        focusComposer();
      }
      return;
    }
    setRenameSessionId(sessionId);
    setRenameTitle(sessionTitleForId(sessionId));
    setRenameReturnFocusToComposer(options?.returnFocusToComposer === true);
    setRenameModalOpen(true);
  };

  const closeRenameModal = () => {
    if (renameBusy()) return;
    finishRenameModal();
  };

  const submitRename = async () => {
    const sessionId = renameSessionId();
    if (!sessionId) return;
    const next = renameTitle().trim();
    if (!next || !renameCanSave()) return;
    setRenameBusy(true);
    try {
      await props.renameSession(sessionId, next);
      finishRenameModal();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message);
    } finally {
      setRenameBusy(false);
    }
  };

  const openDeleteSessionModal = (requestedSessionId?: string) => {
    const sessionId = requestedSessionId ?? props.selectedSessionId;
    if (!sessionId) {
      setToastMessage("No session selected");
      return;
    }
    setDeleteSessionId(sessionId);
    setDeleteSessionOpen(true);
  };

  const closeDeleteSessionModal = () => {
    if (deleteSessionBusy()) return;
    setDeleteSessionOpen(false);
    setDeleteSessionId(null);
  };

  const confirmDeleteSession = createConfirmDeleteSession({
    busy: deleteSessionBusy,
    setBusy: setDeleteSessionBusy,
    pendingSessionId: deleteSessionId,
    deleteSession: (sessionId) => props.deleteSession(sessionId),
    close: () => {
      setDeleteSessionOpen(false);
      setDeleteSessionId(null);
    },
    toast: (message) => setToastMessage(message),
    describeError: (error) =>
      error instanceof Error ? error.message : props.safeStringify(error),
  });

  const requireSessionId = () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      setToastMessage("No session selected");
      return null;
    }
    return sessionId;
  };

  const openAgentPicker = () => {
    if (!agentPickerOpen()) void loadAgentOptions(true);
    setAgentPickerOpen((current) => !current);
  };

  const applySessionAgent = (agent: string | null) => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      props.setPendingSessionAgent(agent);
      return;
    }
    props.setSessionAgent(sessionId, agent);
    return sessionId;
  };

  const pickAgent = (agent: string | null): boolean => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      props.setPendingSessionAgent(agent);
      return false;
    }
    if (!props.applySessionAgentModelPolicy(sessionId, agent)) {
      setToastMessage("Local LLM is not available. Start the local model server to use this agent.");
      return false;
    }
    applySessionAgent(agent);
    return true;
  };

  const selectQuickAgent = (id: string) => {
    if (pickAgent(props.selectedSessionAgent === id ? null : id)) focusComposer();
  };

  createEffect(() => {
    if (!agentPickerOpen()) return;
    const handler = (event: MouseEvent) => {
      if (!agentPickerRef) return;
      if (agentPickerRef.contains(event.target as Node)) return;
      setAgentPickerOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  // Close model breakdown dropdown on outside click
  createEffect(() => {
    if (!modelBreakdownOpen()) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      // Check if click is inside the dropdown or trigger button
      if (target.closest("[data-model-breakdown]")) return;
      setModelBreakdownOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  const handleProviderAuthSelect = async (
    providerId: string,
  ): Promise<ProviderOAuthStartResult> => {
    if (providerAuthActionBusy()) {
      throw new Error("Provider auth is already in progress.");
    }
    setProviderAuthActionBusy(true);
    try {
      return await props.startProviderAuth(providerId);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthOAuth = async (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => {
    if (providerAuthActionBusy()) return { connected: false, pending: true };
    setProviderAuthActionBusy(true);
    try {
      const result = await props.completeProviderAuthOAuth(
        providerId,
        methodIndex,
        code,
      );
      if (result.connected) {
        setToastMessage(result.message || "Provider connected");
        props.closeProviderAuthModal();
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth failed";
      setToastMessage(message);
      return { connected: false };
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthApiKey = async (
    providerId: string,
    apiKey: string,
  ) => {
    if (providerAuthActionBusy()) return;
    setProviderAuthActionBusy(true);
    try {
      const message = await props.submitProviderApiKey(providerId, apiKey);
      setToastMessage(message || "API key saved");
      props.closeProviderAuthModal();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save API key";
      setToastMessage(message);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const sharePublish = createSharePublish({
    shareWorkspaceId,
    workspaces: () => props.workspaces,
    workspaceLabel,
    serverHostInfo: () => props.openworkServerHostInfo,
    serverSettings: () => props.openworkServerSettings,
    engineInfo: () => props.engineInfo,
    exportWorkspaceBusy: () => props.exportWorkspaceBusy,
  });
  const exportDisabledReason = sharePublish.exportDisabledReason;

  const isDefaultAgent = () =>
    !props.selectedSessionAgent ||
    props.selectedSessionAgent === "superclaw-default";

  const shouldShowDefaultAgentTavilyWarning = () => {
    // Nothing while the status is loading, in a mode with no key store (nothing in Settings
    // could fix it) or with a key saved. A status we could not read gets its own wording.
    const kind = tavilySessionWarning(props.tavilyKeyView);
    if (!isDefaultAgent() || kind === "none") return false;
    const unreadable = kind === "unreadable";
    // Suppress while persisted cooldown is still hydrating (desktop async storage)
    if (!(unreadable ? tavilyUnreadableReady() : tavilyWarningReady())) return false;
    // Global cooldown: suppress if dismissed within the cooldown period
    const lastDismissed = (unreadable ? tavilyUnreadableDismissedAt : tavilyWarningDismissedAt).ts;
    if (
      lastDismissed > 0 &&
      Date.now() - lastDismissed < TAVILY_WARNING_COOLDOWN_MS
    )
      return false;
    const sessionId = props.selectedSessionId;
    if (!sessionId) return true;
    return !defaultAgentTavilyAcknowledgedSessionIds().has(`${kind}:${sessionId}`);
  };

  const showDefaultAgentTavilyWarning = async (draft: ComposerDraft) => {
    setDefaultAgentTavilyPendingDraft(draft);
    setDefaultAgentTavilyWarningOpen(true);
  };

  const acknowledgeDefaultAgentTavilyWarning = () => {
    const sessionId = props.selectedSessionId;
    const kind = tavilySessionWarning(props.tavilyKeyView);
    if (sessionId) {
      setDefaultAgentTavilyAcknowledgedSessionIds((current) => {
        const next = new Set(current);
        next.add(`${kind}:${sessionId}`);
        return next;
      });
    }
    // Persist global cooldown timestamp, for the kind of warning that was shown
    if (kind === "unreadable") setTavilyUnreadableDismissedAt("ts", Date.now());
    else setTavilyWarningDismissedAt("ts", Date.now());
  };

  const validateHybridDeepResearchFileLimit = (
    agent: string | null,
  ): boolean => {
    if (
      agent === "hybrid-deep-research" &&
      workspaceSelectedLeafFileCount() > 5
    ) {
      setHybridDeepResearchFileLimitOpen(true);
      return false;
    }
    return true;
  };

  const handleSendPrompt = async (
    draft: ComposerDraft,
    options?: {
      skipDefaultAgentTavilyWarning?: boolean;
      onAccepted?: () => void;
      submittedAt?: number;
    },
  ): Promise<void | false> => {
    if (isGenerating() || blockSendWhileEdgeDegraded(capability.isActive(), setToastMessage)) return false; // #3531

    // Sub-task sessions (e.g. the websearch subagent's transcript) are opened
    // read-only via "Open session" — chatting there would fork a conversation
    // the parent task doesn't see. A confirmed child hides the composer; this
    // guard covers any path that still calls onSend (e.g. a stale keybinding).
    // It also fails closed while the selected session's metadata is still
    // loading, so a fast submission on a
    // directly-navigated child session can't slip through before we know it is one.
    if (sessionReadOnly()) {
      notifySessionReadOnly();
      return false;
    }

    const wsFiles = [...workspaceSelectedFiles()];

    if (!validateHybridDeepResearchFileLimit(props.selectedSessionAgent)) {
      return false;
    }

    if (
      !options?.skipDefaultAgentTavilyWarning &&
      shouldShowDefaultAgentTavilyWarning()
    ) {
      await showDefaultAgentTavilyWarning(draft);
      return false;
    }

    // Capture selected files — keep selection intact so user can ask
    // follow-up questions about the same files without re-selecting.
    if (wsFiles.length > 0) {
      const extraParts: ComposerDraft["parts"] = [];

      // All selected files are injected as path mentions. The LLM uses its
      // tools (read, grep, glob, bash) to access file contents on demand.
      // This avoids context overflow from large files and lets skills
      // (spreadsheet, pdf, docx, pptx) handle binary formats via
      // extract_text.py.
      for (const f of wsFiles) {
        const isInbox = f.startsWith("inbox/");
        const rawRelPath = isInbox ? f.slice(6) : f.slice(9);
        const isFolder = rawRelPath.endsWith("/");
        const relPath = isFolder ? rawRelPath.replace(/\/+$/, "") : rawRelPath;
        const absPath = selectedWorkspacePath(relPath, props.activeWorkspaceRoot);

        if (isFolder) {
          extraParts.push({
            type: "text",
            text: `[Selected folder: ${absPath}]`,
          });
          continue;
        }

        extraParts.push({ type: "text", text: `[Selected file: ${absPath}]` });
      }

      // Insert a newline separator so file annotations appear on their own
      // line after the user's message text instead of being appended inline.
      const hasUserText = draft.parts.some(
        (p) => p.type === "text" && (p as { text?: string }).text?.trim(),
      );
      draft = {
        ...draft,
        parts: [
          ...draft.parts,
          ...(hasUserText ? [{ type: "text" as const, text: "\n" }] : []),
          ...extraParts,
        ],
      };
    }

    const routerAlias = selectedRouterAlias();
    const gatedRouterModel =
      routerAlias === "auto" ||
      routerAlias === "cloud-model" ||
      routerAlias === "local-model";
    if (gatedRouterModel) {
      const needCloud = routerAlias === "auto" || routerAlias === "cloud-model";
      const needLocal = routerAlias === "auto" || routerAlias === "local-model";

      let cStatus = cloudModelStatus();
      let lStatus = localModelStatus();

      // If a background refresh is in-flight (e.g. from view-switch after
      // configuring/deleting the cloud model), wait briefly for it so we
      // use the freshest result — even if the cached status is "ready".
      const inFlightCheck = modelRouting.pendingCheck();
      if (inFlightCheck) {
        await Promise.race([
          inFlightCheck,
          new Promise<void>((r) => setTimeout(r, 1_500)),
        ]);
        cStatus = cloudModelStatus();
        lStatus = localModelStatus();
      }

      const notReady = () =>
        (needCloud && cStatus !== "ready") ||
        (needLocal && lStatus !== "ready");

      let presendCheckTimedOut = false;
      if (notReady()) {
        if (!llmrouterBaseUrl()) {
          setAutoRouterDiagnostics(
            `auto-route health probe @ ${new Date().toISOString()}\n` +
              "llmrouterBaseUrl (OpenWork server URL) is empty at send time — the UI has no " +
              "server URL, so it cannot reach the ServiceHub to probe cloud/edge health.",
          );
          setCloudModelWarningReason("both_not_configured");
          setCloudModelWarningOpen(true);
          return false;
        }
        const PRESEND_CHECK_BUDGET_MS = 1_500;
        // The fresh check maps its own errors to "check_failed" and normally
        // resolves; the rejection handler is defensive so that when the
        // timeout wins the race, the detached refresh can never surface as an
        // unhandled rejection.  A rejected check is treated as "not settled"
        // -> optimistic send (the backend falls back to cloud on failure).
        const freshCheck = refreshCloudModelStatus().then(
          () => true,
          () => false,
        );
        const settled = await Promise.race([
          freshCheck,
          new Promise<boolean>((r) =>
            setTimeout(() => r(false), PRESEND_CHECK_BUDGET_MS),
          ),
        ]);
        if (settled) {
          cStatus = cloudModelStatus();
          lStatus = localModelStatus();
        } else {
          presendCheckTimedOut = true;
        }
      }

      if (!presendCheckTimedOut) {
        const cloudMissing = needCloud && cStatus !== "ready";
        const localMissing = needLocal && lStatus !== "ready";

        if (
          (needCloud && cStatus === "check_failed") ||
          (needLocal && lStatus === "check_failed")
        ) {
          setCloudModelWarningReason("check_failed");
          setCloudModelWarningOpen(true);
          return false;
        }

        if (cloudMissing && localMissing) {
          if (cStatus === "not_configured" && lStatus === "not_configured") {
            setCloudModelWarningReason("both_not_configured");
          } else if (lStatus !== "not_configured") {
            setCloudModelWarningReason("local_unhealthy");
          } else {
            setCloudModelWarningReason("cloud_unhealthy");
          }
          setCloudModelWarningOpen(true);
          return false;
        }

        if (cloudMissing) {
          setCloudModelWarningReason(
            cStatus === "not_configured"
              ? "cloud_not_configured"
              : "cloud_unhealthy",
          );
          setCloudModelWarningOpen(true);
          return false;
        }

        if (localMissing) {
          setCloudModelWarningReason(
            lStatus === "not_configured"
              ? "local_not_configured"
              : "local_unhealthy",
          );
          setCloudModelWarningOpen(true);
          return false;
        }
      }
    }

    suppressJumpControlsTemporarily();
    awaitingNewUserMessagePin = true;
    cancelPinnedScrollWait();
    if (scrollFrame !== undefined) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
      pendingScrollBehavior = "auto";
    }
    startRun();
    try {
      const accepted = await props.sendPromptAsync(draft, {
        validateAutoRoutedAgent: validateHybridDeepResearchFileLimit,
        onAccepted: options?.onAccepted,
        onSessionResolved: run.adoptSession,
        submittedAt: options?.submittedAt,
      });
      if (accepted === false) {
        clearPendingRun();
        return false;
      }
    } catch (error) {
      clearPendingRun();
      console.error("handleSendPrompt: send failed", error);
      return false;
    }
  };

  const confirmDefaultAgentTavilyWarning = async () => {
    const draft = defaultAgentTavilyPendingDraft();
    acknowledgeDefaultAgentTavilyWarning();
    setDefaultAgentTavilyWarningOpen(false);
    setDefaultAgentTavilyPendingDraft(null);
    if (draft) {
      const accepted = await handleSendPrompt(draft, {
        skipDefaultAgentTavilyWarning: true,
      });
      if (accepted !== false) {
        props.setPrompt("");
      }
    }
  };

  const isSandboxWorkspace = createMemo(
    () => props.activeWorkspaceDisplay.sandboxBackend === "servicehub",
  );

  const handleDisconnectedRetry = async () => {
    try {
      if (isTauriRuntime() && import.meta.env.DEV) {
        await retryServiceHubBoot();
        return;
      }

      await platform.restart();
    } catch (error) {
      console.error(
        "[session] Failed to restart app after worker disconnect:",
        error,
      );
      if (isTauriRuntime() && import.meta.env.DEV) {
        window.location.reload();
        return;
      }
      await props.recoverWorkspace(props.activeWorkspaceId);
    }
  };

  const normalizeUrlOrigin = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    try {
      return new URL(trimmed).origin.toLowerCase();
    } catch {
      return null;
    }
  };

  const runtimeEndpointOrigins = () => {
    const workspace = props.activeWorkspaceDisplay;
    return new Set(
      [
        props.openworkServerUrl,
        props.openworkServerSettings.urlOverride,
        props.openworkServerHostInfo?.baseUrl,
        workspace.openworkHostUrl,
        workspace.baseUrl,
      ]
        .map(normalizeUrlOrigin)
        .filter((origin): origin is string => Boolean(origin)),
    );
  };

  const isOpencodePath = (path: string) => {
    const normalized = path.toLowerCase().replace(/\/+$/, "");
    return normalized === "/opencode" || normalized.includes("/opencode/");
  };

  const referencesRuntimeOpencodeEndpoint = (message: string) => {
    if (!message.toLowerCase().includes("/opencode")) return false;
    const origins = runtimeEndpointOrigins();
    if (origins.size === 0) return false;

    const urlMatches = message.match(/https?:\/\/[^\s'"<>]+/gi) ?? [];
    return urlMatches.some((candidate) => {
      try {
        const url = new URL(candidate);
        return (
          isOpencodePath(url.pathname) && origins.has(url.origin.toLowerCase())
        );
      } catch {
        return false;
      }
    });
  };

  const referencesRuntimeEndpoint = (message: string) => {
    const normalized = message.toLowerCase();
    const origins = runtimeEndpointOrigins();
    if (origins.size === 0) return false;
    if ([...origins].some((origin) => normalized.includes(origin))) return true;
    return referencesRuntimeOpencodeEndpoint(message);
  };

  const isRuntimeConnectionError = (message: string) => {
    const normalized = message.trim().toLowerCase();
    if (!normalized) return false;
    if (message.trim() === t("app.connection_lost", currentLocale()))
      return true;
    if (normalized.includes(t("app.connection_lost", "en").toLowerCase()))
      return true;
    if (normalized.includes(t("app.connection_lost", "zh").toLowerCase()))
      return true;
    const networkError = [
      "error sending request",
      "fetch failed",
      "failed to fetch",
      "network error",
    ].some((needle) => normalized.includes(needle));
    if (networkError && referencesRuntimeEndpoint(message)) return true;
    return false;
  };

  const runtimeDisconnected = createMemo(() => {
    if (!props.clientConnected) return true;
    const error = props.error?.trim();
    return Boolean(error && isRuntimeConnectionError(error));
  });
  const runtimeStartupConnecting = createStartupConnectingState(
    () => props.clientConnected,
  );
  const runtimeDisconnectedVisible = createMemo(
    () =>
      runtimeDisconnected() &&
      !runtimeStartupConnecting() &&
      !props.connectingWorkspaceId,
  );
  const [nativeRecovery, setNativeRecovery] =
    createSignal<NativeRecoveryPresentation | null>(null);
  let nativeRecoveryRead = 0;
  createEffect(() => {
    const refresh = () => {
      const read = ++nativeRecoveryRead;
      void props.nativeBackendRecovery.read().then((result) => {
        if (read === nativeRecoveryRead) {
          setNativeRecovery((current) =>
            nextNativeRecoveryPresentation(current, result)
          );
        }
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 5_000);
    onCleanup(() => window.clearInterval(interval));
  });
  let runtimeDisconnectedVisibleLogged = false;
  createEffect(() => {
    if (!runtimeDisconnectedVisible() || runtimeDisconnectedVisibleLogged)
      return;
    runtimeDisconnectedVisibleLogged = true;
    uiLogError("runtime.disconnected", "Runtime disconnected banner shown", {
      workspaceId: props.activeWorkspaceId?.trim() || null,
      clientConnected: props.clientConnected,
      error: props.error?.trim() || null,
    });
  });
  const statusStartupConnecting = createStartupConnectingState(
    () => runtimeStatus?.view?.().severity === "ok",
  );

  // Auto-heal: when an *already-connected* runtime drops (e.g. the sandbox
  // container is recycled mid-session, or a transient network blip), attempt to
  // reconnect on a capped-backoff schedule instead of forcing the user to click
  // Retry / restart the app.
  //
  // Scope: this is the backstop for post-connect drops, NOT the initial-connect
  // boot race. It calls recoverWorkspace(activeWorkspaceId), which only acts on
  // a workspace that already exists in the store — so it does nothing until a
  // first successful connect has created that workspace. The boot-time race
  // (a freshly-ready container that reports healthy a few hundred ms before its
  // openwork workspace is listable) is owned by the connect-time backoff retry
  // in the workspace store (resolveOpenworkHostWithRetry); this effect does not
  // cover that path. Bounded so a genuinely dead runtime still settles on the
  // manual Retry button.
  {
    const AUTO_HEAL_MAX_ATTEMPTS = 6;
    const autoHealDelayMs = (attempt: number) =>
      Math.min(2_000 * 2 ** attempt, 30_000);
    let autoHealTimer: ReturnType<typeof setTimeout> | null = null;
    let autoHealAttempt = 0;
    let autoHealInFlight = false;
    let autoHealExhaustedLogged = false;

    const clearAutoHeal = () => {
      if (autoHealTimer !== null) {
        clearTimeout(autoHealTimer);
        autoHealTimer = null;
      }
    };

    createEffect(() => {
      const disconnected = runtimeDisconnected();
      const connecting =
        runtimeStartupConnecting() || Boolean(props.connectingWorkspaceId);

      if (!disconnected) {
        // Reconnected — reset the backoff so the next drop starts fresh.
        autoHealAttempt = 0;
        autoHealExhaustedLogged = false;
        clearAutoHeal();
        return;
      }
      // A connect attempt is already in flight (manual or from the store); don't
      // stack a second one. The effect re-runs when connecting flips back.
      if (connecting || autoHealInFlight || autoHealTimer !== null) return;
      if (autoHealAttempt >= AUTO_HEAL_MAX_ATTEMPTS) {
        if (!autoHealExhaustedLogged) {
          autoHealExhaustedLogged = true;
          uiLogError(
            "runtime.autoheal",
            "Runtime auto-reconnect attempts exhausted",
            {
              workspaceId: props.activeWorkspaceId?.trim() || null,
              attempts: AUTO_HEAL_MAX_ATTEMPTS,
            },
          );
        }
        return;
      }

      const workspaceId = props.activeWorkspaceId?.trim();
      if (!workspaceId) return;

      const delay = autoHealDelayMs(autoHealAttempt);
      autoHealTimer = setTimeout(() => {
        autoHealTimer = null;
        autoHealAttempt += 1;
        autoHealInFlight = true;
        uiLogInfo(
          "runtime.autoheal",
          "Auto-reconnecting disconnected runtime",
          {
            workspaceId,
            attempt: autoHealAttempt,
            delayMs: delay,
          },
        );
        void (async () => {
          try {
            await props.recoverWorkspace(workspaceId);
          } catch (error) {
            uiLogError("runtime.autoheal", "Runtime auto-reconnect failed", {
              workspaceId,
              attempt: autoHealAttempt,
              message:
                error instanceof Error
                  ? error.message
                  : props.safeStringify(error),
            });
          } finally {
            autoHealInFlight = false;
          }
        })();
      }, delay);
    });

    onCleanup(clearAutoHeal);
  }

  const [inboxVersion, setInboxVersion] = createSignal(0);

  // Workspace files panel: selected files for context injection
  const [workspaceSelectedFiles, setWorkspaceSelectedFiles] = createSignal<
    string[]
  >([]);
  const [workspaceSelectedLeafFileCount, setWorkspaceSelectedLeafFileCount] =
    createSignal(0);
  const [workspaceSelectedLeafFiles, setWorkspaceSelectedLeafFiles] =
    createSignal<string[]>([]);

  createEffect(
    on(
      [() => props.composerAttachmentUpload, () => props.selectedSessionId],
      ([upload]) => {
        if (!upload || upload.sessionID !== props.selectedSessionId) return;
        const selection = workspaceSelectionForComposerUpload(upload.paths);
        props.consumeComposerAttachmentUpload();
        if (!selection.length) return;
        setInboxVersion((version) => version + 1);
        setWorkspaceSelectedFiles(selection);
        // Composer uploads are always leaf files, so the selection is also the
        // leaf set the hybrid-deep-research file gate reads.
        setWorkspaceSelectedLeafFiles(selection);
        setWorkspaceSelectedLeafFileCount(selection.length);
      },
      { defer: true },
    ),
  );

  // The agent's `question` tool: options in a panel above the composer, the typed answer in the composer.
  const question = createSessionQuestion(props, () => selectedSessionMetadataResolved() && !selectedSessionLoading());

  const openSessionFromList = (
    workspaceId: string,
    sessionId: string,
    options?: { focusComposer?: boolean },
  ) => {
    if (!sessionId) return;
    const shouldFocusComposer = options?.focusComposer === true;
    // Route-driven selection: navigate first and let the route effect own selectSession.
    if (workspaceId === props.activeWorkspaceId) {
      props.setView("session", sessionId);
      if (shouldFocusComposer) {
        focusComposer();
      }
      return;
    }
    // For different workspace, activate workspace first
    void (async () => {
      await Promise.resolve(props.activateWorkspace(workspaceId));
      props.setView("session", sessionId);
      if (shouldFocusComposer) {
        focusComposer();
      }
    })();
  };

  const createTaskInWorkspace = (workspaceId: string) => {
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

  const commandPalette = createCommandPaletteItems({
    mode: commandPaletteMode,
    query: commandPaletteQuery,
    sessionGroups: () => props.workspaceSessionGroups,
    activeWorkspaceId: () => props.activeWorkspaceId,
    labelWorkspace: workspaceLabel,
    selectedSessionTitle,
    selectedSessionModelLabel: () => props.selectedSessionModelLabel,
    modelVariant: () => props.modelVariant,
    modelVariantLabel: () => props.modelVariantLabel,
    // The palette is already open when an item runs, so reusing the opener is
    // equivalent to resetting mode/query/selection by hand.
    enterMode: openCommandPalette,
    close: closeCommandPalette,
    closeAndFocusComposer: closeCommandPaletteAndFocusComposer,
    focusComposer,
    notify: setToastMessage,
    openNewTask: () => props.openNewTask(),
    openRenameModal: () => openRenameModal({ returnFocusToComposer: true }),
    openSessionModelPicker: () =>
      props.openSessionModelPicker({ returnFocusTarget: "composer" }),
    openProviderAuthModal: () =>
      props.openProviderAuthModal({ returnFocusTarget: "composer" }),
    setModelVariant: (variant) => props.setModelVariant(variant),
    openSessionFromList: (workspaceId, sessionId) =>
      openSessionFromList(workspaceId, sessionId, { focusComposer: true }),
  });

  const commandPaletteItems = commandPalette.items;
  const commandPaletteTitle = commandPalette.title;
  const commandPalettePlaceholder = commandPalette.placeholder;

  createEffect(
    on(
      () => [commandPaletteMode(), commandPaletteQuery()],
      () => {
        if (!commandPaletteOpen()) return;
        commandPaletteOptionRefs.length = 0;
        setCommandPaletteActiveIndex(0);
      },
    ),
  );

  const openSettings = (section: SettingsSection = "model") => {
    closeSearch();
    props.openSettings(section);
  };

  const openConfig = () => {
    openSettings(props.developerMode ? "config" : "identities");
  };

  const openMcp = () => {
    openSettings("mcp");
  };

  const openProviderAuth = () => {
    void props.openProviderAuthModal().catch((error) => {
      const message = error instanceof Error ? error.message : "Connect failed";
      setToastMessage(message);
    });
  };

  const hasOpenAIProviderConnected = createMemo(() =>
    (props.providerConnectedIds ?? []).some(
      (id) => id.trim().toLowerCase() === "openai",
    ),
  );

  return (
    <div class="h-[100dvh] min-h-screen w-full flex flex-col overflow-hidden bg-[var(--dls-app-bg)] text-dls-text font-sans">
      <Titlebar />
      {__BUILD_DEBUG__ && (
        <Show when={runtimeStatusUiVisible() && !nativeRecovery()}>
          <SandboxStatusBanner
            view={runtimeStatus.view}
            onOpenDetails={() => {
              setDevToolsTab("sandbox");
              setDevToolsOpen(true);
            }}
            hidden={statusStartupConnecting}
          />
          <DevToolsModal
            open={devToolsOpen}
            initialTab={devToolsTab}
            onClose={() => setDevToolsOpen(false)}
            sandbox={{
              view: runtimeStatus.view,
              onRefresh: () => runtimeStatus.refresh(),
              isFetching: runtimeStatus.isFetching,
              lastUpdatedAt: runtimeStatus.lastUpdatedAt,
            }}
            trajectoryOrigin={trajectoryOriginAccessor}
            sessionId={() => props.selectedSessionId}
          />
        </Show>
      )}
      <Show when={nativeRecovery()}>
        {(recovery) => (
          <NativeRecoveryBanner
            recovery={recovery()}
            recoveryBusy={props.nativeBackendRecovery.busy()}
            recoveryError={props.nativeBackendRecovery.error()}
            onRestart={() => {
              void props.nativeBackendRecovery.restart();
            }}
          />
        )}
      </Show>
      <div class="flex flex-1 min-h-0 w-full gap-3 md:gap-4 p-3 md:p-4 pt-1 md:pt-2">
        {/*  Sidebar drawer for smaller screens */}
        <SidebarDrawer
          open={sidebarDrawerOpen()}
          onClose={() => setSidebarDrawerOpen(false)}
        >
          <div class="flex min-h-0 flex-1 flex-col">
            <SidebarNewTaskRow
              label={t("session.new_task")}
              disabled={props.newTaskDisabled}
              onCreate={() => {
                createTaskInWorkspace(props.activeWorkspaceId);
                setSidebarDrawerOpen(false);
              }}
            />
            <div class="flex-1 min-h-0 overflow-y-auto">
              <WorkspaceSessionList
                workspaceSessionGroups={props.workspaceSessionGroups}
                activeWorkspaceId={props.activeWorkspaceId}
                selectedSessionId={props.selectedSessionId}
                showSessionActions
                sessionStatusById={props.sessionStatusById}
                connectingWorkspaceId={props.connectingWorkspaceId}
                workspaceConnectionStateById={
                  props.workspaceConnectionStateById
                }
                newTaskDisabled={props.newTaskDisabled}
                importingWorkspaceConfig={props.importingWorkspaceConfig}
                onActivateWorkspace={props.activateWorkspace}
                onOpenSession={(workspaceId, sessionId) => {
                  openSessionFromList(workspaceId, sessionId);
                  setSidebarDrawerOpen(false);
                }}
                onCreateTaskInWorkspace={(workspaceId) => {
                  createTaskInWorkspace(workspaceId);
                  setSidebarDrawerOpen(false);
                }}
                onOpenRenameSession={openRenameModal}
                onOpenDeleteSession={openDeleteSessionModal}
                onOpenRenameWorkspace={props.openRenameWorkspace}
                onShareWorkspace={(workspaceId) =>
                  setShareWorkspaceId(workspaceId)
                }
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
              class="w-full flex min-h-11 items-center justify-start gap-2.5 rounded-card px-3.5 border text-body font-medium transition-[background-color,border-color,box-shadow,color] border-transparent text-dls-secondary hover:border-dls-border hover:bg-dls-surface hover:text-dls-text"
              onClick={() => {
                props.setTab("data");
                props.setView("dashboard");
                setSidebarDrawerOpen(false);
              }}
              aria-label="Data & Usage"
            >
              <ChartColumnIncreasing size={18} />
              {t("dashboard.data_usage")}
            </button>
            <button
              type="button"
              class="w-full flex min-h-11 items-center justify-start gap-2.5 rounded-card px-3.5 border text-body font-medium transition-[background-color,border-color,box-shadow,color] border-transparent text-dls-secondary hover:border-dls-border hover:bg-dls-surface hover:text-dls-text"
              onClick={() => {
                props.openSettings(undefined, navigationToggleEl);
                setSidebarDrawerOpen(false);
              }}
              aria-label={t("tour.advanced_config.title")}
            >
              <SlidersHorizontal size={18} />
              {t("tour.advanced_config.title")}
            </button>
          </div>
        </SidebarDrawer>

        <aside
          class="group/leftsidebar relative hidden lg:flex shrink-0 flex-col rounded-shell border border-dls-border bg-dls-sidebar p-2.5"
          style={{
            width: `${leftSidebarWidth()}px`,
            "min-width": `${leftSidebarWidth()}px`,
          }}
        >
          <div
            data-tour-id="sidebar-sessions-area"
            class="flex min-h-0 flex-1 flex-col"
          >
            <SidebarNewTaskRow
              label={t("session.new_task")}
              disabled={props.newTaskDisabled}
              onCreate={() => createTaskInWorkspace(props.activeWorkspaceId)}
            />
            <div class="min-h-0 flex-1 overflow-y-auto">
              <WorkspaceSessionList
                workspaceSessionGroups={props.workspaceSessionGroups}
                activeWorkspaceId={props.activeWorkspaceId}
                selectedSessionId={props.selectedSessionId}
                showSessionActions
                sessionStatusById={props.sessionStatusById}
                connectingWorkspaceId={props.connectingWorkspaceId}
                workspaceConnectionStateById={
                  props.workspaceConnectionStateById
                }
                newTaskDisabled={props.newTaskDisabled}
                importingWorkspaceConfig={props.importingWorkspaceConfig}
                onActivateWorkspace={props.activateWorkspace}
                onOpenSession={openSessionFromList}
                onCreateTaskInWorkspace={createTaskInWorkspace}
                onOpenRenameSession={openRenameModal}
                onOpenDeleteSession={openDeleteSessionModal}
                onOpenRenameWorkspace={props.openRenameWorkspace}
                onShareWorkspace={(workspaceId) =>
                  setShareWorkspaceId(workspaceId)
                }
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
              data-tour-id="sidebar-data"
              type="button"
              class="w-full flex min-h-11 items-center justify-start gap-2.5 rounded-card px-3.5 border text-body font-medium transition-[background-color,border-color,box-shadow,color] border-transparent text-dls-secondary hover:border-dls-border hover:bg-dls-surface hover:text-dls-text"
              onClick={() => {
                props.setTab("data");
                props.setView("dashboard");
              }}
              aria-label="Data & Usage"
            >
              <ChartColumnIncreasing size={18} />
              {t("tour.data_usage.title")}
            </button>
            <button
              data-testid="advanced-settings-button"
              data-tour-id="sidebar-advanced"
              type="button"
              class="w-full flex min-h-11 items-center justify-start gap-2.5 rounded-card px-3.5 border text-body font-medium transition-[background-color,border-color,box-shadow,color] border-transparent text-dls-secondary hover:border-dls-border hover:bg-dls-surface hover:text-dls-text"
              onClick={() => props.openSettings()}
              aria-label={t("tour.advanced_config.title")}
            >
              <SlidersHorizontal size={18} />
              {t("tour.advanced_config.title")}
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
            aria-label="Resize workspace column"
          >
            <div class="relative h-full w-0.5 rounded-pill bg-dls-border/50 transition-colors duration-150 group-hover:bg-dls-status-neutral-dot">
              <div class="absolute left-1/2 top-1/2 h-24 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-dls-status-neutral-dot transition-colors duration-150 group-hover:bg-dls-muted group-active:bg-dls-neutral-active" />
            </div>
            <div class="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 whitespace-nowrap rounded-control border border-dls-border bg-dls-surface-solid px-2 py-1 text-label text-dls-secondary shadow-[var(--dls-card-shadow)] group-hover:block">
              Drag to resize
            </div>
          </div>
        </aside>

        <main class="relative min-w-0 flex-1 flex flex-col overflow-hidden rounded-shell border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
          <header class="z-10 flex h-12 shrink-0 items-center justify-between bg-dls-surface pl-4 pr-14 md:pl-6 md:pr-14">
            <div class="flex min-w-0 items-center gap-3">
              <button
                ref={navigationToggleEl}
                type="button"
                class="lg:hidden flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover/70 hover:text-dls-text"
                onClick={() => setSidebarDrawerOpen(true)}
                aria-label="Open navigation"
                title="Open navigation"
              >
                <Menu size={18} />
              </button>
              {__BUILD_DEBUG__ && (
                <Show when={runtimeStatusUiVisible()}>
                  {(() => {
                    // During the startup connecting grace the runtime isn't
                    // connected yet — surface the Dev Tools light as amber
                    // ("connecting"), not red, matching the session banner.
                    // Once the grace ends the real severity tone is shown.
                    const devToolsTone = () => {
                      const sev = runtimeStatus.view().severity;
                      const tone = pillTone(sev);
                      if (
                        statusStartupConnecting() &&
                        (tone === "red" || tone === "gray")
                      )
                        return "amber" as const;
                      return tone;
                    };
                    return (
                      <button
                        type="button"
                        class={(() => {
                          const tone = devToolsTone();
                          const toneClass =
                            tone === "green"
                              ? "border-dls-success-border-solid text-dls-success-text"
                              : tone === "amber"
                                ? "border-dls-warning-border text-dls-warning-text"
                                : tone === "red"
                                  ? "border-dls-danger-border-solid text-dls-danger-text"
                                  : "border-dls-border text-dls-secondary";
                          return `hidden md:flex items-center gap-1.5 rounded-pill border bg-dls-surface px-2.5 py-1 text-caption font-medium shadow-sm transition-colors active:scale-[0.99] hover:bg-dls-hover/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.2)] ${toneClass}`;
                        })()}
                        onClick={() => {
                          setDevToolsTab("trajectory");
                          setDevToolsOpen(true);
                        }}
                        title="Open developer tools"
                        aria-label="Open developer tools"
                      >
                        <Circle
                          size={8}
                          class={(() => {
                            const tone = devToolsTone();
                            if (tone === "green")
                              return "fill-dls-success-dot text-dls-success-dot shrink-0";
                            if (tone === "amber")
                              return "fill-dls-warning-dot text-dls-warning-dot shrink-0 animate-pulse";
                            if (tone === "red")
                              return "fill-dls-danger-dot text-dls-danger-dot shrink-0 animate-pulse";
                            return "fill-dls-muted text-dls-muted shrink-0";
                          })()}
                        />
                        <span>Dev Tools</span>
                      </button>
                    );
                  })()}
                </Show>
              )}
              {/* <span class="shrink-0 rounded-control bg-dls-hover px-2 py-1 text-label font-medium text-dls-secondary">
                {showWorkspaceSetupEmptyState()
                  ? "Worker"
                  : props.activeWorkspaceDisplay.workspaceType === "remote"
                    ? ""
                    : "Worker"}
              </span> */}
              <SessionTokenUsageToggle
                tokensByModel={showWorkspaceSetupEmptyState() ? null : tokenUsage.sessionTokensByModel()}
                formatTokens={tokenUsage.formatTokens}
                formatModelLabel={tokenUsage.formatModelLabel}
              >
                <h1 class="truncate text-title leading-title font-semibold text-dls-text">
                  {showWorkspaceSetupEmptyState()
                    ? t("session.create_or_connect_worker")
                    : localizedSessionTitle() || t("session.new_session")}
                </h1>
              </SessionTokenUsageToggle>
              <Show when={props.developerMode}>
                <span class="hidden text-caption text-dls-secondary lg:inline">
                  {props.headerStatus}
                </span>
              </Show>
              <Show when={props.busyHint}>
                <span class="hidden text-caption text-dls-secondary lg:inline">
                  {props.busyHint}
                </span>
              </Show>
            </div>

            <Show when={parentSessionId()}>
              {(pid) => (
                <button
                  type="button"
                  class="flex items-center gap-1.5 rounded-control border border-dls-border bg-dls-surface px-2.5 py-1.5 text-body font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                  onClick={() => props.setView("session", pid())}
                  title="Back to parent session"
                  aria-label="Back to parent session"
                >
                  <ChevronLeft size={14} />
                  <span class="hidden sm:inline">Parent task</span>
                </button>
              )}
            </Show>
          </header>

          <Tooltip
            content={
              rightSidebarExpanded() ? "Collapse sidebar" : "Expand sidebar"
            }
            placement="left"
            maxWidthClass="max-w-[160px]"
            class="absolute right-2 top-1.5 z-20"
          >
            <button
              type="button"
              data-testid="right-sidebar-toggle"
              class="flex h-9 w-9 items-center justify-center rounded-pill text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={toggleRightSidebar}
              aria-label={
                rightSidebarExpanded() ? "Collapse sidebar" : "Expand sidebar"
              }
            >
              <Show
                when={rightSidebarExpanded()}
                fallback={<ChevronLeft size={18} />}
              >
                <ChevronRight size={18} />
              </Show>
            </button>
          </Tooltip>

          <Show when={parentSessionId()}>
            <div class="border-b border-dls-border bg-dls-surface/70">
              <div class="flex items-center gap-2 px-4 py-2.5 text-body text-dls-secondary sm:px-6 lg:px-10">
                <Eye size={14} class="shrink-0" />
                <span>{t("session.subagent_readonly_notice")}</span>
              </div>
            </div>
          </Show>

          <Show
            when={
              !nativeRecovery() &&
              props.clientConnected &&
              props.error &&
              !runtimeDisconnected()
            }
          >
            <div role="alert" data-testid="session-error-banner" class="border-b border-dls-danger-border bg-dls-danger-bg animate-in fade-in slide-in-from-top-3 duration-300">
              <div class="flex items-start gap-3 px-4 py-3 sm:px-6 lg:px-10">
                <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-inset border border-dls-danger-border bg-dls-danger-bg text-dls-danger-text">
                  <AlertTriangle size={14} />
                </div>
                <div class="min-w-0 flex-1 text-body-lg leading-relaxed text-dls-danger-text">
                  {props.error}
                </div>
              </div>
            </div>
          </Show>

          {/* Runtime not connected. Unified top banner: shows an amber
              "Connecting…" state during the startup connecting grace OR while a
              workspace is actively being connected; shows the red error once the
              grace ends and no connect is in flight (a genuine failure is never
              masked). NOTE: intentionally NOT gated on showWorkspaceSetupEmptyState
              — during startup there is no workspace yet (empty-state is true), and
              the content area shows the setup card while THIS top banner shows the
              connection status; the two are different regions and coexist. */}
          <Show when={(runtimeDisconnected() || edgeBannerShown()) && !nativeRecovery()}>
            {(() => {
              const connecting = () => !runtimeDisconnectedVisible();
              const genericMessage = () => {
                const wsState =
                  props.workspaceConnectionStateById[props.activeWorkspaceId];
                return props.error || wsState?.message || null;
              };
              return (
                <RuntimeDisconnectedBanner
                  connecting={connecting()}
                  genericMessage={genericMessage()}
                  onRetry={() => void handleDisconnectedRetry()}
                  onOpenSettings={() => openSettings("model")}
                />
              );
            })()}
          </Show>

          <Show when={searchOpen() || searchClosing()}>
            <div
              class="search-panel-motion absolute right-6 top-[60px] z-30 w-[min(92vw,340px)] will-change-[opacity,transform]"
              style={{
                opacity: searchPanelVisible() ? 1 : 0,
                transform: searchPanelVisible()
                  ? "translate3d(0, 0, 0)"
                  : "translate3d(0, -16px, 0)",
              }}
            >
              <div class="flex items-center gap-1.5 rounded-card border border-dls-border bg-dls-surface-solid px-2.5 py-1.5 shadow-[var(--dls-shell-shadow)] ring-1 ring-[rgb(var(--dls-accent-rgb)/0.15)] focus-within:ring-2 focus-within:ring-[rgb(var(--dls-accent-rgb)/0.45)]">
                <Search size={13} class="shrink-0 text-dls-secondary" />
                <textarea
                  ref={(el) => (searchInputEl = el)}
                  rows={1}
                  value={searchQuery()}
                  onInput={(event) => {
                    setSearchQuery(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      moveSearchHit(event.shiftKey ? -1 : 1);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeSearch();
                    }
                  }}
                  class="min-w-0 flex-1 resize-none bg-transparent py-0 text-body leading-5 text-dls-text placeholder:text-dls-secondary/70 focus:outline-none"
                  placeholder="Search in this chat"
                  aria-label="Search in this chat"
                />
                <Show when={searchQuery().trim()}>
                  <span class="shrink-0 rounded-control bg-dls-hover px-1.5 py-0.5 text-tiny font-medium text-dls-secondary tabular-nums">
                    {activeSearchPositionLabel()}
                  </span>
                </Show>
                <div class="h-4 w-px shrink-0 bg-dls-border" />
                <Tooltip content="Previous match (Ctrl+Shift+G)" placement="bottom" maxWidthClass="max-w-[180px]">
                  <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:pointer-events-none disabled:opacity-40"
                    disabled={searchNavState().scanning || searchNavState().total === 0}
                    onClick={() => moveSearchHit(-1)}
                    aria-label="Previous match"
                  >
                    <ChevronUp size={13} />
                  </button>
                </Tooltip>
                <Tooltip content="Next match (Enter)" placement="bottom" maxWidthClass="max-w-[160px]">
                  <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:pointer-events-none disabled:opacity-40"
                    disabled={searchNavState().scanning || searchNavState().total === 0}
                    onClick={() => moveSearchHit(1)}
                    aria-label="Next match"
                  >
                    <ChevronDown size={13} />
                  </button>
                </Tooltip>
                <Tooltip content="Close search (Esc)" placement="bottom" maxWidthClass="max-w-[150px]">
                  <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                    onClick={closeSearch}
                    aria-label="Close search"
                  >
                    <X size={13} />
                  </button>
                </Tooltip>
              </div>
            </div>
          </Show>

          {/* <Show when={props.showSkillReloadBanner}>
            <div class="border-b border-dls-border/70 bg-dls-surface animate-in fade-in slide-in-from-top-3 duration-300">
              <div class="flex min-h-[104px] items-start gap-3 px-4 py-5 sm:px-6 lg:px-10">
                <div
                  class={`flex h-10 w-10 shrink-0 items-center justify-center rounded-card border ${
                    props.reloadBannerBlocked
                      ? "border-dls-warning-border bg-dls-warning-bg-strong text-dls-warning-text"
                      : "border-dls-info-border bg-dls-info-bg text-dls-info-text"
                  }`.trim()}
                >
                  <RefreshCcw size={18} class={props.reloadBusy ? "animate-spin" : ""} />
                </div>

                <div class="min-w-0 flex-1">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="truncate text-body-lg font-semibold text-dls-text">{props.reloadBannerTitle}</span>
                        <Show when={props.reloadBannerBlocked}>
                          <span class="inline-flex items-center gap-1 rounded-pill bg-dls-warning-bg-strong px-2 py-0.5 text-tiny font-semibold uppercase tracking-[0.18em] text-dls-warning-text">
                            Active tasks
                          </span>
                        </Show>
                      </div>

                      <div class="mt-1 space-y-1 text-body-lg leading-relaxed text-dls-secondary">
                        <div>
                          <Show
                            when={props.reloadBannerBlocked}
                            fallback={
                              <Show when={props.reloadError} fallback={props.reloadBannerBody}>
                                <span class="font-medium text-dls-danger-text">{props.reloadError}</span>
                              </Show>
                            }
                          >
                            <span class="font-medium text-dls-warning-text">Reloading will stop active tasks.</span>
                          </Show>
                        </div>

                        <Show when={props.reloadBannerBlocked}>
                          <div class="flex items-start gap-2 rounded-card border border-dls-warning-border bg-dls-warning-bg-strong px-3 py-2 text-caption text-dls-warning-text">
                            <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                            <span>
                              {`Reloading stops ${props.reloadBannerActiveCount} active conversation${props.reloadBannerActiveCount === 1 ? "" : "s"}.`}
                            </span>
                          </div>
                        </Show>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={props.dismissReloadBanner}
                      class="rounded-pill p-1 text-dls-muted transition hover:bg-dls-hover hover:text-dls-text"
                      aria-label="Dismiss reload prompt"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  <div class="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant={props.reloadBannerBlocked ? "danger" : "primary"}
                      class="rounded-pill px-3 py-1.5 text-caption"
                      disabled={!props.canReloadWorkspace || props.reloadBusy}
                      onClick={() =>
                        void (props.reloadBannerBlocked
                          ? props.forceStopActiveConversations()
                          : props.reloadWorkspaceEngine())
                      }
                    >
                      {props.reloadBusy
                        ? "Reloading..."
                        : props.reloadBannerBlocked
                          ? "Reload & Stop Tasks"
                          : "Reload now"}
                    </Button>
                    <Button
                      variant="ghost"
                      class="rounded-pill px-3 py-1.5 text-caption"
                      onClick={props.dismissReloadBanner}
                    >
                      Later
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </Show> */}

          <div class="flex-1 flex overflow-hidden">
            <div class="relative min-w-0 flex-1 overflow-hidden bg-dls-surface">
              <div
                class={`h-full overflow-y-auto px-4 sm:px-6 lg:px-10 ${showWorkspaceSetupEmptyState() ? "pt-20" : "pt-10"} bg-dls-surface ${shouldHideChatWhileInitializing() ? "invisible" : "visible"}`}
                style={{
                  contain: "paint style",
                  // Disable browser scroll anchoring only while a prompt pin is
                  // actively controlling scroll position. Leaving it on globally
                  // would let content insertions above the viewport (history
                  // prepend, tool-result expansion) jump the reading position.
                  "overflow-anchor": autoPinActive() ? "none" : "auto",
                  "scrollbar-gutter": "stable both-edges",
                }}
                // Passive: the compositor otherwise waits on this handler for
                // every wheel tick over this area, including over the Settings
                // dialog drawn on top of it.
                on:wheel={{
                  passive: true,
                  handleEvent: () => {
                    lastManualScrollIntentAt = Date.now();
                    promptNavigationScrollUntil = 0;
                    jumpScroll.cancel();
                  },
                }}
                onTouchStart={() => {
                  lastManualScrollIntentAt = Date.now();
                  promptNavigationScrollUntil = 0;
                  jumpScroll.cancel();
                }}
                onPointerDown={(event) => {
                  const container = event.currentTarget as HTMLDivElement;
                  const rect = container.getBoundingClientRect();
                  const rightGutterWidth =
                    (container.offsetWidth - container.clientWidth) / 2;
                  if (event.clientX < rect.right - rightGutterWidth) return;
                  scrollbarDragActive = true;
                  lastManualScrollIntentAt = Date.now();
                  promptNavigationScrollUntil = 0;
                  jumpScroll.cancel();
                  const endDrag = () => {
                    scrollbarDragActive = false;
                    lastManualScrollIntentAt = Date.now();
                    window.removeEventListener("pointerup", endDrag);
                    window.removeEventListener("pointercancel", endDrag);
                  };
                  window.addEventListener("pointerup", endDrag);
                  window.addEventListener("pointercancel", endDrag);
                }}
                onKeyDown={(event) => {
                  if (!MANUAL_SCROLL_KEYS.has(event.key)) return;
                  const target = event.target as HTMLElement | null;
                  if (
                    target?.closest("input, textarea, [contenteditable='true']")
                  ) {
                    return;
                  }
                  lastManualScrollIntentAt = Date.now();
                  promptNavigationScrollUntil = 0;
                  jumpScroll.cancel();
                }}
                onScroll={(event) => {
                  const container = event.currentTarget as HTMLDivElement;
                  // A drag can outlive the intent window, so keep it stamped.
                  if (scrollbarDragActive)
                    lastManualScrollIntentAt = Date.now();
                  if (
                    historicalPromptScrollReady &&
                    bottomSpacerPx() > 0 &&
                    pinnedScrollTopThreshold !== null &&
                    container.scrollTop > pinnedScrollTopThreshold + 1
                  ) {
                    historicalPromptScrollReady = false;
                    preserveLatestUserMessageSpacerWhileScrolling();
                  }
                  if (
                    !isGenerating() &&
                    !pinScrollAnimating() &&
                    pinnedUserMessageId !== null &&
                    bottomSpacerPx() > 0 &&
                    pinnedScrollTopThreshold !== null &&
                    container.scrollTop > pinnedScrollTopThreshold + 1
                  ) {
                    // Content can grow after the pin is set (e.g. expanding a collapsed long message), turning reserved spacer into real
                    // content the user must still be able to reach/scroll.
                    const maxScrollWithoutSpacer =
                      container.scrollHeight -
                      bottomSpacerPx() -
                      container.clientHeight;
                    if (maxScrollWithoutSpacer > pinnedScrollTopThreshold + 1) {
                      preserveLatestUserMessageSpacerWhileScrolling();
                    } else {
                      container.scrollTop = pinnedScrollTopThreshold;
                      lastKnownScrollTop = pinnedScrollTopThreshold;
                      setScrollBottomGap(0);
                      setIsViewingLatest(true);
                      setAutoPinActive(true);
                      return;
                    }
                  }
                  const bottomGap =
                    container.scrollHeight -
                    (container.scrollTop + container.clientHeight);
                  setScrollBottomGap(bottomGap);
                  refreshRunFooterOffscreen();
                  // Collapsing stream content clamps scrollTop to the bottom on its own.
                  // Only a real scroll gesture may release the pin.
                  const holdingPin =
                    isGenerating() &&
                    pinnedUserMessageId !== null &&
                    Date.now() - lastManualScrollIntentAt >=
                      MANUAL_SCROLL_INTENT_WINDOW_MS;
                  if (
                    bottomGap <= 2 &&
                    !holdingPin &&
                    !promptNavigationScrollActive()
                  ) {
                    setIsViewingLatest(true);
                    setAutoPinActive(false);
                  }
                  if (
                    bottomGap > 2 &&
                    container.scrollTop < lastKnownScrollTop - 1
                  ) {
                    setIsViewingLatest(false);
                    const leavingPinnedPrompt =
                      pinnedScrollTopThreshold === null ||
                      container.scrollTop < pinnedScrollTopThreshold - 1;
                    if (leavingPinnedPrompt) {
                      setAutoPinActive(false);
                      cancelPinnedScrollWait();
                      cancelPinRetry();
                      pendingPinMessageId = null;
                      awaitingNewUserMessagePin = false;
                      if (props.selectedSessionId) {
                        sessionManualViewportOverride.add(
                          props.selectedSessionId,
                        );
                      }
                    }
                    if (scrollFrame !== undefined) {
                      window.cancelAnimationFrame(scrollFrame);
                      scrollFrame = undefined;
                      pendingScrollBehavior = "auto";
                    }
                  }
                  lastKnownScrollTop = container.scrollTop;
                }}
                ref={(el) => {
                  chatContainerEl = el;
                  setIsChatContainerReady(Boolean(el));
                  lastKnownScrollTop = el?.scrollTop ?? 0;
                }}
              >
                <div
                  class="mx-auto w-full max-w-[800px]"
                  ref={(el) => {
                    chatContentEl = el;
                  }}
                >
                  <Show when={props.messages.length === 0}>
                    <div class="text-center py-1 px-6 space-y-3">
                      <div class="flex justify-center">
                        <SuperClawIcon size={112} class="text-dls-secondary" />
                      </div>
                      <div class="space-y-2">
                        <h3 class="text-display font-medium">
                          {t("welcome.title")}
                        </h3>
                        <p class="text-body-lg text-dls-secondary">
                          {t("welcome.subtitle")}
                        </p>
                      </div>
                    </div>
                  </Show>

                  <Show
                    when={
                      hiddenMessageCount() > 0 || hasServerEarlierMessages()
                    }
                  >
                    <div class="mb-4 flex justify-center">
                      <button
                        type="button"
                        class="rounded-pill border border-dls-border bg-dls-hover/70 px-3 py-1 text-caption text-dls-secondary transition-colors hover:bg-dls-active hover:text-dls-text"
                        onClick={() => {
                          void revealEarlierMessages();
                        }}
                        disabled={props.loadingEarlierMessages}
                      >
                        {props.loadingEarlierMessages
                          ? "Loading earlier messages..."
                          : hiddenMessageCount() > 0
                            ? `Show ${nextRevealCount().toLocaleString()} earlier message${nextRevealCount() === 1 ? "" : "s"}`
                            : "Load earlier messages"}
                      </button>
                    </div>
                  </Show>

                  <MessageList
                    messages={batchedRenderedMessages()}
                    isStreaming={isGenerating()}
                    developerMode={props.developerMode}
                    onSubmitEditedUserMessage={
                      sessionReadOnly() ? undefined : submitEditedMessage
                    }
                    onRetry={sessionReadOnly() ? undefined : retryRun}
                    onOpenSettings={() => openSettings("model")}
                    canEditLastUserMessage={
                      !sessionReadOnly() &&
                      canUndoLastMessage() &&
                      historyActionBusy() === null
                    }
                    lastRunElapsedMs={runElapsedByMessageId()}
                    speakMessage={props.speakMessage}
                    ttsAvailable={props.ttsAvailable}
                    ttsReadAloud={props.ttsReadAloud}
                    sessionTitle={selectedSessionTitle() || undefined}
                    tokensByMessageId={tokenUsage.tokensByMessageId()}
                    servedModelLabelByMessageId={tokenUsage.servedModelLabelByMessageId()}
                    activityModelExecutions={tokenUsage.activityModelExecutions()}
                    debugObservabilityAvailable={props.debugObservabilityAvailable}
                    showThinking={props.showThinking}
                    skills={props.skills}
                    getSessionById={props.getSessionById}
                    getMessagesBySessionId={props.getMessagesBySessionId}
                    ensureSessionLoaded={props.ensureSessionLoaded}
                    sessionLoadingById={props.sessionLoadingById}
                    workspaceRoot={props.activeWorkspaceRoot}
                    localFiles={localFiles}
                    onCollapseLargeText={pinPromptForMessage}
                    expandedStepIds={props.expandedStepIds}
                    setExpandedStepIds={props.setExpandedStepIds}
                    openSessionById={(sessionId) =>
                      props.setView("session", sessionId)
                    }
                    searchMatchMessageIds={searchMatchMessageIds()}
                    searchHighlightQuery={searchQueryDebounced().trim()}
                    scrollElement={() => chatContainerEl}
                    setScrollToMessageById={(handler) => {
                      scrollMessageIntoViewById = handler;
                    }}
                    onSearchNavStateChange={setSearchNavState}
                    setSearchMatchController={(controller) => {
                      searchMatchNav = controller;
                    }}
                    reportSummaries={reportSummaryBlocks()}
                    onOpenReportSummary={(path) => void filePreview.previewFile(path)}
                    onPreviewFile={(path) => void filePreview.previewFile(path)}
                    onRevealFile={(path) => void revealArtifact(path)}
                    footer={
                      showRunIndicator() ? (
                        <div
                          class="flex justify-start pl-2"
                          ref={(el) => {
                            runFooterEl = el;
                          }}
                        >
                          <div class="w-full max-w-[68ch]">
                            <div
                              class={`ml-3 mt-3 flex items-center gap-2 text-caption py-1 ${runPhase() === "error" ? "text-dls-danger-text" : "text-dls-secondary"}`}
                              role="status"
                              aria-live="polite"
                            >
                              <span
                                class={`truncate ${
                                  runPhase() === "sending" ||
                                  runPhase() === "retrying" ||
                                  runPhase() === "thinking" ||
                                  runPhase() === "responding"
                                    ? "animate-pulse"
                                    : ""
                                }`}
                              >
                                {thinkingStatus() || runLabel()}
                              </span>
                              <Show
                                when={
                                  props.debugObservabilityAvailable ||
                                  props.developerMode
                                }
                              >
                                <span class="text-tiny text-dls-subtle ml-auto shrink-0">
                                  {runElapsedLabel()}
                                </span>
                              </Show>
                            </div>
                          </div>
                        </div>
                      ) : undefined
                    }
                  />

                  <div
                    aria-hidden="true"
                    style={{ height: `${bottomSpacerPx()}px` }}
                  />
                  <div
                    ref={(el) => {
                      messagesEndEl = el;
                      bottomVisibilityEl = el;
                    }}
                  />
                </div>
              </div>

              <Show when={hasPromptNavigation()}>
                <div
                  class="group absolute right-5 top-1/2 z-30 -translate-y-1/2"
                  onMouseEnter={() => setPromptNavigationHovered(true)}
                  onMouseLeave={() => setPromptNavigationHovered(false)}
                  onFocusIn={() => setPromptNavigationFocused(true)}
                  onFocusOut={(event) => {
                    if (
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    ) {
                      setPromptNavigationFocused(false);
                    }
                  }}
                >
                  <button
                    type="button"
                    class="flex size-8 items-center justify-center rounded-control border border-dls-border bg-dls-surface-solid/95 text-dls-secondary shadow-[var(--dls-card-shadow)] backdrop-blur-md transition-colors hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dls-status-neutral-dot dark:bg-dls-surface-raised dark:hover:bg-dls-hover"
                    aria-label="Navigate prompts"
                    aria-expanded={promptNavigationOpen()}
                  >
                    <TextAlignJustify size={16} />
                  </button>
                  <div
                    class="invisible pointer-events-none absolute right-full top-1/2 w-[min(22.5rem,calc(100vw-4.5rem))] -translate-y-1/2 pr-2 opacity-0 transition-[opacity,visibility] duration-150 group-hover:visible group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:visible group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                    role="group"
                    aria-label="Conversation prompts"
                  >
                    <div
                      class="overflow-y-auto rounded-control border border-dls-border bg-dls-surface-solid/95 p-1.5 shadow-[var(--dls-card-shadow)] backdrop-blur-md"
                      style={{
                        "max-height": `${Math.max(96, Math.min(416, chatViewportHeight() - 32))}px`,
                      }}
                    >
                      <For each={promptNavigationItems()}>
                        {(prompt, index) => (
                          <button
                            type="button"
                            class="flex w-full items-start gap-2 rounded-compact px-2.5 py-2 text-left text-body-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text focus-visible:bg-dls-hover focus-visible:text-dls-text focus-visible:outline-none"
                            onClick={() => navigateToUserPrompt(prompt.id)}
                          >
                            <span class="mt-0.5 shrink-0 text-caption tabular-nums text-dls-subtle">
                              {index() + 1}
                            </span>
                            <span class="line-clamp-2 min-w-0 break-words leading-5">
                              {prompt.label}
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </Show>

              <Show when={shouldShowJumpControls()}>
                <div class="absolute bottom-4 left-0 right-0 z-20 flex justify-center pointer-events-none">
                  <Show when={runSpinnerVisible()}>
                    <div class="pointer-events-auto flex items-center gap-2 rounded-pill border border-dls-border bg-dls-surface-solid/95 p-1 shadow-[var(--dls-card-shadow)] backdrop-blur-md">
                      <button
                        type="button"
                        class="inline-flex items-center justify-center rounded-pill px-3 py-1.5 text-caption text-dls-secondary transition-colors hover:bg-dls-hover"
                        onClick={() => {
                          if (autoPinActive()) {
                            suppressJumpControlsTemporarily();
                            jumpToLatest("smooth");
                          } else {
                            restorePinnedUserPrompt("smooth");
                          }
                        }}
                        title={
                          autoPinActive()
                            ? "Response in progress, jump to latest output"
                            : "Return to latest prompt"
                        }
                        aria-label={
                          autoPinActive()
                            ? "Response in progress, jump to latest output"
                            : "Return to latest prompt"
                        }
                      >
                        <SuperClawSpinner size={16} />
                      </button>
                    </div>
                  </Show>
                  <Show when={!isGenerating() && showJumpToLatest()}>
                    <button
                      type="button"
                      data-testid="scroll-to-end"
                      class="pointer-events-auto inline-flex items-center gap-1.5 rounded-pill border border-dls-border bg-dls-surface-solid/95 py-1.5 pl-2.5 pr-3.5 text-body-lg font-medium text-dls-text shadow-[var(--dls-card-shadow)] backdrop-blur-md transition-colors hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent"
                      onClick={() => {
                        suppressJumpControlsTemporarily();
                        jumpToLatest("smooth");
                      }}
                    >
                      <ChevronDown size={14} class="text-dls-secondary" />
                      Scroll to end
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </div>

          <Show when={!showWorkspaceSetupEmptyState()}>
            <QuickAgentChips
              agents={visibleQuickAgents()}
              hidden={sessionReadOnlyReason() === "subagent" || question.state.open()}
              selectedAgent={props.selectedSessionAgent}
              onSelect={selectQuickAgent}
            />
            <Show when={todoCount() > 0}>
              <div class="mx-auto w-full max-w-[800px] px-4">
                <div class="rounded-t-dialog border border-b-0 border-dls-border bg-dls-surface-solid shadow-[var(--dls-card-shadow)]">
                  <button
                    type="button"
                    class="flex w-full items-center justify-between rounded-t-dialog px-4 py-3 text-caption text-dls-muted transition-colors hover:bg-dls-hover/50"
                    onClick={() => setTodoExpanded((prev) => !prev)}
                  >
                    <div class="flex items-center gap-2">
                      <ListTodo size={14} class="text-dls-subtle" />
                      <span class="text-dls-secondary font-medium">
                        {todoLabel()}
                      </span>
                    </div>
                    <Minimize2
                      size={12}
                      class={`text-dls-subtle transition-transform ${todoExpanded() ? "" : "rotate-180"}`}
                    />
                  </button>
                  <Show when={todoExpanded()}>
                    <div class="max-h-40 overflow-y-auto overscroll-contain border-t border-dls-border px-4 pb-3 space-y-2.5">
                      <For each={todoList()}>
                        {(todo, index) => {
                          const done = () => todo.status === "completed";
                          const cancelled = () => todo.status === "cancelled";
                          const active = () => todo.status === "in_progress";
                          return (
                            <div class="flex items-start gap-2.5 pt-2.5 first:pt-2.5">
                              <div class="flex items-center gap-1.5 pt-0.5">
                                <div
                                  class={`h-4.5 w-4.5 rounded-pill border flex items-center justify-center ${
                                    done()
                                      ? "border-dls-success-border bg-dls-success-bg text-dls-success-text"
                                      : active()
                                        ? "border-dls-warning-border bg-dls-warning-bg text-dls-warning-text"
                                        : cancelled()
                                          ? "border-dls-border bg-dls-surface-raised text-dls-subtle"
                                          : "border-dls-border bg-dls-surface-solid text-dls-subtle"
                                  }`}
                                >
                                  <Show when={done()}>
                                    <Check size={10} />
                                  </Show>
                                  <Show when={!done() && active()}>
                                    <span class="h-1.5 w-1.5 rounded-pill bg-dls-warning-dot" />
                                  </Show>
                                </div>
                              </div>
                              <div
                                class={`flex-1 text-body-lg leading-relaxed ${
                                  cancelled()
                                    ? "text-dls-muted line-through"
                                    : "text-dls-text"
                                }`}
                              >
                                <span class="text-dls-muted mr-1.5">
                                  {index() + 1}.
                                </span>
                                {todo.content}
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>
          </Show>
          <QuestionPanel state={question.state} />
          <Composer
            prompt={props.prompt}
            developerMode={props.developerMode}
            busy={props.busy}
            isStreaming={isGenerating()}
            readOnly={sessionReadOnlyReason()}
            compactTopSpacing
            onSend={handleSendPrompt}
            onStop={cancelRun}
            onDraftChange={(draft) => props.setPrompt(draft.resolvedText ?? draft.text)}
            onPrepareSend={(text) => selectMentionedAgent(text, {
              roster: agentPicker.roster(), selectedAgent: props.selectedSessionAgent, hasSession: Boolean(props.selectedSessionId), pickAgent,
            })}
            questionMode={question.composerMode()}
            selectedModelLabel={props.selectedSessionModelLabel || "Model"}
            selectedModel={props.selectedModel}
            selectedModelIsLocal={props.selectedSessionModelIsLocal}
            modelOptions={props.modelOptions}
            onSelectModel={props.applySessionModelSelection}
            onManageModels={() => props.openSessionModelPicker()}
            agentLabel={agentLabel()}
            selectedAgent={props.selectedSessionAgent}
            agentPickerOpen={agentPickerOpen()}
            agentPickerBusy={agentPickerBusy()}
            agentPickerReady={agentPickerReady()}
            agentPickerError={agentPickerError()}
            agentOptions={agentOptions()}
            agentDisplayNames={agentDisplayNames()}
            onToggleAgentPicker={openAgentPicker}
            onRetryAgentLoad={() => void loadAgentOptions(true)}
            onSelectAgent={(agent) => {
              pickAgent(agent);
              setAgentPickerOpen(false);
            }}
            setAgentPickerRef={(el) => {
              agentPickerRef = el;
            }}
            toast={toastMessage()}
            onToast={(message) => setToastMessage(message)}
            onDismissToast={() => setToastMessage(null)}
            loadAgentOptions={loadAgentOptions}
            recentFiles={toWorkspaceMentionPaths(props.workingFiles, props.activeWorkspaceRoot)}
            searchFiles={props.searchFiles}
            listCommands={props.listCommands}
            commandsVersion={props.commandsVersion}
            agentsVersion={props.agentsVersion}
            isRemoteWorkspace={props.activeWorkspaceDisplay.workspaceType === "remote"}
            isSandboxWorkspace={isSandboxWorkspace()}
            workspaceRoot={props.activeWorkspaceRoot}
            imageThumbnail={localFiles.imageThumbnail}
            onUploadInboxFiles={uploadInboxFiles}
            attachmentsEnabled={attachmentsEnabled()}
            attachmentsDisabledReason={attachmentsDisabledReason()}
            gmailConnectionStatus={gmailAuth.connectionStatus()}
            ensureGmailCredentials={gmailAuth.refreshConnectionStatus}
            selectedSessionId={props.selectedSessionId}
            confirmEmailAgentCloudRisk={confirmSelectedEmailAgentCloudRisk}
            onGmailStatusClick={() => gmailAuth.setStatusModalOpen(true)}
            ttsNarration={props.ttsNarration}
            ttsAvailable={props.ttsAvailable}
            ttsSpeaking={props.ttsSpeaking}
            toggleTtsNarration={props.toggleTtsNarration}
            voiceInput={props.voiceInput}
            onOpenVoiceSettings={() => openSettings("voice")}
          />

          <StatusBar
            clientConnected={props.clientConnected}
            openworkServerStatus={props.openworkServerStatus}
            developerMode={props.developerMode}
            onSendFeedback={openFeedback}
            onOpenMessaging={openConfig}
            onOpenProviders={openProviderAuth}
            onOpenMcp={openMcp}
            providerConnectedIds={props.providerConnectedIds}
            mcpStatuses={props.mcpStatuses}
            statusLabel={
              props.clientConnected
                ? showRunIndicator()
                  ? "Session Active"
                  : props.selectedSessionId
                    ? "Session Ready"
                    : "Session Idle"
                : undefined
            }
            statusDetail={
              props.clientConnected
                ? showRunIndicator()
                  ? `${props.activeWorkspaceDisplay.name} is running`
                  : props.selectedSessionId
                    ? undefined
                    : "Choose a worker to begin"
                : undefined
            }
            statusDotClass={
              props.clientConnected
                ? showRunIndicator()
                  ? "bg-dls-success-dot"
                  : props.selectedSessionId
                    ? "bg-dls-success-dot"
                    : "bg-dls-panel-dot"
                : undefined
            }
            statusPingClass={
              props.clientConnected
                ? showRunIndicator()
                  ? "bg-dls-success-dot/45 animate-ping"
                  : "bg-dls-success-dot/35"
                : undefined
            }
            statusPulse={props.clientConnected ? showRunIndicator() : undefined}
          />
          <FeedbackModal
            open={feedbackModalOpen()}
            appVersion={props.versionLabel()}
            onClose={() => setFeedbackModalOpen(false)}
          />
        </main>

        <Show when={rightSidebarExpanded()}>
          <div
            class="group/rightsidebar relative flex shrink-0"
            style={{
              width: `${rightSidebarWidth()}px`,
              "min-width": `${rightSidebarWidth()}px`,
            }}
          >
          <aside class="relative flex w-full flex-col overflow-hidden rounded-shell border border-dls-border bg-dls-sidebar p-3">
            <div class="flex-1 overflow-y-auto space-y-5 pt-1">
                {/* <div class="rounded-dialog border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)]">
                <InboxPanel
                  id="sidebar-inbox"
                  client={props.openworkServerClient}
                  workspaceId={props.openworkServerWorkspaceId}
                  onToast={(message) => setToastMessage(message)}
                  onRagSelectionChange={(paths) => {
                    const client = props.openworkServerClient;
                    const wid = props.openworkServerWorkspaceId?.trim();
                    if (client?.setRagContext && wid) {
                      void client.setRagContext(wid, paths).catch(() => undefined);
                    }
                  }}
                />
              </div> */}
                {/* PII Shield indicator */}
                <Show when={piiStats().total > 0}>
                  <div class="rounded-dialog border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)] mt-3 first:mt-0">
                    <div class="flex items-center gap-2 mb-2">
                      <span class="text-caption font-semibold text-dls-text">
                        PII Protected in Current Session
                      </span>
                    </div>
                    <div class="flex items-center justify-between rounded-inset bg-dls-panel-hover-bg px-2.5 py-2 text-label">
                      <span class="text-dls-secondary">Total Protected</span>
                      <span class="font-semibold text-dls-success-text">
                        {piiStats().total}
                      </span>
                    </div>
                  </div>
                </Show>

                {/* FileUploadPanel hidden — feature retained but not rendered in current version */}
                {/* <div class="rounded-dialog border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)] mt-3">
                <FileUploadPanel
                  id="sidebar-file-upload"
                  client={props.openworkServerClient}
                  workspaceId={props.openworkServerWorkspaceId}
                  onToast={(message) => setToastMessage(message)}
                  onFileSelectionChange={(selection) => {
                    const client = props.openworkServerClient;
                    const wid = props.openworkServerWorkspaceId?.trim();
                    if (!client?.setRagContext || !wid) return;
                    const sessionId = props.selectedSessionId ?? "";
                    if (selection.type === "rag") {
                      // For RAG files, store target URIs so the RAG plugin
                      // knows which documents to query against.
                      void client.setRagContext(wid, selection.files, sessionId).catch(() => undefined);
                    }
                    // Regular file selection does NOT update rag-context.json.
                    // It was previously overwriting the RAG doc_ids with empty
                    // inbox paths when switchTab cleared the regular selection.
                  }}
                />
              </div> */}

                <div
                  data-test-id="workspace-files-panel"
                  data-tour-id="workspace-files-panel"
                  class="rounded-dialog border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)] mt-3 first:mt-0"
                >
                  <WorkspaceFilesPanel
                    client={props.openworkServerClient}
                    workspaceId={props.openworkServerWorkspaceId}
                    sessionId={props.selectedSessionId}
                    onToast={(message) => setToastMessage(message)}
                    refreshVersion={inboxVersion()}
                    onOpenInFileExplorer={(path, kind) => {
                      void openWorkspaceItemInExplorer(path, kind);
                    }}
                    onPreview={filePreview.previewWorkspaceFile}
                    onFilesDeleted={(deletedPaths) => {
                      // Remove deleted files from the artifacts panel immediately
                      if (deletedPaths.length > 0) {
                        const normalizedDeleted = deletedPaths.map((p) =>
                          p
                            .trim()
                            .replace(/[\\/]+/g, "/")
                            .toLowerCase(),
                        );
                        // Persist to localStorage so deletions survive app restart
                        // and prevent cross-session file leakage
                        const sid = props.selectedSessionId;
                        if (sid) {
                          addSessionDeletions(
                            sid,
                            normalizedDeleted,
                            props.artifacts,
                          );
                        }
                        setVerifiedFiles((prev) =>
                          prev.filter((file) => {
                            const key = file.toLowerCase();
                            return !normalizedDeleted.some(
                              (d) => key === d || key.startsWith(d + "/"),
                            );
                          }),
                        );
                      }
                      // Remove matching inbox markdown links from the composer
                      const current = props.prompt ?? "";
                      if (!current) return;
                      const cleaned = deletedPaths
                        .reduce((text, p) => {
                          const inboxPath = `/workspace/${p}`;
                          const escaped = inboxPath.replace(
                            /[.*+?^${}()|[\]\\]/g,
                            "\\$&",
                          );
                          // Match markdown links: [name](inboxPath)
                          const re = new RegExp(
                            `\\[([^\\]]*)\\]\\(${escaped}\\)\\n?`,
                            "g",
                          );
                          return text.replace(re, "");
                        }, current)
                        .replace(/\n{2,}$/g, "\n")
                        .trimEnd();
                      if (cleaned !== current) {
                        props.setPrompt(cleaned);
                      }
                    }}
                    onSelectionChange={(paths) =>
                      setWorkspaceSelectedFiles(paths)
                    }
                    onSelectionFileCountChange={
                      setWorkspaceSelectedLeafFileCount
                    }
                    onSelectionLeafFilesChange={setWorkspaceSelectedLeafFiles}
                    selectedPaths={workspaceSelectedFiles()}
                  />
                </div>

                <Show when={verifiedFiles().length > 0}>
                  <div class="rounded-dialog border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)] mt-3">
                    <ArtifactsPanel
                      id="sidebar-artifacts"
                      files={verifiedFiles()}
                      workspaceRoot={props.activeWorkspaceRoot}
                      obsidianAvailable={obsidianAvailable()}
                      onRevealArtifact={revealArtifact}
                      onOpenInObsidian={openArtifactInObsidian}
                      onPreview={filePreview.previewFile}
                    />
                  </div>
                </Show>
            </div>
          </aside>
          <Show when={rightSidebarVisible()}>
            <div
              class="group absolute left-0 top-6 z-10 hidden h-[calc(100%-48px)] w-4 -translate-x-1/2 cursor-col-resize items-center justify-center rounded-pill transition-colors hover:bg-dls-hover/70 active:bg-dls-hover lg:flex"
              onPointerDown={startRightSidebarResize}
              aria-label="Resize details column"
            >
              <div class="relative h-full w-0.5 rounded-pill bg-dls-border/50 transition-colors duration-150 group-hover:bg-dls-status-neutral-dot">
                <div class="absolute left-1/2 top-1/2 h-24 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-dls-status-neutral-dot transition-colors duration-150 group-hover:bg-dls-muted group-active:bg-dls-neutral-active" />
              </div>
              <div class="pointer-events-none absolute left-4 top-1/2 hidden -translate-y-1/2 whitespace-nowrap rounded-control border border-dls-border bg-dls-surface-solid px-2 py-1 text-label text-dls-secondary shadow-[var(--dls-card-shadow)] group-hover:block">
                Drag to resize
              </div>
            </div>
          </Show>
          </div>
        </Show>
      </div>

      <Show when={commandPaletteOpen()}>
        <div
          class="fixed inset-0 z-50 dls-modal-backdrop flex items-start justify-center p-4 overflow-y-auto"
          onClick={closeCommandPalette}
        >
          <div
            class="w-full max-w-2xl mt-12 overflow-hidden border dls-modal-surface"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="border-b border-dls-border px-4 py-3 space-y-2">
              <div class="flex items-center gap-2">
                <Show when={commandPaletteMode() !== "root"}>
                  <button
                    type="button"
                    class="h-8 px-2 rounded-control text-caption text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                    onClick={returnToCommandRoot}
                  >
                    Back
                  </button>
                </Show>
                <Search size={14} class="text-dls-secondary shrink-0" />
                <input
                  ref={(el) => (commandPaletteInputEl = el)}
                  type="text"
                  value={commandPaletteQuery()}
                  onInput={(event) =>
                    setCommandPaletteQuery(event.currentTarget.value)
                  }
                  placeholder={commandPalettePlaceholder()}
                  class="min-w-0 flex-1 bg-transparent text-body-lg text-dls-text placeholder:text-dls-secondary focus:outline-none"
                  aria-label={commandPaletteTitle()}
                />
                <button
                  type="button"
                  class="h-8 w-8 flex items-center justify-center rounded-control text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                  onClick={closeCommandPalette}
                  aria-label="Close quick actions"
                >
                  <X size={14} />
                </button>
              </div>
              <div class="text-label text-dls-secondary">
                {commandPaletteTitle()}
              </div>
            </div>

            <div class="max-h-[56vh] overflow-y-auto p-2">
              <Show
                when={commandPaletteItems().length > 0}
                fallback={
                  <div class="px-3 py-6 text-body-lg text-dls-secondary text-center">
                    No matches.
                  </div>
                }
              >
                <For each={commandPaletteItems()}>
                  {(item, index) => {
                    const idx = () => index();
                    return (
                      <button
                        ref={(el) => {
                          commandPaletteOptionRefs[idx()] = el;
                        }}
                        type="button"
                        class={`w-full text-left rounded-inset px-3 py-2.5 transition-colors ${
                          idx() === commandPaletteActiveIndex()
                            ? "bg-dls-active text-dls-text"
                            : "text-dls-text hover:bg-dls-hover"
                        }`}
                        onMouseEnter={() => setCommandPaletteActiveIndex(idx())}
                        onClick={item.action}
                      >
                        <div class="flex items-start justify-between gap-3">
                          <div class="min-w-0">
                            <div class="text-body-lg font-medium truncate">
                              {item.title}
                            </div>
                            <Show when={item.detail}>
                              <div class="text-caption text-dls-secondary mt-1 truncate">
                                {item.detail}
                              </div>
                            </Show>
                          </div>
                          <Show when={item.meta}>
                            <span class="text-tiny uppercase tracking-wide text-dls-secondary shrink-0">
                              {item.meta}
                            </span>
                          </Show>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </div>

            <div class="border-t border-dls-border px-3 py-2 text-label text-dls-secondary flex items-center justify-between gap-2">
              <span>Arrow keys to navigate</span>
              <span>Enter to run · Esc to close</span>
            </div>
          </div>
        </div>
      </Show>

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

      <RenameSessionModal
        open={renameModalOpen()}
        title={renameTitle()}
        busy={renameBusy()}
        canSave={renameCanSave()}
        onClose={closeRenameModal}
        onSave={submitRename}
        onTitleChange={setRenameTitle}
      />

      <ConfirmModal
        open={deleteSessionOpen()}
        title={`${t("session.delete_title")}?`}
        data-testid="delete-session-confirm-btn"
        message={
          sessionTitleForId(deleteSessionId()).trim()
            ? `${t("session.delete_confirm_prefix")}${localizeSessionTitle(sessionTitleForId(deleteSessionId()).trim())}${t("session.delete_confirm_suffix")}`
            : t("session.delete_session_message_generic")
        }
        confirmLabel={
          deleteSessionBusy() ? t("common.deleting") : t("common.delete")
        }
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={confirmDeleteSession}
        onCancel={closeDeleteSessionModal}
      />

      <ConfirmModal
        open={cloudModelWarningOpen()}
        title={(() => {
          const reason = cloudModelWarningReason();
          const alias = selectedRouterAlias();
          if (reason === "check_failed")
            return t("session.model_check_failed_title");
          if (reason === "both_not_configured")
            return t("session.auto_route_requires_both_title");
          if (reason === "local_not_configured")
            return alias === "auto"
              ? t("session.auto_route_requires_local_title")
              : t("session.local_model_not_configured_title");
          if (reason === "local_unhealthy")
            return t("session.local_model_unavailable_title");
          if (reason === "cloud_not_configured")
            return alias === "auto"
              ? t("session.auto_route_requires_cloud_title")
              : t("session.cloud_model_not_configured_title");
          return t("session.cloud_model_unavailable_title");
        })()}
        message={(() => {
          const reason = cloudModelWarningReason();
          const alias = selectedRouterAlias();
          const base = (() => {
            if (reason === "check_failed")
              return t("session.model_check_failed_message");
            if (reason === "both_not_configured")
              return t("session.auto_route_both_intro");
            if (reason === "local_not_configured")
              return alias === "auto"
                ? t("session.auto_route_local_intro")
                : t("session.local_model_not_configured_message");
            if (reason === "local_unhealthy")
              return t("session.local_model_unavailable_message");
            if (reason === "cloud_not_configured")
              return alias === "auto"
                ? t("session.auto_route_intro")
                : t("session.cloud_model_not_configured_message");
            return t("session.cloud_model_unavailable_message");
          })();
          const diag = autoRouterDiagnostics();
          return (
            <div class="space-y-3">
              <p>{base}</p>
              {diag ? (
                // Collapsed by default
                <details
                  class="group"
                  open={diagnosticsExpanded()}
                  onToggle={(e) => setDiagnosticsExpanded(e.currentTarget.open)}
                >
                  <summary class="text-caption font-semibold opacity-70 cursor-pointer select-none list-none flex items-center gap-1.5">
                    <span class="inline-block transition-transform group-open:rotate-90">
                      ▸
                    </span>
                    Diagnostics (model health probe)
                  </summary>
                  <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-compact bg-black/30 p-2 font-mono text-label leading-snug">
                    {diag}
                  </pre>
                </details>
              ) : null}
            </div>
          );
        })()}
        // check_failed is a transient connectivity blip, not a misconfigured
        // model: the message tells the user to retry sending, so the primary
        // action just dismisses (letting them re-send) and "Go to Settings"
        // is demoted to the secondary slot. Every other reason is a genuine
        // configuration problem where Settings is the right primary action.
        confirmLabel={
          cloudModelWarningReason() === "check_failed"
            ? t("common.close")
            : t("session.go_to_settings")
        }
        cancelLabel={
          cloudModelWarningReason() === "check_failed"
            ? t("session.go_to_settings")
            : t("common.cancel")
        }
        variant="warning"
        size="lg"
        onConfirm={() => {
          const reason = cloudModelWarningReason();
          setCloudModelWarningOpen(false);
          if (reason !== "check_failed") openSettings("model");
        }}
        onCancel={() => {
          const reason = cloudModelWarningReason();
          setCloudModelWarningOpen(false);
          if (reason === "check_failed") openSettings("model");
        }}
      />

      <ConfirmModal
        open={defaultAgentTavilyWarningOpen()}
        title={t("session.web_search_limited_title")}
        data-testid="tavily-warning-close-btn"
        message={
          <div class="space-y-3">
            <Show
              when={tavilySessionWarning(props.tavilyKeyView) === "unreadable"}
              fallback={
                <>
                  <p>{t("session.default_agent_tavily_note")}</p>
                  <p>{t("session.default_agent_tavily_reminder")}</p>
                </>
              }
            >
              <p>{t("session.default_agent_tavily_unreadable")}</p>
              <p>{t("session.default_agent_tavily_unreadable_hint")}</p>
            </Show>
          </div>
        }
        confirmLabel={t("common.close")}
        variant="warning"
        size="lg"
        hideIcon={true}
        onConfirm={confirmDefaultAgentTavilyWarning}
      />

      <ConfirmModal
        open={hybridDeepResearchFileLimitOpen()}
        title="Too Many Files Selected"
        data-testid="hybrid-dr-file-limit-close-btn"
        message="Hybrid Deep Research currently supports 0-5 selected leaf files. Deselect files or choose a smaller folder before starting."
        confirmLabel={t("common.close")}
        variant="warning"
        size="lg"
        hideIcon={true}
        onConfirm={() => setHybridDeepResearchFileLimitOpen(false)}
      />

      {/* Gmail credentials missing — block send and redirect to settings */}
      <ConfirmModal
        open={gmailAuth.statusModalOpen()}
        title="Gmail Credentials Not Configured"
        message={
          <>
            <p>
              The email agent requires Google OAuth credentials to function.
              Please upload your credentials.json file in Advanced &gt; Connections
              &gt; Gmail Credentials.
            </p>
            <p class="mt-3">
              Refer to{" "}
              <span
                class="text-dls-link underline hover:text-dls-link-hover cursor-pointer"
                onClick={() =>
                  platform.openLink(
                    "https://developers.google.com/workspace/guides/create-credentials",
                  )
                }
              >
                Google Workspace Developer Guide
              </span>{" "}
              to create one.
            </p>
          </>
        }
        confirmLabel="Go to Settings"
        cancelLabel="Cancel"
        variant="warning"
        size="lg"
        onConfirm={() => {
          gmailAuth.setStatusModalOpen(false);
          openSettings("identities");
        }}
        onCancel={() => gmailAuth.setStatusModalOpen(false)}
      />

      <ShareWorkspaceModal
        open={Boolean(shareWorkspaceId())}
        onClose={() => setShareWorkspaceId(null)}
        workspaceName={sharePublish.workspaceName()}
        workspaceDetail={sharePublish.workspaceDetail()}
        fields={sharePublish.fields()}
        note={sharePublish.note()}
        publisherBaseUrl={DEFAULT_OPENWORK_PUBLISHER_BASE_URL}
        onShareWorkspaceProfile={sharePublish.publishWorkspaceProfileLink}
        shareWorkspaceProfileBusy={sharePublish.workspaceProfileBusy()}
        shareWorkspaceProfileUrl={sharePublish.workspaceProfileUrl()}
        shareWorkspaceProfileError={sharePublish.workspaceProfileError()}
        shareWorkspaceProfileDisabledReason={sharePublish.serviceDisabledReason()}
        onShareSkillsSet={sharePublish.publishSkillsSetLink}
        onOpenSingleSkillShare={() => {
          setShareWorkspaceId(null);
          openSettings("skills");
        }}
        shareSkillsSetBusy={sharePublish.skillsSetBusy()}
        shareSkillsSetUrl={sharePublish.skillsSetUrl()}
        shareSkillsSetError={sharePublish.skillsSetError()}
        shareSkillsSetDisabledReason={sharePublish.serviceDisabledReason()}
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

      <Show
        when={
          props.activePermission?.permission === "review_masked_entities" &&
          selectedSessionMetadataResolved() &&
          !selectedSessionLoading()
        }
      >
        <Show when={props.activePermission?.id} keyed>
          {(_permissionId: string) => (
            <MaskedEntityReviewDialog
              client={props.openworkServerClient}
              workspaceId={props.openworkServerWorkspaceId}
              operations={parseReviewOperations(props.activePermission?.metadata)}
              busy={props.permissionReplyBusy}
              onContinue={() =>
                props.activePermission &&
                props.respondPermission(props.activePermission.id, "once")
              }
              onCancel={() =>
                props.activePermission &&
                props.respondPermission(props.activePermission.id, "reject")
              }
            />
          )}
        </Show>
      </Show>

      <Show
        when={
          props.activePermission?.permission !== "review_masked_entities" &&
          selectedSessionMetadataResolved() &&
          !selectedSessionLoading() &&
          props.activePermission
        }
      >
        {(permission) => (
          <PermissionApprovalDialog
            permission={permission()}
            busy={props.permissionReplyBusy}
            respond={props.respondPermission}
            respondAndRemember={props.respondPermissionAndRemember}
            safeStringify={props.safeStringify}
          />
        )}
      </Show>

      <FilePreviewModal {...filePreview.modalProps()} />

      <For each={flyouts()}>{(item) => <FlyoutItem item={item} />}</For>
    </div>
  );
}
