/** Props for the Settings page. */
import type { VoiceInputController } from "~/features/voice-input";
import type { DashboardTab } from "../types";
import type { ProviderListItem } from "../types";
import type { SettingsTab } from "../types";
import type { LlmRouterClient } from "../lib/llmrouter-client";
import type { LlmRouterCloudModel } from "../lib/llmrouter-client";
import type { LlmRouterProviderModel } from "../lib/llmrouter-client";
import type { LocalModelHealthInfo } from "../lib/local-model-availability";
import type { OpenworkRuntimeSettings } from "../lib/openwork-server";
import type { OpenworkRuntimeSettingsPatch } from "../lib/openwork-server";
import type { OpenworkServerStatus } from "../lib/openwork-server";
import type { OpenworkServerInfo } from "../lib/tauri";
import type { ResetInstallIdFeedback } from "../app.app-prefs";
import type { Accessor } from "solid-js";
import type { Language } from "../../i18n";
import type { UpdateStatus } from "../context/updater";
import type { UpdaterEnvironment } from "../lib/tauri";

export type SettingsViewProps = {
  busy: boolean;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  providerAuthBusy: boolean;
  openProviderAuthModal: (options?: {
    returnFocusTarget?: "none" | "composer";
  }) => Promise<void>;
  disconnectProvider: (providerId: string) => Promise<string | void>;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  /** Lightweight provider-only refresh for edge model transitions. */
  refreshProviders: () => Promise<unknown>;
  cloudModel: LlmRouterCloudModel | null;
  cloudModelHealthError: string | null;
  cloudModelLoading: boolean;
  cloudModelDeleting: boolean;
  cloudModelTesting: boolean;
  localModelHealth: LocalModelHealthInfo | null;
  saveCloudModel: (input: {
    provider: string;
    model: string;
    max_tokens?: number;
    context_limit?: number;
  }) => Promise<void>;
  deleteCloudModel: () => Promise<void>;
  testProviderConnection: (input: { provider: string; model?: string }) => Promise<void>;
  loadProviderModels: (provider: string) => Promise<LlmRouterProviderModel[]>;
  /** Accessor for the ServiceHub-backed LLM router client (null until connected). */
  llmRouterClient: () => LlmRouterClient | null;
  /** Committed primary-bundle capability accessor (single connected-truth + ceiling). */
  primaryBundleCapability?: () =>
    | import("@different-ai/openwork-contracts/capability").PrimaryBundleCapability
    | null;
  edgeConfigured: boolean;
  /** True iff the committed primary bundle's backend is "edge" (single connected-truth). */
  edgeConnected?: boolean;
  edgeBaseUrl: string;
  edgeModelName: string;
  edgeBypassProxy?: boolean;
  edgeTesting: boolean;
  edgeError: string | null;
  testEdgeConnection: (input: {
    base_url: string;
    api_key: string;
    model_name: string;
    bypass_proxy?: boolean;
  }) => Promise<string[]>;
  connectEdge: (input: {
    base_url: string;
    api_key: string;
    model_name: string;
    bypass_proxy?: boolean;
  }) => Promise<void>;
  /** Connect a selected local (llama) bundle by staging a model switch. */
  connectLocal?: (bundleId: string) => Promise<boolean>;
  /** True on Lite hardware with Edge connected: the Edge card offers Disconnect. */
  edgeDisconnectAvailable?: boolean;
  edgeDisconnecting?: boolean;
  /** Release the Edge server and return to Cloud only. Throws on failure. */
  disconnectEdge?: () => Promise<void>;
  /** Progress line while the model switch is running. */
  bundleSwitchMessage?: string | null;
  /** Error surfaced if the model switch failed. */
  bundleSwitchError?: string | null;
  /** Per-step probe checklist for the model-change dialog. */
  bundleSwitchSteps?:
    | import("~/shared/ui/restart-required-dialog").BundleSwitchStep[]
    | null;
  /** True while a staged switch is being applied. */
  bundleSwitchApplying?: boolean;
  bundleSwitchCanResume?: boolean;
  /** Transient "Edge connected." confirmation shown after Apply connects an Edge server. */
  edgeUpdatedMessage?: string | null;
  /** Apply the staged switch; true means it completed without an App restart. */
  onApplyBundleSwitch?: () => Promise<boolean>;
  /** Discard the staged switch and clear its UI state ("Cancel"/Disconnect). */
  onCancelSwitch?: () => void;
  /** Signal the config-read effect to skip overwriting defaultModel on next reconnect. */
  setPreserveDefaultModel?: (v: boolean) => void;
  openworkServerHostInfo: OpenworkServerInfo | null;
  openworkServerWorkspaceId: string | null;
  runtimeSettings: OpenworkRuntimeSettings | null;
  runtimeSettingsStatus: "idle" | "loading" | "saving" | "error";
  runtimeSettingsError: string | null;
  refreshRuntimeSettings: () => Promise<void>;
  saveRuntimeSettings: (patch: OpenworkRuntimeSettingsPatch) => Promise<void>;
  developerMode: boolean;
  toggleDeveloperMode: () => void;
  keepBackendOnExit: boolean;
  setKeepBackendOnExit: (value: boolean) => void;
  fullTelemetryEnabled: boolean;
  setFullTelemetryEnabled: (value: boolean) => void;
  baselineTelemetryEnabled: boolean;
  setBaselineTelemetryEnabled: (value: boolean) => void;
  resetInstallId: () => void;
  resetInstallIdFeedback: ResetInstallIdFeedback;
  defaultModelLabel: string;
  defaultModelRef: string;
  openDefaultModelPicker: () => void;
  showThinking: boolean;
  toggleShowThinking: () => void;
  autoCompactContext: boolean;
  toggleAutoCompactContext: () => void;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
  modelVariantLabel: string;
  editModelVariant: () => void;
  language: Language;
  setLanguage: (value: Language) => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
  updateStatus: Accessor<UpdateStatus | null>;
  updateEnv: Accessor<UpdaterEnvironment | null>;
  checkForUpdates: () => void;
  openUpdateDownloadPage: (url: string) => void;
  anyActiveRuns: boolean;
  repairOpencodeMigration: () => void;
  migrationRepairBusy: boolean;
  migrationRepairResult: { ok: boolean; message: string } | null;
  migrationRepairAvailable: boolean;
  migrationRepairUnavailableReason: string | null;
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  onNavigateDashboard?: (tab: DashboardTab) => void;
  /**
   * Voice-input state from the app shell. Optional: when it is absent the
   * "Voice input" tab is not offered at all, which keeps every existing caller
   * (and the settings tests) working unchanged.
   */
  voice?: VoiceInputController;
};
