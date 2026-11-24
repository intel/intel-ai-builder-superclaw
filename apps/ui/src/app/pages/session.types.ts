/** Props for the Session view. */
import type { Accessor } from "solid-js";
import type { VoiceInputController } from "~/features/voice-input";
import type { NarrationState, ReadAloudState } from "~/features/tts";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import type { Part } from "@opencode-ai/sdk/v2/client";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { ArtifactItem } from "../types";
import type { DashboardTab } from "../types";
import type { ComposerDraft } from "../types";
import type { MessageGroup } from "../types";
import type { ModelOption, ModelRef } from "../types";
import type { MessageWithParts } from "../types";
import type { McpServerEntry } from "../types";
import type { McpStatusMap } from "../types";
import type { PendingPermission } from "../types";
import type { PendingQuestion } from "../types";
import type { PiiLevel } from "../types";
import type { ProviderListItem } from "../types";
import type { SettingsSection } from "./settings-dialog.sections";
import type { SkillCard } from "../types";
import type { TodoItem } from "../types";
import type { View } from "../types";
import type { WorkspaceConnectionState } from "../types";
import type { WorkspaceDisplay } from "../types";
import type { WorkspaceSessionGroup } from "../types";
import type { EngineInfo } from "../lib/tauri";
import type { OpenworkServerInfo } from "../lib/tauri";
import type { WorkspaceInfo } from "../lib/tauri";
import type { UpdaterEnvironment } from "../lib/tauri";
import type { UpdateStatus } from "../context/updater";
import type { ProviderOAuthStartResult } from "../components/provider-auth-modal";
import type { TavilyKeyView } from "~/features/tavily-api-key";
import type { ChatWebAccess } from "~/features/egress-approvals";
import type { OpenworkServerClient } from "../lib/openwork-server";
import type { OpenworkServerSettings } from "../lib/openwork-server";
import type { OpenworkServerStatus } from "../lib/openwork-server";
import type { LlmRouterClient } from "../lib/llmrouter-client";
import type { SidebarSectionState } from "../components/session/sidebar";
import type { GlobalSessionSearchBackend } from "./session-global-search";
import type { NativeBackendRecovery } from "../native-backend-recovery";

export type SessionViewProps = {
  selectedSessionId: string | null;
  /** Web pages "Ask for approval / Allow for this session", a chip in the composer's picker row. */
  chatWebAccess: ChatWebAccess;
  view: View;
  setView: (view: View, sessionId?: string) => void;
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  /**
   * Opens the Settings dialog over this page; without a section, at General. `returnFocus` takes
   * focus on close when the opener will not survive (a button in a drawer that closes behind it).
   */
  openSettings: (section?: SettingsSection, returnFocus?: HTMLElement) => void;
  /** True while the Settings dialog covers this page, so its window shortcuts stand down. */
  settingsOpen: boolean;
  toggleSettings: () => void;
  // Shared version/build info (single fetch owned by app.tsx; see useVersionInfo).
  versionLabel: () => string | null;
  debugBuildCommit: () => string | null;
  debugBuildCommitLabel: () => string | null;
  commitCopied: () => boolean;
  copyDebugBuildCommit: () => Promise<void>;
  activeWorkspaceDisplay: WorkspaceDisplay;
  activeWorkspaceRoot: string;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  editWorkspaceConnection: (workspaceId: string) => void;
  openCreateWorkspace: () => void;
  openCreateRemoteWorkspace: () => void;
  importWorkspaceConfig: () => void;
  importingWorkspaceConfig: boolean;
  exportWorkspaceConfig: (workspaceId?: string) => void;
  exportWorkspaceBusy: boolean;
  clientConnected: boolean;
  agentClient: object | null;
  nativeBackendRecovery: NativeBackendRecovery;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerClient: OpenworkServerClient | null;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerHostInfo: OpenworkServerInfo | null;
  openworkServerUrl: string;
  openworkServerWorkspaceId: string | null;
  tavilyKeyView: TavilyKeyView;
  engineInfo: EngineInfo | null;
  stopHost: () => void;
  headerStatus: string;
  busyHint: string | null;
  updateStatus: Accessor<UpdateStatus | null>;
  updateEnv: Accessor<UpdaterEnvironment | null>;
  anyActiveRuns: boolean;
  openUpdateDownloadPage: (url: string) => void;
  openNewTask: () => void;
  sendPromptAsync: (
    draft: ComposerDraft,
    options?: {
      validateAutoRoutedAgent?: (agent: string) => Promise<boolean> | boolean;
      onAccepted?: () => void;
      onSessionResolved?: (sessionID: string) => void;
      submittedAt?: number;
    },
  ) => Promise<void | false | true>;
  abortSession: (sessionId?: string) => Promise<void>;
  sessionRevertMessageId: string | null;
  submitEditedUserMessage: (
    messageId: string,
    text: string,
    options?: { optimisticHide?: boolean },
  ) => Promise<void>;
  lastPromptSent: string;
  retryLastPrompt: () => void;
  newTaskDisabled: boolean;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  openRenameWorkspace: (workspaceId: string) => void;
  selectSession: (sessionId: string) => Promise<void> | void;
  messages: MessageWithParts[];
  getSessionById: (sessionId: string | null) => Session | null;
  getMessagesBySessionId: (sessionId: string | null) => MessageWithParts[];
  llmRouterClient: LlmRouterClient | null;
  ensureSessionLoaded: (sessionId: string) => Promise<void> | void;
  /** Undefined while disconnected, or on runtimes without `/session/search`. */
  searchSessions?: GlobalSessionSearchBackend;
  sessionLoadingById: (sessionId: string | null) => boolean;
  todos: TodoItem[];
  busyLabel: string | null;
  developerMode: boolean;
  debugObservabilityAvailable: boolean;
  showThinking: boolean;
  groupMessageParts: (parts: Part[], messageId: string) => MessageGroup[];
  summarizeStep: (part: Part) => { title: string; detail?: string };
  expandedStepIds: Set<string>;
  setExpandedStepIds: (
    updater: (current: Set<string>) => Set<string>,
  ) => Set<string>;
  expandedSidebarSections: SidebarSectionState;
  setExpandedSidebarSections: (
    updater: (current: SidebarSectionState) => SidebarSectionState,
  ) => SidebarSectionState;
  artifacts: ArtifactItem[];
  workingFiles: string[];
  authorizedDirs: string[];
  activePlugins: string[];
  activePluginStatus: string | null;
  mcpServers: McpServerEntry[];
  mcpStatuses: McpStatusMap;
  skills: SkillCard[];
  skillsStatus: string | null;
  showSkillReloadBanner: boolean;
  reloadBannerTitle: string;
  reloadBannerBody: string;
  reloadBannerBlocked: boolean;
  reloadBannerActiveCount: number;
  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  forceStopActiveConversations: () => Promise<void>;
  dismissReloadBanner: () => void;
  reloadBusy: boolean;
  reloadError: string | null;
  busy: boolean;
  composerAttachmentUpload: { sessionID: string; paths: string[] } | null;
  consumeComposerAttachmentUpload: () => void;
  prompt: string;
  setPrompt: (value: string) => void;
  selectedSessionModelLabel: string;
  selectedSessionModelIsLocal: boolean;
  selectedModel: ModelRef;
  modelOptions: ModelOption[];
  llmRouterResolvedModelNames: Record<string, string | null>;
  openSessionModelPicker: (options?: {
    returnFocusTarget?: "none" | "composer";
  }) => void;
  applySessionModelSelection: (model: ModelRef) => void;
  setSessionModel: (providerID: string, modelID: string) => void;
  setSessionModelForCurrentSessionOnly: (
    providerID: string,
    modelID: string,
  ) => void;
  clearSessionModelOverride: (sessionID: string) => void;
  modelVariantLabel: string;
  modelVariant: string | null;
  setModelVariant: (value: string) => void;
  activePermission: PendingPermission | null;
  permissionReplyBusy: boolean;
  respondPermission: (
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => void;
  respondPermissionAndRemember: (
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => void;
  activeQuestion: PendingQuestion | null;
  questionReplyBusy: boolean;
  respondQuestion: (requestID: string, answers: string[][]) => void;
  rejectQuestion: (requestID: string) => void;
  safeStringify: (value: unknown) => string;
  error: string | null;
  sessionStatus: string;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  startProviderAuth: (providerId?: string) => Promise<ProviderOAuthStartResult>;
  completeProviderAuthOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => Promise<{
    connected: boolean;
    pending?: boolean;
    terminated?: boolean;
    message?: string;
  }>;
  cancelProviderAuthOAuth?: (providerId: string) => Promise<void>;
  submitProviderApiKey: (
    providerId: string,
    apiKey: string,
  ) => Promise<string | void>;
  refreshProviders: () => Promise<unknown>;
  openProviderAuthModal: (options?: {
    returnFocusTarget?: "none" | "composer";
  }) => Promise<void>;
  closeProviderAuthModal: (options?: { restorePromptFocus?: boolean }) => void;
  providerAuthModalOpen: boolean;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<
    string,
    { type: "oauth" | "api"; label: string }[]
  >;
  providers: ProviderListItem[];
  allProviders: ProviderListItem[];
  providerDefaults: Record<string, string>;
  providerConnectedIds: string[];
  listAgents: () => Promise<Agent[]>;
  searchFiles: (query: string) => Promise<string[]>;
  listCommands: () => Promise<
    {
      id: string;
      name: string;
      description?: string;
      source?: "command" | "mcp" | "skill";
    }[]
  >;
  commandsVersion: number;
  agentsVersion: number;
  selectedSessionAgent: string | null;
  setSessionAgent: (
    sessionId: string,
    agent: string | null,
    opts?: { source?: "user" | "classifier" },
  ) => void;
  setPendingSessionAgent: (agent: string | null) => void;
  applySessionAgentModelPolicy: (
    sessionId: string,
    agent: string | null,
  ) => boolean;
  confirmEmailAgentCloudRisk: () => Promise<boolean>;
  saveSession: (sessionId: string) => Promise<string>;
  sessionStatusById: Record<string, string>;
  hasEarlierMessages: boolean;
  loadingEarlierMessages: boolean;
  loadEarlierMessages: (sessionId: string) => Promise<void>;
  sessionMessageHistoryComplete: (sessionId: string) => boolean;
  deleteSession: (sessionId: string) => Promise<void>;
  piiLevel: PiiLevel;
  setPiiLevel: (level: PiiLevel) => void;
  customPiiCategories: string[];
  setCustomPiiCategories: (cats: string[]) => void;
  /**
   * Voice-input state, forwarded to the composer's microphone button. Optional:
   * without it the button drives the browser speech service only.
   */
  voiceInput?: VoiceInputController;
  ttsNarration: NarrationState;
  setTtsNarrationOn: (on: boolean) => void;
  /** Whether the backend exposes TTS at all; the 🔊 controls are hidden when false. */
  ttsAvailable: boolean;
  /** Gated toggle: enabling narration may first show the voice-model download consent dialog. */
  toggleTtsNarration: () => void;
  ttsSpeaking: boolean;
  /** On-demand playback of a single assistant reply (speaker button next to Copy). */
  speakMessage: (messageId: string, text: string) => void;
  /** The message being read aloud on demand, and whether it is still starting; or null. */
  ttsReadAloud: ReadAloudState | null;
};
