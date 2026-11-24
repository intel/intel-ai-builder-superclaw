import { ChevronDown, ChevronRight } from "lucide-solid";
import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Tooltip } from "~/shared/ui/tooltip";
import type { ActivityModelExecution } from "../../lib/activity-model-executions";
import type { StepTone } from "./message-list.tool";

export type TimelineMetaItem =
  | { text: string; kind?: "default"; title?: string }
  | {
      text: "Local" | "Cloud" | "Hybrid";
      kind: "model-source";
      source: "local" | "cloud" | "hybrid";
      title?: string;
    }
  | { text: string; kind: "action"; onClick: () => void; ariaLabel?: string };

/** The Local / Cloud / Hybrid tag for a step, or nothing when unattributed. */
export function modelSourceMetaItem(
  execution: ActivityModelExecution | undefined,
): TimelineMetaItem | undefined {
  if (!execution) return undefined;
  const text =
    execution.source === "local" ? "Local" : execution.source === "cloud" ? "Cloud" : "Hybrid";
  const what = execution.source === "hybrid" ? "Local and cloud models" : `${text} model`;
  return {
    text,
    kind: "model-source",
    source: execution.source,
    title: execution.modelLabel ? `${what}: ${execution.modelLabel}` : what,
  };
}

type TimelineRowProps = {
  tone: StepTone;
  icon: JSX.Element;
  primary: string;
  secondary?: string;
  expandable: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  controlsId?: string;
  badge?: JSX.Element;
  meta?: TimelineMetaItem[];
  emphasis?: boolean;
  as?: "button" | "div";
  density?: "parent" | "child";
  rowKind: "group" | "tool" | "reasoning" | "subagent";
  childBranch?: boolean;
  searchLabelRef?: (element: HTMLSpanElement) => void;
};

const TONE_CLASS: Record<StepTone, string> = {
  done: "bg-dls-hover text-dls-secondary",
  idle: "bg-dls-hover text-dls-secondary",
  running: "bg-dls-warning-bg text-dls-warning-text ring-1 ring-dls-warning-border animate-pulse",
  error: "bg-dls-danger-bg text-dls-danger-text ring-1 ring-dls-danger-border",
  cancelled: "bg-dls-hover text-dls-secondary",
};

export function TimelineChildren(props: {
  ref?: (element: HTMLDivElement) => void;
  id?: string;
  children: JSX.Element;
  class?: string;
  branching?: boolean;
}): JSX.Element {
  return (
    <div
      ref={props.ref}
      id={props.id}
      class={`relative ml-[14px] mt-1 py-1 pl-[26px] ${
        props.branching
          ? ""
          : "before:absolute before:-top-3 before:bottom-[18px] before:left-0 before:w-px before:bg-dls-border/60"
      } ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

export function TimelineChild(props: {
  children: JSX.Element;
  first: boolean;
  last: () => boolean;
}): JSX.Element {
  return (
    <div
      class={`relative ${
        props.first
          ? "before:absolute before:-top-3 before:left-[-26px] before:h-[29px] before:w-px before:bg-dls-border/60"
          : "before:absolute before:top-0 before:left-[-26px] before:h-[17px] before:w-px before:bg-dls-border/60"
      } ${
        props.last()
          ? ""
          : "after:absolute after:top-[17px] after:-bottom-2 after:left-[-26px] after:w-px after:bg-dls-border/60"
      }`}
    >
      {props.children}
    </div>
  );
}

export function TimelineRow(props: TimelineRowProps): JSX.Element {
  const density = () => props.density ?? "parent";
  const isChild = () => density() === "child";
  const isButton = () =>
    (props.as ?? (props.expandable ? "button" : "div")) === "button";
  const columns = () =>
    isChild()
      ? "grid-cols-[22px_minmax(0,1fr)_auto]"
      : "grid-cols-[28px_minmax(0,1fr)_auto]";
  const mainColumns = () =>
    isChild() ? "grid-cols-[22px_minmax(0,1fr)]" : "grid-cols-[28px_minmax(0,1fr)]";
  const rowClass = () =>
    `relative grid w-full min-w-0 items-center gap-3 ${columns()} ${
      isChild() ? "min-h-[34px]" : "min-h-10"
    } ${
      props.childBranch
        ? "before:absolute before:left-[-26px] before:top-1/2 before:h-px before:w-[37px] before:bg-dls-border/60"
        : ""
    }`;
  const mainClass = () =>
    `col-span-2 grid min-w-0 items-center gap-3 rounded-control px-1 py-1 text-left text-body text-dls-secondary select-none ${mainColumns()} ${
      isButton()
        ? "cursor-pointer transition-colors hover:bg-dls-hover/60 hover:text-dls-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dls-accent"
        : ""
    }`;

  const content = () => (
    <>
      <span
        data-testid="tool-status-dot"
        data-status={props.tone}
        aria-hidden="true"
        class={`relative z-10 flex shrink-0 items-center justify-center rounded-pill ${
          isChild() ? "size-[22px]" : "size-7"
        } ${TONE_CLASS[props.tone]}`}
      >
        {props.icon}
      </span>
      <span class="min-w-0" ref={props.searchLabelRef}>
        <span class="flex min-w-0 items-center gap-1.5">
          <Show when={props.expandable}>
            <span class="shrink-0 text-dls-secondary" aria-hidden="true">
              <Show when={props.expanded} fallback={<ChevronRight size={12} />}>
                <ChevronDown size={12} />
              </Show>
            </span>
          </Show>
          <span
            data-testid="tool-headline"
            class={`search-highlight-block min-w-0 truncate ${
              props.emphasis ? "font-medium text-dls-text" : ""
            }`}
            title={props.primary}
          >
            {props.primary}
          </span>
          <Show when={props.badge}>
            <span class="max-[520px]:hidden shrink-0">{props.badge}</span>
          </Show>
        </span>
        <Show when={props.secondary}>
          <span
            data-testid="tool-detail"
            class="search-highlight-block mt-0.5 block truncate text-caption leading-4 text-dls-secondary"
            title={props.secondary}
          >
            {props.secondary}
          </span>
        </Show>
      </span>
    </>
  );

  return (
    <div class={rowClass()} data-row-kind={props.rowKind} data-testid="tool-step-row">
      <Show
        when={isButton()}
        fallback={<div class={mainClass()}>{content()}</div>}
      >
        <button
          type="button"
          data-testid="tool-step-button"
          class={mainClass()}
          onClick={props.onToggle}
          aria-expanded={props.expandable ? Boolean(props.expanded) : undefined}
          aria-controls={props.expandable ? props.controlsId : undefined}
        >
          {content()}
        </button>
      </Show>
      <div
        data-testid="activity-meta"
        class="col-start-3 flex shrink-0 items-center justify-end gap-1.5 pl-2 font-mono text-label tabular-nums text-dls-secondary whitespace-nowrap"
      >
        <For each={props.meta ?? []}>
          {(item, index) => (
            <>
              <Show when={index() > 0}>
                <span aria-hidden="true" class="size-0.5 rounded-pill bg-dls-border" />
              </Show>
              <Show
                when={item.kind === "action"}
                fallback={
                  item.kind === "model-source" ? (
                    <Tooltip content={item.title ?? item.text} placement="top" focusable>
                      <span
                        data-testid="activity-model-source"
                        data-model-source={item.source}
                        class={
                          item.source === "local"
                            ? "text-dls-model-source-local"
                            : item.source === "cloud"
                              ? "text-dls-model-source-cloud"
                              : "text-dls-model-source-other"
                        }
                      >
                        {item.text}
                      </span>
                    </Tooltip>
                  ) : (
                    <span title={item.kind === "action" ? undefined : item.title}>
                      {item.text}
                    </span>
                  )
                }
              >
                <button
                  type="button"
                  class="max-[520px]:hidden text-dls-link transition-colors hover:text-dls-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dls-accent"
                  aria-label={
                    item.kind === "action" ? item.ariaLabel ?? item.text : item.text
                  }
                  onClick={() => {
                    if (item.kind === "action") item.onClick();
                  }}
                >
                  {item.text}
                </button>
              </Show>
            </>
          )}
        </For>
      </div>
    </div>
  );
}
