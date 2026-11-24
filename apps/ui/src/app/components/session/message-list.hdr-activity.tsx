import { Index, Show } from "solid-js";
import type { JSX } from "solid-js";

import {
  getWebSourceFromUrl,
  mergeWebSourcesByHost,
  type ExplorationWebSource,
} from "./message-list.exploration";
import { formatElapsedMs } from "./message-list.format";
import type {
  HdrPhase,
  HdrProgress,
  HdrSection,
  HdrWebSearch,
} from "./message-list.hdr-progress";
import { StepIcon, type StepIconKind } from "./message-list.step-icon";
import {
  TimelineChild,
  TimelineChildren,
  TimelineRow,
} from "./message-list.timeline-row";
import type { StepTone } from "./message-list.tool";

const PHASE_ICON: Record<string, StepIconKind> = {
  input_local: "document",
  input_web: "web",
  plan: "plan",
  section_write: "write",
  fill: "edit",
  conclusion: "write",
  fill_conclusion: "edit",
  assemble: "document",
  polish: "edit",
};

const PHASE_TONE: Record<HdrPhase["status"], StepTone> = {
  done: "done",
  running: "running",
  failed: "error",
  pending: "idle",
  skipped: "idle",
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

function searchSources(searches: HdrWebSearch[]): ExplorationWebSource[] {
  return mergeWebSourcesByHost(
    searches.flatMap((search) =>
      search.results.flatMap((result) => getWebSourceFromUrl(result.url) ?? []),
    ),
  );
}

type Detail = { icon: StepIconKind; tone: StepTone; primary: string; secondary?: string; sources?: ExplorationWebSource[] };

/** The rows a phase opens to: what it read, searched or wrote. */
function phaseDetails(phase: HdrPhase, progress: HdrProgress, searches: HdrWebSearch[]): Detail[] {
  if (phase.phase === "input_local") {
    return progress.localFiles.map((name) => ({ icon: "document", tone: "done", primary: name }));
  }
  if (phase.phase === "input_web") {
    return searches.map((search) => ({
      icon: "web",
      tone: "done",
      primary: search.query,
      secondary: plural(search.results.length, "result"),
      sources: searchSources([search]),
    }));
  }
  if (phase.phase === "section_write") {
    return progress.sections.map((section) => ({
      icon: "write",
      tone: section.stage === "done" ? "done" : phase.status === "running" ? "running" : "idle",
      primary: section.title,
      secondary: sectionStageText(section),
    }));
  }
  return [];
}

/** Only the primary text is searchable (see `hdrActivityText`); counts and stages are not. */
function detailsMatch(details: Detail[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !!needle && details.some((detail) => detail.primary.toLowerCase().includes(needle));
}

function sectionStageText(section: HdrSection): string | undefined {
  if (section.stage === "done") return undefined;
  const draft = section.attempt ? ` draft ${section.attempt}` : "";
  return section.stage === "reviewing" ? `Reviewing${draft}` : `Writing${draft}`;
}

function phaseSummary(phase: HdrPhase, progress: HdrProgress, searches: HdrWebSearch[]): string | undefined {
  if (phase.status === "skipped") return "Skipped";
  if (phase.status === "failed") return "Failed";
  if (phase.status === "pending") return undefined;
  if (phase.phase === "input_local") {
    return progress.localFiles.length ? plural(progress.localFiles.length, "file") : "No local files";
  }
  if (phase.phase === "input_web" && searches.length) return plural(searches.length, "search");
  const total = progress.sectionCount;
  if (phase.phase === "plan" && total) return plural(total, "section");
  if (phase.phase === "section_write" && total) {
    const written = progress.sections.filter((section) => section.stage === "done").length;
    return `${written}/${total} sections written`;
  }
  return undefined;
}

/** Index, not For: the progress is re-parsed on every 2 s refresh, so rows are keyed by position. */
function ChildRows<T>(props: { each: T[]; children: (item: () => T) => JSX.Element }) {
  return (
    <Index each={props.each}>
      {(item, index) => (
        <TimelineChild first={index === 0} last={() => index === props.each.length - 1}>
          {props.children(item)}
        </TimelineChild>
      )}
    </Index>
  );
}

/**
 * Hybrid Deep Research runs in its own service, not as an opencode sub-agent,
 * so it has no child session to show. Its phases render as child rows from the
 * progress the tool reports, opening to the files, searches and sections each
 * one worked on. A phase whose rows match the search query opens, so its match
 * can be highlighted.
 */
export function HdrActivity(props: {
  ref: (element: HTMLElement) => void;
  partId: string;
  searchQuery: string;
  progress: HdrProgress;
  searches: HdrWebSearch[];
  result: string;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  sourceBadge: (sources: ExplorationWebSource[]) => JSX.Element;
}): JSX.Element {
  return (
    <TimelineChildren ref={props.ref} id={`tool-output-${props.partId}`} class="flex flex-col gap-2" branching={true}>
      <ChildRows each={props.progress.phases}>
        {(phase) => {
          const key = () => `${props.partId}:hdr:${phase().phase}`;
          const details = () => phaseDetails(phase(), props.progress, props.searches);
          const open = () =>
            details().length > 0 && (props.isOpen(key()) || detailsMatch(details(), props.searchQuery));
          const duration = () => phase().durationMs;
          return (
            <div class="flex flex-col gap-1">
              <TimelineRow
                tone={PHASE_TONE[phase().status]}
                icon={<StepIcon kind={PHASE_ICON[phase().phase] ?? "research"} />}
                primary={phase().label}
                secondary={phaseSummary(phase(), props.progress, props.searches)}
                expandable={details().length > 0}
                expanded={open()}
                onToggle={() => props.toggle(key())}
                controlsId={`hdr-phase-${key()}`}
                badge={phase().phase === "input_web" ? props.sourceBadge(searchSources(props.searches)) : undefined}
                meta={(() => {
                  const ms = duration();
                  return ms !== undefined ? [{ text: formatElapsedMs(ms) }] : [];
                })()}
                density="child"
                rowKind="tool"
                childBranch={true}
              />
              <Show when={open()}>
                <TimelineChildren id={`hdr-phase-${key()}`} class="flex flex-col gap-2" branching={true}>
                  <ChildRows each={details()}>
                    {(detail) => (
                      <TimelineRow
                        tone={detail().tone}
                        icon={<StepIcon kind={detail().icon} />}
                        primary={detail().primary}
                        secondary={detail().secondary}
                        expandable={false}
                        badge={(() => {
                          const sources = detail().sources;
                          return sources ? props.sourceBadge(sources) : undefined;
                        })()}
                        density="child"
                        rowKind="tool"
                        childBranch={true}
                      />
                    )}
                  </ChildRows>
                </TimelineChildren>
              </Show>
            </div>
          );
        }}
      </ChildRows>
      <Show when={props.result}>
        <div class="rounded-control border border-dls-border/50 bg-dls-surface-solid/92 p-3 whitespace-pre-wrap break-words text-caption leading-[1.6] text-dls-secondary">
          {props.result}
        </div>
      </Show>
    </TimelineChildren>
  );
}
