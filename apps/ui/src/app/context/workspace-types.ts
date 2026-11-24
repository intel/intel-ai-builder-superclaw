import type {
  Client,
  EngineRuntime,
  OnboardingStep,
  OpencodeConnectStatus,
  ProviderListItem,
  StartupPreference,
  WorkspaceConnectionState,
} from "../types";
import type { OpencodeAuth } from "../lib/opencode";
import type { OpenworkServerClient, OpenworkServerSettings } from "../lib/openwork-server";
import type { WorkspaceInfo } from "../lib/tauri";
import type { View } from "../../shared/types/navigation";
import type { ModelRef } from "../../shared/types/models";
import type { MessageWithParts, PendingPermission, TodoItem } from "../../shared/types/session";

// Plain data types for the workspace store: its debug trace/event records, the
// sandbox-create progress model the onboarding UI renders, and the migration
// repair result. Moved verbatim out of context/workspace.ts — no behaviour change.

export type OwtTrace = {
  requestId: string;
  attempt: number;
  tokenCreatedAt: string;
  tokenScope: string;
  tokenRevision: string | null;
};

export type WorkspaceDebugEvent = {
  at: number;
  label: string;
  payload?: unknown;
};

export type MigrationRepairResult = {
  ok: boolean;
  message: string;
};

// Signatures of the store members that more than one extracted module depends
// on. Declared once here so the copies cannot drift apart.

export type UpdateWorkspaceConnectionState = (
  workspaceId: string,
  next: Partial<WorkspaceConnectionState>,
) => void;

export type StartHost = (optionsOverride?: {
  workspacePath?: string;
  navigate?: boolean;
}) => Promise<boolean>;

export type ConnectToServer = (
  nextBaseUrl: string,
  directory?: string,
  context?: {
    workspaceId?: string;
    workspaceType?: WorkspaceInfo["workspaceType"];
    targetRoot?: string;
    reason?: string;
  },
  auth?: OpencodeAuth,
  connectOptions?: { quiet?: boolean; navigate?: boolean },
) => Promise<boolean>;

/**
 * Everything `createWorkspaceStore` receives from the app shell. Named here so
 * the extracted store modules can accept it as a single dependency; every
 * member is a thunk or a callback, so passing the object cannot capture a
 * stale value.
 */
export type WorkspaceStoreOptions = {
  startupPreference: () => StartupPreference | null;
  setStartupPreference: (value: StartupPreference | null) => void;
  onboardingStep: () => OnboardingStep;
  setOnboardingStep: (step: OnboardingStep) => void;
  rememberStartupChoice: () => boolean;
  setRememberStartupChoice: (value: boolean) => void;
  baseUrl: () => string;
  setBaseUrl: (value: string) => void;
  clientDirectory: () => string;
  setClientDirectory: (value: string) => void;
  client: () => Client | null;
  setClient: (value: Client | null) => void;
  setConnectedVersion: (value: string | null) => void;
  setSseConnected: (value: boolean) => void;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  loadSessions: (scopeRoot?: string) => Promise<void>;
  refreshPendingPermissions: () => Promise<void>;
  selectedSessionId: () => string | null;
  selectSession: (id: string) => Promise<void>;
  setSelectedSessionId: (value: string | null) => void;
  setMessages: (value: MessageWithParts[]) => void;
  setTodos: (value: TodoItem[]) => void;
  setPendingPermissions: (value: PendingPermission[]) => void;
  setSessionStatusById: (value: Record<string, string>) => void;
  defaultModel: () => ModelRef;
  modelVariant: () => string | null;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshPlugins: () => Promise<void>;
  engineSource: () => "path" | "sidecar" | "custom";
  engineCustomBinPath?: () => string;
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  setView: (value: View) => void;
  isWindowsPlatform: () => boolean;
  openworkServerSettings: () => OpenworkServerSettings;
  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  openworkServerClient?: () => OpenworkServerClient | null;
  setOpencodeConnectStatus?: (status: OpencodeConnectStatus | null) => void;
  onEngineStable?: () => void;
  engineRuntime?: () => EngineRuntime;
  developerMode: () => boolean;
};
