 import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
  Suspense,
  untrack,
} from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { useCapabilityStartupPreflight } from "./capability/use-capability-startup-preflight";
import { useOpenworkRuntimeSettings } from "~/features/openwork-runtime-settings";
import { useOpenworkConnection } from "~/features/openwork-connection";
import { tavilyKeyView, useTavilyApiKey } from "../features/tavily-api-key";
import { useEgressFeatures } from "../features/egress-approvals";
import { HostMcpApprovalDialog, HostMcpProvider, useHostMcp } from "~/features/host-mcp";
import { useInstanceApiClient } from "~/shared/platform/transport/instance-api";
import { useHostMcpApiClient } from "~/shared/platform/transport/host-mcp-api";
import { openLocalReadGrant } from "~/shared/platform/transport/servicehub";
import {
  formatConfigWithDefaultModel,
  getConfigSnapshot,
  parseDefaultModelFromConfig,
} from "./lib/workspace-model-config";
import {
  allowedSessionRouteAliases, normalizeSessionRouteForProfile,
} from "~/shared/platform/capability/session-route-policy";
import HardwareRequirementsDialog from "./components/hardware-requirements-dialog";
import TtsDownloadConfirmDialog from "./components/tts-download-confirm-dialog";
import { usePlatform } from "./context/platform";
import {
  useBackendBootOverlay,
  useRuntimeBoot,
  useRuntimeBootLifecycle,
} from "~/features/runtime";
import { useProviderAuth } from "~/features/providers";
import { McpAuthModal, useMcpServers } from "~/features/mcp";
import { createModelRoutingFeature } from "~/features/model-routing";

import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import ModelPickerModal from "./components/model-picker-modal";
import { setPendingModelSection } from "./pages/settings.model-section";
import WorkspaceSwitchOverlay from "./components/workspace-switch-overlay";
import CreateRemoteWorkspaceModal from "./components/create-remote-workspace-modal";
import CreateWorkspaceModal from "./components/create-workspace-modal";
import SharedSkillDestinationModal from "./components/shared-skill-destination-modal";
import SharedBundleImportModal from "./components/shared-bundle-import-modal";
import RenameWorkspaceModal from "./components/rename-workspace-modal";
import ConfirmModal from "./components/confirm-modal";
import EgressApprovalDialog from "./components/egress-approval-dialog";
import StatusToast from "./components/status-toast";
import BackendBootOverlay from "./components/backend-boot-overlay";
import {
  capabilityStartupHandled,
  startupActivationGrace,
  startupOwtToken,
} from "~/shared/platform/capability/capability-startup-signal";
import UiTour, { isTourDone } from "./components/ui-tour";
import DownloadConsentModal, {
  type ModelInfo,
} from "./components/download-consent-modal";
import EdgeServerStartupGate from "./components/edge-server-startup-gate";
import type { ProviderOAuthStartResult } from "./components/provider-auth-modal";
import OnboardingView from "./pages/onboarding";
import { AppErrorBoundary } from "./components/app-error-boundary";
import { SuperClawSpinner } from "./components/superclaw-spinner";
import SessionPage from "./pages/session-page";

// Code-split the views that are not on the startup path. Each becomes its own
// chunk instead of sitting in the main bundle: the proto pages are reachable
// only via the internal 'proto' view, and the dashboard is gated behind
// dashboardMounted(). SessionView and OnboardingView stay eager on purpose -
// session is the primary surface and onboarding gates first run.
/**
 * Lazy-chunk fallback. Not `null`: the dashboard chunk carries DataUsage, and
 * the wrapper is `display: contents`, so `null` blanks the whole window.
 * `100dvh` because nothing between here and `#root` sets a height, so `h-full`
 * would collapse to `auto`; it also matches what dashboard/session open with.
 */
const LazyViewFallback = () => (
  <div class="flex h-[100dvh] w-full items-center justify-center">
    <SuperClawSpinner size={28} />
  </div>
);

const DashboardView = lazy(() => import("./pages/dashboard"));
// Settings and the pages it hosts are preloaded once the backend is up (see
// the preload effect below); it draws over the current view, so it needs no
// fallback.
const SettingsDialog = lazy(() => import("./pages/settings-dialog"));
const ProtoWorkspacesView = lazy(() => import("./pages/proto-workspaces"));
const ProtoV1UxView = lazy(() => import("./pages/proto-v1-ux"));
import {
  isLocalModelAvailable,
  type LocalModelHealthInfo,
} from "./lib/local-model-availability";
import { formatLlmRouterSessionModelLabel } from "~/shared/util/llmrouter-session-model-label";
import { INTERNAL_PROVIDER_PREFIXES } from "~/shared/util/model-ref";
import { loadLocalModelHealth } from "./lib/local-model-control-plane";
import { listedWorkspaceFiles, mergeFileSearchResults } from "./lib/workspace-file-search";
import { unwrap } from "./lib/opencode";
import {
  createDenClient,
  writeDenSettings,
} from "./lib/den";
import { clearPerfLogs } from "./lib/perf-log";
import {
  setUiBootId,
  uiLogDebug,
  uiLogInfo,
  uiLogWarn,
  uiLogError,
} from "./lib/log";
import {
  AUTO_COMPACT_CONTEXT_PREF_KEY,
  DEFAULT_MODEL,
  HIDE_TITLEBAR_PREF_KEY,
  MODEL_PREF_KEY,
  PII_LEVEL_PREF_KEY,
  SUGGESTED_PLUGINS,
  THINKING_PREF_KEY,
  VARIANT_PREF_KEY,
} from "./constants";
import { isLocalProvider } from "~/shared/util/providers";
import {
  formatModelVariantLabel,
  normalizeModelVariant,
} from "./utils/model-variant";
import { type PiiLevel } from "./types";
import type {
  Client,
  DashboardTab,
  StartupPreference,
  EngineRuntime,
  ModelOption,
  ModelRef,
  OnboardingStep,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
  PromptFocusReturnTarget,
  View,
  ProviderListItem,
  OpencodeConnectStatus,
  WorkspacePreset,
} from "./types";
import {
  FALLBACK_MODEL,
  isLlmRouterSessionModel,
} from "./app.llmrouter-models";
import { createPiiCategories } from "./app.pii-categories";
import { toGlobalProviderList } from "./app.provider-list";
import { createSessionTurns } from "./app.session-turns";
import { createSkillCreatorWatch } from "./app.skill-creator-watch";
import { refreshWrittenReloadTarget } from "./app.reload-target-refresh";
import { watchTauriDeepLinks } from "./app.deep-links";
import { createTelemetryConsent } from "./app.telemetry-consent";
import {
  buildModelOptions,
  filterModelOptions,
  routeAwayFromHiddenCloud,
} from "./app.model-picker";
import { createCloudOnlyRouteRewrite, createHiddenCloudRoute } from "./app.stored-route-rewrites";
import { composerBusyForSelection, createAppBusy } from "./app-busy";
import { createPromptDispatch, type AmbiguousPromptEntry } from "./app.prompt-dispatch";
import { createSessionRunControls } from "./app.session-run-controls";
import { createSessionCreator } from "./app.create-session";
import { createSessionAgentSelection } from "./app.session-agent";
import { replyRecordingFileProtectionDecline } from "./app.file-protection-decline";
import { createNativeBackendRecovery } from "./native-backend-recovery";
import {
  forgetPreference,
  persistToLocalStorage,
} from "~/shared/platform/persist-to-local-storage";
import { readStoredPreferences } from "./utils/read-stored-preferences";
import {
  deriveArtifacts,
  deriveWorkingFiles,
  formatBytes,
  formatModelLabel,
  formatModelRef,
  groupMessageParts,
  isTauriRuntime,
  modelEquals,
  normalizeDirectoryPath,
  isWindowsPlatform,
  lastUserModelFromMessages,
  parseModelRef,
  readStartupPreference,
  safeStringify,
  summarizeStep,
  addOpencodeCacheHint,
} from "./utils";
import { computeDashboardAccess } from "./dashboard-access";
import { isSettingsTab } from "./dashboard-focus";
import type { SettingsSection } from "./pages/settings-dialog.sections";
import {
  elapsedSeconds,
  isNewTaskDisabled,
  isWorkspaceSwitchOpen,
  resolveBusyHint,
  resolveHeaderStatus,
  resolveHeaderVersion,
  resolveLocalHostLabel,
  resolveWorkspaceSwitchStatusKey,
} from "./app.shell-status";
import {
  buildSharedBundleWorkerOptions,
  describeSharedBundleImport,
  describeWorkspaceForToasts,
  findSharedBundleImportWorkspaceId,
  resolveSharedBundleImportTargetForWorkspace,
  resolveSharedBundleWorkerTarget,
  sortSharedSkillDestinations,
  type SharedBundleCreateWorkerRequest,
  type SharedBundleImportChoice,
  type SharedSkillDestinationRequest,
  type SharedSkillSuccessToast,
} from "./app.shared-bundle";
import { createSharedBundleActions } from "./app.shared-bundle-actions";
import {
  checkOpenworkServer,
  createOpenworkConnectionActions,
} from "./app.openwork-connection";
import { createAgentManagedModel } from "./app.agent-managed-model";
import { createAppPrefs } from "./app.app-prefs";
import { resolveEffectiveSessionModel } from "./app.effective-session-model";
import { createModelPickerActions } from "./app.model-picker-actions";
import { createSessionCrud } from "./app.session-crud";
import {
  parseSessionModelOverrides,
  serializeSessionModelOverrides,
  sessionModelOverridesKey,
} from "./app.session-model-overrides";
import { currentLocale, setLocale, t } from "../i18n";
import {
  applyThemeMode,
  getInitialThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "./theme";
import { createSystemState } from "./system-state";
import {
  createAppUpdaterVersionSignals,
  installAppUpdaterRuntime,
  restoreUpdaterLocalStoragePrefs,
  runTauriUpdaterStartup,
} from "./context/app-updater-lifecycle";
import { createInAppUpdateBindings } from "./lib/in-app-update-bindings";
import { installFrontendCrashHandlers } from "./lib/telemetry";
import { createSessionStore } from "~/features/session";
import { createWorkspaceSidebarFeature } from "~/features/workspace-sidebar";
import { useScheduler } from "~/features/scheduler";
import { useVersionInfo } from "~/features/version-info";
import { useServer } from "./context/server";

// Providers visible in Settings page (user can configure API keys).
// Uses prefix matching so variants (e.g. minimax-cn, alibaba-coding-plan) are included.
const SETTINGS_PROVIDER_PREFIXES = [
  "deepseek",
  "ovms",
  "openai",
  "anthropic",
  "google",
  "xai",
  "mistral",
  "perplexity",
  "zhipuai",
  "zai",
  "minimax",
  "alibaba",
  "tencent",
  "xiaomi",
  "openrouter",
];
const matchesPrefix = (id: string, prefixes: string[]) =>
  prefixes.some((prefix) => id === prefix || id.startsWith(prefix + "-"));
const isAllowedProvider = (id: string) =>
  matchesPrefix(id, SETTINGS_PROVIDER_PREFIXES) ||
  matchesPrefix(id, INTERNAL_PROVIDER_PREFIXES);
import { createExtensionsStore } from "./context/extensions";
import { useGlobalSync } from "./context/global-sync";
import {
  createWorkspaceStore, nextOpenworkServerSettingsForWorkspace,
} from "./context/workspace";
import {
  readOpencodeConfig,
  writeOpencodeConfig,
  schedulerDeleteJob,
  schedulerListJobs,
  setWindowDecorations,
  getServiceHubBootSnapshot,
  retryServiceHubBoot,
  stopServiceHub,
  getWorkspaceCleanupStatus,
  getWorkspaceCleanupSettings,
  type OpenworkServerInfo,
} from "./lib/tauri";
import {
  FONT_ZOOM_STEP,
  applyWebviewZoom,
  applyFontZoom,
  normalizeFontZoom,
  parseFontZoomShortcut,
  persistFontZoom,
  readStoredFontZoom,
} from "./lib/font-zoom";
import {
  createLlmRouterClient,
  loadLlmRouterProviderOptions,
  type LlmRouterProviderOption,
} from "./lib/llmrouter-client";
import {
  parseOpenworkWorkspaceIdFromUrl,
  readOpenworkBundleInviteFromSearch,
  readOpenworkConnectInviteFromSearch,
  stripOpenworkBundleInviteFromUrl,
  stripOpenworkConnectInviteFromUrl,
  DEFAULT_OPENWORK_SERVER_PORT,
  hydrateOpenworkServerSettingsFromEnv,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
  type OpenworkServerCapabilities,
  type OpenworkServerDiagnostics,
  type OpenworkServerStatus,
  type OpenworkServerSettings,
  OWT_EXPIRED_EVENT,
} from "./lib/openwork-server";
import {
  getBackendRetryPolicy,
  getRecoverableBootSnapshot,
} from "./backend-boot-policy";
import {
} from "./telemetry-consent-policy";
import { fetchOwtToken } from "./lib/servicehub";
import { useTtsNarration } from "~/features/tts";
import { useVoiceInput } from "~/features/voice-input";
import VoiceDownloadConfirmDialog from "./components/voice-download-confirm-dialog";
import { beginIntentSessionDisplayHydration } from "./lib/intent-session-display-hydrate";
import {
  refreshManagedWorkspaceToken,
} from "~/shared/platform/transport/managed-workspace-token-refresh";

import {
  createSharedBundleImportFlow,
  normalizeSharedBundleImportIntent,
  parseDenAuthDeepLink,
  parseRemoteConnectDeepLink,
  parseSharedBundleDeepLink,
  stripRemoteConnectQuery,
  stripSharedBundleQuery,
  type DenAuthDeepLink,
  type RemoteWorkspaceDefaults,
  type SharedBundleDeepLink,
  type SharedBundleImportTarget,
} from "~/features/workspace-import";

const AGENTS_FORCE_LOCAL_MODEL = new Set([
  "email-agent",
]);

export default function App() {
  const server = useServer();

  const envOpenworkWorkspaceId =
    typeof import.meta.env?.VITE_OPENWORK_WORKSPACE_ID === "string"
      ? import.meta.env.VITE_OPENWORK_WORKSPACE_ID.trim() || null
      : null;

  // Workspace switch tracing is noisy, so only emit in developer mode.
  // (OpenWork already has a developer mode toggle in Settings.)
  const wsDebugEnabled = () => developerMode();

  const wsDebug = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
    } catch {
      // ignore
    }
  };
  const location = useLocation();
  const navigate = useNavigate();

  const [creatingSession, setCreatingSession] = createSignal(false);
  const [sessionViewLockUntil] = createSignal(0);
  const [tourVisible, setTourVisible] = createSignal(false);
  // Session-level flag: user dismissed via X/Esc this session but hasn't finished the tour.
  // Prevents auto-start from re-triggering within the same session without persisting to localStorage.
  const [tourDismissedThisSession, setTourDismissedThisSession] =
    createSignal(false);
  function sessionRuntimeReadyForTour() {
    return (
      backendBootReady() &&
      openworkServerStatus() === "connected" &&
      Boolean(openworkServerWorkspaceId()) &&
      Boolean(client())
    );
  }
  const currentView = createMemo<View>(() => {
    const path = location.pathname.toLowerCase();
    if (path.startsWith("/onboarding")) return "onboarding";
    if (path.startsWith("/session")) return "session";
    if (path.startsWith("/proto")) return "proto";
    return "dashboard";
  });
  const isProtoV1Ux = createMemo(() =>
    location.pathname.toLowerCase().startsWith("/proto-v1-ux"),
  );

  // Auto-start tour on first session view for new users, but only when
  // the remote worker onboarding modal is not covering the session UI.
  createEffect(
    on(
      [
        currentView,
        () => workspaceStore.createRemoteWorkspaceOpen(),
        sessionRuntimeReadyForTour,
      ],
      ([view, remoteModalOpen, runtimeReady]) => {
        if (
          view === "session" &&
          runtimeReady &&
          !remoteModalOpen &&
          !isTourDone() &&
          !tourVisible() &&
          !tourDismissedThisSession()
        ) {
          setTourVisible(true);
        }
      },
    ),
  );

  // Track whether each main view has been mounted at least once.
  // Once mounted, the view stays in the DOM and is shown/hidden via CSS
  // to avoid unmount/remount flickering of the left sidebar on view transitions.
  const [sessionMounted, setSessionMounted] = createSignal(false);
  const [dashboardMounted, setDashboardMounted] = createSignal(false);
  createEffect(() => {
    const v = currentView();
    if (v === "session") setSessionMounted(true);
    if (v === "dashboard") setDashboardMounted(true);
  });

  const [tab, setTabState] = createSignal<DashboardTab>("data");
  // Settings is a dialog over the current view; opened without a section it
  // starts on General.
  const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("app");
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  let settingsReturnFocus: HTMLElement | undefined;
  const openSettings = (section?: SettingsSection, returnFocus?: HTMLElement) => {
    setSettingsSection(section ?? "app");
    settingsReturnFocus = returnFocus;
    setSettingsOpen(true);
  };
  // Back and Forward change the page under the dialog, so they close it, as they used to leave the
  // Settings page. A replace navigation (the /dashboard/<section> redirect) fires no popstate.
  const closeSettingsOnTraversal = () => setSettingsOpen(false);
  window.addEventListener("popstate", closeSettingsOnTraversal);
  onCleanup(() => window.removeEventListener("popstate", closeSettingsOnTraversal));

  const goToDashboard = (
    nextTab: DashboardTab,
    options?: { replace?: boolean },
  ) => {
    setTabState(nextTab);
    navigate(`/dashboard/${nextTab}`, options);
  };

  const setTab = (nextTab: DashboardTab) => {
    if (currentView() === "dashboard") {
      goToDashboard(nextTab);
      return;
    }
    setTabState(nextTab);
  };

  function openNewTask() {
    if (selectedSessionId()) {
      setPendingSessionModel(null);
      setPendingSessionAgent(null);
    }

    setSelectedSessionId(null);
    navigate("/session");
  }

  const setView = (next: View, sessionId?: string) => {
    if (next === "dashboard" && creatingSession()) {
      return;
    }
    if (next === "dashboard" && Date.now() < sessionViewLockUntil()) {
      return;
    }
    if (next === "proto") {
      navigate("/proto/workspaces");
      return;
    }
    if (next === "onboarding") {
      navigate("/onboarding");
      return;
    }
    if (next === "session") {
      if (sessionId) {
        goToSession(sessionId);
        return;
      }
      navigate("/session");
      return;
    }
    goToDashboard(tab());
  };

  const goToSession = (sessionId: string, options?: { replace?: boolean }) => {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      navigate("/session", options);
      return;
    }
    navigate(`/session/${trimmed}`, options);
  };

  const [startupPreference, setStartupPreference] =
    createSignal<StartupPreference | null>(null);
  const [onboardingStep, setOnboardingStep] =
    createSignal<OnboardingStep>("welcome");
  const [rememberStartupChoice, setRememberStartupChoice] = createSignal(false);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(
    getInitialThemeMode(),
  );

  const [engineSource, setEngineSource] = createSignal<
    "path" | "sidecar" | "custom"
  >(isTauriRuntime() ? "sidecar" : "path");

  const [engineCustomBinPath, setEngineCustomBinPath] = createSignal("");

  const [engineRuntime, setEngineRuntime] = createSignal<EngineRuntime>(
    "openwork-orchestrator",
  );

  const [baseUrl, setBaseUrl] = createSignal("");
  const [clientDirectory, setClientDirectory] = createSignal("");

  const [openworkServerUrl, setOpenworkServerUrl] = createSignal("");
  const [openworkServerStatus, setOpenworkServerStatus] =
    createSignal<OpenworkServerStatus>("disconnected");
  const [openworkServerCapabilities, setOpenworkServerCapabilities] =
    createSignal<OpenworkServerCapabilities | null>(null);
  const [openworkServerCheckedAt, setOpenworkServerCheckedAt] = createSignal<
    number | null
  >(null);
  const [openworkServerWorkspaceId, setOpenworkServerWorkspaceId] =
    createSignal<string | null>(null);
  const [openworkServerHostInfo, setOpenworkServerHostInfo] =
    createSignal<OpenworkServerInfo | null>(null);
  const [openworkServerDiagnostics, setOpenworkServerDiagnostics] =
    createSignal<OpenworkServerDiagnostics | null>(null);
  const [openworkReconnectBusy, setOpenworkReconnectBusy] = createSignal(false);
  const [devtoolsWorkspaceId, setDevtoolsWorkspaceId] = createSignal<
    string | null
  >(null);

  // PII detection level: "none" | "medium" | "high" | "custom" (default: "medium")
  const [piiLevel, setPiiLevel] = createSignal<PiiLevel>("medium");
  const {
    openworkServerSettings,
    setOpenworkServerSettings,
    openworkServerBaseUrl,
    openworkServerAuth,
    openworkServerClient,
    updateOpenworkServerSettings,
    resetOpenworkServerSettings,
  } = useOpenworkConnection({ startupPreference, openworkServerHostInfo });

  const { customPiiCategories, setCustomPiiCategories } = createPiiCategories({
    openworkServerClient,
    openworkServerWorkspaceId,
  });

  // ── Backend boot progress signals ─────────────────────────────────────────
  // In Tauri desktop mode, initialize to "initializing" so the BackendBootOverlay
  // renders from the very first frame, preventing the user from seeing the
  // "workspace disconnect" state while the backend-manager hasn't started yet.
  const runtimeBoot = useRuntimeBoot({
    initialStage: isTauriRuntime() ? "initializing" : null,
    isDesktop: isTauriRuntime(),
  });
  const backendBootStage = runtimeBoot.stage;
  const backendBootMessage = runtimeBoot.message;
  const backendBootPct = runtimeBoot.pct;
  const backendBootError = runtimeBoot.error;
  const backendBootReady = runtimeBoot.ready;
  const serviceHubReadyWithoutDataPlane =
    runtimeBoot.serviceHubReadyWithoutDataPlane;

  const serviceHubSettings = createMemo(() => {
    const settings = openworkServerSettings();
    const baseUrl = settings.hubUrl?.trim() ?? "";
    const token = settings.hubToken?.trim() ?? "";
    if (!baseUrl || !token) return null;
    return { baseUrl, token };
  });

  const llmRouterClient = createMemo(() => {
    const settings = serviceHubSettings();
    return settings ? createLlmRouterClient(settings) : null;
  });

  const instanceApiClient = useInstanceApiClient(serviceHubSettings);

  const backendBootOverlay = useBackendBootOverlay({
    runtimeBoot,
    isTauriRuntime,
    retryServiceHubBoot,
    uiLogError,
    getBackendRetryPolicy,
  });
  const capabilityStartupPreflight = useCapabilityStartupPreflight({
    backendBootReady,
    serviceHubReadyWithoutDataPlane,
    isTauriRuntime,
    llmRouterClient,
  });
  const edgeGateBypass = capabilityStartupPreflight.edgeGateBypass;
  const persistEdgeProvider = capabilityStartupPreflight.persistEdgeProvider;

  // ── Download consent modal ─────────────────────────────────────────────────
  // DORMANT (2026-07: legacy backend-manager retired). This first-launch
  // model-download consent flow was driven by backend-manager's
  // `download_consent_required` boot stage and the `get_download_models_info`/
  // `approve_downloads` Tauri commands, all removed with backend-manager.
  // ServiceHub does not currently emit `download_consent_required`, so this
  // path is unreachable. Kept intentionally for reuse when model-download
  // consent is re-homed to LRM; the two `invoke(...)` calls below target
  // commands that no longer exist and are `.catch`-guarded no-ops until then.
  const [downloadConsentModalOpen, setDownloadConsentModalOpen] =
    createSignal(false);
  const [downloadModelsInfo, setDownloadModelsInfo] = createSignal<
    ModelInfo[] | null
  >(null);

  createEffect(
    on(
      () => backendBootStage(),
      (stage) => {
        if (!isTauriRuntime() || downloadConsentModalOpen()) return;
        if (stage === "download_consent_required") {
          setDownloadModelsInfo(null);
          setDownloadConsentModalOpen(true);
          // Fetch actual model info from backend
          import("@tauri-apps/api/core")
            .then((mod) => mod.invoke<ModelInfo[]>("get_download_models_info")) // dormant: command removed with backend-manager — see note above
            .then((info) => setDownloadModelsInfo(info))
            .catch((err) =>
              console.warn("[download-consent] failed to get model info:", err),
            );
        }
      },
    ),
  );

  const [debugObservabilityAvailable] = createSignal(__BUILD_DEBUG__);

  const {
    narrationState: ttsNarration,
    setNarrationOn: setTtsNarrationOn,
    available: ttsAvailable,
    speaking: ttsSpeaking,
    readAloud: ttsReadAloud,
    downloadOpen: ttsDownloadOpen,
    downloadPhase: ttsDownloadPhase,
    downloadProgress: ttsDownloadDone,
    downloadTotal: ttsDownloadTotal,
    error: ttsDownloadError,
    toggleNarration: toggleTtsNarration,
    speakMessage,
    confirmTtsDownload,
    dismissTtsDownload,
    stopNarration,
  } = useTtsNarration(
    () => serviceHubSettings()?.baseUrl ?? "",
    () => serviceHubSettings()?.token,
    () => activeMessages(),
  );

  const TTS_MODEL_NAME = "Kokoro-82M (English voice)";

  const [localModelHealth, setLocalModelHealth] =
    createSignal<LocalModelHealthInfo | null>(null);
  const localModelAvailable = createMemo(() =>
    isLocalModelAvailable(localModelHealth()),
  );
  const localModelExplicitlyUnavailable = createMemo(() => {
    const local = localModelHealth();
    return Boolean(local && !isLocalModelAvailable(local));
  });

  const refreshLocalModelHealth = async () => {
    const hubUrl = openworkServerSettings().hubUrl?.trim() ?? "";
    const hubToken = openworkServerSettings().hubToken?.trim() ?? "";
    if (!hubUrl || !hubToken) {
      setLocalModelHealth(null);
      return;
    }
    try {
      setLocalModelHealth(await loadLocalModelHealth());
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLocalModelHealth(null);
    }
  };

  createEffect(() => {
    if (serviceHubReadyWithoutDataPlane()) {
      setLocalModelHealth(null);
      return;
    }

    const hubUrl = openworkServerSettings().hubUrl?.trim() ?? "";
    const hubToken = openworkServerSettings().hubToken?.trim() ?? "";
    if (!hubUrl || !hubToken) {
      setLocalModelHealth(null);
      return;
    }

    let disposed = false;
    let controller: AbortController | null = null;

    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const payload = await loadLocalModelHealth();
        if (!disposed) setLocalModelHealth(payload);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (!disposed) setLocalModelHealth(null);
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    onCleanup(() => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
    });
  });

  const { runtimeSettings, runtimeSettingsStatus, runtimeSettingsError, refreshRuntimeSettings, saveRuntimeSettings } =
    useOpenworkRuntimeSettings({
      openworkServerStatus,
      openworkServerClient,
      openworkServerWorkspaceId,
      safeStringify,
    });

  const {
    tavilyApiKey,
    tavilyApiKeyStatus,
    tavilyApiKeyError,
    refreshTavilyApiKey,
    saveTavilyApiKey,
    clearTavilyApiKey, setTavilyApiKeyEnabled,
  } = useTavilyApiKey({ instanceApiClient, safeStringify });
  const tavilyKey = createMemo(() =>
    tavilyKeyView({
      availability: tavilyApiKey(),
      status: tavilyApiKeyStatus(),
      error: tavilyApiKeyError(),
    }),
  );

  const devtoolsOpenworkClient = createMemo(() => openworkServerClient());

  createEffect(() => {
    if (typeof window === "undefined") return;
    hydrateOpenworkServerSettingsFromEnv();

    const stored = readOpenworkServerSettings();
    const invite = readOpenworkConnectInviteFromSearch(window.location.search);
    const bundleInvite = readOpenworkBundleInviteFromSearch(
      window.location.search,
    );

    if (!invite) {
      setOpenworkServerSettings(stored);
    } else {
      const merged: OpenworkServerSettings = {
        ...stored,
        urlOverride: invite.url,
        token: invite.token ?? stored.token,
      };

      const next = writeOpenworkServerSettings(merged);
      setOpenworkServerSettings(next);

      if (
        invite.startup === "server" &&
        untrack(onboardingStep) === "welcome"
      ) {
        setStartupPreference("server");
        setOnboardingStep("server");
      }
    }

    if (bundleInvite?.bundleUrl) {
      setPendingSharedBundleInvite({
        bundleUrl: bundleInvite.bundleUrl,
        intent: normalizeSharedBundleImportIntent(bundleInvite.intent),
        source: bundleInvite.source,
        orgId: bundleInvite.orgId,
        label: bundleInvite.label,
      });
      setSharedBundleNoticeShown(false);
    }

    const cleanedConnect = stripOpenworkConnectInviteFromUrl(
      window.location.href,
    );
    const cleaned = stripOpenworkBundleInviteFromUrl(cleanedConnect);
    if (cleaned !== window.location.href) {
      window.history.replaceState(window.history.state ?? null, "", cleaned);
    }
  });

  createEffect(() => {
    if (typeof document === "undefined") return;
    const update = () =>
      setDocumentVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    onCleanup(() => document.removeEventListener("visibilitychange", update));
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!isTauriRuntime()) return;

    const applyAndPersistFontZoom = (value: number) => {
      const next = normalizeFontZoom(value);
      persistFontZoom(window.localStorage, next);

      try {
        const webview = getCurrentWebview();
        void applyWebviewZoom(webview, next)
          .then(() => {
            document.documentElement.style.removeProperty(
              "--openwork-font-size",
            );
          })
          .catch(() => {
            applyFontZoom(document.documentElement.style, next);
          });
      } catch {
        applyFontZoom(document.documentElement.style, next);
      }

      return next;
    };

    let fontZoom = applyAndPersistFontZoom(
      readStoredFontZoom(window.localStorage) ?? 1,
    );

    const handleZoomShortcut = (event: KeyboardEvent) => {
      const action = parseFontZoomShortcut(event);
      if (!action) return;

      if (action === "in") {
        fontZoom = applyAndPersistFontZoom(fontZoom + FONT_ZOOM_STEP);
      } else if (action === "out") {
        fontZoom = applyAndPersistFontZoom(fontZoom - FONT_ZOOM_STEP);
      } else {
        fontZoom = applyAndPersistFontZoom(1);
      }

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleZoomShortcut, true);
    onCleanup(() =>
      window.removeEventListener("keydown", handleZoomShortcut, true),
    );
  });

  createEffect(() => {
    const pref = startupPreference();
    const info = openworkServerHostInfo();
    const hostUrl =
      info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl =
      normalizeOpenworkServerUrl(openworkServerSettings().urlOverride ?? "") ??
      "";

    if (pref === "local") {
      setOpenworkServerUrl(hostUrl);
      return;
    }
    if (pref === "server") {
      setOpenworkServerUrl(settingsUrl);
      return;
    }
    setOpenworkServerUrl(hostUrl || settingsUrl);
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!documentVisible()) return;
    const url = openworkServerBaseUrl().trim();
    const auth = openworkServerAuth();
    const token = auth.token;
    const hostToken = auth.hostToken;

    if (!url) {
      setOpenworkServerStatus("disconnected");
      setOpenworkServerCapabilities(null);
      setOpenworkServerCheckedAt(Date.now());
      return;
    }

    let active = true;
    let busy = false;
    let timeoutId: number | undefined;
    let delayMs = 10_000;

    const scheduleNext = () => {
      if (!active) return;
      timeoutId = window.setTimeout(run, delayMs);
    };

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await checkOpenworkServer(url, token, hostToken);
        if (!active) return;
        setOpenworkServerStatus(result.status);
        setOpenworkServerCapabilities(result.capabilities);
        delayMs =
          result.status === "connected" || result.status === "limited"
            ? 10_000
            : Math.min(delayMs * 2, 60_000);
      } catch {
        delayMs = Math.min(delayMs * 2, 60_000);
      } finally {
        if (!active) return;
        setOpenworkServerCheckedAt(Date.now());
        busy = false;
        scheduleNext();
      }
    };

    run();
    onCleanup(() => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
    });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!documentVisible()) return;
    if (!developerMode()) {
      setOpenworkServerDiagnostics(null);
      return;
    }

    const client = openworkServerClient();
    if (!client || openworkServerStatus() === "disconnected") {
      setOpenworkServerDiagnostics(null);
      return;
    }

    let active = true;
    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const status = await client.status();
        if (active) setOpenworkServerDiagnostics(status);
      } catch {
        if (active) setOpenworkServerDiagnostics(null);
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  const [client, setClient] = createSignal<Client | null>(null);
  const [connectedVersion, setConnectedVersion] = createSignal<string | null>(
    null,
  );
  const [sseConnected, setSseConnected] = createSignal(false);

  const { busy, shellBusy, setBusy, setDispatchBusy, busyLabel, setBusyLabel, busyStartedAt, setBusyStartedAt } =
    createAppBusy();
  const [composerAttachmentUpload, setComposerAttachmentUpload] = createSignal<{
    sessionID: string;
    paths: string[];
  } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [opencodeConnectStatus, setOpencodeConnectStatus] =
    createSignal<OpencodeConnectStatus | null>(null);
  const [booting, setBooting] = createSignal(true);
  const [lastKnownConfigSnapshot, setLastKnownConfigSnapshot] =
    createSignal("");
  const [developerMode, setDeveloperMode] = createSignal(false);
  const [documentVisible, setDocumentVisible] = createSignal(true);
  // `onInstallIdReset` is a thunk because `setTelemetryRestartHint` is
  // declared below, by the telemetry store that reads these prefs back.
  const {
    appPrefs,
    appPrefsReady,
    appPrefsWriteTail,
    keepBackendOnExit,
    persistAppPrefs,
    resetInstallIdFeedback,
    resetInstallIdHandler,
    setAppPrefs: setAppPrefsSignal,
    setKeepBackendOnExit,
  } = createAppPrefs({
    onInstallIdReset: () => setTelemetryRestartHint(true),
  });
  // When capability gating is active, force the backend to stop on exit so a
  // restart never leaves a residual backend running (the lifecycle toggle is
  // also hidden in that mode). Dark-safe: non-capability builds keep current
  // behavior.
  const capabilityGate = useCapabilityGate();
  const platform = usePlatform();
  // Sits below `platform`, which it needs for the restart, and above
  // `resetInstallIdHandler`'s only caller, which raises the same hint.
  const telemetryConsent = createTelemetryConsent({
    appPrefs,
    setAppPrefs: setAppPrefsSignal,
    persistAppPrefs,
    appPrefsReady,
    appPrefsWriteTail,
    isTauriRuntime,
    stopBackend: async () => {
      await stopServiceHub();
    },
    restartApp: () => platform.restart(),
  });
  const nativeBackendRecovery = createNativeBackendRecovery(serviceHubSettings, platform);
  const {
    writeError: telemetryWriteError,
    setWriteError: setTelemetryWriteError,
    restartError: telemetryRestartError,
    setRestartError: setTelemetryRestartError,
    restartHint: telemetryRestartHint,
    setRestartHint: setTelemetryRestartHint,
    fullEnabled: fullTelemetryEnabled,
    setFullEnabled: setFullTelemetryEnabled,
    baselineEnabled: baselineTelemetryEnabled,
    setBaselineEnabled: setBaselineTelemetryEnabled,
  } = telemetryConsent;
  createEffect(() => {
    if (capabilityGate.isActive() && keepBackendOnExit()) {
      setKeepBackendOnExit(false);
    }
  });

  // Voice input. Declared after the capability gate because the ON-DEVICE option
  // is Profile-gated (`feature_flags.voice_input`); cloud voice input is not
  // gated and keeps working with or without a Profile.
  const voiceInput = useVoiceInput(
    () => serviceHubSettings()?.baseUrl ?? "",
    () => serviceHubSettings()?.token,
    () => capabilityGate.voiceInputEnabled(), { onRecordingStarted: stopNarration },
  );
  // Version counter that increments when skills/commands change (e.g., import, uninstall)
  // Components watching this signal can refresh their command lists without app reload
  const [commandsVersion, setCommandsVersion] = createSignal(0);
  // Version counter that increments when agents change (e.g., created via Agent Creator)
  const [agentsVersion, setAgentsVersion] = createSignal(0);

  createEffect(() => {
    if (developerMode()) return;
    clearPerfLogs();
  });

  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    null,
  );
  const SESSION_BY_WORKSPACE_KEY = "openwork.workspace-last-session.v1";
  const readSessionByWorkspace = () => {
    if (typeof window === "undefined") return {} as Record<string, string>;
    try {
      const raw = window.localStorage.getItem(SESSION_BY_WORKSPACE_KEY);
      if (!raw) return {} as Record<string, string>;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object")
        return {} as Record<string, string>;
      return parsed as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  };
  const writeSessionByWorkspace = (map: Record<string, string>) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        SESSION_BY_WORKSPACE_KEY,
        JSON.stringify(map),
      );
    } catch {
      // ignore
    }
  };
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [sessionModelById, setSessionModelById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [pendingSessionModel, setPendingSessionModel] =
    createSignal<ModelRef | null>(null);
  const [pendingSessionAgent, setPendingSessionAgent] =
    createSignal<string | null>(null);
  const [sessionModelOverridesReady, setSessionModelOverridesReady] =
    createSignal(false);
  const [workspaceDefaultModelReady, setWorkspaceDefaultModelReady] =
    createSignal(false);
  const [legacyDefaultModel, setLegacyDefaultModel] =
    createSignal<ModelRef>(DEFAULT_MODEL);
  const [defaultModelExplicit, setDefaultModelExplicit] = createSignal(false);

  const [sessionAgentById, setSessionAgentById] = createSignal<
    Record<string, string>
  >({});
  const [sessionAgentManagedModelById, setSessionAgentManagedModelById] =
    createSignal<Record<string, true>>({});
  // Sessions the classifier already resolved an agent for. Classify once per
  // session (any agent, default or specialized); cleared on a user-driven
  // agent change so the next turn is classified again.
  const [classifierResolvedSessionById, setClassifierResolvedSessionById] =
    createSignal<Record<string, true>>({});
  const { setSessionAgent, hydrateSessionAgentFromServer } = createSessionAgentSelection({
    sessionAgentById, setSessionAgentById, classifierResolvedSessionById, setClassifierResolvedSessionById, capabilityGate,
  });
  const [
    classifierAmbiguousPromptsBySessionId,
    setClassifierAmbiguousPromptsBySessionId,
  ] = createSignal<Record<string, AmbiguousPromptEntry[]>>({});
  const [localLlmConfigWarningOpen, setLocalLlmConfigWarningOpen] =
    createSignal(false);
  const [emailAgentCloudRiskOpen, setEmailAgentCloudRiskOpen] =
    createSignal(false);
  const [emailAgentCloudRiskAcknowledged, setEmailAgentCloudRiskAcknowledged] =
    createSignal(false);
  const [providerAuthReturnFocusTarget, setProviderAuthReturnFocusTarget] =
    createSignal<PromptFocusReturnTarget>("none");
  const [llmRouterProviders, setLlmRouterProviders] = createSignal<
    LlmRouterProviderOption[]
  >([]);
  const modelRouting = createModelRoutingFeature({
    serviceHubSettings,
    llmRouterClient,
    llmRouterProviders,
    refreshLocalModelHealth,
    refreshCapabilityProfile: capabilityGate.refresh,
    activeProfile: capabilityGate.activeProfile,
    syncWorkspaceToken: (...args) => workspaceStore.onBackendTokenRefresh(...args),
  });
  const {
    cloudModel,
    setCloudModel,
    cloudModelMissing,
    cloudModelHealthError,
    cloudModelLoading,
    cloudModelDeleting,
    cloudModelTesting,
    edgeConfig,
    setEdgeConfig,
    edgeTesting,
    edgeError,
    primaryBundleCapability,
    setPrimaryBundleCapability,
    edgeConnected,
    edgeDisconnectAvailable,
    edgeDisconnecting,
    bundleSwitchMessage,
    bundleSwitchError,
    bundleSwitchSteps,
    bundleSwitchApplying,
    bundleSwitchCanResume,
    edgeUpdatedMessage,
    switchHardwareFailures,
    setSwitchHardwareFailures,
    refreshCloudModel,
    refreshEdgeConfig,
    refreshPrimaryBundleCapability,
    saveCloudModel,
    deleteCloudModel,
    testProviderConnection,
    connectEdge,
    disconnectEdge,
    testEdgeConnection,
    connectLocal,
    applyBundleSwitch,
    cancelBundleSwitch,
  } = modelRouting;

  const toggleSettings = (section?: SettingsSection) => {
    if (settingsOpen()) {
      setSettingsOpen(false);
      return;
    }
    openSettings(section);
  };

  // Global disk-critical notice. When the workspace's total intermediate files
  // cross the critical threshold AND auto-cleanup is disabled, the backend
  // no longer deletes automatically — so we surface a dismissible toast that
  // routes the user to Settings to review and free space. Event-driven and
  // throttled (mount + window-visible), never a background timer: computing
  // the intermediate size walks the workspace, so we keep it off any hot path.
  const [diskCriticalBytes, setDiskCriticalBytes] = createSignal<number | null>(null);
  let lastDiskCheckAt = 0;
  const DISK_CHECK_THROTTLE_MS = 5 * 60_000;

  const checkCleanupDisk = async () => {
    if (!isTauriRuntime()) return;
    const now = Date.now();
    if (now - lastDiskCheckAt < DISK_CHECK_THROTTLE_MS) return;
    lastDiskCheckAt = now;
    try {
      // When auto-cleanup is on the backend handles critical disk automatically
      // and the Settings banner covers the detail.
      const settings = await getWorkspaceCleanupSettings();
      if (settings.enabled) {
        setDiskCriticalBytes(null);
        return;
      }
      const status = await getWorkspaceCleanupStatus();
      setDiskCriticalBytes(status.disk_level === "critical" ? status.intermediate_bytes : null);
    } catch {
      /* best-effort: a failed status read must never break the app shell */
    }
  };

  onMount(() => {
    void checkCleanupDisk();
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkCleanupDisk();
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() =>
      document.removeEventListener("visibilitychange", onVisible),
    );
  });

  let markReloadRequiredHandler: ((reason: ReloadReason, trigger?: ReloadTrigger) => void) | undefined;
  const markReloadRequired = (reason: ReloadReason, trigger?: ReloadTrigger) => markReloadRequiredHandler?.(reason, trigger);

  const intentDisplayHydratedSessionIds = new Set<string>();

  const sessionStore = createSessionStore({
    client,
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot().trim(),
    selectedSessionId,
    setSelectedSessionId,
    sessionModelState: () => ({
      overrides: sessionModelOverrideById(),
      resolved: sessionModelById(),
    }),
    setSessionModelState: (updater) => {
      const next = updater({
        overrides: sessionModelOverrideById(),
        resolved: sessionModelById(),
      });
      setSessionModelOverrideById(next.overrides);
      setSessionModelById(next.resolved);
      return next;
    },
    lastUserModelFromMessages,
    onSessionMessagesLoaded: hydrateSessionAgentFromServer,
    developerMode,
    setError,
    setSseConnected,
    markReloadRequired,
    onReloadTargetWritten: (trigger) => refreshWrittenReloadTarget(trigger, {
      refreshWrittenSkill: (name) => refreshWrittenSkill(name),
      bumpAgentsVersion: () => setAgentsVersion((v) => v + 1),
    }),
    onHotReloadApplied: () => {
      void refreshSkills({ force: true });
      void refreshPlugins(pluginScope());
      void mcp.refreshMcpServers();
      setCommandsVersion((v) => v + 1);
      setAgentsVersion((v) => v + 1);
    },
    onAutomationCompleted: (sessionId, sessionTitle) => {
      const automationName = sessionTitle.replace(/^Automation:\s*/, "");

      if (isTauriRuntime()) {
        void (async () => {
          try {
            const { isPermissionGranted, requestPermission, sendNotification } =
              await import("@tauri-apps/plugin-notification");
            let permitted = await isPermissionGranted();
            if (!permitted) {
              const result = await requestPermission();
              permitted = result === "granted";
            }
            if (permitted) {
              sendNotification({
                title: `Automation completed: ${automationName}`,
                body: "Your scheduled automation has finished running.",
              });
            }
          } catch (err) {
            console.error("[Automation:notification] Tauri notification error:", err);
          }
        })();
        return;
      }

      if (!("Notification" in window)) {
        return;
      }
      const permission = Notification.permission;
      if (permission !== "granted") {
        if (permission === "default") {
          void Notification.requestPermission();
        }
        return;
      }
      const inView =
        document.visibilityState === "visible" && document.hasFocus();
      if (inView) return;
      try {
        const n = new Notification(`Automation completed: ${automationName}`, {
          body: "Your scheduled automation has finished running.",
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch (err) {
        console.error("[Automation:notification] Browser notification error:", err);
      }
    },
  });

  const {
    sessions,
    sessionById,
    sessionStatusById,
    selectedSession,
    selectedSessionStatus,
    messages,
    messagesBySessionId,
    todos,
    permissionReplyBusy,
    activeQuestion,
    questionReplyBusy,
    activePermission,
    loadSessions,
    ensureSessionLoaded,
    refreshPendingPermissions,
    selectSession,
    loadEarlierMessages,
    renameSession,
    respondPermission,
    respondQuestion, rejectQuestion,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    sessionLoadingById,
  } = sessionStore;

  const egress = useEgressFeatures({ instanceApiClient, chats: sessions, selectedSessionId });
  const hostMcp = useHostMcp({
    client: useHostMcpApiClient(serviceHubSettings),
    enabled: () => capabilityGate.mcpHostExecutionEnabled() || capabilityGate.hostBrowserEnabled(),
  });

  const ARTIFACT_SCAN_MESSAGE_WINDOW = 220;
  const artifacts = createMemo(() =>
    deriveArtifacts(messages(), { maxMessages: ARTIFACT_SCAN_MESSAGE_WINDOW }),
  );
  const workingFiles = createMemo(() => deriveWorkingFiles(artifacts()));
  const activeSessionId = createMemo(() => selectedSessionId());
  const activeSessions = createMemo(() => sessions());
  const activeSessionStatusById = createMemo(() => sessionStatusById());
  const activeMessages = createMemo(() => messages());
  const activeTodos = createMemo(() => todos());
  const activeArtifacts = createMemo(() => artifacts());
  const activeWorkingFiles = createMemo(() => workingFiles());

  const [sessionsLoaded, setSessionsLoaded] = createSignal(false);
  const loadSessionsWithReady = async (scopeRoot?: string) => {
    await loadSessions(scopeRoot);
    setSessionsLoaded(true);
  };

  createEffect(() => {
    if (!client()) {
      setSessionsLoaded(false);
    }
  });

  createEffect(() => {
    const settings = serviceHubSettings();
    if (!settings) {
      setLlmRouterProviders([]);
      setCloudModel(null);
      setEdgeConfig(null);
      setPrimaryBundleCapability(null);
      return;
    }

    void refreshLlmRouterProviders().catch(() => undefined);
    void refreshCloudModel().catch(() => undefined);
    void refreshEdgeConfig().catch(() => undefined);
    void refreshPrimaryBundleCapability().catch(() => undefined);
  });

  const [prompt, setPrompt] = createSignal("");
  const [lastPromptSent, setLastPromptSent] = createSignal("");

  const [lastSessionStatus, setLastSessionStatus] = createSignal<string | null>(
    null,
  );
  createEffect(() => {
    const sessionID = selectedSessionId();
    const status = sessionID ? (sessionStatusById()[sessionID] ?? null) : null;
    const previous = lastSessionStatus();
    setLastSessionStatus(status);

    if (!sessionID) return;
    if (!autoCompactContext()) return;
    if (status !== "idle") return;
    if (!previous || previous === "idle") return;
    void triggerAutoCompaction(sessionID);
  });

  const {
    appendSessionClassifierUserTurn,
    appendSessionCompactTurn,
    sessionClassifierUserTurnsById,
    setSessionClassifierUserTurnsById,
    visibleMessages,
  } = createSessionTurns({ selectedSessionId, sessionStore });

  // Hydrate Slack/Telegram canned intent-classifier turns (issue #1726).
  // The transcript is read again after the fetch so a greeting the desktop
  // just appended is not written a second time (issue #3364).
  createEffect(() => {
    const sessionID = selectedSessionId();
    const client = openworkServerClient();
    beginIntentSessionDisplayHydration({
      enabled: capabilityGate.intentClassifierEnabled(),
      sessionID,
      hydratedSessionIds: intentDisplayHydratedSessionIds,
      fetchDisplay: client
        ? (sid) => client.getIntentSessionDisplay(sid)
        : null,
      userTurns: () =>
        sessionClassifierUserTurnsById()[sessionID?.trim() ?? ""] ?? [],
      classifierTurns: () =>
        sessionStore.sessionClassifierTurnsById(sessionID),
      appendUserTurn: (sid, text) => appendSessionClassifierUserTurn(sid, text),
      appendClassifierTurn: (sid, text, kind, afterMessageID) =>
        sessionStore.appendSessionClassifierTurn(sid, text, kind, afterMessageID),
    });
  });

  async function startProviderAuth(
    providerId?: string,
  ): Promise<ProviderOAuthStartResult> {
    if (!providerId) {
      throw new Error("Provider ID is required to start OAuth.");
    }
    return providerAuth.startAuth(providerId);
  }

  async function refreshProviders(options?: { dispose?: boolean }) {
    void options;
    return refreshLlmRouterProviders();
  }

  async function completeProviderAuthOAuth(
    providerId: string,
    methodIndex: number,
    code?: string,
  ): Promise<{
    connected: boolean;
    pending?: boolean;
    terminated?: boolean;
    message?: string;
  }> {
    return providerAuth.completeOAuth(providerId, methodIndex, code);
  }

  async function cancelProviderAuthOAuth(providerId: string): Promise<void> {
    return providerAuth.cancelOAuth(providerId);
  }

  async function submitProviderApiKey(providerId: string, apiKey: string) {
    return providerAuth.submitApiKey(providerId, apiKey);
  }

  async function disconnectProvider(providerId: string) {
    return providerAuth.disconnectProvider(providerId);
  }

  function focusSessionPromptSoon() {
    if (typeof window === "undefined" || currentView() !== "session") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("openwork:focusPrompt"));
      });
    });
  }

  // SessionView stays mounted once visited, so the composer's onMount autofocus
  // only ever runs once. Re-focus it whenever the active session changes so a
  // new task or a switch to another task lands the caret in the prompt.
  createEffect(
    on(
      () => (currentView() === "session" ? selectedSessionId() : null),
      (sessionId, previousSessionId) => {
        if (!sessionId || sessionId === previousSessionId) return;
        focusSessionPromptSoon();
      },
    ),
  );

  async function openProviderAuthModal(options?: {
    returnFocusTarget?: PromptFocusReturnTarget;
  }) {
    setProviderAuthReturnFocusTarget(options?.returnFocusTarget ?? "none");
    await providerAuth.openAuthModal();
  }

  function closeProviderAuthModal(options?: { restorePromptFocus?: boolean }) {
    const shouldFocusPrompt =
      options?.restorePromptFocus ??
      providerAuthReturnFocusTarget() === "composer";
    providerAuth.closeAuthModal();
    setProviderAuthReturnFocusTarget("none");
    if (shouldFocusPrompt) {
      focusSessionPromptSoon();
    }
  }

  const [declineReplyBusy, setDeclineReplyBusy] = createSignal(false);
  const declineGranted = new Set<string>();
  async function respondPermissionRecordingDecline(
    requestID: string,
    reply: "once" | "always" | "reject",
  ) {
    await replyRecordingFileProtectionDecline(activePermission(), requestID, reply, {
      isBusy: () => declineReplyBusy() || permissionReplyBusy(),
      setBusy: setDeclineReplyBusy,
      granted: declineGranted,
      notifyAlreadyDeclined: () => setModelSelectToast(t("session.permission_already_declined", currentLocale())),
      openGrant: async (sessionId) => {
        const hub = serviceHubSettings();
        if (!hub) throw new Error("ServiceHub is not connected");
        await openLocalReadGrant(hub.baseUrl, hub.token, sessionId);
      },
      respond: respondPermission,
      warn: (message) => console.warn("[file-protection]", message),
    });
  }

  async function respondPermissionAndRemember(
    requestID: string,
    reply: "once" | "always" | "reject",
  ) {
    // Intentional no-op: permission prompts grant session-scoped access only.
    // Persistent workspace roots must be managed explicitly via workspace settings.
    await respondPermissionRecordingDecline(requestID, reply);
  }

  const extensionsStore = createExtensionsStore({
    client,
    projectDir: () => workspaceProjectDir(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    workspaceType: () => workspaceStore.activeWorkspaceDisplay().workspaceType,
    openworkServerClient,
    openworkServerStatus,
    openworkServerCapabilities,
    openworkServerWorkspaceId,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setError,
    markReloadRequired,
    onCommandsChanged: () => {
      // Called after skill import/uninstall to trigger slash command list refresh
      setCommandsVersion((v) => v + 1);
    },
  });

  const {
    skills,
    skillsStatus,
    skillsStatusTone,
    hubSkills,
    hubSkillsStatus,
    hubRepo,
    hubRepos,
    pluginScope,
    setPluginScope,
    pluginConfig,
    pluginConfigPath,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    sidebarPluginList,
    sidebarPluginStatus,
    isPluginInstalledByName,
    refreshSkills,
    refreshHubSkills,
    setHubRepo,
    addHubRepo,
    removeHubRepo,
    refreshPlugins,
    addPlugin,
    removePlugin,
    importLocalSkill,
    importSkillFile,
    installSkillCreator,
    installSkillFinder,
    installHubSkill,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    abortRefreshes,
  } = extensionsStore;

  const globalSync = useGlobalSync();
  const providers = createMemo(() => globalSync.data.provider.all ?? []);
  const selectableProviders = createMemo(() =>
    providers().filter(
      (provider) =>
        provider.id !== "local-llm" || !localModelExplicitlyUnavailable(),
    ),
  );
  const providerDefaults = createMemo(
    () => globalSync.data.provider.default ?? {},
  );
  function resolveLocalLlmModel(): ModelRef | null {
    if (!localModelAvailable()) return null;
    return { providerID: "llmrouter", modelID: "local-model" };
  }
  const setProviders = (value: ProviderListItem[]) => {
    globalSync.set("provider", "all", toGlobalProviderList(value));
  };
  const setProviderDefaults = (value: Record<string, string>) => {
    globalSync.set("provider", "default", value);
  };
  const setProviderConnectedIds = (value: string[]) => {
    globalSync.set("provider", "connected", value);
  };

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [pendingDefaultModelWrite, setPendingDefaultModelWrite] =
    createSignal(false);
  // When true, the workspace-config-read effect will skip overwriting defaultModel.
  // Set by edge model setup/clear to prevent the config's "local-llm/..." model from
  // replacing the user's chosen UI default (e.g. "llmrouter/auto").
  const [preserveDefaultModel, setPreserveDefaultModel] = createSignal(false);
  // Bumped by reconnectOpenworkServer after a successful reconnect so the workspace
  // config effect re-reads opencode.jsonc even when openworkServerStatus stays "connected".
  const [workspaceConfigVersion, setWorkspaceConfigVersion] = createSignal(0);
  // Monotonically-increasing counter so only the latest in-flight write clears the pending flag.
  let defaultModelWriteGen = 0;
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<
    "session" | "default"
  >("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");
  const [modelSelectToast, setModelSelectToast] = createSignal<string | null>(
    null,
  );
  createEffect(() => {
    if (!modelSelectToast()) return;
    const id = window.setTimeout(() => setModelSelectToast(null), 4000);
    onCleanup(() => window.clearTimeout(id));
  });
  const [modelPickerReturnFocusTarget, setModelPickerReturnFocusTarget] =
    createSignal<PromptFocusReturnTarget>("none");

  const [showThinking, setShowThinking] = createSignal(false);
  const [hideTitlebar, setHideTitlebar] = createSignal(false);
  const [autoCompactContext, setAutoCompactContext] = createSignal(false);
  const [modelVariant, setModelVariant] = createSignal<string | null>(null);
  const [autoCompactingSessionId, setAutoCompactingSessionId] = createSignal<
    string | null
  >(null);

  const handleEditModelVariant = () => {
    const next = window.prompt(
      "Model variant (none, low, medium, high, xhigh)",
      normalizeModelVariant(modelVariant()) ?? "none",
    );
    if (next == null) return;
    const normalized = normalizeModelVariant(next);
    if (!normalized) {
      window.alert("Variant must be one of: none, low, medium, high, xhigh.");
      return;
    }
    setModelVariant(normalized);
  };

  const workspaceStore = createWorkspaceStore({
    startupPreference,
    setStartupPreference,
    onboardingStep,
    setOnboardingStep,
    rememberStartupChoice,
    setRememberStartupChoice,
    baseUrl,
    setBaseUrl,
    clientDirectory,
    setClientDirectory,
    client,
    setClient,
    setConnectedVersion,
    setSseConnected,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setOpencodeConnectStatus,
    loadSessions: loadSessionsWithReady,
    refreshPendingPermissions,
    selectedSessionId,
    selectSession,
    setSelectedSessionId,
    setMessages,
    setTodos,
    setPendingPermissions,
    setSessionStatusById,
    defaultModel,
    modelVariant,
    refreshSkills,
    refreshPlugins,
    engineSource,
    engineCustomBinPath,
    setEngineSource,
    setView,
    isWindowsPlatform,
    openworkServerSettings,
    updateOpenworkServerSettings,
    openworkServerClient,
    onEngineStable: () => { },
    engineRuntime,
    developerMode,
  });

  // Must be created after workspaceStore: scheduledJobsSource's createMemo
  // reads workspaceStore eagerly at construction time.
  const scheduler = useScheduler({
    workspaceType: () => workspaceStore.activeWorkspaceDisplay().workspaceType,
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    openworkServerClient,
    openworkServerWorkspaceId,
    openworkServerStatus,
    isPluginInstalledByName,
    isTauriRuntime,
    isWindowsPlatform,
    schedulerListJobs,
    schedulerDeleteJob,
  });
  const {
    scheduledJobs,
    scheduledJobsStatus,
    scheduledJobsBusy,
    scheduledJobsSource,
    scheduledJobsSourceReady,
    schedulerPluginInstalled,
    refreshScheduledJobs,
    deleteScheduledJob,
  } = scheduler;

  // Single shared fetch — both SessionView and DashboardView read from this instance
  const versionInfo = useVersionInfo();

  const workspaceSidebar = createWorkspaceSidebarFeature({
    sessions: activeSessions,
    workspaces: workspaceStore.workspaces,
    activeWorkspaceId: workspaceStore.activeWorkspaceId,
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId,
    workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById,
    engine: workspaceStore.engine,
    debug: wsDebug,
  });
  const {
    sidebarSessionsByWorkspaceId,
    setSidebarSessionsByWorkspaceId,
    setSidebarSessionStatusByWorkspaceId,
    refreshSidebarWorkspaceSessions,
    sidebarWorkspaceGroups,
  } = workspaceSidebar;

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    const sessionId = selectedSessionId();
    if (!workspaceId || !sessionId) return;
    const map = readSessionByWorkspace();
    if (map[workspaceId] === sessionId) return;
    map[workspaceId] = sessionId;
    writeSessionByWorkspace(map);
  });

  createEffect(() => {
    // Only auto-select on bare /session. If the URL already includes /session/:id,
    // let the route-driven selector own the fetch to avoid duplicate selection runs.
    if (currentView() !== "session") return;
    const normalizedPath = location.pathname.toLowerCase().replace(/\/+$/, "");
    if (normalizedPath !== "/session") return;
    if (!client()) return;
    if (!sessionsLoaded()) return;
    if (creatingSession()) return;
    if (selectedSessionId()) return;

    // Keep /session as a draft-ready empty state until the user picks a session
    // or sends a prompt. Avoid auto-selecting prior sessions on app launch.
    return;
  });

  createEffect(() => {
    const active = workspaceStore.activeWorkspaceDisplay();
    const client = openworkServerClient();
    const openworkUrl = openworkServerUrl().trim();

    if (!client || openworkServerStatus() !== "connected") {
      setOpenworkServerWorkspaceId(null);
      return;
    }

    if (active.workspaceType === "remote" && active.remoteType === "openwork") {
      const inferredWorkspaceId =
        parseOpenworkWorkspaceIdFromUrl(active.openworkHostUrl ?? "") ??
        parseOpenworkWorkspaceIdFromUrl(active.baseUrl ?? "") ??
        parseOpenworkWorkspaceIdFromUrl(openworkUrl);
      const preferredId =
        active.openworkWorkspaceId?.trim() ||
        inferredWorkspaceId ||
        envOpenworkWorkspaceId ||
        null;

      // Always fetch the live workspace list even when preferredId is known.
      // This lets us verify the stored ID against the server's current state,
      // correcting stale IDs after workspace resets or server restarts, and
      // enables directory-path matching which takes priority over any stored ID.
      let cancelled = false;
      const resolveWorkspace = async () => {
        try {
          const response = await client.listWorkspaces();
          if (cancelled) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const directoryHint = normalizeDirectoryPath(
            active.directory?.trim() ?? active.path?.trim() ?? "",
          );
          const directoryMatch = directoryHint
            ? items.find((entry) => {
              const entryPath = normalizeDirectoryPath(
                (
                  entry.opencode?.directory ??
                  entry.directory ??
                  entry.path ??
                  ""
                ).trim(),
              );
              return Boolean(entryPath && entryPath === directoryHint);
            })
            : null;
          const preferredMatch = preferredId
            ? items.find((entry) => entry.id === preferredId)
            : null;
          const activeMatch = response.activeId
            ? items.find((entry) => entry.id === response.activeId)
            : null;
          const match =
            directoryMatch ?? preferredMatch ?? activeMatch ?? items[0];
          setOpenworkServerWorkspaceId(match?.id ?? response.activeId ?? null);
        } catch {
          if (!cancelled) setOpenworkServerWorkspaceId(null);
        }
      };

      void resolveWorkspace();
      onCleanup(() => {
        cancelled = true;
      });
      return;
    }

    if (active.workspaceType === "local") {
      const root = normalizeDirectoryPath(
        workspaceStore.activeWorkspaceRoot().trim(),
      );
      if (!root) {
        setOpenworkServerWorkspaceId(null);
        return;
      }

      let cancelled = false;
      const resolveWorkspace = async () => {
        try {
          const response = await client.listWorkspaces();
          if (cancelled) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const match = items.find(
            (entry) => normalizeDirectoryPath(entry.path) === root,
          );
          setOpenworkServerWorkspaceId(match?.id ?? response.activeId ?? null);
        } catch {
          if (!cancelled) setOpenworkServerWorkspaceId(null);
        }
      };

      void resolveWorkspace();
      onCleanup(() => {
        cancelled = true;
      });
      return;
    }

    setOpenworkServerWorkspaceId(null);
  });

  const resolveActiveSharedBundleImportTarget =
    (): SharedBundleImportTarget => {
      const active = workspaceStore.activeWorkspaceDisplay();
      if (active.workspaceType === "local") {
        return { localRoot: workspaceStore.activeWorkspaceRoot().trim() };
      }

      return {
        workspaceId:
          active.openworkWorkspaceId?.trim() ||
          parseOpenworkWorkspaceIdFromUrl(active.openworkHostUrl ?? "") ||
          parseOpenworkWorkspaceIdFromUrl(active.baseUrl ?? "") ||
          null,
        directoryHint: active.directory?.trim() || active.path?.trim() || null,
      };
    };

  createEffect(() => {
    const request = pendingSharedBundleInvite();
    if (!request || booting()) {
      return;
    }

    if (sharedBundleImportBusy()) {
      return;
    }

    let cancelled = false;
    setSharedBundleImportBusy(true);

    void (async () => {
      try {
        await processSharedBundleInvite(request);
        if (cancelled) return;
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : safeStringify(error);
          setError(addOpencodeCacheHint(message));
        }
      } finally {
        if (!cancelled) {
          setSharedBundleImportBusy(false);
          setPendingSharedBundleInvite(null);
          setSharedBundleNoticeShown(false);
        }
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!developerMode()) {
      setDevtoolsWorkspaceId(null);
      return;
    }
    if (!documentVisible()) return;

    const client = devtoolsOpenworkClient();
    if (!client) {
      setDevtoolsWorkspaceId(null);
      return;
    }

    const root = normalizeDirectoryPath(
      workspaceStore.activeWorkspaceRoot().trim(),
    );
    let active = true;

    const run = async () => {
      try {
        const response = await client.listWorkspaces();
        if (!active) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const activeMatch = response.activeId
          ? items.find((item) => item.id === response.activeId)
          : null;
        const match = root
          ? items.find((item) => normalizeDirectoryPath(item.path) === root)
          : (activeMatch ?? items[0]);
        setDevtoolsWorkspaceId(activeMatch?.id ?? match?.id ?? null);
      } catch {
        if (active) setDevtoolsWorkspaceId(null);
      }
    };

    run();
    const interval = window.setInterval(run, 20_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  // Keyed on activeWorkspaceId only (not on the full workspace display object
  // or on openworkServerSettings()) so this effect only fires when the user
  // actually switches the active workspace. Previously it also re-ran on
  // every settings/token change, which meant a background token refresh
  // (ServiceHub ready, Plan C 401 auto-refresh) writing a fresh token into
  // settings would immediately be reverted by this effect back to the active
  // workspace's own (possibly stale, disk-persisted) cached token — see
  // workspace.ts syncOpenworkTokens/onBackendTokenRefresh comments for the
  // race this caused.
  createEffect(
    on(workspaceStore.activeWorkspaceId, () => {
      const next = nextOpenworkServerSettingsForWorkspace(
        workspaceStore.activeWorkspaceDisplay(),
        openworkServerSettings(),
      );
      if (next) updateOpenworkServerSettings(next);
    }),
  );

  const openworkServerReady = createMemo(
    () => openworkServerStatus() === "connected",
  );
  const openworkServerWorkspaceReady = createMemo(() =>
    Boolean(openworkServerWorkspaceId()),
  );

  const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, i) => deepEqual(item, (b as unknown[])[i]));
    }
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((k, i) => k === bKeys[i])) return false;
    return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
  };

  const resolvedOpenworkCapabilities = createMemo(
    () => openworkServerCapabilities(),
    null,
    { equals: (a, b) => deepEqual(a, b) },
  );
  const openworkServerCanWriteSkills = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.skills?.write ?? false),
  );
  const openworkServerCanWritePlugins = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.plugins?.write ?? false),
  );
  const resolvedDevtoolsWorkspaceId = createMemo(
    () => devtoolsWorkspaceId() ?? openworkServerWorkspaceId(),
  );

  const refreshLlmRouterProviders = async () => {
    const settings = serviceHubSettings();
    if (!settings) {
      setLlmRouterProviders([]);
      return [] as LlmRouterProviderOption[];
    }

    const providers = await loadLlmRouterProviderOptions(settings);
    setLlmRouterProviders(providers);
    return providers;
  };

  const providerAuth = useProviderAuth({
    llmRouterClient,
    refreshLlmRouterProviders,
  });
  const providerAuthModalOpen = providerAuth.providerAuthModalOpen;
  const providerAuthBusy = providerAuth.busy;
  const providerAuthError = providerAuth.error;
  const providerAuthMethods = providerAuth.authMethods;

  const loadProviderModels = async (provider: string) => {
    const lrm = llmRouterClient();
    if (!lrm) throw new Error("ServiceHub is not connected.");
    const result = await lrm.listProviderModels(provider);
    return result.data ?? [];
  };

  const [editRemoteWorkspaceOpen, setEditRemoteWorkspaceOpen] =
    createSignal(false);
  const [editRemoteWorkspaceId, setEditRemoteWorkspaceId] = createSignal<
    string | null
  >(null);
  const [editRemoteWorkspaceError, setEditRemoteWorkspaceError] = createSignal<
    string | null
  >(null);
  const [deepLinkRemoteWorkspaceDefaults, setDeepLinkRemoteWorkspaceDefaults] =
    createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingRemoteConnectDeepLink, setPendingRemoteConnectDeepLink] =
    createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingDenAuthDeepLink, setPendingDenAuthDeepLink] =
    createSignal<DenAuthDeepLink | null>(null);
  const [processingDenAuthDeepLink, setProcessingDenAuthDeepLink] =
    createSignal(false);
  const [pendingSharedBundleInvite, setPendingSharedBundleInvite] =
    createSignal<SharedBundleDeepLink | null>(null);
  const [sharedBundleCreateWorkerRequest, setSharedBundleCreateWorkerRequest] =
    createSignal<SharedBundleCreateWorkerRequest | null>(null);
  const [sharedSkillDestinationRequest, setSharedSkillDestinationRequest] =
    createSignal<SharedSkillDestinationRequest | null>(null);
  const [sharedSkillDestinationBusyId, setSharedSkillDestinationBusyId] =
    createSignal<string | null>(null);
  const [sharedBundleImportChoice, setSharedBundleImportChoice] =
    createSignal<SharedBundleImportChoice | null>(null);
  const [sharedBundleImportBusy, setSharedBundleImportBusy] =
    createSignal(false);
  const [sharedBundleImportError, setSharedBundleImportError] = createSignal<
    string | null
  >(null);
  const [sharedBundleNoticeShown, setSharedBundleNoticeShown] =
    createSignal(false);
  const [sharedSkillSuccessToast, setSharedSkillSuccessToast] =
    createSignal<SharedSkillSuccessToast | null>(null);

  const sharedBundleImportFlow = createSharedBundleImportFlow({
    openworkServerClient: () => openworkServerClient(),
    openworkServerStatus: () => openworkServerStatus(),
    setOpenworkServerWorkspaceId,
    refreshSkills: async (options?: { force?: boolean }) => {
      await refreshSkills(options);
    },
    refreshHubSkills: async (options?: { force?: boolean }) => {
      await refreshHubSkills(options);
    },
    markReloadRequired,
    safeStringify,
    setError,
    resolveSharedBundleWorkerTarget: () =>
      resolveSharedBundleWorkerTarget({
        preference: startupPreference(),
        hostInfo: openworkServerHostInfo(),
        settings: openworkServerSettings(),
      }),
    resolveSharedBundleImportTargetForWorkspace,
    resolveActiveSharedBundleImportTarget,
    findSharedBundleImportWorkspaceId,
    workspaceStore: {
      createRemoteWorkspaceFlow: workspaceStore.createRemoteWorkspaceFlow,
      activateWorkspace: workspaceStore.activateWorkspace,
      setCreateWorkspaceOpen: workspaceStore.setCreateWorkspaceOpen,
      workspaces: workspaceStore.workspaces,
    },
    openSettings,
    setSharedSkillDestinationRequest,
    setSharedBundleImportChoice,
    setSharedBundleCreateWorkerRequest,
    setSharedBundleNoticeShown,
    sharedBundleNoticeShown,
  });

  const importSharedBundlePayload =
    sharedBundleImportFlow.importSharedBundlePayload;
  const importSharedBundleIntoActiveWorker =
    sharedBundleImportFlow.importSharedBundleIntoActiveWorker;
  const createWorkerForSharedBundle =
    sharedBundleImportFlow.createWorkerForSharedBundle;
  const processSharedBundleInvite =
    sharedBundleImportFlow.processSharedBundleInvite;

  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = createSignal(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = createSignal<string | null>(
    null,
  );
  const [renameWorkspaceName, setRenameWorkspaceName] = createSignal("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = createSignal(false);
  let sharedSkillSuccessToastTimer: number | null = null;

  const clearSharedSkillSuccessToast = () => {
    if (sharedSkillSuccessToastTimer) {
      window.clearTimeout(sharedSkillSuccessToastTimer);
      sharedSkillSuccessToastTimer = null;
    }
    setSharedSkillSuccessToast(null);
  };

  const showSharedSkillSuccessToast = (toast: SharedSkillSuccessToast) => {
    if (sharedSkillSuccessToastTimer) {
      window.clearTimeout(sharedSkillSuccessToastTimer);
    }
    setSharedSkillSuccessToast(toast);
    sharedSkillSuccessToastTimer = window.setTimeout(() => {
      sharedSkillSuccessToastTimer = null;
      setSharedSkillSuccessToast(null);
    }, 4200);
  };

  onCleanup(() => {
    if (sharedSkillSuccessToastTimer) {
      window.clearTimeout(sharedSkillSuccessToastTimer);
    }
  });

  const createWorkspaceDefaultPreset = createMemo<WorkspacePreset>(
    () => sharedBundleCreateWorkerRequest()?.defaultPreset ?? "starter",
  );

  const sharedSkillDestinationWorkspaces = createMemo(() =>
    sortSharedSkillDestinations(
      workspaceStore.workspaces(),
      workspaceStore.activeWorkspaceId(),
    ),
  );

  const queueRemoteConnectDeepLink = (rawUrl: string): boolean => {
    const parsed = parseRemoteConnectDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingRemoteConnectDeepLink(parsed);
    return true;
  };

  const queueDenAuthDeepLink = (rawUrl: string): boolean => {
    const parsed = parseDenAuthDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingDenAuthDeepLink(parsed);
    return true;
  };

  const queueSharedBundleDeepLink = (rawUrl: string): boolean => {
    const parsed = parseSharedBundleDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingSharedBundleInvite(parsed);
    setSharedSkillDestinationRequest(null);
    setSharedSkillDestinationBusyId(null);
    setSharedBundleImportChoice(null);
    setSharedBundleCreateWorkerRequest(null);
    setSharedBundleImportError(null);
    setSharedBundleNoticeShown(false);
    return true;
  };

  const closeSharedBundleImportChoice = () => {
    if (sharedBundleImportBusy()) return;
    setSharedBundleImportChoice(null);
    setSharedBundleImportError(null);
  };

  const sharedBundleImportCopy = createMemo(() => {
    const choice = sharedBundleImportChoice();
    if (!choice) return null;
    return describeSharedBundleImport(choice.bundle);
  });

  const sharedBundleWorkerOptions = createMemo(() =>
    buildSharedBundleWorkerOptions(
      workspaceStore.workspaces(),
      workspaceStore.activeWorkspaceId(),
    ),
  );

  const {
    importSharedBundleIntoExistingWorkspace,
    importSharedSkillIntoWorkspace,
    openSharedBundleCreateWorkerFlow,
  } = createSharedBundleActions({
    error,
    setError,
    openSettings,
    sharedBundleImportBusy,
    setSharedBundleImportBusy,
    sharedBundleImportChoice,
    setSharedBundleImportChoice,
    setSharedBundleImportError,
    setSharedBundleCreateWorkerRequest,
    setSharedBundleNoticeShown,
    sharedSkillDestinationBusyId,
    setSharedSkillDestinationBusyId,
    sharedSkillDestinationRequest,
    setSharedSkillDestinationRequest,
    showSharedSkillSuccessToast,
    createWorkerForSharedBundle,
    importSharedBundleIntoActiveWorker,
    importSharedBundlePayload,
    resolveActiveSharedBundleImportTarget,
    workspaceStore: {
      activateWorkspace: workspaceStore.activateWorkspace,
      setCreateWorkspaceOpen: workspaceStore.setCreateWorkspaceOpen,
      workspaces: workspaceStore.workspaces,
    },
  });

  createEffect(() => {
    const pending = pendingDenAuthDeepLink();
    if (!pending || booting() || processingDenAuthDeepLink()) {
      return;
    }

    setProcessingDenAuthDeepLink(true);
    setPendingDenAuthDeepLink(null);
    openSettings(developerMode() ? "den" : "model");

    void createDenClient({ baseUrl: pending.denBaseUrl })
      .exchangeDesktopHandoff(pending.grant)
      .then((result) => {
        if (!result.token) {
          throw new Error(
            "Desktop sign-in completed, but Den did not return a session token.",
          );
        }

        writeDenSettings({
          baseUrl: pending.denBaseUrl,
          authToken: result.token,
          activeOrgId: null,
        });

        window.dispatchEvent(
          new CustomEvent("openwork-den-session-updated", {
            detail: {
              status: "success",
              email: result.user?.email ?? null,
            },
          }),
        );
      })
      .catch((error) => {
        window.dispatchEvent(
          new CustomEvent("openwork-den-session-updated", {
            detail: {
              status: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to complete OpenWork Den sign-in.",
            },
          }),
        );
      })
      .finally(() => {
        setProcessingDenAuthDeepLink(false);
      });
  });

  createEffect(() => {
    const pending = pendingRemoteConnectDeepLink();
    if (!pending || booting()) {
      return;
    }

    setDeepLinkRemoteWorkspaceDefaults(pending);
    workspaceStore.setCreateRemoteWorkspaceOpen(true);
    setPendingRemoteConnectDeepLink(null);
  });

  createEffect(() => {
    if (workspaceStore.createRemoteWorkspaceOpen()) {
      return;
    }
    if (!deepLinkRemoteWorkspaceDefaults()) {
      return;
    }
    setDeepLinkRemoteWorkspaceDefaults(null);
  });

  const editRemoteWorkspaceDefaults = createMemo(() => {
    const workspaceId = editRemoteWorkspaceId();
    if (!workspaceId) return null;
    const workspace =
      workspaceStore.workspaces().find((item) => item.id === workspaceId) ??
      null;
    if (!workspace || workspace.workspaceType !== "remote") return null;
    return {
      openworkHostUrl: workspace.openworkHostUrl ?? workspace.baseUrl ?? "",
      openworkToken:
        workspace.openworkToken ?? openworkServerSettings().token ?? "",
      directory: workspace.directory ?? "",
      displayName: workspace.displayName ?? "",
    };
  });

  const openRenameWorkspace = (workspaceId: string) => {
    const workspace =
      workspaceStore.workspaces().find((item) => item.id === workspaceId) ??
      null;
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceName(
      workspace.displayName?.trim() ||
      workspace.openworkWorkspaceName?.trim() ||
      workspace.name?.trim() ||
      "",
    );
    setRenameWorkspaceOpen(true);
  };

  const closeRenameWorkspace = () => {
    if (renameWorkspaceBusy()) return;
    setRenameWorkspaceOpen(false);
    setRenameWorkspaceId(null);
    setRenameWorkspaceName("");
  };

  const canReloadLocalEngine = () =>
    isTauriRuntime() &&
    workspaceStore.activeWorkspaceDisplay().workspaceType === "local";

  const canReloadWorkspace = createMemo(() => {
    if (canReloadLocalEngine()) return true;
    if (workspaceStore.activeWorkspaceDisplay().workspaceType !== "remote")
      return false;
    return (
      openworkServerStatus() === "connected" &&
      Boolean(openworkServerClient() && openworkServerWorkspaceId())
    );
  });

  const {
    openWorkspaceConnectionSettings,
    reconnectOpenworkServer,
    reloadWorkspaceEngineFromUi,
    saveRenameWorkspace,
    testOpenworkServerConnection,
  } = createOpenworkConnectionActions({
    client,
    setError,
    openSettings,
    openworkReconnectBusy,
    setOpenworkReconnectBusy,
    openworkServerAuth,
    openworkServerBaseUrl,
    openworkServerClient,
    openworkServerHostInfo,
    setOpenworkServerHostInfo,
    openworkServerSettings,
    updateOpenworkServerSettings,
    setOpenworkServerCapabilities,
    setOpenworkServerCheckedAt,
    openworkServerStatus,
    setOpenworkServerStatus,
    openworkServerWorkspaceId,
    startupPreference,
    setEditRemoteWorkspaceError,
    setEditRemoteWorkspaceId,
    setEditRemoteWorkspaceOpen,
    setRenameWorkspaceBusy,
    setRenameWorkspaceId,
    setRenameWorkspaceName,
    setRenameWorkspaceOpen,
    renameWorkspaceBusy,
    renameWorkspaceId,
    renameWorkspaceName,
    canReloadLocalEngine,
    refreshMcpServers: () => mcp.refreshMcpServers(),
    refreshProviders,
    setWorkspaceConfigVersion,
    workspaceStore: {
      activateWorkspace: workspaceStore.activateWorkspace,
      activeWorkspaceDisplay: workspaceStore.activeWorkspaceDisplay,
      activeWorkspaceId: workspaceStore.activeWorkspaceId,
      createRemoteWorkspaceFlow: workspaceStore.createRemoteWorkspaceFlow,
      reloadWorkspaceEngine: workspaceStore.reloadWorkspaceEngine,
      updateWorkspaceDisplayName: workspaceStore.updateWorkspaceDisplayName,
      workspaces: workspaceStore.workspaces,
    },
  });

  const { startSkillCreatorRefreshWatch, refreshWrittenSkill } = createSkillCreatorWatch({
    skills,
    refreshSkills,
    bumpCommandsVersion: () => setCommandsVersion((v) => v + 1),
  });

  const {
    engine,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    projectDir: workspaceProjectDir,
    activeWorkspaceSdkDirectory: workspaceSdkDir,
    newAuthorizedDir,
    stopHost,
  } = workspaceStore;

  const mcp = useMcpServers({
    instanceApiBaseUrl: openworkServerBaseUrl,
    instanceApiAuth: openworkServerAuth,
    instanceWorkspaceId: openworkServerWorkspaceId,
    instanceApiStatus: openworkServerStatus,
    instanceCapabilities: resolvedOpenworkCapabilities,
    currentLocale,
    hostMcpClient: hostMcp.available,
    hostMcpAwake: hostMcp.awake,
  });

  const {
    appVersion,
    setAppVersion,
    setProductVersion,
    effectiveVersion,
  } = createAppUpdaterVersionSignals();

  const systemState = createSystemState({
    client,
    sessions,
    sessionStatusById,
    refreshPlugins,
    refreshSkills,
    refreshMcpServers: mcp.refreshMcpServers,
    reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
    canReloadWorkspaceEngine: () => canReloadWorkspace(),
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
  });

  const {
    reloadRequired,
    reloadCopy,
    reloadTrigger,
    reloadBusy,
    reloadError,
    reloadWorkspaceEngine,
    clearReloadRequired,
    cacheRepairBusy,
    cacheRepairResult,
    repairOpencodeCache,
    updateAutoCheck,
    setUpdateAutoCheck,
    updateStatus,
    setUpdateStatus,
    updateEnv,
    setUpdateEnv,
    checkForUpdates,
    anyActiveRuns,
  } = systemState;

  const { triggerInitialCheck } = installAppUpdaterRuntime({
    booting,
    updateAutoCheck,
    updateStatus,
    setUpdateAutoCheck,
    setUpdateStatus,
    setUpdateEnv,
    checkForUpdates,
    setAppVersion,
    setProductVersion,
  });

  const inAppUpdateBindings = createMemo(() =>
    createInAppUpdateBindings({
      updateStatus,
      updateEnv,
      checkForUpdates,
    }),
  );

  markReloadRequiredHandler = systemState.markReloadRequired;

  const workspaceAutoReloadAvailable = createMemo(() => false);

  const workspaceAutoReloadEnabled = createMemo(() => {
    if (!workspaceAutoReloadAvailable()) return false;
    const cfg = workspaceStore.workspaceConfig();
    return Boolean(cfg?.reload?.auto);
  });

  const workspaceAutoReloadResumeEnabled = createMemo(() => {
    if (!workspaceAutoReloadAvailable()) return false;
    const cfg = workspaceStore.workspaceConfig();
    return Boolean(cfg?.reload?.resume);
  });

  const setWorkspaceAutoReloadEnabled = async (next: boolean) => {
    if (!workspaceAutoReloadAvailable()) return;
    const cfg = workspaceStore.workspaceConfig();
    const resume = Boolean(cfg?.reload?.resume);
    await workspaceStore.persistReloadSettings({
      auto: next,
      resume: next ? resume : false,
    });
  };

  const setWorkspaceAutoReloadResumeEnabled = async (next: boolean) => {
    if (!workspaceAutoReloadAvailable()) return;
    const cfg = workspaceStore.workspaceConfig();
    const auto = Boolean(cfg?.reload?.auto);
    await workspaceStore.persistReloadSettings({
      auto,
      resume: auto ? next : false,
    });
  };

  const reloadWorkspaceEngineAndResume = async () => {
    await reloadWorkspaceEngine();
  };

  const activeReloadBlockingSessions = createMemo(() => {
    const statuses = sessionStatusById();
    return sessions()
      .filter((session) => statuses[session.id] === "running")
      .map((session) => ({
        id: session.id,
        title: session.title?.trim() || session.slug?.trim() || session.id,
      }));
  });

  const forceStopActiveSessionsAndReload = async () => {
    const activeSessions = activeReloadBlockingSessions();
    for (const session of activeSessions) {
      try {
        await abortSession(session.id);
      } catch {
        // ignore and continue stopping the rest before reload
      }
    }
    await reloadWorkspaceEngineAndResume();
  };

  onMount(() => {
    // OpenCode hot reload drives freshness now; OpenWork no longer listens for
    // legacy reload-required events.
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    workspaceStore.activeWorkspaceId();
    workspaceProjectDir();
    client();
    workspaceSdkDir();
    void mcp.refreshMcpServers();
  });

  // For non-Tauri (web) environments, re-trigger MCP refresh when the
  // SuperClaw server connection becomes ready. On page load the dashboard
  // effect may call refreshMcpServers before the server/workspace signals
  // are populated, hitting the "only available for local workspaces" bail-out.
  createEffect(() => {
    if (isTauriRuntime()) return;
    if (openworkServerStatus() !== "connected") return;
    if (!openworkServerClient() || !openworkServerWorkspaceId()) return;
    workspaceStore.activeWorkspaceId();
    void mcp.refreshMcpServers();
  });

  const activeAuthorizedDirs = createMemo(() =>
    workspaceStore.authorizedDirs(),
  );
  const activeWorkspaceDisplay = createMemo(() =>
    workspaceStore.activeWorkspaceDisplay(),
  );
  const activePermissionMemo = createMemo(() => activePermission());
  const migrationRepairUnavailableReason = createMemo<string | null>(() => {
    if (workspaceStore.canRepairOpencodeMigration()) return null;
    if (!isTauriRuntime()) {
      return t("app.migration.desktop_required", currentLocale());
    }

    if (activeWorkspaceDisplay().workspaceType !== "local") {
      return t("app.migration.local_only", currentLocale());
    }

    if (!workspaceStore.activeWorkspacePath().trim()) {
      return t("app.migration.workspace_required", currentLocale());
    }

    return t("app.migration.local_only", currentLocale());
  });

  const [expandedStepIds, setExpandedStepIds] = createSignal<Set<string>>(
    new Set(),
  );
  const [expandedSidebarSections, setExpandedSidebarSections] = createSignal({
    progress: true,
    artifacts: true,
    context: false,
    plugins: false,
    mcp: false,
    skills: true,
    authorizedFolders: false,
  });
  const [autoConnectAttempted, setAutoConnectAttempted] = createSignal(false);

  onMount(() => {
    const disposeCrashHandlers = installFrontendCrashHandlers({
      fullTelemetryEnabled,
      appVersion: effectiveVersion,
    });
    onCleanup(() => {
      disposeCrashHandlers();
    });
  });

  const busySeconds = createMemo(() => elapsedSeconds(busyStartedAt(), Date.now()));

  const newTaskDisabled = createMemo(() =>
    isNewTaskDisabled({
      hasClient: Boolean(client()),
      busy: busy(),
      busyLabel: busyLabel(),
    }),
  );

  createEffect(() => {
    if (isTauriRuntime()) return;
    if (autoConnectAttempted()) return;
    if (client()) return;
    if (openworkServerStatus() !== "connected") return;

    const settings = openworkServerSettings();
    if (!settings.urlOverride || !settings.token) return;

    setAutoConnectAttempted(true);
    void workspaceStore.onConnectClient();
  });

  const llmRouterResolvedModelMap = createMemo<Record<string, string | null>>(
    () => {
      const localName = localModelHealth()?.model?.trim() || null;
      const configuredCloud = cloudModel();
      const cloudName = configuredCloud
        ? `${configuredCloud.provider}/${configuredCloud.model}`
        : null;

      return {
        "llmrouter/auto": null,
        "llmrouter/local-model": localName,
        "llmrouter/cloud-model": cloudName,
      };
    },
  );

  const getLlmRouterResolvedModelName = (modelID: string) =>
    llmRouterResolvedModelMap()[`llmrouter/${modelID}`] ?? null;

  // With no cloud model saved, Cloud leaves the main page picker, and every
  // stored Cloud pick moves to Auto (see app.hidden-cloud-route).
  const hideCloudRoute = createHiddenCloudRoute({
    allowedAliases: () => allowedSessionRouteAliases(capabilityGate.activeProfile()),
    cloudModelMissing, defaultModel, setDefaultModel, pendingSessionModel, setPendingSessionModel,
    selectedSessionId, modelFromMessages: () => lastUserModelFromMessages(messages()),
    sessionModelById, sessionModelOverrideById, setSessionModelOverrideById,
  });

  const selectedSessionModel = createMemo<ModelRef>(() =>
    routeAwayFromHiddenCloud(resolveEffectiveSessionModel({
      agentsForceLocalModel: AGENTS_FORCE_LOCAL_MODEL,
      defaultModel,
      localLlmModel: resolveLocalLlmModel,
      modelFromMessages: () => lastUserModelFromMessages(messages()),
      pendingSessionAgent,
      pendingSessionModel,
      profile: capabilityGate.activeProfile(),
      selectedSessionId: selectedSessionId(),
      sessionModelById,
      sessionModelOverrideById,
    }), hideCloudRoute()),
  );

  // Wired here rather than where these operations are used: `workspaceSdkDir`
  // and `refreshSidebarWorkspaceSessions` are declared above but after the
  // bodies that read them, and the factory reads the object eagerly.
  const {
    deleteSessionById,
    listAgents,
    listCommands,
    renameSessionTitle,
    saveSessionExport,
    upsertLocalSession,
  } = createSessionCrud({
    client,
    navigate,
    openworkServerClient,
    chatGrantClient: instanceApiClient,
    readSessionByWorkspace,
    writeSessionByWorkspace,
    refreshSidebarWorkspaceSessions,
    renameSession,
    resolvedDevtoolsWorkspaceId,
    routerPathname: () => location.pathname,
    selectedSessionId,
    setSelectedSessionId,
    sessions,
    setSessions,
    sessionStatusById,
    setSessionStatusById,
    setSidebarSessionsByWorkspaceId,
    skills,
    workspaceSdkDir,
    workspaceStore: {
      activeWorkspaceId: workspaceStore.activeWorkspaceId,
      activeWorkspaceRoot: workspaceStore.activeWorkspaceRoot,
    },
  });

  // Wired here rather than where these actions are used: `workspaceSdkDir` and
  // `selectedSessionModel` are the last dependencies to be declared, and the
  // factory reads the object eagerly.
  const {
    abortSession,
    compactCurrentSession,
    retryLastPrompt,
    submitEditedUserMessage,
    triggerAutoCompaction,
  } = createSessionRunControls({
    appendSessionCompactTurn,
    autoCompactContext,
    autoCompactingSessionId,
    client,
    developerMode,
    lastPromptSent,
    messages,
    modelVariant,
    selectedSession,
    selectedSessionId,
    selectedSessionModel,
    sendPrompt: (draft, options) => sendPrompt(draft, options),
    sessionStore,
    setAutoCompactingSessionId,
    setMessages,
    setSessionClassifierUserTurnsById,
    upsertLocalSession,
    visibleMessages,
    workspaceSdkDir,
  });

  const selectedSessionAgent = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return pendingSessionAgent();
    return sessionAgentById()[id] ?? null;
  });

  const selectedSessionModelLabel = createMemo(() => {
    const selected = selectedSessionModel();
    if (isLlmRouterSessionModel(selected)) {
      return formatLlmRouterSessionModelLabel(selected.modelID);
    }
    return formatModelLabel(selected, providers());
  });

  const selectedSessionModelIsLocal = createMemo(() =>
    selectedSessionModel().providerID === "llmrouter"
      ? selectedSessionModel().modelID === "local-model"
      : isLocalProvider(
        selectedSessionModel().providerID,
        selectedSessionModel().modelID,
      ),
  );

  // True once the selected session's model is known from any source.
  const sessionHasModelData = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return true; // no session → no need to defer
    return !!(
      sessionModelOverrideById()[id] ||
      sessionModelById()[id] ||
      lastUserModelFromMessages(messages())
    );
  });

  // Fall back to llmrouter/auto when the persisted default model's provider
  // or model no longer exists in the providers list.
  createEffect(() => {
    const providerList = selectableProviders();
    if (!providerList.length) return;

    const current = defaultModel();
    if (
      current.providerID === FALLBACK_MODEL.providerID &&
      current.modelID === FALLBACK_MODEL.modelID
    )
      return;

    // Wait for session model data before validating, so the composer doesn't
    // briefly flash "llmrouter/auto" while the real model is still loading.
    if (!sessionHasModelData()) return;

    if (isLlmRouterSessionModel(current)) return;

    const provider = providerList.find((p) => p.id === current.providerID);
    const modelExists =
      provider &&
      provider.models &&
      Object.hasOwn(provider.models, current.modelID);

    if (!provider || !modelExists) {
      setDefaultModel(FALLBACK_MODEL);
      setLegacyDefaultModel(FALLBACK_MODEL);
    }
  });

  // Migrate stale local-llm session model refs when providers change (e.g. edge model setup/clear).
  // "local-llm" only ever has one model at a time; if a session recorded a modelID that no longer
  // exists in the provider's model list, remap it to the current local-llm model.
  createEffect(() => {
    const currentLocal = resolveLocalLlmModel();
    if (!currentLocal) return;

    const localProvider = providers().find((p) => p.id === "local-llm");
    if (!localProvider) return;
    const localModels = localProvider.models ?? {};

    // Helper: returns the updated modelID if the ref is a stale local-llm entry, else null.
    const migratedModelID = (ref: ModelRef): string | null => {
      if (ref.providerID !== "local-llm") return null;
      if (ref.modelID in localModels) return null; // still valid
      return currentLocal.modelID;
    };

    // --- sessionModelById ---
    const resolved = sessionModelById();
    let resolvedChanged = false;
    const nextResolved: Record<string, ModelRef> = {};
    for (const [sid, ref] of Object.entries(resolved)) {
      const newID = migratedModelID(ref);
      if (newID && newID !== ref.modelID) {
        nextResolved[sid] = { providerID: ref.providerID, modelID: newID };
        resolvedChanged = true;
      } else {
        nextResolved[sid] = ref;
      }
    }
    if (resolvedChanged) setSessionModelById(nextResolved);

    // --- sessionModelOverrideById ---
    const overrides = sessionModelOverrideById();
    let overridesChanged = false;
    const nextOverrides: Record<string, ModelRef> = {};
    for (const [sid, ref] of Object.entries(overrides)) {
      const newID = migratedModelID(ref);
      if (newID && newID !== ref.modelID) {
        nextOverrides[sid] = { providerID: ref.providerID, modelID: newID };
        overridesChanged = true;
      } else {
        nextOverrides[sid] = ref;
      }
    }
    if (overridesChanged) setSessionModelOverrideById(nextOverrides);
  });

  // Cloud-only Lite keeps stored auto/local picks on cloud-model.
  createCloudOnlyRouteRewrite({
    activeProfile: capabilityGate.activeProfile, defaultModel, setDefaultModel,
    pendingSessionModel, setPendingSessionModel, sessionModelOverrideById, setSessionModelOverrideById,
  });
  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default"
      ? normalizeSessionRouteForProfile(
        defaultModel(),
        capabilityGate.activeProfile(),
      )
      : selectedSessionModel(),
  );

  // All allowed providers (settings + internal) — used for model picker.
  const filteredProviders = createMemo(() =>
    selectableProviders().filter((p) => isAllowedProvider(p.id)),
  );
  // Settings-visible providers only — used for Settings page and auth modal.
  const settingsProviders = createMemo(() => llmRouterProviders());
  const settingsProviderConnectedIds = createMemo(() =>
    llmRouterProviders()
      .filter((provider) => provider.configured)
      .map((provider) => provider.id),
  );

  // Under Lite the picker collapses to Cloud only; every other Profile keeps
  // all three route aliases. Policy lives in session-route-policy, not here.
  const modelOptions = createMemo<ModelOption[]>(() =>
    buildModelOptions({
      allowedAliases: allowedSessionRouteAliases(capabilityGate.activeProfile()),
      hideCloudRoute: hideCloudRoute(),
      getResolvedModelName: getLlmRouterResolvedModelName,
    }),
  );

  const filteredModelOptions = createMemo(() =>
    filterModelOptions(modelOptions(), modelPickerQuery()),
  );

  // Wired here rather than where these are used: `selectedSessionModel` is the
  // last dependency to be declared, and the factory reads the object eagerly.
  const {
    applySessionAgentModelPolicy,
    clearSessionAgentManagedModel,
    clearSessionAgentManagedModelMarker,
    confirmEmailAgentCloudRisk,
    openLocalLlmSettingsFromWarning,
    prepareSessionAgentModelPolicy,
    resolveEmailAgentCloudRisk,
  } = createAgentManagedModel({
    agentsForceLocalModel: AGENTS_FORCE_LOCAL_MODEL,
    defaultModel,
    emailAgentCloudRiskAcknowledged,
    openSettings,
    resolveLocalLlmModel,
    selectedSessionId,
    selectedSessionModel,
    sessionAgentManagedModelById,
    setSessionAgentManagedModelById,
    sessionModelById,
    sessionModelOverrideById,
    setSessionModelOverrideById,
    setEmailAgentCloudRiskAcknowledged,
    setEmailAgentCloudRiskOpen,
    setLocalLlmConfigWarningOpen,
  });

  // Wired here rather than where these are used: the session branch clears
  // the agent-managed marker, so this must follow `createAgentManagedModel`.
  const {
    applyModelSelection,
    applySessionModelSelection,
    closeModelPicker,
    openDefaultModelPicker,
    openSessionModelPicker,
  } = createModelPickerActions({
    activeProfile: capabilityGate.activeProfile,
    activeWorkspacePath: workspaceStore.activeWorkspacePath,
    activeWorkspaceType: () =>
      workspaceStore.activeWorkspaceDisplay().workspaceType,
    clearSessionAgentManagedModelMarker,
    cloudModel,
    currentLocale,
    focusSessionPromptSoon,
    localModelHealth,
    modelPickerReturnFocusTarget,
    modelPickerTarget,
    selectedSessionId,
    setDefaultModel,
    setDefaultModelExplicit,
    setModelPickerOpen,
    setModelPickerQuery,
    setModelPickerReturnFocusTarget,
    setModelPickerTarget,
    setModelSelectToast,
    setPendingDefaultModelWrite,
    setPendingSessionModel,
    setSessionModelOverrideById,
  });

  const { createSessionAndOpen } = createSessionCreator({
    agentsForceLocalModel: AGENTS_FORCE_LOCAL_MODEL,
    abortRefreshes,
    chatWebAccess: egress.chatWebAccess,
    baseUrl,
    client,
    developerMode,
    goToSession,
    pendingSessionAgent,
    pendingSessionModel,
    prepareSessionAgentModelPolicy,
    resolveLocalLlmModel,
    selectSession,
    sessions,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setCreatingSession,
    setError,
    setLocalLlmConfigWarningOpen,
    setPendingSessionAgent,
    setPendingSessionModel,
    setSessionAgent,
    setSessionModelOverrideById,
    setSessions,
    setSidebarSessionStatusByWorkspaceId,
    setSidebarSessionsByWorkspaceId,
    sidebarSessionsByWorkspaceId,
    workspaceStore,
  });

  // Wired here because `createSessionAndOpen` is the last dependency to be
  // declared. The session run controls above take `sendPrompt` as a thunk for
  // the same reason: both directions are only ever called from a user action,
  // long after `App()` has finished setting up.
  const { sendPrompt, dispatchingSessions } = createPromptDispatch({
    appendSessionClassifierUserTurn,
    applySessionAgentModelPolicy,
    capabilityGate,
    classifierAmbiguousPromptsBySessionId,
    classifierResolvedSessionById,
    client,
    compactCurrentSession,
    confirmEmailAgentCloudRisk,
    createSessionAndOpen,
    customPiiCategories,
    developerMode,
    listAgents,
    localModelExplicitlyUnavailable,
    messages,
    modelVariant,
    openworkServerClient,
    openworkServerWorkspaceId,
    piiLevel,
    prompt,
    selectedSessionAgent,
    selectedSessionId,
    selectedSessionModel,
    selectedSessionModelIsLocal,
    sessionStore,
    setBusyLabel,
    setBusyStartedAt,
    setClassifierAmbiguousPromptsBySessionId,
    setClassifierResolvedSessionById,
    setComposerAttachmentUpload,
    setDispatchBusy,
    setError,
    setLastPromptSent,
    setLocalLlmConfigWarningOpen,
    setPrompt,
    setSessionAgent,
    setSessionModelById,
    startSkillCreatorRefreshWatch,
    stopNarration,
    workspaceSdkDir,
  });

  onMount(async () => {
    const startupPref = readStartupPreference();
    if (startupPref) {
      setRememberStartupChoice(true);
      setStartupPreference(startupPref);
    }

    const unsubscribeTheme = subscribeToSystemTheme((isDark) => {
      if (themeMode() !== "system") return;
      applyThemeMode(isDark ? "dark" : "light");
    });

    onCleanup(() => {
      unsubscribeTheme();
    });

    createEffect(() => {
      const next = themeMode();
      persistThemeMode(next);
      applyThemeMode(next);
    });

    if (typeof window !== "undefined") {
      try {
        const stored = readStoredPreferences(window.localStorage, {
          isTauri: isTauriRuntime(),
        });

        if (stored.baseUrl) setBaseUrl(stored.baseUrl);
        if (stored.clientDirectory) setClientDirectory(stored.clientDirectory);
        if (stored.engineCustomBinPath) {
          setEngineCustomBinPath(stored.engineCustomBinPath);
        }
        if (stored.engineSource) setEngineSource(stored.engineSource);
        if (stored.engineRuntime) setEngineRuntime(stored.engineRuntime);

        setDefaultModel(stored.defaultModel);
        setLegacyDefaultModel(stored.defaultModel);
        if (stored.defaultModelNeedsRewrite) {
          try {
            window.localStorage.setItem(
              MODEL_PREF_KEY,
              formatModelRef(stored.defaultModel),
            );
          } catch {
            // ignore
          }
        }

        if (stored.showThinking != null) setShowThinking(stored.showThinking);
        if (stored.hideTitlebar != null) setHideTitlebar(stored.hideTitlebar);
        if (stored.modelVariant) setModelVariant(stored.modelVariant);
        if (stored.updateAutoCheck != null) {
          setUpdateAutoCheck(stored.updateAutoCheck);
        }
        if (stored.updateLastCheckedAt != null) {
          setUpdateStatus({
            state: "idle",
            lastCheckedAt: stored.updateLastCheckedAt,
          });
        }

        // Auto-compact and the PII level both lost their UI. Drop whatever the
        // old settings left behind so a stale value cannot resurface; PII stays
        // at 'medium' so instruction injection keeps firing.
        forgetPreference(AUTO_COMPACT_CONTEXT_PREF_KEY);
        setAutoCompactContext(false);

        const storedVariant = window.localStorage.getItem(VARIANT_PREF_KEY);
        if (storedVariant && storedVariant.trim()) {
          const normalized = normalizeModelVariant(storedVariant);
          if (normalized) {
            setModelVariant(normalized);
          }
        }

        // PII level UI removed; always keep at 'medium' so instruction injection fires.
        // Clear any stale 'none' that may have been persisted from the old UI.
        try {
          window.localStorage.removeItem(PII_LEVEL_PREF_KEY);
        } catch {
          /* ignore */
        }

        restoreUpdaterLocalStoragePrefs({
          setUpdateAutoCheck,
          setUpdateStatus,
        });

      } catch {
        // ignore
      }
    }

    if (isTauriRuntime()) {
      void runTauriUpdaterStartup({
        setAppVersion,
        setProductVersion,
        setUpdateEnv,
        triggerInitialCheck,
      });

      const stopDeepLinkWatch = await watchTauriDeepLinks(
        (url) =>
          queueDenAuthDeepLink(url) ||
          queueRemoteConnectDeepLink(url) ||
          queueSharedBundleDeepLink(url),
      );
      if (stopDeepLinkWatch) {
        onCleanup(stopDeepLinkWatch);
      }
    }
    if (!isTauriRuntime()) {
      const currentUrl =
        typeof window === "undefined" ? "" : window.location.href;
      if (currentUrl) {
        queueDenAuthDeepLink(currentUrl);
        queueRemoteConnectDeepLink(currentUrl);
        queueSharedBundleDeepLink(currentUrl);
        const remoteStripped =
          stripRemoteConnectQuery(currentUrl) ?? currentUrl;
        const bundleStripped =
          stripSharedBundleQuery(remoteStripped) ?? remoteStripped;
        if (bundleStripped !== currentUrl) {
          window.history.replaceState({}, "", bundleStripped);
        }
      }
    }

    void workspaceStore.bootstrapOnboarding().finally(() => setBooting(false));
  });

  useRuntimeBootLifecycle({
    runtimeBoot,
    isTauriRuntime,
    readOpenworkServerSettings,
    writeOpenworkServerSettings,
    setOpenworkServerSettings,
    setStartupPreference,
    refreshLlmRouterProviders,
    uiLogInfo,
    uiLogWarn,
    uiLogError,
    uiLogDebug,
    setUiBootId,
    getServiceHubBootSnapshot,
    getRecoverableBootSnapshot,
    fetchOwtToken,
    refreshManagedWorkspaceToken,
    server,
    workspaceStore,
    listen,
    startupOwtToken,
    DEFAULT_OPENWORK_SERVER_PORT,
    OWT_EXPIRED_EVENT,
  });

  // [Remote-first] Do not auto-open the remote-worker modal at startup.
  // The installed app receives openworkUrl + owtToken from backend-manager and
  // auto-connects through workspaceStore.onBackendTokenRefresh above; manual
  // and deep-link entry points still open the modal when explicitly requested.

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;

    setSessionModelOverridesReady(false);
    const raw = window.localStorage.getItem(
      sessionModelOverridesKey(workspaceId),
    );
    setSessionModelOverrideById(parseSessionModelOverrides(raw));
    setSessionAgentManagedModelById({});
    setSessionModelOverridesReady(true);
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!sessionModelOverridesReady()) return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;

    const payload = serializeSessionModelOverrides(sessionModelOverrideById());
    try {
      if (payload) {
        window.localStorage.setItem(
          sessionModelOverridesKey(workspaceId),
          payload,
        );
      } else {
        window.localStorage.removeItem(sessionModelOverridesKey(workspaceId));
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;
    const isPendingWrite = pendingDefaultModelWrite();
    workspaceConfigVersion(); // read to subscribe; bumped after edge-model reconnect

    setWorkspaceDefaultModelReady(false);
    const workspaceType = workspaceStore.activeWorkspaceDisplay().workspaceType;
    const workspaceRoot = workspaceStore.activeWorkspacePath().trim();
    const activeClient = client();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = openworkServerWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read;

    let cancelled = false;

    const applyDefault = async () => {
      if (isPendingWrite) {
        return;
      }

      let configDefault: ModelRef | null = null;
      let configFileContent: string | null = null;

      if (workspaceType === "local" && workspaceRoot) {
        if (canUseOpenworkServer) {
          try {
            const config = await openworkClient.getConfig(openworkWorkspaceId);
            if (cancelled) return;
            const model =
              typeof config.opencode?.model === "string"
                ? config.opencode.model
                : null;
            configDefault = parseModelRef(model);
          } catch {
            // ignore
          }
        } else if (isTauriRuntime()) {
          try {
            const configFile = await readOpencodeConfig(
              "project",
              workspaceRoot,
            );
            if (cancelled) return;
            configFileContent = configFile.content;
            configDefault = parseDefaultModelFromConfig(configFile.content);
          } catch {
            // ignore
          }
        }
      } else if (activeClient) {
        try {
          const config = unwrap(
            await activeClient.config.get({
              directory: workspaceRoot || undefined,
            }),
          );
          if (cancelled) return;
          if (typeof config.model === "string") {
            configDefault = parseModelRef(config.model);
          }
        } catch {
          // ignore
        }
      }

      if (cancelled) return;

      // When an edge model transition is in progress, skip overwriting the UI
      // default model — the config file now contains "local-llm/..." but the
      // user's picker selection (e.g. "llmrouter/auto") should be preserved.
      const skipModelUpdate = untrack(preserveDefaultModel);
      if (skipModelUpdate) {
        setPreserveDefaultModel(false);
      } else {
        setDefaultModelExplicit(Boolean(configDefault));
        const nextDefault = configDefault ?? legacyDefaultModel();
        const currentDefault = untrack(defaultModel);
        if (nextDefault && !modelEquals(currentDefault, nextDefault)) {
          setDefaultModel(nextDefault);
        }
      }

      if (workspaceType === "local" && workspaceRoot) {
        setLastKnownConfigSnapshot(getConfigSnapshot(configFileContent));
      }

      setWorkspaceDefaultModelReady(true);
    };

    void applyDefault();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!workspaceDefaultModelReady()) return;
    if (!isTauriRuntime()) return;
    if (!defaultModelExplicit()) return;

    const workspace = workspaceStore.activeWorkspaceDisplay();
    if (workspace.workspaceType !== "local") return;

    const root = workspaceStore.activeWorkspacePath().trim();
    if (!root) return;
    const nextModel = defaultModel();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = openworkServerWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write;
    let cancelled = false;
    const writeGen = ++defaultModelWriteGen;

    const writeConfig = async () => {
      try {
        if (canUseOpenworkServer) {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          const currentModel =
            typeof config.opencode?.model === "string"
              ? parseModelRef(config.opencode.model)
              : null;
          if (currentModel && modelEquals(currentModel, nextModel)) return;

          await openworkClient.patchConfig(openworkWorkspaceId, {
            opencode: { model: formatModelRef(nextModel) },
          });
          markReloadRequired("config", {
            type: "config",
            name: "opencode.json",
            action: "updated",
          });
          return;
        }

        const configFile = await readOpencodeConfig("project", root);
        const existingModel = parseDefaultModelFromConfig(configFile.content);
        if (existingModel && modelEquals(existingModel, nextModel)) return;

        const content = formatConfigWithDefaultModel(
          configFile.content,
          nextModel,
        );
        const result = await writeOpencodeConfig("project", root, content);
        if (!result.ok) {
          throw new Error(
            result.stderr || result.stdout || "Failed to update opencode.json",
          );
        }
        setLastKnownConfigSnapshot(getConfigSnapshot(content));
        markReloadRequired("config", {
          type: "config",
          name: "opencode.json",
          action: "updated",
        });
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : safeStringify(error);
          setError(addOpencodeCacheHint(message));
        }
      } finally {
        // Only clear the flag if this is still the latest write (not superseded by a newer one).
        if (writeGen === defaultModelWriteGen) {
          setPendingDefaultModelWrite(false);
        }
      }
    };

    void writeConfig();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (onboardingStep() !== "local") return;
    void workspaceStore.refreshEngineDoctor();
  });

  persistToLocalStorage("openwork.baseUrl", () => baseUrl());

  persistToLocalStorage("openwork.clientDirectory", () => clientDirectory());

  // Legacy key: keep for backwards compatibility.
  persistToLocalStorage("openwork.projectDir", () => workspaceProjectDir());

  persistToLocalStorage("openwork.engineSource", () => engineSource());

  persistToLocalStorage(
    "openwork.engineCustomBinPath",
    () => engineCustomBinPath().trim() || null,
  );

  persistToLocalStorage("openwork.engineRuntime", () => engineRuntime());

  persistToLocalStorage(MODEL_PREF_KEY, () => formatModelRef(defaultModel()));

  persistToLocalStorage("openwork.updateAutoCheck", () =>
    updateAutoCheck() ? "1" : "0",
  );

  persistToLocalStorage(THINKING_PREF_KEY, () =>
    JSON.stringify(showThinking()),
  );

  persistToLocalStorage(HIDE_TITLEBAR_PREF_KEY, () =>
    JSON.stringify(hideTitlebar()),
  );

  // Always disable native decorations — we use a custom titlebar
  if (isTauriRuntime()) {
    setWindowDecorations(false).catch(() => {
      // ignore errors (e.g., window not ready)
    });
  }

  persistToLocalStorage(VARIANT_PREF_KEY, () => modelVariant() || null);

  const headerConnectedVersion = createMemo(() =>
    resolveHeaderVersion({
      developerMode: developerMode(),
      connectedVersion: connectedVersion(),
      appVersion: appVersion(),
      diagnosticsVersion: openworkServerDiagnostics()?.version ?? null,
    }),
  );

  const headerStatus = createMemo(() =>
    resolveHeaderStatus({
      hasClient: Boolean(client()),
      headerVersion: headerConnectedVersion(),
      sseConnected: sseConnected(),
    }),
  );

  const busyHint = createMemo(() =>
    resolveBusyHint({
      busy: busy(),
      busyLabel: busyLabel(),
      seconds: busySeconds(),
    }),
  );

  const workspaceSwitchWorkspace = createMemo(() => {
    const switchingId = workspaceStore.connectingWorkspaceId();
    if (switchingId) {
      return (
        workspaceStore.workspaces().find((ws) => ws.id === switchingId) ??
        activeWorkspaceDisplay()
      );
    }
    return activeWorkspaceDisplay();
  });

  // Avoid flashing the full-screen switch overlay for fast workspace switches.
  // Only show it if a switch is still in progress after a short delay.
  const [workspaceSwitchDelayElapsed, setWorkspaceSwitchDelayElapsed] =
    createSignal(false);
  createEffect(() => {
    if (typeof window === "undefined") return;
    const switchingId = workspaceStore.connectingWorkspaceId();
    if (!switchingId) {
      setWorkspaceSwitchDelayElapsed(false);
      return;
    }

    setWorkspaceSwitchDelayElapsed(false);
    const timer = window.setTimeout(() => setWorkspaceSwitchDelayElapsed(true), 250);
    onCleanup(() => window.clearTimeout(timer));
  });

  const workspaceSwitchOpen = createMemo(() =>
    isWorkspaceSwitchOpen({
      booting: booting(),
      capabilityStartupHandled: capabilityStartupHandled(),
      connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
      startupActivationGrace: startupActivationGrace(),
      modelSwitchApplying: bundleSwitchApplying(),
      switchDelayElapsed: workspaceSwitchDelayElapsed(),
      busy: busy(),
      busyLabel: busyLabel(),
    }),
  );

  const workspaceSwitchStatusKey = createMemo(() =>
    resolveWorkspaceSwitchStatusKey({
      busyLabel: busyLabel(),
      connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
    }),
  );

  const localHostLabel = createMemo(() => {
    const info = engine();
    return resolveLocalHostLabel({
      hostname: info?.hostname,
      port: info?.port,
      baseUrl: baseUrl(),
    });
  });

  const onboardingProps = () => ({
    startupPreference: startupPreference(),
    onboardingStep: onboardingStep(),
    rememberStartupChoice: rememberStartupChoice(),
    busy: busy(),
    clientDirectory: clientDirectory(),
    openworkHostUrl: openworkServerSettings().urlOverride ?? "",
    openworkToken: openworkServerSettings().token ?? "",
    newAuthorizedDir: newAuthorizedDir(),
    authorizedDirs: workspaceStore.authorizedDirs(),
    activeWorkspacePath: workspaceStore.activeWorkspacePath(),
    workspaces: workspaceStore.workspaces(),
    localHostLabel: localHostLabel(),
    engineRunning: Boolean(engine()?.running),
    developerMode: developerMode(),
    engineBaseUrl: engine()?.baseUrl ?? null,
    engineDoctorFound: engineDoctorResult()?.found ?? null,
    engineDoctorSupportsServe: engineDoctorResult()?.supportsServe ?? null,
    engineDoctorVersion: engineDoctorResult()?.version ?? null,
    engineDoctorResolvedPath: engineDoctorResult()?.resolvedPath ?? null,
    engineDoctorNotes: engineDoctorResult()?.notes ?? [],
    engineDoctorServeHelpStdout: engineDoctorResult()?.serveHelpStdout ?? null,
    engineDoctorServeHelpStderr: engineDoctorResult()?.serveHelpStderr ?? null,
    engineDoctorCheckedAt: engineDoctorCheckedAt(),
    engineInstallLogs: engineInstallLogs(),
    error: error(),
    canRepairMigration: workspaceStore.canRepairOpencodeMigration(),
    migrationRepairUnavailableReason: migrationRepairUnavailableReason(),
    migrationRepairBusy: workspaceStore.migrationRepairBusy(),
    migrationRepairResult: workspaceStore.migrationRepairResult(),
    isWindows: isWindowsPlatform(),
    onClientDirectoryChange: setClientDirectory,
    onOpenworkHostUrlChange: (value: string) =>
      updateOpenworkServerSettings({
        ...openworkServerSettings(),
        urlOverride: value,
      }),
    onOpenworkTokenChange: (value: string) =>
      updateOpenworkServerSettings({
        ...openworkServerSettings(),
        token: value,
      }),
    onSelectStartup: workspaceStore.onSelectStartup,
    onRememberStartupToggle: workspaceStore.onRememberStartupToggle,
    onStartHost: workspaceStore.onStartHost,
    onRepairMigration: workspaceStore.onRepairOpencodeMigration,
    onCreateWorkspace: workspaceStore.createWorkspaceFlow,
    onPickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
    onImportWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
    onAttachHost: workspaceStore.onAttachHost,
    onConnectClient: workspaceStore.onConnectClient,
    onBackToWelcome: workspaceStore.onBackToWelcome,
    onSetAuthorizedDir: workspaceStore.setNewAuthorizedDir,
    onAddAuthorizedDir: workspaceStore.addAuthorizedDir,
    onAddAuthorizedDirFromPicker: () =>
      workspaceStore.addAuthorizedDirFromPicker({ persistToWorkspace: true }),
    onRemoveAuthorizedDir: workspaceStore.removeAuthorizedDirAtIndex,
    onRefreshEngineDoctor: async () => {
      workspaceStore.setEngineInstallLogs(null);
      await workspaceStore.refreshEngineDoctor();
    },
    onInstallEngine: workspaceStore.onInstallEngine,
    onShowSearchNotes: () => {
      const notes =
        workspaceStore.engineDoctorResult()?.notes?.join("\n") ?? "";
      workspaceStore.setEngineInstallLogs(notes || null);
    },
    onOpenSettings: () => openSettings(),
    themeMode: themeMode(),
    setThemeMode,
  });

  const dashboardAccess = createMemo(() =>
    computeDashboardAccess({
      workspaceType: activeWorkspaceDisplay().workspaceType,
      isTauri: isTauriRuntime(),
      openworkStatus: openworkServerStatus(),
      canWriteSkills: openworkServerCanWriteSkills(),
      canWritePlugins: openworkServerCanWritePlugins(),
    }),
  );

  const dashboardProps = () => {
    return {
      get tab() { return tab(); },
      setTab,
      openSettings,
      // Settings > Voice input. Passing the controller is what makes the tab
      // appear (settings.tsx gates `availableTabs` on it).
      voice: voiceInput,
      versionLabel: versionInfo.versionLabel,
      debugBuildCommit: versionInfo.debugBuildCommit,
      debugBuildCommitLabel: versionInfo.debugBuildCommitLabel,
      commitCopied: versionInfo.commitCopied,
      copyDebugBuildCommit: versionInfo.copyDebugBuildCommit,
      get providers() { return settingsProviders(); },
      get allProviders() { return filteredProviders(); },
      get providerDefaults() { return providerDefaults(); },
      get providerConnectedIds() { return settingsProviderConnectedIds(); },
      get providerAuthBusy() { return providerAuthBusy(); },
      get providerAuthModalOpen() { return providerAuthModalOpen(); },
      get providerAuthError() { return providerAuthError(); },
      get providerAuthMethods() { return providerAuthMethods(); },
      openProviderAuthModal,
      disconnectProvider,
      closeProviderAuthModal,
      startProviderAuth,
      completeProviderAuthOAuth,
      cancelProviderAuthOAuth,
      submitProviderApiKey,
      get cloudModel() { return cloudModel(); },
      get cloudModelHealthError() { return cloudModelHealthError(); },
      get cloudModelLoading() { return cloudModelLoading(); },
      get cloudModelDeleting() { return cloudModelDeleting(); },
      get cloudModelTesting() { return cloudModelTesting(); },
      get localModelHealth() { return localModelHealth(); },
      saveCloudModel,
      deleteCloudModel,
      testProviderConnection,
      loadProviderModels,
      llmRouterClient,
      get edgeConfigured() { return Boolean(edgeConfig()?.configured); },
      get edgeConnected() { return edgeConnected(); },
      primaryBundleCapability,
      get edgeBaseUrl() { return edgeConfig()?.base_url ?? ""; },
      get edgeModelName() { return edgeConfig()?.model_name ?? ""; },
      get edgeBypassProxy() {
        const cfg = edgeConfig();
        if (!cfg?.configured) return undefined;
        return cfg.bypass_proxy ?? true;
      },
      get edgeTesting() { return edgeTesting(); },
      get edgeError() { return edgeError(); },
      testEdgeConnection,
      connectEdge,
      connectLocal,
      get edgeDisconnectAvailable() { return edgeDisconnectAvailable(); },
      get edgeDisconnecting() { return edgeDisconnecting(); },
      disconnectEdge,
      get bundleSwitchMessage() { return bundleSwitchMessage(); },
      get bundleSwitchError() { return bundleSwitchError(); },
      get bundleSwitchSteps() { return bundleSwitchSteps(); },
      get bundleSwitchApplying() { return bundleSwitchApplying(); },
      get bundleSwitchCanResume() { return bundleSwitchCanResume(); },
      get edgeUpdatedMessage() { return edgeUpdatedMessage(); },
      onApplyBundleSwitch: applyBundleSwitch,
      onCancelSwitch: cancelBundleSwitch,
      get view() { return currentView(); },
      setView,
      toggleSettings: () => toggleSettings(),
      get clientConnected() { return Boolean(client()); },
      get busy() { return busy(); },
      get busyHint() { return busyHint(); },
      get busyLabel() { return busyLabel(); },
      get newTaskDisabled() { return newTaskDisabled(); },
      get headerStatus() { return headerStatus(); },
      get error() { return error(); },
      get openworkServerStatus() { return dashboardAccess().openworkStatus; },
      get openworkServerUrl() { return openworkServerUrl(); },
      get openworkServerClient() { return openworkServerClient(); },
      get openworkReconnectBusy() { return openworkReconnectBusy(); },
      reconnectOpenworkServer,
      refreshProviders: () => refreshProviders({ dispose: true }),
      setPreserveDefaultModel,
      get openworkServerSettings() { return openworkServerSettings(); },
      get openworkServerHostInfo() { return openworkServerHostInfo(); },
      get openworkServerWorkspaceId() { return resolvedDevtoolsWorkspaceId(); },
      get selectedModel() { return selectedSessionModel(); },
      get modelOptions() { return modelOptions(); },
      get runtimeSettings() { return runtimeSettings(); },
      get runtimeSettingsStatus() { return runtimeSettingsStatus(); },
      get runtimeSettingsError() { return runtimeSettingsError(); },
      refreshRuntimeSettings,
      saveRuntimeSettings,
      get channelCredentials() { return instanceApiClient(); },
      get tavilyKeyView() { return tavilyKey(); },
      get tavilyApiKeyStatus() { return tavilyApiKeyStatus(); },
      refreshTavilyApiKey,
      saveTavilyApiKey,
      clearTavilyApiKey, setTavilyApiKeyEnabled,
      get engineInfo() { return workspaceStore.engine(); },
      updateOpenworkServerSettings,
      resetOpenworkServerSettings,
      testOpenworkServerConnection,
      get canReloadWorkspace() { return canReloadWorkspace(); },
      reloadWorkspaceEngine: reloadWorkspaceEngineAndResume,
      get reloadBusy() { return reloadBusy(); },
      get reloadError() { return reloadError(); },
      get workspaceAutoReloadAvailable() { return workspaceAutoReloadAvailable(); },
      get workspaceAutoReloadEnabled() { return workspaceAutoReloadEnabled(); },
      setWorkspaceAutoReloadEnabled,
      get workspaceAutoReloadResumeEnabled() { return workspaceAutoReloadResumeEnabled(); },
      setWorkspaceAutoReloadResumeEnabled,
      get activeWorkspaceDisplay() { return activeWorkspaceDisplay(); },
      get workspaces() { return workspaceStore.workspaces(); },
      get activeWorkspaceId() { return workspaceStore.activeWorkspaceId(); },
      get connectingWorkspaceId() { return workspaceStore.connectingWorkspaceId(); },
      get workspaceConnectionStateById() { return workspaceStore.workspaceConnectionStateById(); },
      activateWorkspace: workspaceStore.activateWorkspace,
      testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
      recoverWorkspace: workspaceStore.recoverWorkspace,
      openCreateWorkspace: () => workspaceStore.setCreateWorkspaceOpen(true),
      openCreateRemoteWorkspace: () =>
        workspaceStore.setCreateRemoteWorkspaceOpen(true),
      connectRemoteWorkspace: workspaceStore.createRemoteWorkspaceFlow,
      importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
      get importingWorkspaceConfig() { return workspaceStore.importingWorkspaceConfig(); },
      exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
      get exportWorkspaceBusy() { return workspaceStore.exportingWorkspaceConfig(); },
      get createWorkspaceOpen() { return workspaceStore.createWorkspaceOpen(); },
      setCreateWorkspaceOpen: workspaceStore.setCreateWorkspaceOpen,
      createWorkspaceFlow: workspaceStore.createWorkspaceFlow,
      pickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
      get workspaceSessionGroups() { return sidebarWorkspaceGroups(); },
      get sessionStatusById() { return activeSessionStatusById(); },
      getMessagesBySessionId: messagesBySessionId,
      get opencodeClient() { return client(); },
      get selectedSessionId() { return activeSessionId(); },
      openRenameWorkspace,
      editWorkspaceConnection: openWorkspaceConnectionSettings,
      get scheduledJobs() { return scheduledJobs(); },
      get scheduledJobsSource() { return scheduledJobsSource(); },
      get scheduledJobsSourceReady() { return scheduledJobsSourceReady(); },
      get schedulerPluginInstalled() { return schedulerPluginInstalled(); },
      get scheduledJobsStatus() { return scheduledJobsStatus(); },
      get legacySchedulerSupported() { return scheduler.legacySchedulerSupported(); },
      get scheduledJobsBusy() { return scheduledJobsBusy(); },
      get scheduledJobsUpdatedAt() { return scheduler.scheduledJobsUpdatedAt(); },
      refreshScheduledJobs: (options?: { force?: boolean }) =>
        refreshScheduledJobs(options).catch(() => undefined),
      deleteScheduledJob,
      listAgents,
      get activeWorkspaceRoot() { return workspaceStore.activeWorkspaceRoot().trim(); },
      get isRemoteWorkspace() { return dashboardAccess().isRemoteWorkspace; },
      refreshSkills: (options?: { force?: boolean }) =>
        refreshSkills(options).catch(() => undefined),
      refreshHubSkills: (options?: { force?: boolean }) =>
        refreshHubSkills(options).catch(() => undefined),
      refreshPlugins: (scopeOverride?: PluginScope) =>
        refreshPlugins(scopeOverride).catch(() => undefined),
      get skills() { return skills(); },
      get skillsStatus() { return skillsStatus(); },
      get skillsStatusTone() { return skillsStatusTone(); },
      get hubSkills() { return hubSkills(); },
      get hubSkillsStatus() { return hubSkillsStatus(); },
      get hubRepo() { return hubRepo(); },
      get hubRepos() { return hubRepos(); },
      get skillsAccessHint() { return dashboardAccess().skillsAccessHint; },
      get canInstallSkillCreator() { return dashboardAccess().canInstallSkillCreator; },
      get canUseDesktopTools() { return dashboardAccess().canUseDesktopTools; },
      get canImportLocalSkill() { return dashboardAccess().canImportLocalSkill; },
      get canUninstallSkill() { return dashboardAccess().canUninstallSkill; },
      get canEditSkill() { return dashboardAccess().canEditSkill; },
      importLocalSkill,
      importSkillFile,
      installSkillCreator,
      installSkillFinder,
      installHubSkill,
      setHubRepo,
      addHubRepo,
      removeHubRepo,
      revealSkillsFolder,
      uninstallSkill,
      readSkill,
      saveSkill,
      get pluginsAccessHint() { return dashboardAccess().pluginsAccessHint; },
      get canEditPlugins() { return dashboardAccess().canEditPlugins; },
      get canUseGlobalPluginScope() { return dashboardAccess().canUseGlobalPluginScope; },
      get pluginScope() { return pluginScope(); },
      setPluginScope,
      get pluginConfigPath() { return pluginConfigPath() ?? pluginConfig()?.path ?? null; },
      get pluginList() { return pluginList(); },
      get pluginInput() { return pluginInput(); },
      setPluginInput,
      get pluginStatus() { return pluginStatus(); },
      get activePluginGuide() { return activePluginGuide(); },
      setActivePluginGuide,
      isPluginInstalled: isPluginInstalledByName,
      suggestedPlugins: SUGGESTED_PLUGINS,
      addPlugin,
      removePlugin,
      openNewTask,
      setPrompt,
      selectSession: selectSession,
      get defaultModelLabel() { return formatModelLabel(defaultModel(), providers()); },
      get defaultModelRef() { return formatModelRef(defaultModel()); },
      openDefaultModelPicker,
      get showThinking() { return showThinking(); },
      toggleShowThinking: () => setShowThinking((v) => !v),
      get autoCompactContext() { return autoCompactContext(); },
      toggleAutoCompactContext: () => setAutoCompactContext((v) => !v),
      get hideTitlebar() { return hideTitlebar(); },
      toggleHideTitlebar: () => setHideTitlebar((v) => !v),
      get modelVariantLabel() { return formatModelVariantLabel(modelVariant()); },
      editModelVariant: handleEditModelVariant,
      get updateAutoCheck() { return updateAutoCheck(); },
      toggleUpdateAutoCheck: () => setUpdateAutoCheck((v) => !v),
      ...inAppUpdateBindings(),
      get appVersion() { return effectiveVersion(); },
      get anyActiveRuns() { return anyActiveRuns(); },
      isWindows: isWindowsPlatform(),
      toggleDeveloperMode: () => setDeveloperMode((v) => !v),
      get developerMode() { return developerMode(); },
      get keepBackendOnExit() { return keepBackendOnExit(); },
      setKeepBackendOnExit,
      get fullTelemetryEnabled() { return fullTelemetryEnabled(); },
      setFullTelemetryEnabled,
      get baselineTelemetryEnabled() { return baselineTelemetryEnabled(); },
      setBaselineTelemetryEnabled,
      resetInstallId: resetInstallIdHandler,
      get resetInstallIdFeedback() { return resetInstallIdFeedback(); },
      stopHost,
      get themeMode() { return themeMode(); },
      setThemeMode,
      repairOpencodeMigration: workspaceStore.repairOpencodeMigration,
      get migrationRepairBusy() { return workspaceStore.migrationRepairBusy(); },
      get migrationRepairResult() { return workspaceStore.migrationRepairResult(); },
      get migrationRepairAvailable() { return workspaceStore.canRepairOpencodeMigration(); },
      get migrationRepairUnavailableReason() { return migrationRepairUnavailableReason(); },
      repairOpencodeCache,
      get cacheRepairBusy() { return cacheRepairBusy(); },
      get cacheRepairResult() { return cacheRepairResult(); },
      get mcpServers() { return mcp.mcpServers(); },
      get mcpBrowserSandboxRefusal() { return mcp.mcpBrowserSandboxRefusal(); },
      dismissMcpBrowserSandboxRefusal: mcp.dismissMcpBrowserSandboxRefusal,
      get mcpHostExecutionRefusal() { return mcp.mcpHostExecutionRefusal(); },
      dismissMcpHostExecutionRefusal: mcp.dismissMcpHostExecutionRefusal,
      get mcpStdioExitedOnStart() { return mcp.mcpStdioExitedOnStart(); },
      dismissMcpStdioExitedOnStart: mcp.dismissMcpStdioExitedOnStart,
      get mcpLastUpdatedAt() { return mcp.mcpLastUpdatedAt(); },
      get mcpStatuses() { return mcp.mcpStatuses(); },
      get mcpConnectingName() { return mcp.mcpConnectingName(); },
      quickConnect: mcp.quickConnect,
      connectMcp: mcp.connectMcp,
      get connectMcpPlaced() { return hostMcp.available() ? mcp.connectMcpPlaced : null; },
      reconnectMcp: mcp.reconnectMcp,
      setMcpEnabled: mcp.setMcpEnabled,
      authorizeMcp: mcp.authorizeMcp,
      logoutMcpAuth: mcp.logoutMcpAuth,
      removeMcp: mcp.removeMcp,
      refreshMcpServers: mcp.refreshMcpServers,
      listMcpTools: mcp.listMcpTools,
      setMcpToolPolicy: mcp.setMcpToolPolicy,
      onAgentsChanged: () => setAgentsVersion((v) => v + 1),
      get agentsVersion() { return agentsVersion(); },
      get language() { return currentLocale(); },
      setLanguage: setLocale,
    };
  };

  const searchWorkspaceFiles = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const activeClient = client();
    if (!activeClient) return [];
    const listed = listedWorkspaceFiles.search(openworkServerClient(), openworkServerWorkspaceId(), trimmed);
    try {
      // SDK call (find.files goes to opencode in the container).
      const directory = workspaceSdkDir();
      const result = unwrap(
        await activeClient.find.files({
          query: trimmed,
          dirs: "true",
          limit: 50,
          directory: directory || undefined,
        }),
      );
      return mergeFileSearchResults(result, await listed, listedWorkspaceFiles.isGone);
    } catch {
      return listed;
    }
  };

  const sessionProps = () => ({
    get selectedSessionId() { return activeSessionId(); },
    chatWebAccess: egress.chatWebAccess,
    get view() { return currentView(); },
    setView,
    get tab() { return tab(); },
    setTab,
    openSettings,
    get settingsOpen() { return settingsOpen(); },
    toggleSettings: () => toggleSettings(),
    versionLabel: versionInfo.versionLabel,
    debugBuildCommit: versionInfo.debugBuildCommit,
    debugBuildCommitLabel: versionInfo.debugBuildCommitLabel,
    commitCopied: versionInfo.commitCopied,
    copyDebugBuildCommit: versionInfo.copyDebugBuildCommit,
    get activeWorkspaceDisplay() { return activeWorkspaceDisplay(); },
    get activeWorkspaceRoot() { return workspaceStore.activeWorkspaceRoot().trim(); },
    get workspaces() { return workspaceStore.workspaces(); },
    get activeWorkspaceId() { return workspaceStore.activeWorkspaceId(); },
    get connectingWorkspaceId() { return workspaceStore.connectingWorkspaceId(); },
    get workspaceConnectionStateById() { return workspaceStore.workspaceConnectionStateById(); },
    activateWorkspace: workspaceStore.activateWorkspace,
    testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
    recoverWorkspace: workspaceStore.recoverWorkspace,
    editWorkspaceConnection: openWorkspaceConnectionSettings,
    openCreateWorkspace: () => workspaceStore.setCreateWorkspaceOpen(true),
    openCreateRemoteWorkspace: () =>
      workspaceStore.setCreateRemoteWorkspaceOpen(true),
    importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    get importingWorkspaceConfig() { return workspaceStore.importingWorkspaceConfig(); },
    exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
    get exportWorkspaceBusy() { return workspaceStore.exportingWorkspaceConfig(); },
    get clientConnected() { return Boolean(client()); },
    get agentClient() { return client(); },
    nativeBackendRecovery,
    get openworkServerStatus() { return openworkServerStatus(); },
    get openworkServerClient() { return openworkServerClient(); },
    get openworkServerSettings() { return openworkServerSettings(); },
    get openworkServerHostInfo() { return openworkServerHostInfo(); },
    get openworkServerUrl() { return openworkServerUrl(); },
    get openworkServerWorkspaceId() { return openworkServerWorkspaceId(); },
    get tavilyKeyView() { return tavilyKey(); },
    get selectedModel() { return selectedSessionModel(); },
    get llmRouterResolvedModelNames() { return llmRouterResolvedModelMap(); },
    get modelOptions() { return modelOptions(); },
    get engineInfo() { return workspaceStore.engine(); },
    stopHost,
    get headerStatus() { return headerStatus(); },
    get busyHint() { return busyHint(); },
    ...inAppUpdateBindings(),
    get anyActiveRuns() { return anyActiveRuns(); },
    get selectedSessionModelLabel() { return selectedSessionModelLabel(); },
    get selectedSessionModelIsLocal() { return selectedSessionModelIsLocal(); },
    openSessionModelPicker: openSessionModelPicker,
    applySessionModelSelection,
    setSessionModel: (providerID: string, modelID: string) => {
      // Fail-safe: even this external setter honors the cloud-only profile.
      const next = normalizeSessionRouteForProfile(
        { providerID, modelID },
        capabilityGate.activeProfile(),
      );
      const id = selectedSessionId();
      if (id) {
        clearSessionAgentManagedModel(id);
        setSessionModelOverrideById((current) => ({ ...current, [id]: next }));
      } else {
        setPendingSessionModel(next);
      }
      setDefaultModelExplicit(true);
      setDefaultModel(next);
    },
    // Per-session model override that does NOT mutate the global defaultModel.
    // Use for agent-driven automatic overrides (see issue #420).
    setSessionModelForCurrentSessionOnly: (
      providerID: string,
      modelID: string,
    ) => {
      // Fail-safe: agent-driven auto→local overrides also respect cloud-only.
      const next = normalizeSessionRouteForProfile(
        { providerID, modelID },
        capabilityGate.activeProfile(),
      );
      const id = selectedSessionId();
      if (id) {
        clearSessionAgentManagedModel(id);
        setSessionModelOverrideById((current) => ({ ...current, [id]: next }));
      } else {
        // No session yet — applySessionAgent is concurrently creating one.
        // pendingSessionModel is consumed by createSessionAndOpen as the new
        // session's override, without touching defaultModel.
        setPendingSessionModel(next);
      }
    },
    // Drop a session's override so it falls back to defaultModel.
    clearSessionModelOverride: (sessionID: string) => {
      clearSessionAgentManagedModel(sessionID);
      setSessionModelOverrideById((current) => {
        if (!(sessionID in current)) return current;
        const next = { ...current };
        delete next[sessionID];
        return next;
      });
    },
    get modelVariantLabel() { return formatModelVariantLabel(modelVariant()); },
    get modelVariant() { return modelVariant(); },
    setModelVariant: (value: string) => setModelVariant(value),
    confirmEmailAgentCloudRisk: confirmEmailAgentCloudRisk,
    get activePlugins() { return sidebarPluginList(); },
    get activePluginStatus() { return sidebarPluginStatus(); },
    get mcpServers() { return mcp.mcpServers(); },
    get mcpStatuses() { return mcp.mcpStatuses(); },
    get skills() { return skills(); },
    get skillsStatus() { return skillsStatus(); },
    get skillsStatusTone() { return skillsStatusTone(); },
    get showSkillReloadBanner() { return reloadRequired() && reloadTrigger()?.type === "skill"; },
    get reloadBannerTitle() { return reloadCopy().title; },
    get reloadBannerBody() { return reloadCopy().body; },
    get reloadBannerBlocked() { return activeReloadBlockingSessions().length > 0; },
    get reloadBannerActiveCount() { return activeReloadBlockingSessions().length; },
    get canReloadWorkspace() { return canReloadWorkspace(); },
    reloadWorkspaceEngine: reloadWorkspaceEngineAndResume,
    forceStopActiveConversations: forceStopActiveSessionsAndReload,
    dismissReloadBanner: clearReloadRequired,
    get reloadBusy() { return reloadBusy(); },
    get reloadError() { return reloadError(); },
    openNewTask,
    sendPromptAsync: sendPrompt,
    abortSession: abortSession,
    get sessionRevertMessageId() { return selectedSession()?.revert?.messageID ?? null; },
    submitEditedUserMessage: submitEditedUserMessage,
    get lastPromptSent() { return lastPromptSent(); },
    retryLastPrompt: retryLastPrompt,
    get newTaskDisabled() { return newTaskDisabled(); },
    get workspaceSessionGroups() { return sidebarWorkspaceGroups(); },
    openRenameWorkspace,
    selectSession: selectSession,
    get messages() { return visibleMessages(); },
    getSessionById: sessionById,
    getMessagesBySessionId: messagesBySessionId,
    get llmRouterClient() { return llmRouterClient(); },
    ensureSessionLoaded,
    get searchSessions() { return client()?.searchSessions; },
    sessionLoadingById,
    get todos() { return activeTodos(); },
    get busyLabel() { return busyLabel(); },
    get developerMode() { return developerMode(); },
    get debugObservabilityAvailable() { return debugObservabilityAvailable(); },
    get showThinking() { return showThinking(); },
    get autoCompactContext() { return autoCompactContext(); },
    toggleAutoCompactContext: () => setAutoCompactContext((v) => !v),
    groupMessageParts,
    summarizeStep,
    get expandedStepIds() { return expandedStepIds(); },
    setExpandedStepIds: setExpandedStepIds,
    get expandedSidebarSections() { return expandedSidebarSections(); },
    setExpandedSidebarSections: setExpandedSidebarSections,
    get artifacts() { return activeArtifacts(); },
    get workingFiles() { return activeWorkingFiles(); },
    get authorizedDirs() { return activeAuthorizedDirs(); },
    get busy() { return composerBusyForSelection(shellBusy(), dispatchingSessions(), activeSessionId()); },
    get composerAttachmentUpload() { return composerAttachmentUpload(); },
    consumeComposerAttachmentUpload: () => setComposerAttachmentUpload(null),
    get prompt() { return prompt(); },
    setPrompt: setPrompt,
    get activePermission() { return activePermissionMemo(); },
    get permissionReplyBusy() { return declineReplyBusy() || permissionReplyBusy(); },
    respondPermission: respondPermissionRecordingDecline,
    respondPermissionAndRemember: respondPermissionAndRemember,
    get activeQuestion() { return activeQuestion(); },
    get questionReplyBusy() { return questionReplyBusy(); },
    respondQuestion: respondQuestion, rejectQuestion: rejectQuestion,
    safeStringify: safeStringify,
    startProviderAuth: startProviderAuth,
    completeProviderAuthOAuth: completeProviderAuthOAuth,
    cancelProviderAuthOAuth: cancelProviderAuthOAuth,
    refreshProviders: refreshProviders,
    submitProviderApiKey: submitProviderApiKey,
    openProviderAuthModal: openProviderAuthModal,
    closeProviderAuthModal: closeProviderAuthModal,
    get providerAuthModalOpen() { return providerAuthModalOpen(); },
    get providerAuthBusy() { return providerAuthBusy(); },
    get providerAuthError() { return providerAuthError(); },
    get providerAuthMethods() { return providerAuthMethods(); },
    get providers() { return settingsProviders(); },
    get allProviders() { return filteredProviders(); },
    get providerDefaults() { return providerDefaults(); },
    get providerConnectedIds() { return settingsProviderConnectedIds(); },
    listAgents: listAgents,
    listCommands: listCommands,
    get commandsVersion() { return commandsVersion(); },
    get agentsVersion() { return agentsVersion(); },
    get selectedSessionAgent() { return selectedSessionAgent(); },
    setSessionAgent: setSessionAgent,
    setPendingSessionAgent,
    applySessionAgentModelPolicy,
    saveSession: saveSessionExport,
    get sessionStatusById() { return activeSessionStatusById(); },
    get hasEarlierMessages() { return selectedSessionHasEarlierMessages(); },
    get loadingEarlierMessages() { return selectedSessionLoadingEarlierMessages(); },
    loadEarlierMessages,
    sessionMessageHistoryComplete: sessionStore.sessionMessageHistoryComplete,
    searchFiles: searchWorkspaceFiles,
    deleteSession: deleteSessionById,
    get sessionStatus() { return selectedSessionStatus(); },
    renameSession: renameSessionTitle,
    get error() { return error(); },
    get piiLevel() { return piiLevel(); },
    setPiiLevel,
    get customPiiCategories() { return customPiiCategories(); },
    setCustomPiiCategories,
    // Voice input for the composer's microphone button (mode, model lifecycle,
    // hotkey, first-run hint). The controller itself is a stable object.
    voiceInput,
    get ttsNarration() { return ttsNarration(); },
    setTtsNarrationOn,
    // Whether the backend exposes TTS at all (probed on mount). The 🔊 controls
    // are hidden when false, so a service-off backend shows no button to misfire.
    get ttsAvailable() { return ttsAvailable(); },
    // Gated toggle: turning narration ON checks /tts/health first and, if the
    // voice model is not yet downloaded, shows the consent dialog instead of
    // enabling immediately. Turning OFF is immediate.
    toggleTtsNarration: () => { void toggleTtsNarration(); },
    get ttsSpeaking() { return ttsSpeaking(); },
    // Per-message "read aloud" (speaker button next to Copy). Independent of the
    // auto-narration toggle above.
    speakMessage,
    get ttsReadAloud() { return ttsReadAloud(); },
  });

  const dashboardTabs = new Set<DashboardTab>([
    "data",
    "scheduled",
    "skills",
    "mcp",
    "identities",
    "agent",
    "config",
    "settings",
  ]);

  const resolveDashboardTab = (value?: string | null) => {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (dashboardTabs.has(normalized as DashboardTab)) {
      return normalized as DashboardTab;
    }
    return "data";
  };

  const initialRoute = () => {
    if (typeof window === "undefined") return "/session";
    return "/session";
  };

  createEffect(() => {
    const rawPath = location.pathname.trim();
    const path = rawPath.toLowerCase();

    if (path === "" || path === "/") {
      navigate(initialRoute(), { replace: true });
      return;
    }

    if (path.startsWith("/dashboard")) {
      const [, , tabSegment] = path.split("/");
      const resolvedTab = resolveDashboardTab(tabSegment);

      // Settings is a dialog, not a page: a settings route opens it over the chat.
      if (isSettingsTab(resolvedTab)) {
        openSettings(resolvedTab === "settings" ? undefined : resolvedTab);
        const sessionId = activeSessionId();
        if (sessionId) goToSession(sessionId, { replace: true });
        else navigate("/session", { replace: true });
        return;
      }

      if (resolvedTab !== tab()) {
        setTabState(resolvedTab);
      }
      if (!tabSegment || tabSegment !== resolvedTab) {
        goToDashboard(resolvedTab, { replace: true });
      }
      return;
    }

    if (path.startsWith("/session")) {
      const [, , sessionSegment] = rawPath.split("/");
      const id = (sessionSegment ?? "").trim();

      if (!id) {
        if (selectedSessionId()) {
          setSelectedSessionId(null);
          setMessages([]);
          setTodos([]);
        }
        return;
      }

      // If the URL points at a session that no longer exists (e.g. after deletion),
      // route back to /session so the app can fall back safely.
      // Also allow child/subagent sessions that are already loaded via sessionById
      // (they won't appear in the top-level sessions() list).
      if (
        sessionsLoaded() &&
        !sessions().some((session) => session.id === id) &&
        !sessionById(id)
      ) {
        if (selectedSessionId() === id) {
          setSelectedSessionId(null);
        }
        navigate("/session", { replace: true });
        return;
      }

      if (selectedSessionId() !== id) {
        void selectSession(id);
      }
      return;
    }

    if (path.startsWith("/proto-v1-ux")) {
      if (isTauriRuntime()) {
        navigate("/session", { replace: true });
      }
      return;
    }

    if (path.startsWith("/proto")) {
      if (isTauriRuntime()) {
        navigate("/session", { replace: true });
        return;
      }

      const [, , protoSegment] = rawPath.split("/");
      if (!protoSegment) {
        navigate("/proto/workspaces", { replace: true });
      }
      return;
    }

    if (path.startsWith("/onboarding")) {
      navigate("/session", { replace: true });
      return;
    }

    const fallback = activeSessionId();
    if (fallback) {
      goToSession(fallback, { replace: true });
      return;
    }
    navigate("/session", { replace: true });
  });

  createEffect(() => {
    if (backendBootReady()) {
      void refreshProviders({ dispose: true }).catch(() => undefined);
    }
  });

  // Fetch the dashboard and Settings dialog chunks once the app is up, so the
  // first Settings open draws at once instead of waiting, blank, while the
  // dialog's chunk downloads. Read the Model page's late sections too, so it
  // opens at its full height and the scrollbar holds.
  createEffect(() => {
    if (!backendBootReady()) return;
    void DashboardView.preload();
    void SettingsDialog.preload();
    const lrm = llmRouterClient();
    void import("./components/local-model-config").then((m) => m.prefetchLocalProvider(lrm));
    void import("./components/perf-weight-slider").then((m) => m.prefetchPerfWeight());
    void import("./components/local-ctx-size-slider").then((m) => m.prefetchLocalCtxSize());
  });

  return (
    <HostMcpProvider value={hostMcp}>
      <EdgeServerStartupGate
        backendBootReady={backendBootReady()}
        serverHealthy={server.healthy()}
        serverBaseUrl={openworkServerBaseUrl()}
        serverToken={openworkServerAuth().token}
        hubUrl={openworkServerSettings().hubUrl ?? ""}
        hubToken={openworkServerSettings().hubToken}
        bypass={edgeGateBypass()}
        persistEdgeProvider={persistEdgeProvider()}
        onReady={() => {
          void refreshProviders({ dispose: true }).catch(() => undefined);
          // The gate just confirmed edge config against the LRM. Re-read it so
          // the Model Routing edge card populates URL/model even if the earlier
          // one-shot refreshEdgeConfig ran before the LRM hub was reachable.
          void refreshEdgeConfig().catch(() => undefined);
        }}
      >
        <Switch>
          <Match when={currentView() === "proto"}>
            <Switch>
              <Match when={isProtoV1Ux()}>
                <AppErrorBoundary scope="page:proto-v1-ux">
                  <Suspense fallback={<LazyViewFallback />}>
                    <ProtoV1UxView />
                  </Suspense>
                </AppErrorBoundary>
              </Match>
              <Match when={true}>
                <AppErrorBoundary scope="page:proto-workspaces">
                  <Suspense fallback={<LazyViewFallback />}>
                    <ProtoWorkspacesView />
                  </Suspense>
                </AppErrorBoundary>
              </Match>
            </Switch>
          </Match>
          <Match when={currentView() === "onboarding"}>
            <AppErrorBoundary scope="page:onboarding">
              <OnboardingView {...onboardingProps()} />
            </AppErrorBoundary>
          </Match>
        </Switch>
        <Show when={sessionMounted()}>
          <div
            style={{
              display: currentView() === "session" ? "contents" : "none",
            }}
          >
            <AppErrorBoundary scope="page:session">
              <SessionPage {...sessionProps()} />
            </AppErrorBoundary>
          </div>
        </Show>

        {/* UI Tour */}
        <Show
          when={
            tourVisible() &&
            currentView() === "session" &&
            backendBootReady() &&
            !workspaceStore.createRemoteWorkspaceOpen()
          }
        >
          <UiTour
            profile={capabilityGate.activeProfile()}
            onDone={() => setTourVisible(false)}
            onDismiss={() => {
              setTourVisible(false);
              setTourDismissedThisSession(true);
            }}
          />
        </Show>
        <Show when={dashboardMounted()}>
          <div
            style={{
              display: currentView() === "dashboard" ? "contents" : "none",
            }}
          >
            <AppErrorBoundary scope="page:dashboard">
              <Suspense fallback={<LazyViewFallback />}>
                <DashboardView {...dashboardProps()} />
              </Suspense>
            </AppErrorBoundary>
          </div>
        </Show>
        <Show when={settingsOpen()}>
          <AppErrorBoundary scope="page:settings">
            <Suspense>
              <SettingsDialog
                {...dashboardProps()}
                section={settingsSection()}
                onSectionChange={setSettingsSection}
                returnFocus={settingsReturnFocus}
                onClose={() => setSettingsOpen(false)}
              />
            </Suspense>
          </AppErrorBoundary>
        </Show>
      </EdgeServerStartupGate>

      <WorkspaceSwitchOverlay
        open={workspaceSwitchOpen()}
        workspace={workspaceSwitchWorkspace()}
        statusKey={workspaceSwitchStatusKey()}
      />

      <Show when={!capabilityStartupHandled()}>
        <BackendBootOverlay
          stage={backendBootOverlay.stage()}
          message={backendBootOverlay.message()}
          pct={backendBootOverlay.pct()}
          error={backendBootOverlay.error()}
          ready={backendBootOverlay.ready()}
          debugObservabilityAvailable={debugObservabilityAvailable()}
          retryDisabled={backendBootOverlay.retryDisabled()}
          onRetry={backendBootOverlay.onRetry}
        />
      </Show>

      <DownloadConsentModal
        open={downloadConsentModalOpen()}
        stage={backendBootStage()}
        message={backendBootMessage()}
        pct={backendBootPct()}
        ready={backendBootReady()}
        error={backendBootError()}
        models={downloadModelsInfo()}
        onContinue={() => {
          if (isTauriRuntime()) {
            import("@tauri-apps/api/core")
              .then((mod) => mod.invoke("approve_downloads"))
              .catch(console.error); // dormant: command removed with backend-manager — see note above
          }
        }}
        onCancel={() => {
          if (isTauriRuntime()) {
            import("@tauri-apps/plugin-process")
              .then((mod) => mod.exit(0))
              .catch(() => window.close());
          } else {
            window.close();
          }
        }}
        onClose={() => setDownloadConsentModalOpen(false)}
      />

      <HardwareRequirementsDialog
        open={switchHardwareFailures().length > 0}
        failures={switchHardwareFailures()}
        mode="cancel"
        onDismiss={() => setSwitchHardwareFailures([])}
      />

      <TtsDownloadConfirmDialog
        open={ttsDownloadOpen()}
        phase={ttsDownloadPhase()}
        modelName={TTS_MODEL_NAME}
        doneBytes={ttsDownloadDone()}
        totalBytes={ttsDownloadTotal()}
        error={ttsDownloadError()}
        onConfirm={() => { void confirmTtsDownload(); }}
        onCancel={dismissTtsDownload}
        onRetry={() => { void confirmTtsDownload(); }}
        onCancelDownload={dismissTtsDownload}
      />

      {/* Local speech model: 630 MB consent, progress, and the explicit
          "use cloud instead" escape hatch. */}
      <VoiceDownloadConfirmDialog
        open={voiceInput.consentOpen()}
        phase={voiceInput.downloadPhase()}
        doneBytes={voiceInput.snapshot()?.done_bytes ?? 0}
        totalBytes={voiceInput.snapshot()?.total_bytes ?? 0}
        error={voiceInput.downloadError()}
        onConfirm={() => { void voiceInput.confirmDownload(); }}
        onUseCloud={voiceInput.useCloudInstead}
        onRetry={() => { void voiceInput.confirmDownload(); }}
        onCancel={voiceInput.dismissConsent}
      />

      <ConfirmModal
        open={localLlmConfigWarningOpen()}
        title="Local LLM configuration may be incorrect"
        message="The Local LLM configuration may be incorrect. Please check your Local LLM settings."
        confirmLabel="Go to Settings"
        cancelLabel="Close"
        variant="warning"
        size="lg"
        hideIcon={true}
        onConfirm={openLocalLlmSettingsFromWarning}
        onCancel={() => setLocalLlmConfigWarningOpen(false)}
      />

      <ConfirmModal
        open={emailAgentCloudRiskOpen()}
        title="Cloud Model Email Privacy Risk"
        data-testid="email-agent-cloud-risk-confirm-btn"
        message={
          <div class="space-y-3">
            <p>
              Email Agent can process email and calendar content. Sending this
              request with a cloud model may disclose that content to the
              configured cloud provider.
            </p>
            <p>
              Continue only if you understand and accept this privacy risk. You
              will not be asked again until SuperClaw restarts.
            </p>
          </div>
        }
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        variant="warning"
        confirmVariant="danger"
        size="lg"
        onConfirm={() => resolveEmailAgentCloudRisk(true)}
        onCancel={() => resolveEmailAgentCloudRisk(false)}
      />

      <EgressApprovalDialog egress={egress.approvals} />
      <HostMcpApprovalDialog approvals={hostMcp.approvals} stopAll={hostMcp.stopAll} />

      <ModelPickerModal
        open={modelPickerOpen()}
        options={modelOptions()}
        filteredOptions={filteredModelOptions()}
        query={modelPickerQuery()}
        setQuery={setModelPickerQuery}
        target={modelPickerTarget()}
        current={modelPickerCurrent()}
        onSelect={applyModelSelection}
        onClose={closeModelPicker}
        suspended={providerAuthModalOpen()}
        onEditSettings={(section) => {
          closeModelPicker({ restorePromptFocus: false });
          setPendingModelSection(section);
          openSettings("model");
        }}
      />

      <McpAuthModal
        open={mcp.mcpAuthModalOpen()}
        getStatus={mcp.getMcpAuthStatus}
        startAuth={mcp.startMcpAuth}
        completeAuth={mcp.completeMcpAuth}
        entry={mcp.mcpAuthEntry()}
        language={currentLocale()}
        reloadRequired={mcp.mcpAuthNeedsReload()}
        reloadBlocked={activeReloadBlockingSessions().length > 0}
        activeSessions={activeReloadBlockingSessions()}
        isRemoteWorkspace={activeWorkspaceDisplay().workspaceType === "remote"}
        onForceStopSession={(sessionID) => abortSession(sessionID)}
        onClose={() => {
          mcp.setMcpAuthModalOpen(false);
          mcp.setMcpAuthEntry(null);
          mcp.setMcpAuthNeedsReload(false);
        }}
        onComplete={async () => {
          mcp.setMcpAuthModalOpen(false);
          mcp.setMcpAuthEntry(null);
          mcp.setMcpAuthNeedsReload(false);
          await mcp.refreshMcpServers();
        }}
        onReloadEngine={() => reloadWorkspaceEngineAndResume()}
      />

      <SharedBundleImportModal
        open={Boolean(sharedBundleImportChoice())}
        title={sharedBundleImportCopy()?.title ?? "Import shared bundle"}
        description={
          sharedBundleImportCopy()?.description ??
          "Choose how to import this shared bundle."
        }
        items={sharedBundleImportCopy()?.items ?? []}
        workers={sharedBundleWorkerOptions()}
        busy={sharedBundleImportBusy()}
        error={sharedBundleImportError()}
        onClose={closeSharedBundleImportChoice}
        onCreateNewWorker={() => {
          void openSharedBundleCreateWorkerFlow();
        }}
        onSelectWorker={(workspaceId) => {
          void importSharedBundleIntoExistingWorkspace(workspaceId);
        }}
      />

      <CreateWorkspaceModal
        open={workspaceStore.createWorkspaceOpen()}
        onClose={() => {
          workspaceStore.setCreateWorkspaceOpen(false);
          setSharedBundleCreateWorkerRequest(null);
        }}
        onPickFolder={workspaceStore.pickWorkspaceFolder}
        defaultPreset={createWorkspaceDefaultPreset()}
        onConfirm={async (preset, folder) => {
          const request = sharedBundleCreateWorkerRequest();
          const ok = await workspaceStore.createWorkspaceFlow(preset, folder);
          if (!ok || !request) return;
          const imported = await importSharedBundleIntoActiveWorker(
            request.request,
            {
              localRoot: workspaceStore.activeWorkspaceRoot().trim(),
            },
            request.bundle,
          );
          setSharedBundleCreateWorkerRequest(null);
          if (imported) {
            if (request.bundle.type === "skill") {
              showSharedSkillSuccessToast({
                title: "Skill added",
                description: `Added '${request.bundle.name.trim() || "Shared skill"}' to ${describeWorkspaceForToasts(workspaceStore.activeWorkspaceDisplay())}.`,
              });
            }
            setSharedSkillDestinationRequest(null);
          }
        }}
        submitting={busy() && busyLabel() === "status.creating_workspace"}
      />

      <SharedSkillDestinationModal
        open={
          Boolean(sharedSkillDestinationRequest()) &&
          !workspaceStore.createWorkspaceOpen() &&
          !workspaceStore.createRemoteWorkspaceOpen()
        }
        skill={(() => {
          const request = sharedSkillDestinationRequest();
          if (!request) return null;
          return {
            name: request.bundle.name,
            description: request.bundle.description ?? null,
            trigger: request.bundle.trigger ?? null,
          };
        })()}
        workspaces={sharedSkillDestinationWorkspaces()}
        activeWorkspaceId={workspaceStore.activeWorkspaceId()}
        busyWorkspaceId={sharedSkillDestinationBusyId()}
        onClose={() => {
          if (sharedSkillDestinationBusyId()) return;
          setSharedSkillDestinationRequest(null);
        }}
        onSubmitWorkspace={importSharedSkillIntoWorkspace}
        onCreateWorker={
          isTauriRuntime()
            ? () => {
              const request = sharedSkillDestinationRequest();
              if (!request) return;
              setError(null);
              setSharedBundleCreateWorkerRequest({
                request: request.request,
                bundle: request.bundle,
                defaultPreset: "starter",
              });
              workspaceStore.setCreateWorkspaceOpen(true);
            }
            : undefined
        }
        onConnectRemote={() => {
          setError(null);
          workspaceStore.setCreateRemoteWorkspaceOpen(true);
        }}
      />

      <CreateRemoteWorkspaceModal
        open={workspaceStore.createRemoteWorkspaceOpen()}
        onClose={() => {
          workspaceStore.setCreateRemoteWorkspaceOpen(false);
          setDeepLinkRemoteWorkspaceDefaults(null);
        }}
        onConfirm={(input) => workspaceStore.createRemoteWorkspaceFlow(input)}
        initialValues={deepLinkRemoteWorkspaceDefaults() ?? undefined}
        submitting={
          busy() &&
          (busyLabel() === "status.creating_workspace" ||
            busyLabel() === "status.connecting")
        }
      />

      <Show when={modelSelectToast()}>
        <div class="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div class="pointer-events-auto w-[min(24rem,calc(100vw-2rem))]">
            <StatusToast
              open={Boolean(modelSelectToast())}
              tone="info"
              title={modelSelectToast() ?? ""}
              dismissLabel={t("common.dismiss", currentLocale())}
              onDismiss={() => setModelSelectToast(null)}
            />
          </div>
        </div>
      </Show>

      <div class="pointer-events-none fixed right-4 top-4 z-[90] flex w-[min(24rem,calc(100vw-1.5rem))] max-w-full flex-col gap-3 sm:right-6 sm:top-6">
        <Show when={telemetryWriteError()}>
          <div class="pointer-events-auto">
            <StatusToast
              open={telemetryWriteError()}
              tone="error"
              title={t("consent.telemetry_save_failed_title", currentLocale())}
              description={t("consent.telemetry_save_failed_body", currentLocale())}
              dismissLabel={t("common.dismiss", currentLocale())}
              onDismiss={() => setTelemetryWriteError(false)}
            />
          </div>
        </Show>

        <Show when={telemetryRestartError()}>
          <div class="pointer-events-auto">
            <StatusToast
              open={telemetryRestartError()}
              tone="error"
              title={t("consent.telemetry_restart_failed_title", currentLocale())}
              description={t("consent.telemetry_restart_failed_body", currentLocale())}
              dismissLabel={t("common.dismiss", currentLocale())}
              onDismiss={() => setTelemetryRestartError(false)}
            />
          </div>
        </Show>

        <Show when={telemetryRestartHint()}>
          <div class="pointer-events-auto">
            <StatusToast
              open={telemetryRestartHint()}
              tone="info"
              title={t("consent.telemetry_restart_title", currentLocale())}
              description={t("consent.telemetry_restart_body", currentLocale())}
              actionLabel={t("consent.telemetry_restart_action", currentLocale())}
              onAction={telemetryConsent.confirmRestart}
              dismissLabel={t("common.dismiss", currentLocale())}
              onDismiss={() => setTelemetryRestartHint(false)}
            />
          </div>
        </Show>

        <div class="pointer-events-auto">
          <StatusToast
            open={Boolean(sharedSkillSuccessToast())}
            tone="success"
            title={sharedSkillSuccessToast()?.title ?? "Skill added"}
            description={sharedSkillSuccessToast()?.description ?? null}
            dismissLabel="Dismiss"
            onDismiss={clearSharedSkillSuccessToast}
          />
        </div>

        <Show when={diskCriticalBytes() != null}>
          <div class="pointer-events-auto">
            <StatusToast
              open={diskCriticalBytes() != null}
              tone="info"
              title={t(
                "app.cleanup_disk_critical_toast_title",
                currentLocale(),
              )}
              description={t(
                "app.cleanup_disk_critical_toast_body",
                currentLocale(),
              ).replace("{size}", formatBytes(diskCriticalBytes() ?? 0))}
              actionLabel={t(
                "app.cleanup_disk_critical_toast_action",
                currentLocale(),
              )}
              onAction={() => {
                setDiskCriticalBytes(null);
                openSettings("app");
              }}
              dismissLabel={t("common.dismiss", currentLocale())}
              onDismiss={() => setDiskCriticalBytes(null)}
            />
          </div>
        </Show>
      </div>

      <RenameWorkspaceModal
        open={renameWorkspaceOpen()}
        title={renameWorkspaceName()}
        busy={renameWorkspaceBusy()}
        canSave={
          renameWorkspaceName().trim().length > 0 && !renameWorkspaceBusy()
        }
        onClose={closeRenameWorkspace}
        onSave={saveRenameWorkspace}
        onTitleChange={setRenameWorkspaceName}
      />

      <CreateRemoteWorkspaceModal
        open={editRemoteWorkspaceOpen()}
        onClose={() => {
          setEditRemoteWorkspaceOpen(false);
          setEditRemoteWorkspaceId(null);
          setEditRemoteWorkspaceError(null);
        }}
        onConfirm={(input) => {
          const workspaceId = editRemoteWorkspaceId();
          if (!workspaceId) return;
          setEditRemoteWorkspaceError(null);
          void (async () => {
            try {
              const ok = await workspaceStore.updateRemoteWorkspaceFlow(
                workspaceId,
                input,
              );
              if (ok) {
                setEditRemoteWorkspaceOpen(false);
                setEditRemoteWorkspaceId(null);
                setEditRemoteWorkspaceError(null);
              } else {
                setEditRemoteWorkspaceError(
                  error() || "Connection failed. Check the URL and token.",
                );
                setError(null);
              }
            } catch (e) {
              const message =
                e instanceof Error ? e.message : "Connection failed";
              setEditRemoteWorkspaceError(message);
              setError(null);
            }
          })();
        }}
        initialValues={editRemoteWorkspaceDefaults() ?? undefined}
        submitting={busy() && busyLabel() === "status.connecting"}
        error={editRemoteWorkspaceError()}
        title={t("dashboard.edit_remote_workspace_title", currentLocale())}
        subtitle={t(
          "dashboard.edit_remote_workspace_subtitle",
          currentLocale(),
        )}
        confirmLabel={t(
          "dashboard.edit_remote_workspace_confirm",
          currentLocale(),
        )}
      />
    </HostMcpProvider>
  );
}
