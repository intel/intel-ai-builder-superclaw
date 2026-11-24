import type { JSX, createSignal } from "solid-js";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { MessageWithParts } from "../../types";
import type { SkillCard } from "~/shared/types/extensions";
import type { DeepResearchReportSummaryBlock } from "~/shared/util/turn-blocks";
import type { ModelBadgeDescriptor } from "~/shared/util/model-ref";
import type { ActivityModelExecution } from "../../lib/activity-model-executions";
import type { SearchNavState } from "./message-list.search-nav";
import type { SearchHighlightBudget } from "../part-view.highlight";
import type { ReadAloudState } from "~/features/tts";

/** Host-side lookups for files the transcript references. */
export type MessageListLocalFiles = {
  /** Resolve a container/workspace file path to a host-side path for opening. */
  resolveHostFilePath: (containerPath: string) => Promise<string | null>;
  /** Byte size for an attachment chip; null hides it. */
  fileSize: (path: string) => Promise<number | null>;
  /** A loadable thumbnail URL for a local image attachment; null keeps the icon. */
  imageThumbnail: (path: string) => Promise<string | null>;
};

export type MessageListProps = {
  messages: MessageWithParts[];
  isStreaming?: boolean;
  developerMode: boolean;
  debugObservabilityAvailable?: boolean;
  showThinking: boolean;
  getSessionById?: (sessionId: string | null) => Session | null;
  getMessagesBySessionId?: (sessionId: string | null) => MessageWithParts[];
  ensureSessionLoaded?: (sessionId: string) => Promise<void> | void;
  sessionLoadingById?: (sessionId: string | null) => boolean;
  expandedStepIds: Set<string>;
  setExpandedStepIds: (updater: (current: Set<string>) => Set<string>) => void;
  openSessionById?: (sessionId: string) => void;
  searchMatchMessageIds?: ReadonlySet<string>;
  searchHighlightQuery?: string;
  searchHighlightBudget?: SearchHighlightBudget;
  /** Reports the rendered-DOM match count/active position after each repaint. */
  onSearchNavStateChange?: (state: SearchNavState) => void;
  /** Registers the live navigation handle; null on unmount. */
  setSearchMatchController?: (
    controller: { requestNav: (offset: number) => void } | null,
  ) => void;
  workspaceRoot?: string;
  /** Installed skills, so a skill command chip shows the skill's own name. */
  skills?: SkillCard[];
  localFiles?: MessageListLocalFiles;
  /** Collapsing a large message drops content above the viewport; caller re-pins the originating prompt. */
  onCollapseLargeText?: (messageId: string) => void;
  scrollElement?: () => HTMLElement | undefined;
  setScrollToMessageById?: (
    handler: ((messageId: string, behavior?: ScrollBehavior) => boolean) | null,
  ) => void;
  footer?: JSX.Element;
  reportSummaries?: DeepResearchReportSummaryBlock[];
  onOpenReportSummary?: (path: string) => void;
  onPreviewFile?: (path: string) => void;
  onRevealFile?: (path: string) => void;
  variant?: "default" | "nested";
  /** Elapsed ms per assistant message — keyed by messageId, shown after "Copy message" (debug observability only). */
  lastRunElapsedMs?: Record<string, number>;
  /** On-demand "read aloud" of a single assistant reply (speaker button next to Copy). */
  speakMessage?: (messageId: string, text: string) => void;
  /** Whether the backend exposes TTS; the read-aloud button is hidden when false. */
  ttsAvailable?: boolean;
  /** The message being read aloud on demand, and whether it is still starting; or null. */
  ttsReadAloud?: ReadAloudState | null;
  /** Title of the current session, used for pre-filling bug reports. */
  sessionTitle?: string;
  _externalToolOutputOpenMap?: ReturnType<
    typeof createSignal<Map<string, boolean>>
  >;
  _externalSubagentOpenMap?: ReturnType<
    typeof createSignal<Map<string, boolean>>
  >;
  /** External scroll-position map for tool output <pre> elements, keyed by partId */
  _externalToolOutputScrollPositions?: Map<string, number>;
  // Revert to the given message and resubmit `text` as its replacement
  onSubmitEditedUserMessage?: (
    messageId: string,
    text: string,
    options?: { optimisticHide?: boolean },
  ) => void | Promise<void>;
  canEditLastUserMessage?: boolean;
  // Retry the latest assistant response. When `onSubmitEditedUserMessage` is provided, MessageList will prefer an in-place revert+resend;
  // otherwise this can be used as a fallback retry action.
  onRetry?: () => void;
  // Opens Settings (model tab) from the "Cloud/Local Model Not Configured" error turn's CTA button.
  onOpenSettings?: () => void;
  /**
   * Per-turn token totals from LRM `token_events`, keyed by the turn's final
   * assistant `message.info.id`, split by whether each contributing call ran
   * locally or in the cloud (via `isLocalProvider`). Omitted / absent id =>
   * no token line shown.
   */
  tokensByMessageId?: Record<string, { input: number; output: number; local: number; cloud: number }>;
  /** Served-model badge label keyed by the turn's final assistant message id. */
  servedModelLabelByMessageId?: Record<string, ModelBadgeDescriptor>;
  /** Presentation-ready model dispatch metadata keyed by stable tool part ID. */
  activityModelExecutions?: Record<string, ActivityModelExecution>;
};
