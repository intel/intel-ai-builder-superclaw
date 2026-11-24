import type { Part } from "@opencode-ai/sdk/v2/client";
import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";

import { sanitizeProtectionMessages } from "~/shared/util/protection-messages";
import { applyTextHighlights } from "../part-view.highlight";
import {
  shouldUseInnerTimelineScroll,
  type ToolStepGroup,
} from "~/shared/util/turn-blocks";
import {
  ExplorationWebSource,
  asToolPart,
  explorationStatus,
  getExplorationWebSources,
  getWebSourcesFromPart,
  mergeWebSourcesByHost,
  summarizeExploration,
} from "./message-list.exploration";
import { formatElapsedMs, TIMELINE_BOTTOM_STICK_PX } from "./message-list.format";
import { HdrActivity } from "./message-list.hdr-activity";
import { hdrProgress, hdrWebSearches } from "./message-list.hdr-progress";
import { StepIcon, stepIconKind } from "./message-list.step-icon";
import {
  TimelineChild,
  TimelineChildren,
  TimelineRow,
  modelSourceMetaItem,
  type TimelineMetaItem,
} from "./message-list.timeline-row";
import {
  combineExecutions,
  type ActivityModelExecution,
} from "../../lib/activity-model-executions";
import {
  countVisibleSteps,
  explorationStepDisplayLabel,
  getTaskStepInfo,
  hdrStepResultText,
  latestStepPart,
  stepDisplayLabel,
  stepDurationMs,
  stepGroupDurationMs,
  stepToneForPart,
  searchableStepLabel,
  visibleToolStepOutput,
  unifiedStepDisplayLabel,
} from "./message-list.tool";
import type { MessageListProps } from "./message-list.types";
import { maskingResolverMetaItem } from "./protected-file-masking-meta";

/**
 * What the Activity timeline reads from its parent MessageList. Every entry is
 * an accessor, a setter or a stable reference -- never a plain reactive value --
 * so the destructuring below cannot freeze one.
 */
export type StepComponentsDeps = {
  ExplorationSourceIcon: (props: {
    source: ExplorationWebSource;
  }) => JSX.Element;
  SubagentThread: (props: {
    part: Part;
    density?: "parent" | "child";
    childBranch?: boolean;
  }) => JSX.Element;
  isNestedVariant: () => boolean;
  isStepsExpanded: (id: string, relatedIds?: string[]) => boolean;
  isToolOutputOpen: (partId: string) => boolean;
  /** The list's own props, passed whole so reads here stay reactive. */
  props: MessageListProps;
  timelineScrollPositions: Map<string, { top: number; atBottom: boolean }>;
  toggleToolOutputOpen: (partId: string) => void;
  toolOutputScrollPositions: Map<string, number>;
};

/**
 * Builds the Activity timeline components. Call this from the body of
 * MessageList: the components are then created under that same owner, exactly
 * as they were when declared inline, leaving their reactive scope unchanged.
 */
export function createStepComponents(deps: StepComponentsDeps) {
  const {
    ExplorationSourceIcon,
    SubagentThread,
    isNestedVariant,
    isStepsExpanded,
    isToolOutputOpen,
    props,
    timelineScrollPositions,
    toggleToolOutputOpen,
    toolOutputScrollPositions,
  } = deps;

  const SourceStack = (p: { sources: ExplorationWebSource[] }) => (
    <Show when={p.sources.length > 0}>
      <span
        class="inline-flex items-center"
        aria-label={`${p.sources.length} source${p.sources.length === 1 ? "" : "s"}`}
        title={`${p.sources.length} source${p.sources.length === 1 ? "" : "s"}`}
      >
        <span class="flex items-center -space-x-1">
          <Index each={p.sources.slice(0, 3)}>
            {(s) => <ExplorationSourceIcon source={s()} />}
          </Index>
        </span>
        <Show when={p.sources.length > 3}>
          <span class="ml-1 text-tiny text-dls-secondary">
            +{p.sources.length - 3}
          </span>
        </Show>
      </span>
    </Show>
  );

  const modelSourceMeta = (part: Part): TimelineMetaItem | undefined => {
    const id = (part as { id?: unknown }).id;
    if (typeof id !== "string" || !id) return undefined;
    return modelSourceMetaItem(props.activityModelExecutions?.[id]);
  };

  const groupModelSourceMeta = (parts: Part[]): TimelineMetaItem | undefined => {
    const ids = parts.flatMap((part) => {
      const id = (part as { id?: unknown }).id;
      return part.type === "tool" && typeof id === "string" && id ? [id] : [];
    });
    if (ids.length === 0) return undefined;
    const executions = ids.map((id) => props.activityModelExecutions?.[id]);
    if (executions.some((execution) => !execution)) return undefined;
    return modelSourceMetaItem(
      combineExecutions(executions as ActivityModelExecution[]),
    );
  };

  /** Quiet, structured timeline row. */
  const StepRow = (rowProps: {
    part: Part;
    density?: "parent" | "child";
    childBranch?: boolean;
  }) => {
    const tone = createMemo(() => stepToneForPart(rowProps.part));
    const displayLabel = createMemo(() => {
      const label = stepDisplayLabel(rowProps.part, tone());
      return {
        primary: sanitizeProtectionMessages(label.primary),
        secondary: label.secondary
          ? sanitizeProtectionMessages(label.secondary)
          : undefined,
      };
    });
    const task = createMemo(() => getTaskStepInfo(rowProps.part));

    const toolOutput = createMemo(() => visibleToolStepOutput(rowProps.part));
    const hdr = createMemo(() => hdrProgress(rowProps.part));

    const webSources = createMemo(() => getWebSourcesFromPart(rowProps.part));

    const rawPartId = (rowProps.part as { id?: unknown }).id;
    const partId =
      typeof rawPartId === "string" && rawPartId ? rawPartId : undefined;
    const canToggle = createMemo(() => !!partId && (!!toolOutput() || !!hdr()));
    const textContainsQuery = (text: string, query: string) => {
      const needle = query.trim().toLowerCase();
      return Boolean(needle) && text.toLowerCase().includes(needle);
    };
    // A match hidden inside a collapsed output panel can never be counted or
    // targeted, so the rendered page stays the single source of truth only if
    // a matching panel is revealed.
    const outputHasHiddenMatch = createMemo(() =>
      textContainsQuery(toolOutput(), props.searchHighlightQuery ?? ""),
    );
    const isDone = createMemo(() => tone() === "done");
    const [outputEl, setOutputEl] = createSignal<HTMLElement | undefined>();
    let searchLabelsEl: HTMLSpanElement | undefined;

    createEffect(() => {
      if (rowProps.part.type !== "tool") return;
      const root = searchLabelsEl;
      const query = props.searchHighlightQuery ?? "";
      const label = displayLabel();
      if (!root || !partId || (!label.primary && !label.secondary)) return;
      queueMicrotask(() => {
        if (searchLabelsEl !== root) return;
        root.querySelectorAll<HTMLElement>(".search-highlight-block").forEach((block, index) => {
          applyTextHighlights(
            block,
            query,
            partId,
            props.searchHighlightBudget,
            `step-label:${partId}:${index}`,
          );
        });
      });
    });

    createEffect(() => {
      const pre = outputEl();
      if (!pre || !partId) return;

      const query = props.searchHighlightQuery ?? "";
      // The HDR rows re-render on every refresh, so their marks are repainted with them.
      hdr();
      queueMicrotask(() => {
        if (outputEl() !== pre) return;
        applyTextHighlights(
          pre,
          query,
          partId,
          props.searchHighlightBudget,
          `step-output:${partId}`,
        );
      });

      if (isDone()) {
        const saved = toolOutputScrollPositions.get(partId);
        if (saved !== undefined) pre.scrollTop = saved;
        const onScroll = () =>
          toolOutputScrollPositions.set(partId, pre.scrollTop);
        pre.addEventListener("scroll", onScroll, { passive: true });
        onCleanup(() => pre.removeEventListener("scroll", onScroll));
      } else {
        const output = toolOutput();
        if (!output) return;
        pre.scrollTop = pre.scrollHeight;
      }
    });

    if (rowProps.part.type === "reasoning") {
      return (
        <TimelineRow
          as="div"
          tone="idle"
          icon={<StepIcon kind="thinking" />}
          primary={displayLabel().primary}
          secondary={displayLabel().secondary}
          expandable={false}
          density={rowProps.density}
          rowKind="reasoning"
          childBranch={rowProps.childBranch}
        />
      );
    }

    return (
      <div class="flex flex-col gap-1.5">
        <Show
          when={task().isTask && task().sessionId}
          fallback={
            <Show
              when={rowProps.part.type === "tool"}
              fallback={
                <TimelineRow
                  as="div"
                  tone="idle"
                  icon={<StepIcon kind="thinking" />}
                  primary={displayLabel().primary}
                  secondary={displayLabel().secondary}
                  expandable={false}
                  density={rowProps.density}
                  rowKind="reasoning"
                  childBranch={rowProps.childBranch}
                />
              }
            >
              <TimelineRow
                as={canToggle() ? "button" : "div"}
                tone={tone()}
                icon={<StepIcon kind={stepIconKind(rowProps.part)} />}
                primary={displayLabel().primary}
                secondary={displayLabel().secondary}
                expandable={canToggle()}
                searchLabelRef={(element) => {
                  searchLabelsEl = element;
                }}
                expanded={partId ? isToolOutputOpen(partId) || outputHasHiddenMatch() : false}
                onToggle={() => {
                  if (partId && canToggle()) toggleToolOutputOpen(partId);
                }}
                controlsId={partId ? `tool-output-${partId}` : undefined}
                badge={<SourceStack sources={webSources()} />}
                meta={
                  (() => {
                    const ms = stepDurationMs(rowProps.part);
                    const source = modelSourceMeta(rowProps.part);
                    const masking = maskingResolverMetaItem(rowProps.part);
                    return [
                      ...(source ? [source] : []),
                      ...(masking ? [masking] : []),
                      ...(ms !== null && tone() !== "running"
                        ? [{ text: formatElapsedMs(ms) }]
                        : []),
                    ] satisfies TimelineMetaItem[];
                  })() satisfies TimelineMetaItem[]
                }
                density={rowProps.density}
                rowKind="tool"
                childBranch={rowProps.childBranch}
              />
              <Show when={partId && (isToolOutputOpen(partId) || outputHasHiddenMatch())}>
                <Show
                  when={hdr()}
                  fallback={
                    <div
                      id={partId ? `tool-output-${partId}` : undefined}
                      class={rowProps.density === "child" ? "pl-[34px]" : "pl-[40px]"}
                    >
                      <div class="rounded-control border border-dls-border/50 bg-dls-surface-solid/92 overflow-hidden shadow-[var(--dls-card-shadow)] backdrop-blur-sm">
                        <pre
                          ref={setOutputEl}
                          class="p-3 whitespace-pre-wrap break-words text-caption leading-[1.6] text-dls-secondary font-mono max-h-[240px] overflow-y-auto"
                        >
                          {toolOutput()}
                        </pre>
                      </div>
                    </div>
                  }
                >
                  {(progress) => (
                    <HdrActivity
                      ref={setOutputEl}
                      partId={partId ?? ""}
                      searchQuery={props.searchHighlightQuery ?? ""}
                      progress={progress()}
                      searches={hdrWebSearches(rowProps.part)}
                      result={hdrStepResultText(rowProps.part)}
                      isOpen={isToolOutputOpen}
                      toggle={toggleToolOutputOpen}
                      sourceBadge={(sources) => <SourceStack sources={sources} />}
                    />
                  )}
                </Show>
              </Show>
            </Show>
          }
        >
          <SubagentThread
            part={rowProps.part}
            density={rowProps.density}
            childBranch={rowProps.childBranch}
          />
        </Show>
      </div>
    );
  };

  /** Quiet steps list */
  const StepsList = (listProps: {
    parts: Part[];
    density?: "parent" | "child";
  }) => (
    <div class="flex flex-col gap-2">
      <Index each={listProps.parts}>
        {(part, index) => {
          const row = (
            <StepRow
              part={part()}
              density={listProps.density}
              childBranch={listProps.density === "child"}
            />
          );
          return listProps.density === "child" ? (
            <TimelineChild
              first={index === 0}
              last={() => index === listProps.parts.length - 1}
            >
              {row}
            </TimelineChild>
          ) : (
            row
          );
        }}
      </Index>
    </div>
  );

  /** Expandable steps container */
  const StepsContainer = (containerProps: {
    id: string;
    toolSteps: ToolStepGroup[];
    isUser: boolean;
    isInline?: boolean;
    isActiveStream: boolean;
    /** The running turn's newest Activity block: open until the turn ends. */
    isLiveTurn?: boolean;
  }) => {
    const explorationGroups = createMemo(() =>
      containerProps.toolSteps.filter((group) => group.mode === "exploration"),
    );
    const standaloneGroups = createMemo(() =>
      containerProps.toolSteps.filter((group) => group.mode !== "exploration"),
    );
    const unifiedParts = createMemo(() =>
      containerProps.toolSteps.flatMap((group) => group.parts),
    );
    const explorationParts = createMemo(() =>
      explorationGroups().flatMap((group) => group.parts),
    );
    const explorationGroupIds = createMemo(() =>
      explorationGroups().map((group) => group.id),
    );
    const explorationToggleId = () => `${containerProps.id}-exploration`;
    const explorationSummary = createMemo(() =>
      summarizeExploration(explorationParts()),
    );
    const explorationRunStatus = createMemo(() =>
      explorationStatus(explorationParts()),
    );
    /** Child sessions of every task step. `web` marks websearch subagents, or a task with no `subagent_type`. */
    const taskChildSessions = createMemo(() => {
      const children: { id: string; web: boolean }[] = [];
      const seen = new Set<string>();
      for (const group of containerProps.toolSteps) {
        for (const part of group.parts) {
          const record = asToolPart(part);
          if (!record || record.tool?.toLowerCase() !== "task") continue;
          const rawAgentType =
            typeof record.state?.input?.subagent_type === "string"
              ? record.state.input.subagent_type.trim().toLowerCase()
              : "";
          const info = getTaskStepInfo(part);
          if (!info.isTask || !info.sessionId || seen.has(info.sessionId)) continue;
          seen.add(info.sessionId);
          children.push({
            id: info.sessionId,
            web: !rawAgentType || /web[_-]?search/.test(rawAgentType),
          });
        }
      }
      return children;
    });
    const webChildSessionIds = createMemo(() =>
      taskChildSessions()
        .filter((child) => child.web)
        .map((child) => child.id),
    );
    const useInnerTimelineScroll = () =>
      shouldUseInnerTimelineScroll(
        containerProps.isActiveStream,
        webChildSessionIds().length > 0,
      );
    // Only websearch children are fetched up front. Any other subagent adds
    // its sources once its transcript is loaded, e.g. when its row is shown.
    const requestedChildWebSessions = new Set<string>();
    createEffect(() => {
      const ensure = props.ensureSessionLoaded;
      if (!ensure) return;
      for (const id of webChildSessionIds()) {
        if (requestedChildWebSessions.has(id)) continue;
        requestedChildWebSessions.add(id);
        void ensure(id);
      }
    });
    const childWebSources = createMemo<ExplorationWebSource[]>(() => {
      const resolver = props.getMessagesBySessionId;
      if (!resolver) return [];
      const collected: ExplorationWebSource[][] = [];
      for (const { id } of taskChildSessions()) {
        /** Use primary result URLs (^URL: lines) from search tool outputs. */
        const childParts = (resolver(id) ?? []).flatMap((message) =>
          (message.parts ?? []).filter((p) => p.type === "tool"),
        );
        collected.push(getExplorationWebSources(childParts));
      }
      return mergeWebSourcesByHost(...collected);
    });
    const explorationWebSources = createMemo<ExplorationWebSource[]>((prev) => {
      const next = mergeWebSourcesByHost(
        getExplorationWebSources(unifiedParts()),
        childWebSources(),
      );
      if (!prev || prev.length === 0) return next;

      const prevByHost = new Map(prev.map((s) => [s.host, s]));
      const stableNext = next.map((s) => prevByHost.get(s.host) ?? s);

      if (explorationRunStatus() !== "exploring") {
        return stableNext;
      }

      if (stableNext.length === 0) {
        return prev;
      }

      const merged = [...stableNext];
      const seenHosts = new Set(merged.map((s) => s.host));

      prev.forEach((source) => {
        if (!seenHosts.has(source.host)) {
          merged.push(source);
        }
      });

      return merged;
    }, []);
    // A match hidden inside a collapsed Activity group can never be counted or
    // targeted, so the rendered page stays the single source of truth only if
    // every group containing a match stays revealed while the query is live.
    const partsContainSearchMatch = (parts: Part[]) => {
      const query = props.searchHighlightQuery ?? "";
      const needle = query.trim().toLowerCase();
      if (!needle) return false;
      return parts.some((part) => {
        if (part.type !== "tool") return false;
        return [...searchableStepLabel(part), visibleToolStepOutput(part)].some(
          (text) => text.toLowerCase().includes(needle),
        );
      });
    };
    // Records that the user closed this block, so a running turn's update does
    // not reopen it. Keyed by block, which survives an exploration/unified switch.
    const collapsedKey = () => `${containerProps.id}:collapsed`;
    const liveOpen = () =>
      Boolean(containerProps.isLiveTurn) &&
      !props.expandedStepIds.has(collapsedKey());
    const setStepsExpanded = (id: string, relatedIds: string[], open: boolean) =>
      props.setExpandedStepIds((current) => {
        const next = new Set(current);
        for (const key of [id, ...relatedIds]) {
          if (open) next.add(key);
          else next.delete(key);
        }
        if (open) next.delete(collapsedKey());
        else next.add(collapsedKey());
        return next;
      });
    const explorationExpanded = createMemo(
      () =>
        isStepsExpanded(explorationToggleId(), explorationGroupIds()) ||
        liveOpen() ||
        partsContainSearchMatch(explorationParts()),
    );
    const hasUnifiedGroup = createMemo((prev) => {
      const next =
        containerProps.toolSteps.length > 1 && standaloneGroups().length > 0;

      if (explorationRunStatus() === "exploring" && typeof prev === "boolean") {
        return prev;
      }

      return next;
    });
    const unifiedToggleId = () => `${containerProps.id}-activity`;
    const unifiedRelatedIds = createMemo(() =>
      containerProps.toolSteps.map((group) => group.id),
    );
    const unifiedExpanded = createMemo(
      () =>
        isStepsExpanded(unifiedToggleId(), unifiedRelatedIds()) ||
        liveOpen() ||
        partsContainSearchMatch(unifiedParts()),
    );
    const timelineExpanded = createMemo(() =>
      hasUnifiedGroup() ? unifiedExpanded() : explorationExpanded(),
    );
    const unifiedLatestPart = createMemo(() =>
      latestStepPart(containerProps.toolSteps),
    );
    const unifiedTone = createMemo(() => {
      const part = unifiedLatestPart();
      return part ? stepToneForPart(part) : "idle";
    });
    const unifiedLabel = createMemo(() =>
      unifiedStepDisplayLabel(containerProps.toolSteps, unifiedTone()),
    );
    const unifiedStepCount = createMemo(() => {
      const count = countVisibleSteps(unifiedParts());
      return `${count} step${count === 1 ? "" : "s"}`;
    });
    const unifiedMeta = createMemo<TimelineMetaItem[]>(() => {
      const duration = stepGroupDurationMs(unifiedParts());
      const source = groupModelSourceMeta(unifiedParts());
      return [
        { text: unifiedStepCount() },
        ...(source ? [source] : []),
        ...(duration === null ? [] : [{ text: formatElapsedMs(duration) }]),
      ];
    });
    const explorationStepCount = createMemo(() => {
      const count = countVisibleSteps(explorationParts());
      return `${count} step${count === 1 ? "" : "s"}`;
    });
    const explorationLabel = createMemo(() =>
      explorationStepDisplayLabel(
        explorationParts(),
        explorationRunStatus(),
      ),
    );
    const explorationMeta = createMemo<TimelineMetaItem[]>(() => {
      const duration = stepGroupDurationMs(explorationParts());
      const source = groupModelSourceMeta(explorationParts());
      return [
        { text: explorationStepCount() },
        ...(source ? [source] : []),
        ...(duration === null ? [] : [{ text: formatElapsedMs(duration) }]),
      ];
    });
    const isWebOnlyExploration = createMemo(() => {
      const summary = explorationSummary();
      const activeBuckets = [
        summary.files,
        summary.searches,
        summary.lists,
        summary.webPages,
        summary.commands,
        summary.todoUpdates,
      ].filter((count) => count > 0).length;
      return summary.webPages > 0 && activeBuckets === 1;
    });

    // Restores the timeline scroll offset after a remount and keeps the cached
    // value in sync while the user scrolls. A user parked at the bottom keeps
    // following new steps instead of being pinned to a stale pixel offset.
    const [timelineScrollEl, setTimelineScrollEl] =
      createSignal<HTMLDivElement>();
    const [timelineContentEl, setTimelineContentEl] =
      createSignal<HTMLDivElement>();
    createEffect(() => {
      // Read every dependency before touching the DOM: content growth, the
      // expand toggle, and the overflow class itself. The container is only a
      // scroller while `useInnerTimelineScroll()` holds, and the offset has to
      // be re-applied when it comes back.
      containerProps.toolSteps;
      timelineExpanded();
      const scrollable = !isNestedVariant() && useInnerTimelineScroll();
      const el = timelineScrollEl();
      const contentEl = timelineContentEl();
      if (!el || !contentEl || !scrollable) return;

      const key = containerProps.id;
      const restoreScrollPosition = () => {
        const saved = timelineScrollPositions.get(key);
        if (saved?.atBottom) {
          el.scrollTop = el.scrollHeight;
        } else if (saved && saved.top > 0 && el.scrollTop !== saved.top) {
          el.scrollTop = saved.top;
        }
      };
      restoreScrollPosition();

      const onScroll = () => {
        // A container that is not currently overflowing is held at scrollTop 0
        // by the browser. Recording that would silently replace the user's real
        // offset with 0 — which is how the timeline used to lose its position
        // when the overflow class was dropped mid-run.
        if (el.scrollHeight <= el.clientHeight) return;
        const distanceFromBottom =
          el.scrollHeight - (el.scrollTop + el.clientHeight);
        timelineScrollPositions.set(key, {
          top: el.scrollTop,
          atBottom: distanceFromBottom <= TIMELINE_BOTTOM_STICK_PX,
        });
      };
      el.addEventListener("scroll", onScroll, { passive: true });

      if (typeof ResizeObserver === "undefined") {
        onCleanup(() => el.removeEventListener("scroll", onScroll));
        return;
      }

      // The scroller remains max-height, so observe its content. A step can
      // grow without changing timeline structure; only bottom users follow it.
      const resizeObserver = new ResizeObserver(restoreScrollPosition);
      resizeObserver.observe(contentEl);
      onCleanup(() => {
        el.removeEventListener("scroll", onScroll);
        resizeObserver.disconnect();
      });
    });

    return (
      <div
        class={
          containerProps.isInline
            ? containerProps.isUser
              ? "mt-3"
              : "mt-2"
            : ""
        }
      >
        <div
          ref={setTimelineScrollEl}
          class={`ml-4 flex flex-col ${containerProps.isUser ? "gap-4" : "gap-2"} ${!isNestedVariant() && useInnerTimelineScroll() ? "max-h-[420px] overflow-y-auto pr-1" : ""}`}
        >
          <div
            ref={setTimelineContentEl}
            class={`flex flex-col ${containerProps.isUser ? "gap-4" : "gap-2"}`}
          >
            <Show when={hasUnifiedGroup()}>
              <div class="flex flex-col gap-2">
                <TimelineRow
                  tone={unifiedTone()}
                  icon={<StepIcon kind="group" />}
                  primary={unifiedLabel().primary}
                  secondary={unifiedLabel().secondary}
                  expandable={true}
                  expanded={unifiedExpanded()}
                  onToggle={() =>
                    setStepsExpanded(
                      unifiedToggleId(),
                      unifiedRelatedIds(),
                      !unifiedExpanded(),
                    )
                  }
                  controlsId={`step-group-${unifiedToggleId()}`}
                  badge={<SourceStack sources={explorationWebSources()} />}
                  meta={unifiedMeta()}
                  emphasis={true}
                  density="parent"
                  rowKind="group"
                />
                <Show when={unifiedExpanded()}>
                  <TimelineChildren
                    id={`step-group-${unifiedToggleId()}`}
                    class="flex flex-col gap-2"
                    branching={true}
                  >
                    <StepsList parts={unifiedParts()} density="child" />
                  </TimelineChildren>
                </Show>
              </div>
            </Show>
            <Show when={!hasUnifiedGroup()}>
              <Show when={explorationParts().length > 0}>
                <div class="flex flex-col gap-2">
                  <TimelineRow
                    tone={
                      explorationRunStatus() === "exploring"
                        ? "running"
                        : "done"
                    }
                    icon={
                      <StepIcon
                        kind={isWebOnlyExploration() ? "web" : "group"}
                      />
                    }
                    primary={explorationLabel().primary}
                    secondary={explorationLabel().secondary}
                    expandable={true}
                    expanded={explorationExpanded()}
                    onToggle={() =>
                      setStepsExpanded(
                        explorationToggleId(),
                        explorationGroupIds(),
                        !explorationExpanded(),
                      )
                    }
                    controlsId={`step-group-${explorationToggleId()}`}
                    badge={<SourceStack sources={explorationWebSources()} />}
                    meta={explorationMeta()}
                    emphasis={true}
                    density="parent"
                    rowKind="group"
                  />
                  <Show when={explorationExpanded()}>
                    <TimelineChildren
                      id={`step-group-${explorationToggleId()}`}
                      class="flex flex-col gap-2"
                      branching={true}
                    >
                      <StepsList
                        parts={explorationParts()}
                        density="child"
                      />
                    </TimelineChildren>
                  </Show>
                </div>
              </Show>
              <For each={standaloneGroups()}>
                {(group) => <StepsList parts={group.parts} />}
              </For>
            </Show>
          </div>
        </div>
      </div>
    );
  };

  return { StepsContainer };
}
