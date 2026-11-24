// The shapes that used to be declared here now live in `~/shared/types/*`, split
// by domain. This file re-exports them so existing importers keep working.
//
// What is still declared below cannot move yet: `WorkspaceProfileBundleV1` is derived
// from a type in `app/lib/openwork-server`, and `shared/` may not import `app/`. It
// follows once that family moves down.
//
// Nothing new belongs here. A new shape goes straight to the module in
// `~/shared/types/` that names its domain, or to the slice that owns it.
import type { Client } from "~/shared/platform/transport/opencode";
import type { OpenworkWorkspaceExport } from "./lib/openwork-server";

export type { Client };

export type { ScheduledJob } from "~/shared/platform/tauri";

export type WorkspaceProfileBundleV1 = {
  schemaVersion: 1;
  type: "workspace-profile";
  name: string;
  description: string;
  workspace: OpenworkWorkspaceExport;
};

export type {
  ArtifactItem,
  ClassifierResponseKind,
  MessageGroup,
  MessageInfo,
  MessageWithParts,
  PendingPermission,
  PendingQuestion,
  PlaceholderAssistantMessage,
  SessionClassifierTurn,
  SessionClassifierUserTurn,
  SessionCompactTurn,
  SessionErrorTurn,
  SessionErrorTurnKind,
  SidebarSessionItem,
  TodoItem,
  ToolStepMode,
} from "~/shared/types/session";
export {
  PENDING_USER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_CLASSIFIER_USER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
} from "~/shared/types/session";
export type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  PromptMode,
  SlashCommandOption,
} from "~/shared/types/composer";
export type {
  HubSkillCard,
  HubSkillRepo,
  PluginInstallStep,
  PluginScope,
  SharedSkillItem,
  SkillCard,
  SkillsSetBundleV1,
  SuggestedPlugin,
} from "~/shared/types/extensions";
export type {
  McpServerConfig,
  McpServerEntry,
  McpStatus,
  McpStatusMap,
} from "~/shared/types/mcp";
export type { ModelOption, ModelRef, ProviderListItem } from "~/shared/types/models";
export type {
  DashboardTab,
  OnboardingStep,
  PromptFocusReturnTarget,
  SettingsTab,
  View,
} from "~/shared/types/navigation";
export type {
  OpencodeConnectStatus,
  OpencodeEvent,
  ReloadReason,
  ReloadTrigger,
} from "~/shared/types/opencode-connection";
export type { EngineRuntime, PiiLevel, StartupPreference } from "~/shared/types/preferences";
export type {
  WorkspaceConnectionState,
  WorkspaceConnectionStatus,
  WorkspaceDisplay,
  WorkspaceOpenworkConfig,
  WorkspacePreset,
  WorkspaceSessionGroup,
} from "~/shared/types/workspace";
