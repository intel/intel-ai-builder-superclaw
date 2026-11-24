import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  on,
  runWithOwner,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
import {
  Bug,
  Check,
  CircleAlert,
  Copy,
  FileText,
  Pencil,
  RefreshCw,
  Volume2,
} from "lucide-solid";
import { createVirtualizer } from "@tanstack/solid-virtual";
import BugReportLogsDialog from "../bug-report-logs-dialog";
import {
  PENDING_USER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX,
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
  type MessageGroup,
  type MessageWithParts,
  type SessionErrorTurnKind,
  type ToolStepMode,
} from "../../types";
import {
  groupMessageParts,
  isUserVisiblePart,
  summarizeStep,
} from "../../utils";
import { sanitizeProtectionMessages } from "~/shared/util/protection-messages";
import { copyTextForMessageBlock, partToText } from "./message-text";
import { splitTurnGroups } from "~/shared/util/turn-blocks";
import {
  deepCloneMessageBlock,
  getBlockMessageIds,
  isAssistantMessageStreaming,
  mergeToolStepsBlocks,
  shouldUseInnerTimelineScroll,
  toolStepsContainStreamingAssistant,
  toolStepsSignature,
  messageReuseSignature,
  type DeepResearchReportSummaryBlock,
  type MessageBlock,
  type MessageBlockItem,
  type ToolStepsBlock,
  type ToolStepGroup,
} from "~/shared/util/turn-blocks";
import {
  attachmentsForParts,
  hiddenImageParts,
  isMessageAttachmentPart,
  selectedFileAttachment,
  stripAttachmentMentions,
  stripSelectedFileAnnotations,
} from "./message-attachments";
import { MessageAttachmentChip } from "./attachment-chip";
export type { DeepResearchReportSummaryBlock } from "~/shared/util/turn-blocks";
import { SkillCommandPartView } from "./skill-command-chip";
import { MessageAgentBadge } from "./message-agent-badge";
import { MessageModelBadge } from "./message-model-badge";
import { createSearchHighlightBudget } from "../part-view.highlight";
import { usePlatform } from "../../context/platform";
import {
  BugReportFeedbackNote,
  createBugReportMessageFeedback,
} from "./message-list.bug-report-feedback";
import {
  ExplorationWebSource,
} from "./message-list.exploration";
import {
  VIRTUALIZATION_THRESHOLD,
  VIRTUAL_OVERSCAN,
  formatElapsedMs,
  formatTokenSummary,
  messageModelBadgeLabel,
  renderReportMarkdown,
} from "./message-list.format";
import { createStepComponents } from "./message-list.steps";
import {
  getTaskStepInfo,
  searchableStepLabel,
  stepDurationMs,
  stepTone,
  toolStepStatus,
  visibleToolStepOutput,
  type StepTone,
} from "./message-list.tool";
import { StepIcon } from "./message-list.step-icon";
import {
  TimelineChildren,
  TimelineRow,
  modelSourceMetaItem,
  type TimelineMetaItem,
} from "./message-list.timeline-row";
import type { MessageListProps } from "./message-list.types";
import { createBugReportFlow } from "../../lib/bug-report-flow";
import { perfNow, recordPerfLog } from "../../lib/perf-log";
import { t } from "../../../i18n";
import { Tooltip } from "~/shared/ui/tooltip";
import { MessageTurnTime } from "./message-turn-time";
import { transcriptTurnStarts } from "./message-turn-clock";

import { useGlobalSearchMessageTarget } from "./use-global-search-message-target";
import { MaskedFilesPanel, collectMaskedFiles } from "./message-list.masked";
import {
  SEARCH_MATCH_ACTIVE_ATTR,
  SEARCH_MATCH_ACTIVE_CLASS,
  SEARCH_MATCH_SELECTOR,
  createSearchMatchController,
} from "./message-list.search-nav";
// Re-exported from the extracted helpers so this module's public surface is unchanged.
export type { MessageListProps } from "./message-list.types";

const SEARCH_SCAN_BATCH_SIZE = 16;
const SEARCH_SCAN_BATCH_DELAY_MS = 8;
const SEARCH_MARK_MUTATION_QUIET_MS = 35;
type SearchMatchLocation = { blockIndex: number; occurrenceIndex: number };

export default function MessageList(props: MessageListProps) {
  const platform = usePlatform();
  const [localSearchHighlightBudget, setLocalSearchHighlightBudget] =
    createSignal(createSearchHighlightBudget());
  const searchHighlightBudget = () =>
    props.searchHighlightBudget ?? localSearchHighlightBudget();
  createEffect(
    on(
      () => props.searchHighlightQuery?.trim() ?? "",
      () => {
        if (!props.searchHighlightBudget) {
          setLocalSearchHighlightBudget(createSearchHighlightBudget());
        }
      },
    ),
  );
  const [copyingId, setCopyingId] = createSignal<string | null>(null);
  const bugReportFeedback = createBugReportMessageFeedback();
  const [editingMessageId, setEditingMessageId] = createSignal<string | null>(
    null,
  );
  const [editingText, setEditingText] = createSignal("");
  const [editingOriginalText, setEditingOriginalText] = createSignal("");
  const [collapsedMaskingSummaries, setCollapsedMaskingSummaries] =
    createSignal<Set<string>>(new Set());
  const [failedExplorationFaviconHosts, setFailedExplorationFaviconHosts] =
    createSignal<Set<string>>(new Set());
  const bugReportFlow = createBugReportFlow((url) => platform.openLink(url));
  const [failedAttachmentPreviewUrls, setFailedAttachmentPreviewUrls] =
    createSignal<Set<string>>(new Set());
  const isAttachmentPreviewFailed = (url: string) =>
    failedAttachmentPreviewUrls().has(url);
  const markAttachmentPreviewFailed = (url: string) => {
    setFailedAttachmentPreviewUrls((current) => {
      if (current.has(url)) return current;
      const next = new Set(current);
      next.add(url);
      return next;
    });
  };

  const isExplorationFaviconFailed = (host: string) =>
    failedExplorationFaviconHosts().has(host);
  const markExplorationFaviconFailed = (host: string) => {
    setFailedExplorationFaviconHosts((current) => {
      if (current.has(host)) return current;
      const next = new Set(current);
      next.add(host);
      return next;
    });
  };
  const ExplorationSourceIcon = (iconProps: {
    source: ExplorationWebSource;
  }) => (
    <span
      class="relative inline-flex size-4 items-center justify-center overflow-hidden rounded-pill border border-dls-border/80 bg-dls-surface-solid/92 text-tiny font-semibold text-dls-secondary shadow-sm"
      title={iconProps.source.label}
    >
      <Show
        when={
          !!iconProps.source.faviconUrl &&
          !isExplorationFaviconFailed(iconProps.source.host)
        }
        fallback={
          <span class="absolute inset-0 flex items-center justify-center">
            {iconProps.source.initial}
          </span>
        }
      >
        <img
          src={iconProps.source.faviconUrl}
          alt=""
          class="size-full object-cover"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => markExplorationFaviconFailed(iconProps.source.host)}
        />
      </Show>
    </span>
  );

  const owner = getOwner();
  const persistentNestedMaps = new Map<
    string,
    {
      toolOutputOpenMap: ReturnType<typeof createSignal<Map<string, boolean>>>;
      subagentOpenMap: ReturnType<typeof createSignal<Map<string, boolean>>>;
      toolOutputScrollPositions: Map<string, number>;
    }
  >();
  const getOrCreateNestedMaps = (sessionId: string) => {
    const existing = persistentNestedMaps.get(sessionId);
    if (existing) return existing;

    const signals = runWithOwner(owner, () => ({
      toolOutputOpenMap: createSignal<Map<string, boolean>>(new Map()),
      subagentOpenMap: createSignal<Map<string, boolean>>(new Map()),
    }))!; // MessageList is executing under a Solid owner.
    const created = {
      ...signals,
      toolOutputScrollPositions: new Map<string, number>(),
    };
    persistentNestedMaps.set(sessionId, created);
    return created;
  };

  // Persists scroll positions for open tool output <pre> elements across StepRow remounts.
  // For nested MessageLists the parent passes _externalToolOutputScrollPositions so positions
  // survive SubagentThread remounts (same pattern as open-state maps).
  const toolOutputScrollPositions: Map<string, number> =
    props._externalToolOutputScrollPositions ?? new Map();
  // Same for the Activity timeline's own `max-h-[420px] overflow-y-auto`
  // container, keyed by StepsContainer id. The level-2 render cache below keeps
  // that container mounted across content-only updates; this map covers the
  // remaining case where the cluster's *structure* really did change (a new step
  // arrived), so the row is legitimately rebuilt and would otherwise snap the
  // user back to the top. `atBottom` is tracked separately from `top` because a
  // user parked at the bottom wants to keep following new steps, not to be
  // pinned to a pixel offset that drifts upward as the timeline grows.
  const timelineScrollPositions: Map<
    string,
    { top: number; atBottom: boolean }
  > = new Map();
  const [_localToolOutputOpenMap, _setLocalToolOutputOpenMap] = createSignal<
    Map<string, boolean>
  >(new Map());
  const toolOutputOpenMap = () =>
    props._externalToolOutputOpenMap
      ? props._externalToolOutputOpenMap[0]()
      : _localToolOutputOpenMap();
  const setToolOutputOpenMap = (
    updater: (prev: Map<string, boolean>) => Map<string, boolean>,
  ) => {
    if (props._externalToolOutputOpenMap) {
      props._externalToolOutputOpenMap[1](updater);
    } else {
      _setLocalToolOutputOpenMap(updater);
    }
  };
  const isToolOutputOpen = (partId: string) =>
    toolOutputOpenMap().get(partId) ?? false;
  const toggleToolOutputOpen = (partId: string) =>
    setToolOutputOpenMap((prev) => {
      const next = new Map(prev);
      next.set(partId, !(prev.get(partId) ?? false));
      return next;
    });

  const [_localSubagentOpenMap, _setLocalSubagentOpenMap] = createSignal<
    Map<string, boolean>
  >(new Map());
  const subagentOpenMap = () =>
    props._externalSubagentOpenMap
      ? props._externalSubagentOpenMap[0]()
      : _localSubagentOpenMap();
  const setSubagentOpenMap = (
    updater: (prev: Map<string, boolean>) => Map<string, boolean>,
  ) => {
    if (props._externalSubagentOpenMap) {
      props._externalSubagentOpenMap[1](updater);
    } else {
      _setLocalSubagentOpenMap(updater);
    }
  };
  const isSubagentOpen = (partId: string) =>
    subagentOpenMap().get(partId) ?? true;
  const toggleSubagentOpen = (partId: string) =>
    setSubagentOpenMap((prev) => {
      const next = new Map(prev);
      next.set(partId, !(prev.get(partId) ?? true));
      return next;
    });

  createEffect(() => {
    if (props.isStreaming) return;
    const currentPartIds = new Set<string>();
    for (const message of props.messages) {
      for (const part of message.parts ?? []) {
        const id = (part as any).id;
        if (id) currentPartIds.add(id);
      }
    }
    setToolOutputOpenMap((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const key of prev.keys()) {
        // `${partId}:${row}` keys open a row inside a step and live as long as the step.
        if (!currentPartIds.has(key.split(":", 1)[0])) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setSubagentOpenMap((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const key of prev.keys()) {
        if (!currentPartIds.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  });

  // â”€â”€ messageBlocks() render caches â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Level 1 — per-message blocks, keyed by message id, captured *before*
  // merging. A message whose part count and tool-classification fingerprint are
  // both unchanged skips groupMessageParts() and keeps its object identity, so
  // <For> keeps its row. A message with tool steps and a trailing reply yields
  // two blocks (cluster + answer), so the cache holds arrays.
  let previousMessagePartCountById = new Map<string, number>();
  let previousToolSignatureById = new Map<string, string>();
  let previousPerMessageBlocksById = new Map<string, MessageBlockItem[]>();
  let previousBlockRenderKey = "";
  // Level 2 — post-merge step clusters, keyed by structural and tool-status
  // fingerprint. A merged cluster spans several messages so it cannot live in
  // the level-1 cache; without this every recompute would hand <For> a brand-new
  // object and remount the whole Activity timeline, throwing away the user's
  // scroll offset inside it. Active streaming clusters are excluded because
  // their parts may be replaced without a structural signature change.
  let previousClustersBySignature = new Map<string, ToolStepsBlock>();
  let copyTimeout: number | undefined;
  const renderMessageAttachments = (block: MessageBlock, className: string) => (
    <Show when={block.attachments.length > 0}>
      <div class={className}>
        <For each={block.attachments}>
          {(attachment) => (
            <MessageAttachmentChip
              attachment={attachment}
              thumbnailFailed={isAttachmentPreviewFailed(attachment.url)}
              onThumbnailError={() => markAttachmentPreviewFailed(attachment.url)}
              onPreviewFile={props.onPreviewFile}
              onRevealFile={props.onRevealFile}
              resolveFileSize={props.localFiles?.fileSize}
              resolveImageThumbnail={props.localFiles?.imageThumbnail}
            />
          )}
        </For>
      </div>
    </Show>
  );
  onCleanup(() => {
    if (copyTimeout !== undefined) {
      window.clearTimeout(copyTimeout);
    }
  });

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyingId(id);
      if (copyTimeout !== undefined) {
        window.clearTimeout(copyTimeout);
      }
      copyTimeout = window.setTimeout(() => {
        setCopyingId(null);
        copyTimeout = undefined;
      }, 2000);
    } catch {
      // ignore
    }
  };

  const isStepsExpanded = (id: string, relatedIds: string[] = []) =>
    props.expandedStepIds.has(id) ||
    relatedIds.some((relatedId) => props.expandedStepIds.has(relatedId));

  const isEmbeddedActivityPart = (
    message: MessageWithParts,
    part: Part,
  ) =>
    message.info.role === "assistant" &&
    part.type === "tool" &&
    isUserVisiblePart(part);

  const renderablePartsForMessage = (message: MessageWithParts) =>
    message.parts.filter((part) => {
      if (props.variant === "nested") {
        return isEmbeddedActivityPart(message, part);
      }

      if (!props.developerMode && !isUserVisiblePart(part, { isUserMessage: message.info.role === "user" })) {
        return false;
      }

      if (part.type === "reasoning") {
        return false;
      }

      if (part.type === "step-start" || part.type === "step-finish") {
        return false;
      }

      if (
        part.type === "text" ||
        part.type === "tool" ||
        part.type === "agent" ||
        part.type === "file"
      ) {
        return true;
      }

      return props.developerMode;
    });

  const messageBlocks = createMemo<MessageBlockItem[]>(() => {
    const startedAt = perfNow();
    const renderKey = `${props.developerMode ? 1 : 0}:${props.showThinking ? 1 : 0}`;
    const blocks: MessageBlockItem[] = [];
    const nextMessagePartCountById = new Map<string, number>();
    const nextToolSignatureById = new Map<string, string>();
    const nextPerMessageBlocksById = new Map<string, MessageBlockItem[]>();
    let changedMessageCount = 0;
    let addedMessageCount = 0;
    let toolPartCount = 0;
    let stepGroupCount = 0;

    props.messages.forEach((message, index) => {
      const renderableParts = renderablePartsForMessage(message);
      if (!renderableParts.length) return;

      const messageId = String((message.info as any).id ?? "");
      const idKey = messageId || `idx:${index}`;
      const totalParts = message.parts.length;
      nextMessagePartCountById.set(idKey, totalParts);
      const toolSignature = messageReuseSignature(message.parts);
      nextToolSignatureById.set(idKey, toolSignature);
      const previousPartCount = previousMessagePartCountById.get(idKey);
      const previousBlocksForMessage = previousPerMessageBlocksById.get(idKey);
      if (previousPartCount === undefined) {
        addedMessageCount += 1;
      } else if (previousPartCount !== totalParts) {
        changedMessageCount += 1;
      }

      const isUser = (message.info as any).role === "user";
      // The last message is always rebuilt: its text parts are snapshots taken
      // by groupMessageParts, so a reused block would render stale streaming
      // text. The tool-classification fingerprint has to match too — a step
      // group's exploration/standalone mode is derived from mutable tool output,
      // so a part count alone cannot tell whether the grouping still holds.
      const canReuseStableBlocks =
        previousBlockRenderKey === renderKey &&
        index < props.messages.length - 1 &&
        previousPartCount !== undefined &&
        previousPartCount === totalParts &&
        previousToolSignatureById.get(idKey) === toolSignature &&
        previousBlocksForMessage !== undefined &&
        previousBlocksForMessage.length > 0 &&
        previousBlocksForMessage.every(
          (block) =>
            (block.type === "message" || block.type === "tool-steps") &&
            block.isUser === isUser,
        );

      if (canReuseStableBlocks && previousBlocksForMessage) {
        toolPartCount += renderableParts.reduce(
          (count, part) => (part.type === "tool" ? count + 1 : count),
          0,
        );
        for (const previousBlock of previousBlocksForMessage) {
          if (previousBlock.type === "message") {
            stepGroupCount += previousBlock.groups.reduce(
              (count, group) => (group.type === "tool-steps" ? count + 1 : count),
              0,
            );
          } else if (previousBlock.type === "tool-steps") {
            stepGroupCount += previousBlock.toolSteps.length;
          }
          blocks.push(previousBlock);
        }
        nextPerMessageBlocksById.set(idKey, previousBlocksForMessage);
        return;
      }

      toolPartCount += renderableParts.reduce(
        (count, part) => (part.type === "tool" ? count + 1 : count),
        0,
      );
      const groupId = String((message.info as any).id ?? "message");
      const attachments = attachmentsForParts(
        isUser ? [...renderableParts, ...hiddenImageParts(message.parts, renderableParts)] : renderableParts,
        props.workspaceRoot,
      );
      const nonAttachmentParts = renderableParts
        .filter(
          (part) =>
            !isMessageAttachmentPart(part) && !selectedFileAttachment(part),
        )
        .map((part) => {
          if (part.type !== "text") return part;
          const text = stripSelectedFileAnnotations(String((part as { text?: string }).text ?? ""));
          return {
            ...part,
            text: isUser ? stripAttachmentMentions(text, attachments, props.workspaceRoot) : text,
          } as Part;
        })
        .filter(
          (part) =>
            part.type !== "text" ||
            String((part as { text?: string }).text ?? "").trim().length > 0,
        );
      const groups = groupMessageParts(nonAttachmentParts, groupId, isUser);
      stepGroupCount += groups.reduce(
        (count, group) => (group.type === "tool-steps" ? count + 1 : count),
        0,
      );

      const messageBlockFor = (
        blockGroups: MessageGroup[],
        blockAttachments: MessageBlock["attachments"],
      ): MessageBlock => ({
        type: "message",
        message,
        renderableParts,
        attachments: blockAttachments,
        groups: blockGroups,
        isUser,
        messageId,
      });

      // Turn split (#2697): the agent loop only ends when the model replies
      // without calling a tool, so text at or before the last tool-step group
      // is narration and is dropped from the UI; only text after it is the
      // reply. User messages never split.
      const { toolSteps, answer } = isUser
        ? { toolSteps: [], answer: groups }
        : splitTurnGroups(groups);

      if (toolSteps.length === 0) {
        const block = messageBlockFor(groups, attachments);
        blocks.push(block);
        nextPerMessageBlocksById.set(idKey, [block]);
        return;
      }

      const timelineGroups: ToolStepGroup[] = toolSteps
        .filter((group) => group.type === "tool-steps")
        .map((group) => ({
          id: group.id,
          parts: group.parts,
          mode: group.mode,
        }));

      const stepsClusterBlock: ToolStepsBlock = {
        type: "tool-steps",
        id: timelineGroups[0].id,
        toolSteps: timelineGroups,
        messageIds: [messageId],
        isUser,
      };
      const emitted: MessageBlockItem[] =
        answer.length > 0 || attachments.length > 0
          ? [stepsClusterBlock, messageBlockFor(answer, attachments)]
          : [stepsClusterBlock];
      blocks.push(...emitted);
      nextPerMessageBlocksById.set(idKey, emitted);
    });

    const reportSummariesByMessageId = new Map<
      string,
      DeepResearchReportSummaryBlock[]
    >();
    if (props.variant !== "nested") {
      for (const summary of props.reportSummaries ?? []) {
        const afterMessageId = summary.afterMessageId.trim();
        if (!afterMessageId) continue;
        const existing = reportSummariesByMessageId.get(afterMessageId) ?? [];
        existing.push(summary);
        reportSummariesByMessageId.set(afterMessageId, existing);
      }
    }

    // A message can now span two blocks (cluster + answer); splice its report
    // summaries only after the last of them.
    const lastBlockIndexByMessageId = new Map<string, number>();
    blocks.forEach((block, blockIndex) => {
      for (const messageId of getBlockMessageIds(block)) {
        lastBlockIndexByMessageId.set(messageId, blockIndex);
      }
    });
    const blocksWithSummaries: MessageBlockItem[] = [];
    blocks.forEach((block, blockIndex) => {
      blocksWithSummaries.push(block);
      for (const messageId of getBlockMessageIds(block)) {
        if (lastBlockIndexByMessageId.get(messageId) !== blockIndex) continue;
        const summaries = reportSummariesByMessageId.get(messageId) ?? [];
        for (const summary of summaries) {
          blocksWithSummaries.push({
            type: "report-summary",
            summary,
            isUser: false,
          });
        }
      }
    });

    const mergedBlocks = mergeToolStepsBlocks(blocksWithSummaries);
    const streamingAssistantMessageIds = new Set(
      props.messages
        .filter(isAssistantMessageStreaming)
        .map((message) => String(message.info.id ?? ""))
        .filter(Boolean),
    );

    // Level 2 reuse: swap each freshly merged step cluster back to the previous
    // object when its structure is unchanged, so <For> keeps the mounted row.
    // A streaming cluster must retain its freshly merged Part references.
    const nextClustersBySignature = new Map<string, ToolStepsBlock>();
    const stableBlocks = mergedBlocks.map((block) => {
      if (block.type !== "tool-steps") return block;
      const signature = toolStepsSignature(block, renderKey);
      const stable = toolStepsContainStreamingAssistant(
        block,
        streamingAssistantMessageIds,
      )
        ? block
        : (previousClustersBySignature.get(signature) ?? block);
      nextClustersBySignature.set(signature, stable);
      return stable;
    });

    let removedMessageCount = 0;
    previousMessagePartCountById.forEach((_partCount, id) => {
      if (!nextMessagePartCountById.has(id)) {
        removedMessageCount += 1;
      }
    });
    const addedPendingMessage = props.messages.find((message) => {
      const id = String(message.info.id ?? "");
      return (
        id.startsWith(PENDING_USER_MESSAGE_PREFIX) &&
        !previousMessagePartCountById.has(id)
      );
    });
    if (props.developerMode && addedPendingMessage) {
      recordPerfLog(true, "session.submit", "pending-user-rendered", {
        sessionID: addedPendingMessage.info.sessionID,
        messageID: addedPendingMessage.info.id,
        ms: Date.now() - addedPendingMessage.info.time.created,
      });
    }
    previousMessagePartCountById = nextMessagePartCountById;
    previousToolSignatureById = nextToolSignatureById;
    previousPerMessageBlocksById = nextPerMessageBlocksById;
    previousClustersBySignature = nextClustersBySignature;
    previousBlockRenderKey = renderKey;

    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    if (
      props.developerMode &&
      (elapsedMs >= 6 ||
        (Boolean(props.isStreaming) &&
          props.messages.length >= 16 &&
          changedMessageCount <= 2 &&
          addedMessageCount <= 1 &&
          removedMessageCount === 0) ||
        (Boolean(props.isStreaming) && toolPartCount >= 10))
    ) {
      recordPerfLog(true, "session.render", "message-blocks", {
        messageCount: props.messages.length,
        blockCount: stableBlocks.length,
        changedMessageCount,
        addedMessageCount,
        removedMessageCount,
        toolPartCount,
        stepGroupCount,
        streaming: Boolean(props.isStreaming),
        ms: elapsedMs,
      });
    }

    return stableBlocks;
  });

  const latestAssistantMessageId = createMemo(() => {
    for (let index = props.messages.length - 1; index >= 0; index -= 1) {
      const message = props.messages[index];
      if (message.info.role === "assistant") {
        return String(message.info.id ?? "");
      }
    }
    return "";
  });

  const streamingAssistantMessageIds = createMemo(() => {
    const ids = new Set<string>();
    for (const message of props.messages) {
      if (!isAssistantMessageStreaming(message)) continue;
      const id = String(message.info.id ?? "");
      if (id) ids.add(id);
    }
    return ids;
  });

  // Between agent steps no assistant message is mid-stream, so the running
  // turn is found by position: its newest Activity block, before any user turn.
  const liveToolStepsBlockId = createMemo(() => {
    if (!props.isStreaming) return null;
    const blocks = messageBlocks();
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block.isUser) return null;
      if (block.type === "tool-steps") return block.id;
    }
    return null;
  });

  const turnStartById = createMemo(() =>
    transcriptTurnStarts(props.messages, props.getMessagesBySessionId),
  );

  const latestUserMessageId = createMemo(() => {
    for (let index = props.messages.length - 1; index >= 0; index -= 1) {
      const message = props.messages[index];
      if (message.info.role !== "user") continue;
      const id = String(message.info.id ?? "");
      if (!id) continue;
      if (
        id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX) ||
        id.startsWith(SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX) ||
        id.startsWith(SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX)
      ) {
        continue;
      }
      return id;
    }
    return "";
  });

  // Only allow the edit affordance for messages that are plain text to avoid dropping file/image attachments.
  const isEditableUserMessage = (block: MessageBlock) => {
    if (block.attachments.length > 0) return false;
    return block.renderableParts.every((part) => part.type === "text");
  };

  const canRetryLatestAssistant = createMemo(() => {
    if (!props.onSubmitEditedUserMessage) return Boolean(props.onRetry);
    if (!props.canEditLastUserMessage) return false;
    const userId = latestUserMessageId();
    if (!userId) return false;
    const userBlock = messageBlocks().find(
      (block): block is MessageBlock =>
        block.type === "message" && block.messageId === userId,
    );
    if (!userBlock || !isEditableUserMessage(userBlock)) return false;
    return (
      userBlock.renderableParts
        .map((part) => partToText(part))
        .join("\n")
        .trim().length > 0
    );
  });

  const startEditingMessage = (block: MessageBlock) => {
    const text = block.renderableParts
      .map((part) => partToText(part))
      .join("\n");
    setEditingText(text);
    setEditingOriginalText(text);
    setEditingMessageId(block.messageId);
  };

  const cancelEditingMessage = () => {
    setEditingMessageId(null);
    setEditingText("");
    setEditingOriginalText("");
  };

  // Set while a retry's revert+resend is in flight, used to show a placeholder for the stale assistant reply while the resend is pending.
  const [regeneratingAssistantId, setRegeneratingAssistantId] = createSignal<
    string | null
  >(null);

  // Snapshot of the retried turn (user block through its stale assistant reply, including any tool-step clusters in between).
  const [pendingRetry, setPendingRetry] = createSignal<{
    userMessageId: string;
    frozenTailBlocks: MessageBlockItem[];
    // User message ids that already existed when retry was clicked.
    // Any new user message id that appears after retry is considered the resent duplicate and unfreezes the transcript.
    knownUserMessageIds: Set<string>;
  } | null>(null);

  // Used to unfreeze the transcript display if the resent user message never arrives.
  let pendingRetryFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPendingRetry = () => {
    if (pendingRetryFallbackTimer !== null) {
      clearTimeout(pendingRetryFallbackTimer);
      pendingRetryFallbackTimer = null;
    }
    setRegeneratingAssistantId(null);
    setPendingRetry(null);
  };

  createEffect(() => {
    const pending = pendingRetry();
    if (!pending) return;
    // Only unfreeze once a brand-new user message id shows up (the resend).
    const latestId = latestUserMessageId();
    if (latestId && !pending.knownUserMessageIds.has(latestId)) {
      clearPendingRetry();
    }
  });

  onCleanup(() => {
    if (pendingRetryFallbackTimer !== null) {
      clearTimeout(pendingRetryFallbackTimer);
      pendingRetryFallbackTimer = null;
    }
  });

  // Retry the latest assistant response: keep the prior user message intact but revert+resend it so the stale assistant reply
  // disappears and a fresh one is generated in its place.
  const retryLatestAssistantResponse = async () => {
    const userId = latestUserMessageId();
    const assistantId = latestAssistantMessageId();
    if (!props.onSubmitEditedUserMessage) {
      props.onRetry?.();
      return;
    }
    if (!userId) return;

    const userBlock = messageBlocks().find(
      (block): block is MessageBlock =>
        block.type === "message" && block.messageId === userId,
    );
    const text =
      userBlock?.renderableParts
        .map((part) => partToText(part))
        .join("\n")
        .trim() ?? "";
    if (!text || !userBlock || !isEditableUserMessage(userBlock)) {
      return;
    }

    const startIndex = messageBlocks().findIndex((block) =>
      getBlockMessageIds(block).includes(userId),
    );
    // Deep-clone each block so the frozen tail snapshot can't be changed out from under the retry-in-flight display.
    const frozenTailBlocks = (
      startIndex === -1 ? [userBlock] : messageBlocks().slice(startIndex)
    ).map((block) => deepCloneMessageBlock(block));

    const knownUserMessageIds = new Set<string>();
    for (const message of props.messages) {
      if (message.info.role !== "user") continue;
      const id = String(message.info.id ?? "");
      if (!id) continue;
      if (
        id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX) ||
        id.startsWith(SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX) ||
        id.startsWith(SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX)
      ) {
        continue;
      }
      knownUserMessageIds.add(id);
    }

    setRegeneratingAssistantId(assistantId || userId);
    setPendingRetry({
      userMessageId: userId,
      frozenTailBlocks,
      knownUserMessageIds,
    });
    if (pendingRetryFallbackTimer !== null)
      clearTimeout(pendingRetryFallbackTimer);
    // Safety net: unfreeze even if no fresh user turn ever lands (e.g. the intent
    // classifier intercepts the resend without creating a backend message).
    pendingRetryFallbackTimer = setTimeout(clearPendingRetry, 8000);
    try {
      await Promise.resolve(
        props.onSubmitEditedUserMessage(userId, text, {
          optimisticHide: false,
        }),
      );
    } catch {
      // Error toast is surfaced by the caller (session view); unfreeze immediately so
      // the transcript reflects reality (the revert/resend did not take effect).
      clearPendingRetry();
    }
  };

  const saveEditingMessage = async (messageId: string) => {
    const text = editingText().trim();
    const originalText = editingOriginalText().trim();
    if (!text || text === originalText) return;

    try {
      await props.onSubmitEditedUserMessage?.(messageId, text);
      setEditingMessageId(null);
      setEditingText("");
      setEditingOriginalText("");
    } catch {
      // Keep editor open with the user's text intact so they can retry.
    }
  };

  // Rendered block: while a retry is in flight, everything from the retried user message onward
  // (its stale assistant reply, any tool-step clusters, and the eventual resent duplicate) is
  // replaced by the frozen tail snapshot captured at retry time.
  const displayBlocks = createMemo<MessageBlockItem[]>(() => {
    const base = messageBlocks();
    const pending = pendingRetry();
    if (!pending) return base;

    const cutIndex = base.findIndex((block) =>
      getBlockMessageIds(block).includes(pending.userMessageId),
    );
    const head = cutIndex === -1 ? base : base.slice(0, cutIndex);
    return [...head, ...pending.frozenTailBlocks];
  });

  const blockIndexByMessageId = createMemo(() => {
    const next = new Map<string, number>();
    displayBlocks().forEach((block, index) => {
      if (block.type === "tool-steps") {
        block.messageIds.forEach((id) => {
          if (id) next.set(id, index);
        });
        return;
      }
      if (block.type === "message" && block.messageId) {
        next.set(block.messageId, index);
      }
    });
    return next;
  });

  const shouldVirtualize = createMemo(
    () =>
      Boolean(props.scrollElement?.()) &&
      displayBlocks().length >= VIRTUALIZATION_THRESHOLD,
  );

  const virtualItemKey = (index: number) => {
    const block = displayBlocks()[index];
    if (!block) return `block-${index}`;
    if (block.type === "tool-steps") {
      return `steps-${block.messageIds.join(",")}`;
    }
    if (block.type === "report-summary") {
      return `report-summary-${block.summary.id}`;
    }
    return `message-${block.messageId}`;
  };

  const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
    get count() {
      return displayBlocks().length;
    },
    getScrollElement: () => props.scrollElement?.() ?? null,
    estimateSize: () => 220,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: virtualItemKey,
  });

  const [searchScanOffset, setSearchScanOffset] = createSignal(0);
  const [searchScanComplete, setSearchScanComplete] = createSignal(false);
  const [activeSearchBlockIndex, setActiveSearchBlockIndex] =
    createSignal<number | null>(null);
  const [searchMatchLocations, setSearchMatchLocations] = createSignal<
    SearchMatchLocation[]
  >([]);
  const scannedSearchBlocks = new Set<number>();
  const [searchMarkerRoot, setSearchMarkerRoot] =
    createSignal<HTMLElement | null>(null);
  let cachedVirtualRows: ReturnType<typeof virtualizer.getVirtualItems> = [];
  const searchCandidateBlockIndices = createMemo(() => {
    if (
      !props.searchHighlightQuery?.trim() ||
      !props.searchMatchMessageIds?.size
    ) {
      return [];
    }
    return displayBlocks().flatMap((block, index) =>
      getBlockMessageIds(block).some((id) =>
        props.searchMatchMessageIds?.has(id),
      )
        ? [index]
        : [],
    );
  });
  const searchScanBatch = createMemo(() =>
    searchCandidateBlockIndices().slice(
      searchScanOffset(),
      searchScanOffset() + SEARCH_SCAN_BATCH_SIZE,
    ),
  );
  const captureBlockSearchMatches = (blockIndex: number, row: HTMLElement) => {
    const matches = Array.from(
      row.querySelectorAll(SEARCH_MATCH_SELECTOR),
    ).map((_, occurrenceIndex) => ({ blockIndex, occurrenceIndex }));
    scannedSearchBlocks.add(blockIndex);
    setSearchMatchLocations((previous) =>
      [...previous.filter((match) => match.blockIndex !== blockIndex), ...matches]
        .sort((left, right) => left.blockIndex - right.blockIndex || left.occurrenceIndex - right.occurrenceIndex),
    );
  };
  const virtualRows = createMemo(() => {
    if (!shouldVirtualize()) {
      cachedVirtualRows = [];
      return [];
    }
    const rowsByIndex = new Map(
      virtualizer.getVirtualItems().map((row) => [row.index, row]),
    );
    const activeBlockIndex = activeSearchBlockIndex();
    const pinnedIndices = [
      ...searchScanBatch(),
      ...(activeBlockIndex === null ? [] : [activeBlockIndex]),
    ];
    for (const index of pinnedIndices) {
      if (rowsByIndex.has(index)) continue;
      const offset = virtualizer.getOffsetForIndex(index, "start")?.[0];
      if (offset === undefined) continue;
      const size = 220;
      rowsByIndex.set(index, {
        index,
        key: virtualItemKey(index),
        start: offset,
        end: offset + size,
        size,
        lane: 0,
      });
    }
    const rows = Array.from(rowsByIndex.values()).sort(
      (left, right) => left.index - right.index,
    );
    if (rows.length > 0) {
      cachedVirtualRows = rows;
      return rows;
    }
    if (searchScanComplete()) {
      cachedVirtualRows = [];
      return [];
    }
    return cachedVirtualRows;
  });

  const virtualRowByIndex = createMemo(() => {
    const map = new Map<
      number,
      ReturnType<typeof virtualizer.getVirtualItems>[number]
    >();
    virtualRows().forEach((row) => {
      map.set(row.index, row);
    });
    return map;
  });

  const virtualRowIndices = createMemo(() =>
    virtualRows().map((row) => row.index),
  );

  const shouldUseContentVisibility = createMemo(
    () => !shouldVirtualize() && displayBlocks().length > 500,
  );
  const blockPerfStyle = (index: number): JSX.CSSProperties | undefined => {
    if (!shouldUseContentVisibility()) return undefined;
    const total = displayBlocks().length;
    if (index >= total - 24) return undefined;
    return {
      "content-visibility": "auto",
      "contain-intrinsic-size": "220px",
    };
  };

  createEffect(() => {
    const setScrollToMessageById = props.setScrollToMessageById;
    if (!setScrollToMessageById) return;
    const indexById = blockIndexByMessageId();
    const useVirtualization = shouldVirtualize();

    setScrollToMessageById((messageId, behavior = "smooth") => {
      const index = indexById.get(messageId);
      if (index === undefined) return false;

      if (useVirtualization) {
        virtualizer.scrollToIndex(index, { align: "center" });
        return true;
      }

      const container = props.scrollElement?.();
      if (!container) return false;
      const escapedId = messageId.replace(/"/g, '\\"');
      const target = container.querySelector(
        `[data-message-id="${escapedId}"]`,
      ) as HTMLElement | null;

      if (!target) return false;
      target.scrollIntoView({ behavior, block: "center" });
      return true;
    });
  });

  const virtualSearchActive = createMemo(
    () =>
      shouldVirtualize() &&
      Boolean(props.searchHighlightQuery?.trim()) &&
      (props.searchMatchMessageIds?.size ?? 0) > 0,
  );

  let searchRevealGeneration = 0;
  const revealSearchMatch = (match: HTMLElement) => {
    const blockIndex = Number(match.dataset.searchBlockIndex);
    if (!Number.isInteger(blockIndex)) {
      match.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const occurrenceIndex = Number(match.dataset.searchOccurrenceIndex);
    const root = props.scrollElement?.();
    if (!root) return;
    searchRevealGeneration += 1;
    const generation = searchRevealGeneration;
    setActiveSearchBlockIndex(blockIndex);
    root.querySelectorAll<HTMLElement>(SEARCH_MATCH_SELECTOR).forEach((mark) => {
      mark.removeAttribute(SEARCH_MATCH_ACTIVE_ATTR);
      mark.classList.remove(SEARCH_MATCH_ACTIVE_CLASS);
    });
    virtualizer.scrollToIndex(blockIndex, { align: "center" });

    let attempts = 0;
    const reveal = () => {
      if (generation !== searchRevealGeneration) return;
      const row = root.querySelector<HTMLElement>(`[data-index="${blockIndex}"]`);
      const target = row?.querySelectorAll<HTMLElement>(SEARCH_MATCH_SELECTOR)[occurrenceIndex];
      if (target) {
        target.setAttribute(SEARCH_MATCH_ACTIVE_ATTR, "true");
        target.classList.add(SEARCH_MATCH_ACTIVE_CLASS);
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      attempts += 1;
      if (attempts < 30) setTimeout(reveal, 16);
    };
    setTimeout(reveal, 0);
  };

  const searchMatchController = createSearchMatchController({
    getRoot: () =>
      virtualSearchActive()
        ? searchScanComplete()
          ? searchMarkerRoot()
          : null
        : props.scrollElement?.() ?? null,
      onChange: (state) =>
        props.onSearchNavStateChange?.({
          ...state,
          ...(searchHighlightBudget().isTruncated() ? { truncated: true } : {}),
        }),
    scrollIntoView: revealSearchMatch,
  });

  createEffect(
    on(
      () =>
        `${props.searchHighlightQuery?.trim() ?? ""}\u0000${searchCandidateBlockIndices().join(",")}`,
      () => {
        searchRevealGeneration += 1;
        scannedSearchBlocks.clear();
        setSearchScanOffset(0);
        setActiveSearchBlockIndex(null);
        setSearchMatchLocations([]);
        const scanning = virtualSearchActive();
        setSearchScanComplete(!scanning);
        if (scanning) {
          props.onSearchNavStateChange?.({
            activeIndex: 0,
            total: 0,
            scanning: true,
          });
        }
      },
    ),
  );

  createEffect(() => {
    if (!virtualSearchActive()) return;
    const query = props.searchHighlightQuery?.trim() ?? "";
    const candidates = searchCandidateBlockIndices();
    const offset = searchScanOffset();
    const batch = searchScanBatch();
    if (!query) return;
    if (offset >= candidates.length) {
      setSearchScanComplete(true);
      setTimeout(() => searchMatchController.attach(), 0);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let settleObserver: MutationObserver | undefined;
    let attempts = 0;
    const scanBatch = () => {
      if (
        query !== (props.searchHighlightQuery?.trim() ?? "") ||
        offset !== searchScanOffset()
      ) {
        return;
      }
      const root = props.scrollElement?.();
      if (!root) return;
      const rows = batch.map((index) =>
        root.querySelector<HTMLElement>(`[data-index="${index}"]`),
      );
      if (rows.some((row) => !row)) {
        attempts += 1;
        if (attempts < 30) timer = setTimeout(scanBatch, 16);
        return;
      }

      const captureBatch = () => {
        if (
          query !== (props.searchHighlightQuery?.trim() ?? "") ||
          offset !== searchScanOffset()
        ) {
          return;
        }
        rows.forEach((row, rowIndex) => {
          const blockIndex = batch[rowIndex];
          if (blockIndex !== undefined && row) {
            captureBlockSearchMatches(blockIndex, row);
          }
        });
        if (searchHighlightBudget().isTruncated()) {
          setSearchScanComplete(true);
          setSearchScanOffset(candidates.length);
          setTimeout(() => searchMatchController.attach(), 0);
          return;
        }
        setSearchScanOffset(offset + batch.length);
      };
      const scheduleCapture = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(captureBatch, SEARCH_MARK_MUTATION_QUIET_MS);
      };
      settleObserver = new MutationObserver(scheduleCapture);
      rows.forEach((row) => {
        if (!row) return;
        settleObserver?.observe(row, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
      scheduleCapture();
    };
    timer = setTimeout(scanBatch, SEARCH_SCAN_BATCH_DELAY_MS);
    onCleanup(() => {
      if (timer !== undefined) clearTimeout(timer);
      settleObserver?.disconnect();
    });
  });

  createEffect(() => {
    if (!virtualSearchActive()) return;
    const root = props.scrollElement?.();
    if (!root) return;
    const candidateIndices = new Set(searchCandidateBlockIndices());
    const pendingRefreshes = new Map<number, ReturnType<typeof setTimeout>>();

    const indexForNode = (node: Node): number | null => {
      const element =
        node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
      const row = element?.closest<HTMLElement>("[data-index]");
      const index = row ? Number(row.dataset.index) : Number.NaN;
      return Number.isInteger(index) ? index : null;
    };

    const scheduleRefresh = (index: number) => {
      if (!candidateIndices.has(index) || !scannedSearchBlocks.has(index)) return;
      const pending = pendingRefreshes.get(index);
      if (pending !== undefined) clearTimeout(pending);
      pendingRefreshes.set(
        index,
        setTimeout(() => {
          pendingRefreshes.delete(index);
          const row = root.querySelector<HTMLElement>(`[data-index="${index}"]`);
          if (row) captureBlockSearchMatches(index, row);
        }, SEARCH_MARK_MUTATION_QUIET_MS),
      );
    };

    const observer = new MutationObserver((records) => {
      const changedIndices = new Set<number>();
      records.forEach((record) => {
        const targetIndex = indexForNode(record.target);
        if (targetIndex !== null) changedIndices.add(targetIndex);
        record.addedNodes.forEach((node) => {
          const addedIndex = indexForNode(node);
          if (addedIndex !== null) changedIndices.add(addedIndex);
          if (node.nodeType !== 1) return;
          (node as HTMLElement)
            .querySelectorAll<HTMLElement>("[data-index]")
            .forEach((row) => {
              const index = Number(row.dataset.index);
              if (Number.isInteger(index)) changedIndices.add(index);
            });
        });
      });
      changedIndices.forEach(scheduleRefresh);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    onCleanup(() => {
      observer.disconnect();
      pendingRefreshes.forEach(clearTimeout);
      pendingRefreshes.clear();
    });
  });

  createEffect(
    on(
      () => props.searchHighlightQuery?.trim() ?? "",
      (query) => {
        if (!query) {
          searchMatchController.dispose();
          props.onSearchNavStateChange?.({ activeIndex: 0, total: 0, scanning: false });
          return;
        }
        searchMatchController.reset();
      },
    ),
  );

  createEffect(() => {
    props.setSearchMatchController?.(
      props.searchHighlightQuery?.trim()
        ? { requestNav: searchMatchController.requestNav }
        : null,
    );
  });

  const globalSearchHighlight = useGlobalSearchMessageTarget({
    messages: () => props.messages,
    blockIndexByMessageId,
    shouldVirtualize,
    scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: "center" }),
    scrollElement: () => props.scrollElement?.(),
  });

  createEffect(() => {
    if (!shouldVirtualize()) return;
    queueMicrotask(() => {
      virtualizer.measure();
    });
  });

  onCleanup(() => {
    props.setScrollToMessageById?.(null);
    searchMatchController.dispose();
    props.setSearchMatchController?.(null);
  });

  const isNestedVariant = () => props.variant === "nested";
  const embeddedSubagentTitle = (
    title: string | undefined,
    fallback: string | undefined,
  ) => {
    const sanitized = title
      ?.replace(/\s*\(\s*@[\w.-]+\s+subagent\s*\)\s*$/i, "")
      .trim();
    return sanitized || fallback || "Subagent session";
  };

  const sessionStreamState = (messages: MessageWithParts[]) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info as {
        role?: string;
        time?: { completed?: number };
      };
      if (info?.role !== "assistant") continue;
      return !info.time?.completed;
    }
    return false;
  };

  const SubagentThread = (threadProps: {
    part: Part;
    density?: "parent" | "child";
    childBranch?: boolean;
  }) => {
    const task = createMemo(() => getTaskStepInfo(threadProps.part));
    const sessionId = createMemo(() => task().sessionId ?? null);
    const nestedMaps = createMemo(() => {
      const id = sessionId();
      return id ? getOrCreateNestedMaps(id) : undefined;
    });
    const rawPartId = (threadProps.part as { id?: unknown }).id;
    const partId =
      typeof rawPartId === "string" && rawPartId.length > 0
        ? rawPartId
        : (sessionId() ?? "");
    let requestedSessionId = "";
    const session = createMemo(
      () => props.getSessionById?.(sessionId()) ?? null,
    );
    const childMessages = createMemo(
      () => props.getMessagesBySessionId?.(sessionId()) ?? [],
    );
    const childSearchMatchMessageIds = createMemo(() => {
      const needle = props.searchHighlightQuery?.trim().toLowerCase() ?? "";
      if (!needle) return new Set<string>();
      return new Set(
        childMessages().flatMap((message) => {
          const matches = message.parts.some((part) => {
            if (!isEmbeddedActivityPart(message, part) || part.type !== "tool") {
              return false;
            }
            return [
              ...searchableStepLabel(part),
              visibleToolStepOutput(part),
            ].some((text) => text.toLowerCase().includes(needle));
          });
          const id = message.info.id;
          return matches && typeof id === "string" ? [id] : [];
        }),
      );
    });
    const childSearchMatch = createMemo(
      () => childSearchMatchMessageIds().size > 0,
    );
    const loading = createMemo(
      () => props.sessionLoadingById?.(sessionId()) ?? false,
    );
    const streaming = createMemo(
      () => loading() || sessionStreamState(childMessages()),
    );
    const hasEmbeddedActivity = createMemo(() =>
      childMessages().some((message) =>
        message.parts.some((part) => isEmbeddedActivityPart(message, part)),
      ),
    );
    const childExpandable = createMemo(() => streaming() || hasEmbeddedActivity());
    const expandable = childExpandable;
    const label = createMemo(() => {
      const description = task().description;
      const fallback = description || (task().agentType ? `${task().agentType} task` : undefined);
      return embeddedSubagentTitle(session()?.title, fallback);
    });
    const taskKind = createMemo(() => {
      const agentType = task().agentType
        ?.replace(/\s+agent$/i, "")
        .trim()
        .toLowerCase();
      return agentType ? `${agentType} task` : "sub-agent task";
    });
    const secondary = createMemo(() => {
      if (loading()) return "Loading sub-agent activity";
      if (streaming()) return `Running ${taskKind()}`;
      return undefined;
    });

    createEffect(() => {
      const id = sessionId();
      if (!id) return;
      if (!props.ensureSessionLoaded) return;
      if (requestedSessionId === id) return;
      requestedSessionId = id;
      void props.ensureSessionLoaded(id);
    });

    const tone = createMemo<StepTone>(() =>
      streaming() ? "running" : stepTone(toolStepStatus(threadProps.part)),
    );
    const subagentMeta = createMemo<TimelineMetaItem[]>(() => {
      const items: TimelineMetaItem[] = [];
      const modelSource = modelSourceMetaItem(props.activityModelExecutions?.[partId]);
      if (modelSource) items.push(modelSource);
      if (loading()) {
        items.push({ text: "Loading" });
      } else if (streaming()) {
        items.push({ text: "Running" });
      } else {
        const ms = stepDurationMs(threadProps.part);
        if (ms !== null) {
          items.push({ text: formatElapsedMs(ms) });
        }
      }

      const id = sessionId();
      // The route guard redirects away from a child session the store does not know yet.
      if (id && props.openSessionById && session()) {
        items.push({
          text: "Open session",
          kind: "action",
          ariaLabel: "Open sub-agent session",
          onClick: () => props.openSessionById?.(id),
        });
      }
      return items;
    });

    return (
      <Show when={sessionId()}>
        <div class="flex flex-col gap-1">
          <TimelineRow
            tone={tone()}
            icon={<StepIcon kind="subagent" />}
            primary={label()}
            secondary={secondary()}
            expandable={expandable()}
            expanded={expandable() && (childSearchMatch() || isSubagentOpen(partId))}
            onToggle={() => toggleSubagentOpen(partId)}
            controlsId={`subagent-${partId}`}
            meta={subagentMeta()}
            density={threadProps.density}
            rowKind="subagent"
            childBranch={threadProps.childBranch}
          />
          <Show
            when={expandable() && (childSearchMatch() || isSubagentOpen(partId))}
          >
            <TimelineChildren
              id={`subagent-${partId}`}
              class="min-w-0"
            >
              <Show when={childExpandable() && (childSearchMatch() || isSubagentOpen(partId))}>
                <Show
                  when={hasEmbeddedActivity()}
                  fallback={
                    <div class="py-1 text-caption leading-5 text-dls-muted dark:text-dls-soft">
                      Waiting for sub-agent activity
                    </div>
                  }
                >
                <MessageList
                  messages={childMessages()}
                  searchHighlightQuery={props.searchHighlightQuery}
                  searchMatchMessageIds={childSearchMatchMessageIds()}
                  searchHighlightBudget={searchHighlightBudget()}
                  isStreaming={streaming()}
                  developerMode={props.developerMode}
                  debugObservabilityAvailable={
                    props.debugObservabilityAvailable
                  }
                  showThinking={props.showThinking}
                  getSessionById={props.getSessionById}
                  getMessagesBySessionId={props.getMessagesBySessionId}
                  ensureSessionLoaded={props.ensureSessionLoaded}
                  sessionLoadingById={props.sessionLoadingById}
                  activityModelExecutions={props.activityModelExecutions}
                  expandedStepIds={props.expandedStepIds}
                  setExpandedStepIds={props.setExpandedStepIds}
                  openSessionById={props.openSessionById}
                  workspaceRoot={props.workspaceRoot}
                  localFiles={props.localFiles}
                  variant="nested"
                  _externalToolOutputOpenMap={nestedMaps()?.toolOutputOpenMap}
                  _externalSubagentOpenMap={nestedMaps()?.subagentOpenMap}
                  _externalToolOutputScrollPositions={
                    nestedMaps()?.toolOutputScrollPositions
                  }
                />
                </Show>
              </Show>
            </TimelineChildren>
          </Show>
        </div>
      </Show>
    );
  };

  const { StepsContainer } = createStepComponents({
    ExplorationSourceIcon,
    SubagentThread,
    isNestedVariant,
    isStepsExpanded,
    isToolOutputOpen,
    props,
    timelineScrollPositions,
    toggleToolOutputOpen,
    toolOutputScrollPositions,
  });

  const reportBug = (messageId: string) => {
    bugReportFlow.startBugReport({
      sessionTitle: props.sessionTitle?.trim() || "unknown session",
      onComplete: (result) => bugReportFeedback.record(messageId, result),
    });
  };

  // Shared retry affordance for the latest assistant turn (message or steps-only cluster).
  const RetryButton = (btnProps: { messageId: string }) => (
    <button
      class="text-dls-secondary hover:text-dls-text p-1 rounded-compact hover:bg-dls-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      title="Retry"
      aria-label="Retry"
      disabled={regeneratingAssistantId() !== null}
      onClick={() => void retryLatestAssistantResponse()}
    >
      <RefreshCw
        size={12}
        class={
          regeneratingAssistantId() === btnProps.messageId ? "animate-spin" : ""
        }
      />
    </button>
  );

  const renderBlock = (block: MessageBlockItem, blockIndex: number) => {
    const blockMessageIds = getBlockMessageIds(block);
    const hasSearchMatch = () => blockMessageIds.some((id) =>
      props.searchMatchMessageIds?.has(id),
    );

    if (block.type === "tool-steps") {
      return (
        <div
          class={`flex group ${block.isUser ? "justify-end" : "justify-start mb-0"}`.trim()}
          data-message-role={block.isUser ? "user" : "assistant"}
          data-message-id={block.messageIds[0] ?? ""}
          data-message-ids={block.messageIds.join(" ")}
          style={blockPerfStyle(blockIndex)}
        >
          <div
            class={
              block.isUser
                ? isNestedVariant()
                  ? "relative max-w-[92%] rounded-dialog border border-dls-border bg-dls-sidebar px-4 py-3 text-body-lg leading-relaxed text-dls-text"
                  : "relative max-w-[85%] rounded-shell border border-dls-border bg-dls-sidebar px-6 py-4 text-title leading-relaxed text-dls-text"
                : isNestedVariant()
                  ? "w-full relative text-body-lg leading-[1.65] text-dls-text group"
                  : "w-full relative max-w-[760px] text-title leading-[1.7] text-dls-text group"
            }
          >
            <StepsContainer
              id={block.id}
              toolSteps={block.toolSteps}
              isUser={block.isUser}
              isActiveStream={
                Boolean(props.isStreaming) &&
                block.messageIds.some((id) =>
                  streamingAssistantMessageIds().has(id),
                )
              }
              isLiveTurn={liveToolStepsBlockId() === block.id}
            />
            <Show
              when={
                !isNestedVariant() &&
                !block.isUser &&
                !props.isStreaming &&
                (block.messageIds.includes(latestAssistantMessageId()) ||
                  (() => {
                    const regenId = regeneratingAssistantId();
                    return regenId ? block.messageIds.includes(regenId) : false;
                  })()) &&
                canRetryLatestAssistant()
              }
            >
              <div class="mt-1 flex justify-end">
                <RetryButton
                  messageId={
                    block.messageIds.includes(latestAssistantMessageId())
                      ? latestAssistantMessageId()
                      : (regeneratingAssistantId() ?? block.messageIds[0] ?? "")
                  }
                />
              </div>
            </Show>
          </div>
        </div>
      );
    }

    if (block.type === "report-summary") {
      const summary = block.summary;
      return (
        <div
          class="flex group justify-start mb-10"
          data-report-summary-id={summary.id}
          style={blockPerfStyle(blockIndex)}
        >
          <div class="w-full relative max-w-[760px] text-title leading-[1.72] text-dls-text antialiased group">
            <div class="ml-3 rounded-dialog border border-dls-border bg-dls-surface px-4 py-3 shadow-[var(--dls-card-shadow)]">
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-pill border border-dls-border bg-dls-sidebar text-dls-secondary">
                  <FileText size={16} />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div class="text-body-lg font-semibold text-dls-text">
                        Final report summary
                      </div>
                      <div
                        class="mt-0.5 truncate text-caption text-dls-secondary"
                        title={summary.path}
                      >
                        {summary.displayPath}
                      </div>
                    </div>
                    <button
                      type="button"
                      class="shrink-0 rounded-pill border border-dls-border bg-dls-sidebar px-3 py-1 text-caption font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => props.onOpenReportSummary?.(summary.path)}
                      disabled={!props.onOpenReportSummary}
                    >
                      Open final report
                    </button>
                  </div>
                  <div class="mt-3 text-body-lg leading-6 text-dls-text/90">
                    <Show
                      when={!summary.loading}
                      fallback={
                        <span class="text-dls-secondary">
                          Loading report preview...
                        </span>
                      }
                    >
                      <Show
                        when={!summary.error}
                        fallback={
                          <span class="text-dls-secondary">
                            Final report generated, but preview is unavailable.{" "}
                            {summary.error}
                          </span>
                        }
                      >
                        <Show
                          when={summary.summary}
                          fallback={
                            <span>
                              Final report generated, but the preview is empty.
                            </span>
                          }
                        >
                          <div
                            data-testid="report-summary-content"
                            class="[&_h1]:text-title [&_h1]:leading-title [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-body-lg [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2 [&_li]:mb-0.5 [&_strong]:font-semibold [&_a]:underline [&_code]:font-mono"
                            innerHTML={renderReportMarkdown(summary.summary)}
                          />
                        </Show>
                      </Show>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    const groupSpacing = block.isUser ? "mb-3" : "mb-4";

    const blockMessageIndex = block.isUser
      ? -1
      : props.messages.findIndex(
          (message) => String(message.info.id ?? "") === block.messageId,
        );

    const isLastMessageBlockInTurn = (() => {
      if (block.isUser) return false;

      const blocks = displayBlocks();
      for (let i = blockIndex + 1; i < blocks.length; i ++) {
        const next = blocks[i];
        if (next.isUser) break;
        if (getBlockMessageIds(next).length > 0) return false;
      }
      return true;
    })();

    const shouldShowMaskedFiles = !isNestedVariant() && !block.isUser && isLastMessageBlockInTurn && !(props.isStreaming && isAssistantMessageStreaming(block.message));
    
    const blockMaskedFiles = shouldShowMaskedFiles && blockMessageIndex !== -1 
      ? collectMaskedFiles({
        messages: props.messages.slice(0, blockMessageIndex + 1),
        getMessagesBySessionId: props.getMessagesBySessionId,
        ensureSessionLoaded: props.ensureSessionLoaded,
      })
      : [];

    const isSyntheticCompactMarker =
      !block.isUser &&
      block.messageId.startsWith(SYNTHETIC_SESSION_COMPACT_MESSAGE_PREFIX);
    const isSyntheticSessionError =
      !block.isUser &&
      block.messageId.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);
    const isSyntheticClassifier =
      !block.isUser &&
      block.messageId.startsWith(SYNTHETIC_SESSION_CLASSIFIER_MESSAGE_PREFIX);
    const isSyntheticClassifierAmbiguous =
      isSyntheticClassifier && block.messageId.includes(":ambiguous:");

    if (isSyntheticCompactMarker) {
      const messageText = block.renderableParts
        .map((part) => partToText(part))
        .join(" ")
        .replace(/\s*\n+\s*/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();

      return (
        <div
          class="flex group justify-center"
          data-message-role="system"
          data-message-id={block.messageId}
          style={blockPerfStyle(blockIndex)}
        >
          <div
            class={`w-full relative ${isNestedVariant() ? "" : "max-w-[760px]"}`}
          >
            <div class="flex items-center gap-3 py-2 text-label font-medium uppercase tracking-[0.18em] text-dls-secondary/75">
              <div class="h-px flex-1 bg-dls-border/80" />
              <span class="shrink-0">
                {messageText || "Context compacted here"}
              </span>
              <div class="h-px flex-1 bg-dls-border/80" />
            </div>
          </div>
        </div>
      );
    }

    if (isSyntheticSessionError) {
      const errorKind = (block.message.info as { errorKind?: SessionErrorTurnKind }).errorKind;
      const notConfiguredCta =
        errorKind === "cloud-not-configured" ||
        errorKind === "local-not-configured" ||
        errorKind === "auto-not-configured";
      const messageText = block.renderableParts
        .map((part) => partToText(part))
        .join(" ")
        .replace(/\s*\n+\s*/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();

      return (
        <div
          class="flex group justify-start"
          data-message-role="assistant"
          data-message-id={block.messageId}
          style={blockPerfStyle(blockIndex)}
        >
          <div
            class={`w-full relative ${isNestedVariant() ? "" : "max-w-[650px]"}`}
          >
            <div
              class="inline-flex max-w-full items-start gap-2 rounded-panel border border-dls-danger-border bg-dls-danger-bg px-3 py-2 text-body leading-5 text-dls-danger-text shadow-sm"
              role="alert"
            >
              <CircleAlert size={14} class="mt-0.5 shrink-0" />
              <div class="min-w-0 break-words flex flex-col items-start gap-1.5">
                <div>{messageText}</div>
                <Show when={notConfiguredCta && props.onOpenSettings}>
                  <button
                    type="button"
                    class="rounded-micro text-dls-danger-text underline underline-offset-2 transition-colors hover:text-dls-danger-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.35)]"
                    onClick={() => props.onOpenSettings?.()}
                  >
                    {t("session.go_to_settings")}
                  </button>
                </Show>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        class={`flex flex-col group ${block.isUser ? "items-end" : "items-start"}`.trim()}
        data-message-role={block.isUser ? "user" : "assistant"}
        data-message-id={block.messageId}
        style={blockPerfStyle(blockIndex)}
      >
        <Show when={block.isUser}>
          {renderMessageAttachments(
            block,
            `mb-2 flex ${isNestedVariant() ? "max-w-[78%]" : "max-w-[68%]"} flex-wrap justify-end gap-2`,
          )}
        </Show>
        <div
          class={
            block.isUser
              ? editingMessageId() === block.messageId
                ? isNestedVariant()
                  ? "relative w-[92%] rounded-shell border border-transparent bg-transparent text-body-lg leading-relaxed text-dls-text"
                  : "relative w-[85%] rounded-shell border border-transparent bg-transparent text-title leading-relaxed text-dls-text"
                : !block.groups.length
                  ? "hidden"
                  : isNestedVariant()
                  ? "relative max-w-[92%] rounded-dialog border border-dls-border bg-dls-sidebar px-4 py-3 text-body-lg leading-relaxed text-dls-text"
                  : "relative max-w-[85%] rounded-shell border border-dls-border bg-dls-sidebar px-6 py-2 text-title leading-relaxed text-dls-text"
              : isSyntheticClassifierAmbiguous
                ? "w-full relative max-w-[760px] rounded-panel border border-dls-border bg-dls-surface/65 px-4 py-3 text-title leading-[1.72] text-dls-text antialiased group"
                : isNestedVariant()
                  ? "w-full relative text-body-lg leading-[1.65] text-dls-text antialiased group"
                  : "w-full relative max-w-[760px] text-title leading-[1.72] text-dls-text antialiased group"
          }
        >
          <Show when={isSyntheticClassifierAmbiguous}>
            <div class="mb-2 text-label font-medium uppercase tracking-[0.16em] text-dls-secondary/80">
              Clarification needed
            </div>
          </Show>
          <Show when={!block.isUser}>
            {renderMessageAttachments(block, "mb-4 flex flex-wrap gap-2")}
          </Show>
          <Show
            when={block.isUser && editingMessageId() === block.messageId}
            fallback={
              <Show
                when={
                  !block.isUser && block.messageId === regeneratingAssistantId()
                }
                fallback={
                  <For each={block.groups}>
                    {(group, idx) => (
                      <div
                        class={
                          idx() === block.groups.length - 1 ? "" : groupSpacing
                        }
                      >
                        <Show when={group.type === "text"}>
                          {(() => {
                            const isStreamingLatestAssistant =
                              !block.isUser &&
                              props.isStreaming &&
                              block.messageId === latestAssistantMessageId();
                            const markdownThrottleMs = isStreamingLatestAssistant ? 120 : 100;
                            return (
                              <SkillCommandPartView
                                part={(group as { type: "text"; part: Part }).part}
                                skills={props.skills}
                                developerMode={props.developerMode}
                                showThinking={props.showThinking}
                                workspaceRoot={props.workspaceRoot}
                                resolveHostPath={props.localFiles?.resolveHostFilePath}
                                tone={block.isUser ? "dark" : "light"}
                                renderMarkdown={!block.isUser}
                                isUserMessage={block.isUser}
                                searchHighlightBudget={searchHighlightBudget()}
                                markdownThrottleMs={markdownThrottleMs}
                                highlightQuery={
                                  hasSearchMatch()
                                    ? props.searchHighlightQuery
                                    : props.searchHighlightQuery?.trim()
                                      ? undefined
                                      : globalSearchHighlight()
                                }
                                expansionKey={`${block.messageId}:${idx()}`}
                                isStreaming={isStreamingLatestAssistant}
                                onCollapseLargeText={() =>
                                  props.onCollapseLargeText?.(block.messageId)
                                }
                              />
                            );
                          })()}
                        </Show>
                        {group.type === "tool-steps" &&
                          (() => {
                            const stepGroup = group as {
                              type: "tool-steps";
                              id: string;
                              parts: Part[];
                              mode: ToolStepMode;
                            };
                            return (
                              <StepsContainer
                                id={stepGroup.id}
                                toolSteps={[
                                  {
                                    id: stepGroup.id,
                                    parts: stepGroup.parts,
                                    mode: stepGroup.mode,
                                  },
                                ]}
                                isUser={block.isUser}
                                isInline={true}
                                isActiveStream={
                                  Boolean(props.isStreaming) &&
                                  isAssistantMessageStreaming(block.message)
                                }
                              />
                            );
                          })()}
                      </div>
                    )}
                  </For>
                }
              >
                <div class="flex items-center gap-2 text-dls-secondary">
                  <span class="inline-flex size-1.5 shrink-0 animate-pulse rounded-pill bg-[var(--dls-accent)]" />
                  <span class="animate-pulse text-title leading-[1.7]">
                    Generating new response…
                  </span>
                </div>
              </Show>
            }
          >
            <div class="flex flex-col gap-2">
              <textarea
                autofocus
                aria-label="Edit message"
                rows={2}
                value={editingText()}
                onInput={(event) => setEditingText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void saveEditingMessage(block.messageId);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEditingMessage();
                  }
                }}
                class="w-full resize-none rounded-field border border-dls-border bg-dls-surface px-3 py-2 text-body-lg leading-relaxed text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.35)]"
              />
              <div class="flex items-center justify-end gap-2">
                <button
                  type="button"
                  class="rounded-subtle border border-dls-border bg-dls-surface px-2.5 py-1 text-caption font-medium text-dls-secondary dark:text-dls-text transition-colors hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.35)]"
                  onClick={() => cancelEditingMessage()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-subtle border border-transparent bg-[var(--dls-accent)] px-2.5 py-1 text-caption font-semibold text-white transition-colors hover:bg-[var(--dls-accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.45)] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={
                    !editingText().trim() ||
                    editingText().trim() === editingOriginalText().trim()
                  }
                  onClick={() => void saveEditingMessage(block.messageId)}
                >
                  Update
                </button>
              </div>
            </div>
          </Show>
        </div>
        <Show
          when={
            shouldShowMaskedFiles &&
            blockMaskedFiles.length > 0
          }
        >
          <MaskedFilesPanel
            files={blockMaskedFiles}
            onPreviewFile={props.onPreviewFile}
            onRevealFile={props.onRevealFile}
            collapsedMaskingSummaries={collapsedMaskingSummaries}
            setCollapsedMaskingSummaries={setCollapsedMaskingSummaries}
          />
        </Show>
        <Show
          when={
            !isNestedVariant() &&
            !(
              props.isStreaming &&
              !block.isUser &&
              isAssistantMessageStreaming(block.message)
            )
          }
        >
          <div
            class={`flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 ${block.isUser ? "justify-end" : "w-full justify-between"}`}
          >
            <Show when={!block.isUser && block.type === "message"}>
              {(() => {
                const messageId = String(block.message.info.id ?? "");
                const tokenInfo = messageId
                  ? props.tokensByMessageId?.[messageId]
                  : undefined;
                return (
                  <Show when={tokenInfo}>
                    {(info) => (
                      <div class="flex min-w-0 items-center gap-1.5 text-label text-dls-secondary/70">
                        <span>⚡</span>
                        <Tooltip
                          content={t("session.token_split_tooltip")}
                          placement="top"
                          maxWidthClass="max-w-[280px]"
                          focusable
                        >
                          <span>{formatTokenSummary(info())}</span>
                        </Tooltip>
                      </div>
                    )}
                  </Show>
                );
              })()}
            </Show>
            <div
              class="ml-auto flex items-center gap-2 opacity-100 pointer-events-auto md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto md:group-focus-within:opacity-100 md:group-focus-within:pointer-events-auto transition-opacity select-none"
            >
              <Show
                when={
                  block.isUser &&
                  block.messageId === latestUserMessageId() &&
                  !!props.onSubmitEditedUserMessage &&
                  !!props.canEditLastUserMessage &&
                  editingMessageId() !== block.messageId &&
                  isEditableUserMessage(block)
                }
              >
                <Tooltip
                  content="Edit message"
                  placement="bottom"
                  maxWidthClass="max-w-[140px]"
                >
                  <button
                    class="text-dls-secondary hover:text-dls-text p-1 rounded-compact hover:bg-dls-hover transition-colors"
                    aria-label="Edit message"
                    onClick={() => startEditingMessage(block)}
                  >
                    <Pencil size={12} />
                  </button>
                </Tooltip>
              </Show>
              <Show when={!block.isUser && block.type === "message"}>
                <MessageModelBadge
                  label={messageModelBadgeLabel(
                    block.message.info,
                    props.servedModelLabelByMessageId,
                  )}
                />
              </Show>
              <Show
                when={
                  !block.isUser &&
                  (block.messageId === latestAssistantMessageId() ||
                    block.messageId === regeneratingAssistantId()) &&
                  canRetryLatestAssistant()
                }
              >
                <RetryButton messageId={block.messageId} />
              </Show>
              <Tooltip
                content="Report bug"
                placement="bottom"
                maxWidthClass="max-w-[140px]"
              >
                <button
                  class="text-dls-secondary hover:text-dls-text p-1 rounded-compact hover:bg-dls-hover transition-colors"
                  aria-label="Report bug"
                  onClick={() => reportBug(block.messageId)}
                >
                  <Bug size={12} />
                </button>
              </Tooltip>
              <BugReportFeedbackNote
                messageId={block.messageId}
                activeId={bugReportFeedback.messageId()}
                status={bugReportFeedback.status()}
              />
              <Tooltip
                content="Copy message"
                placement="bottom"
                maxWidthClass="max-w-[140px]"
              >
                <button
                  class="text-dls-secondary hover:text-dls-text p-1 rounded-compact hover:bg-dls-hover transition-colors"
                  aria-label="Copy message"
                  onClick={() => {
                    const text = copyTextForMessageBlock(block);
                    handleCopy(text, block.messageId);
                  }}
                >
                  <Show
                    when={copyingId() === block.messageId}
                    fallback={<Copy size={12} />}
                  >
                    <Check size={12} class="text-dls-success-text" />
                  </Show>
                </button>
              </Tooltip>
              {/* Read aloud: on-demand TTS of this one reply (like ChatGPT/Gemini).
                  Works even when auto-narration is off; clicking again stops it.
                  Hidden unless the backend exposes TTS (probed on mount). */}
              <Show
                when={
                  !block.isUser &&
                  block.type === "message" &&
                  !!props.speakMessage &&
                  props.ttsAvailable
                }
              >
                <Tooltip
                  content={
                    props.ttsReadAloud?.messageId === block.messageId
                      ? t("composer.tts_stop_reading")
                      : t("composer.tts_read_aloud")
                  }
                  placement="bottom"
                  maxWidthClass="max-w-[140px]"
                >
                  <button
                    class={`p-1 rounded-compact transition-colors ${
                      props.ttsReadAloud?.messageId === block.messageId && props.ttsReadAloud.phase === "speaking"
                        ? "text-dls-success-text bg-dls-success-bg hover:bg-dls-success-bg"
                        : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                    }`}
                    aria-label={
                      props.ttsReadAloud?.messageId === block.messageId
                        ? t("composer.tts_stop_reading")
                        : t("composer.tts_read_aloud")
                    }
                    aria-pressed={props.ttsReadAloud?.messageId === block.messageId}
                    onClick={() => {
                      const text = block.renderableParts
                        .map((part) => partToText(part, !block.isUser))
                        .join("\n");
                      props.speakMessage?.(block.messageId, text);
                    }}
                  >
                    {/* Speaker glyph + "EN" label stacked underneath: Kokoro
                        read-aloud is English-only for now. Plain text (no box) so
                        it never overlaps the speaker symbol. */}
                    <span class="inline-flex flex-col items-center leading-none">
                      <Show
                        when={props.ttsReadAloud?.messageId === block.messageId}
                        fallback={<Volume2 size={12} />}
                      >
                        <Volume2 size={12} class="animate-pulse" />
                      </Show>
                      <span
                        aria-hidden="true"
                        class="mt-[1px] text-micro font-bold uppercase leading-none tracking-[0.05em]"
                      >
                        EN
                      </span>
                    </span>
                  </button>
                </Tooltip>
              </Show>
            </div>
            <MessageAgentBadge info={block.message.info} />
            <MessageTurnTime
              info={block.message.info}
              turnStartById={turnStartById()}
              elapsedMs={
                props.debugObservabilityAvailable === true && !block.isUser
                  ? props.lastRunElapsedMs?.[block.messageId]
                  : undefined
              }
            />
          </div>
        </Show>
      </div>
    );
  };

  return (
    <div
      class={isNestedVariant() ? "pb-0" : "pb-20"}
      style={{
        contain: isNestedVariant() ? "layout paint style" : "paint style",
      }}
    >
      <div
        ref={setSearchMarkerRoot}
        class="hidden"
        aria-hidden="true"
        data-search-navigation-index
      >
        <Show when={searchScanComplete() && virtualSearchActive()}>
          <For each={searchMatchLocations()}>
            {(location) => (
              <mark
                data-search-highlight="true"
                data-search-block-index={location.blockIndex}
                data-search-occurrence-index={location.occurrenceIndex}
              />
            )}
          </For>
        </Show>
      </div>
      <Show
        when={shouldVirtualize()}
        fallback={
          <div class={isNestedVariant() ? "space-y-3" : "space-y-4"}>
            <For each={displayBlocks()}>
              {(block, blockIndex) => renderBlock(block, blockIndex())}
            </For>
          </div>
        }
      >
        <Show
          when={virtualRows().length > 0}
            fallback={
              <div
                class="relative"
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: "100%",
                }}
              />
            }
        >
          <div
            class="relative"
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
            }}
          >
            <For each={virtualRowIndices()}>
              {(rowIndex) => {
                const virtualRow = virtualRowByIndex().get(rowIndex);
                if (!virtualRow) return null;
                const block = displayBlocks()[rowIndex];
                if (!block) return null;
                return (
                  <div
                    data-index={rowIndex}
                    ref={(el) => {
                      el.setAttribute("data-index", String(rowIndex));
                      virtualizer.measureElement(el);
                    }}
                    class="absolute left-0 top-0 w-full pb-4"
                    style={{
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {renderBlock(block, rowIndex)}
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
      <Show when={!isNestedVariant() && props.footer}>{props.footer}</Show>
      <BugReportLogsDialog
        logs={bugReportFlow.logs()}
        summary={bugReportFlow.summaryDraft()}
        onSummaryChange={(value) => bugReportFlow.setSummaryDraft(value)}
        summaryMaxLength={4000}
        submitting={bugReportFlow.submitting()}
        picking={bugReportFlow.picking()}
        error={bugReportFlow.error()}
        status={bugReportFlow.status()}
        onClose={() => bugReportFlow.cancelBugReport()}
        onPickLogs={() => bugReportFlow.pickBugLogs()}
        onRemoveLog={(path) => bugReportFlow.removeBugLog(path)}
        onSubmit={() => bugReportFlow.submitBugReport()}
      />
    </div>
  );
}
