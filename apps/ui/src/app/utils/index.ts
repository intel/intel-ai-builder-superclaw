/**
 * Public surface of the app utils.
 *
 * Most of these modules now live under `shared/`; this barrel re-exports them so
 * the existing `from "../utils"` importers and co-located tests keep working.
 * What is still local is `persist`, `read-stored-preferences` and `model-variant`.
 */

export {
  deriveArtifacts,
  deriveWorkingFiles,
  summarizeStep,
} from "~/shared/util/artifacts";
export {
  addOpencodeCacheHint,
  commandPathFromWorkspaceRoot,
  formatBytes,
  formatRelativeTime,
  localizeSessionTitle,
  normalizeDirectoryQueryPath,
  normalizeEvent,
  safeParseJson,
  safeStringify,
} from "~/shared/util/format";
export {
  normalizeDirectoryPath,
} from "~/shared/platform/directory-path";
export {
  groupMessageParts,
} from "~/shared/util/turn-blocks";
export {
  LITELLM_EMPTY_CONTENT_PLACEHOLDER,
  filterZeroUsagePlaceholders,
  formatModelLabel,
  formatModelRef,
  mergeGenericLocalEntries,
  modelEquals,
  normalizeModelKey,
  parseModelRef,
  stripEmptyContentPlaceholder,
  stripModelPrefix,
} from "~/shared/util/model-ref";
export {
  EXPLORATION_TOOL_NAMES,
  isUserVisiblePart,
  isVisibleTextPart,
  isWebSearchToolOutput,
} from "~/shared/util/part-visibility";
export {
  clearStartupPreference,
  isTauriRuntime,
  isWindowsPlatform,
  readStartupPreference,
  writeStartupPreference,
} from "~/shared/platform/runtime-env";
export {
  lastUserModelFromMessages,
  modelFromUserMessage,
  normalizeSessionStatus,
  upsertSession,
} from "~/shared/util/session-collections";
export {
  classifyTool,
} from "~/shared/util/tool-summary";
export {
  resolveWorkspaceDirectory,
} from "~/shared/platform/workspace-directory";
export {
  getWorkspaceTaskLoadErrorDisplay,
} from "~/shared/platform/workspace-status";
