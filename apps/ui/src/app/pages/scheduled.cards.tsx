import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../../i18n";
import type { ScheduledJob } from "../types";
import { ChevronRight } from "lucide-solid";
import { FolderOpen } from "lucide-solid";
import { MoreHorizontal } from "lucide-solid";
import { Pencil } from "lucide-solid";
import { Play } from "lucide-solid";
import { Terminal } from "lucide-solid";
import { Trash2 } from "lucide-solid";
import { TriangleAlert } from "lucide-solid";
import { X } from "lucide-solid";
import { humanizeCron, statusAccentClass, statusLabel, statusTone, taskSummary, toRelative } from "./scheduled.cron";
import { humanizeAgentName } from "./scheduled.agent-name";

// Below this much room under the card, the details panel opens upward instead.
const PANEL_MIN_SPACE = 240;
const VIEWPORT_MARGIN = 8;

type PanelPosition = { top?: number; bottom?: number; left: number; width: number; maxHeight: number };

export const AutomationJobCard = (props: {
  job: ScheduledJob;
  supported: boolean;
  busy: boolean;
  running: boolean;
  enabled: boolean;
  modelLabel?: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  onDelete: () => void;
  onRun: () => void;
  onEdit: () => void;
  onToggleEnabled: () => void;
}) => {
  const summary = () => taskSummary(props.job);
  const status = () => (props.running ? "running" : props.job.lastRunStatus);
  const scheduleLabel = () => humanizeCron(props.job.schedule, props.job.source);
  const isAgentLab = () => props.job.source === "agentlab";
  const [menuOpen, setMenuOpen] = createSignal(false);
  // Only Run is blocked by a live run; pausing or editing a running automation is valid.
  const runDisabled = () => !props.supported || props.busy || props.running;
  const actionDisabled = () => !props.supported || props.busy;
  let menuRef: HTMLDivElement | undefined;
  let cardRef: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  let closeButtonRef: HTMLButtonElement | undefined;
  // Set right before closing the panel to open Edit/Delete instead of just
  // dismissing it, so focus isn't yanked back to the trigger a moment before
  // that other dialog takes it anyway.
  let skipFocusRestore = false;
  // Null until measured, so the panel never paints at a default (0, 0) position.
  const [panelPos, setPanelPos] = createSignal<PanelPosition | null>(null);
  const [panelShown, setPanelShown] = createSignal(false);

  createEffect(() => {
    if (!menuOpen()) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!menuRef?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    });
  });

  // Anchor the details panel over the card itself, flipping upward near the
  // bottom of the window so it never renders off-screen.
  const positionPanel = () => {
    if (!cardRef) return;
    const rect = cardRef.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.top - VIEWPORT_MARGIN;
    const spaceAbove = rect.bottom - VIEWPORT_MARGIN;
    if (spaceBelow >= PANEL_MIN_SPACE || spaceBelow >= spaceAbove) {
      setPanelPos({ top: rect.top, left: rect.left, width: rect.width, maxHeight: Math.max(spaceBelow, 0) });
    } else {
      setPanelPos({ bottom: window.innerHeight - rect.bottom, left: rect.left, width: rect.width, maxHeight: Math.max(spaceAbove, 0) });
    }
  };

  createEffect(() => {
    if (!props.expanded) {
      setPanelPos(null);
      setPanelShown(false);
      return;
    }
    setMenuOpen(false);
    positionPanel();
    // Mount in the start state first, then flip on the next frame so the transition runs.
    const frame = requestAnimationFrame(() => {
      setPanelShown(true);
      closeButtonRef?.focus();
    });
    const onReflow = () => positionPanel();
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef?.contains(target) || cardRef?.contains(target)) return;
      props.onToggleExpanded();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onToggleExpanded();
    };
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      if (skipFocusRestore) skipFocusRestore = false;
      else triggerRef?.focus();
    });
  });

  // Rendered in both the card and the details panel, so each call builds its own nodes.
  const summaryBlock = () => (
    <div class={`min-w-0 flex-1 transition-opacity ${isAgentLab() && !props.enabled ? "opacity-70" : ""}`}>
      <h3 class="truncate text-body-lg font-semibold text-dls-text">{props.job.name}</h3>
      <div class="mt-1 flex flex-wrap items-center gap-1.5">
        <span
          class={`shrink-0 rounded-pill border px-2 py-0.5 text-tiny font-semibold uppercase tracking-wide ${statusTone(
            status()
          )}`}
        >
          {statusLabel(status())}
        </span>
        <Show when={isAgentLab() && !props.enabled}>
          <span class="shrink-0 rounded-pill border border-dls-border bg-dls-hover px-2 py-0.5 text-tiny font-semibold uppercase tracking-wide text-dls-secondary">
            {t("scheduled.paused")}
          </span>
        </Show>
        <span class="truncate text-caption text-dls-secondary">{scheduleLabel()}</span>
      </div>
      <Show when={isAgentLab() && props.job.needsDayReview}>
        <div class="mt-1 flex items-center gap-1 text-tiny font-semibold uppercase tracking-wide text-dls-warning-text">
          <span class="inline-flex shrink-0 items-center gap-1 rounded-pill border border-dls-warning-border bg-dls-warning-bg px-2 py-0.5">
            <TriangleAlert size={11} aria-hidden="true" />
            {t("scheduled.needs_day_review_badge")}
          </span>
        </div>
      </Show>
      <div class="mt-0.5 truncate text-label text-dls-secondary">
        {t("scheduled.last_run")} {toRelative(props.job.lastRunAt)}
      </div>
      <Show when={status() === "failed" && props.job.lastRunError}>
        {(error) => <p class="mt-0.5 text-label text-dls-danger-text">{error()}</p>}
      </Show>
    </div>
  );

  const enabledSwitch = () => (
    <Show when={isAgentLab()}>
      <button
        type="button"
        role="switch"
        aria-checked={props.enabled}
        aria-label={props.enabled ? t("scheduled.pause") : t("scheduled.resume")}
        title={props.enabled ? t("scheduled.pause") : t("scheduled.resume")}
        onClick={props.onToggleEnabled}
        disabled={actionDisabled()}
        class={`relative inline-flex h-5 w-9 items-center rounded-pill transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${props.enabled ? "bg-dls-success-dot" : "bg-dls-border"
          }`}
      >
        <span
          class={`inline-block h-4 w-4 rounded-pill bg-dls-switch-thumb shadow ring-1 ring-dls-switch-thumb-ring transition-transform ${props.enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
        />
      </button>
    </Show>
  );

  const runButton = () => (
    <button
      type="button"
      onClick={props.onRun}
      disabled={runDisabled()}
      aria-label={props.running ? t("scheduled.status_running") : t("scheduled.run")}
      title={props.running ? t("scheduled.status_running") : t("scheduled.run")}
      class={`flex h-8 w-8 items-center justify-center rounded-control border transition-colors disabled:cursor-not-allowed ${props.running
        ? "border-dls-success-border-solid bg-dls-success-dot text-white"
        : !props.supported || props.busy
          ? "border-dls-border text-dls-secondary"
          : "border-dls-success-border bg-dls-success-bg text-dls-success-text hover:bg-dls-success-bg"
        }`}
    >
      <Play size={14} />
    </button>
  );

  const accentBar = () => <div class={`absolute inset-y-2 left-0 w-1 rounded-pill ${statusAccentClass(status())}`} />;

  return (
    <div
      ref={cardRef}
      class={`relative flex h-full flex-col rounded-inset border border-dls-panel-border bg-dls-panel-bg shadow-[var(--dls-card-shadow)] ${menuOpen() ? "z-20" : ""}`}
    >
      {accentBar()}

      <button
        type="button"
        ref={triggerRef}
        onClick={() => props.onToggleExpanded()}
        aria-expanded={props.expanded}
        aria-haspopup="dialog"
        class="flex w-full items-start justify-between gap-2 py-3 pl-5 pr-4 text-left"
      >
        {summaryBlock()}
        <ChevronRight size={14} class="mt-0.5 shrink-0 text-dls-secondary" />
      </button>

      <div class="mt-auto flex items-center gap-1.5 px-4 pb-3 pl-5">
        {enabledSwitch()}
        {runButton()}
        <div class="relative ml-auto" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={!props.supported || props.busy}
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            aria-label={t("scheduled.more_actions")}
            class="flex h-8 w-8 items-center justify-center rounded-control border border-dls-border text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-not-allowed disabled:text-dls-secondary"
          >
            <MoreHorizontal size={14} />
          </button>
          <Show when={menuOpen()}>
            <div
              role="menu"
              class="absolute right-0 top-full z-10 mt-1 w-36 overflow-hidden rounded-control border border-dls-border bg-dls-surface-solid shadow-lg animate-in fade-in zoom-in-95 slide-in-from-top-1 duration-150"
            >
              <Show when={isAgentLab()}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    props.onEdit();
                  }}
                  disabled={actionDisabled()}
                  class="flex w-full items-center gap-1.5 px-3 py-2 text-caption font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Pencil size={12} />
                  {t("scheduled.edit")}
                </button>
              </Show>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  props.onDelete();
                }}
                disabled={!props.supported || props.busy}
                class="flex w-full items-center gap-1.5 px-3 py-2 text-caption font-medium text-dls-danger-text transition-colors hover:bg-dls-danger-bg disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 size={12} />
                {t("scheduled.delete")}
              </button>
            </div>
          </Show>
        </div>
      </div>

      <Show when={props.expanded ? panelPos() : null}>
        {(pos) => (
        <Portal>
          <div
            ref={panelRef}
            role="dialog"
            aria-label={props.job.name}
            style={{
              position: "fixed",
              ...(pos().top !== undefined ? { top: `${pos().top}px` } : { bottom: `${pos().bottom}px` }),
              left: `${pos().left}px`,
              width: `${pos().width}px`,
              "max-height": `${pos().maxHeight}px`,
            }}
            class={`z-[999] flex flex-col rounded-inset border border-dls-border bg-dls-surface-solid font-sans text-dls-text shadow-sm transition-[opacity,transform] duration-150 ease-out ${pos().top !== undefined ? "origin-top" : "origin-bottom"
              } ${panelShown() ? "scale-100 opacity-100" : "scale-[0.97] opacity-0"}`}
          >
            {accentBar()}

            <div class="flex items-start justify-between gap-2 py-3 pl-5 pr-3">
              {summaryBlock()}
              <button
                type="button"
                ref={closeButtonRef}
                onClick={() => props.onToggleExpanded()}
                aria-label={t("common.close")}
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-subtle text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              >
                <X size={14} />
              </button>
            </div>

            <div class="min-h-0 flex-1 space-y-2 overflow-y-auto border-t border-dls-border py-3 pl-5 pr-4 text-caption text-dls-secondary">
              <div>
                <div class="text-tiny uppercase tracking-wide">{summary().label}</div>
                <div class={`mt-0.5 text-body-lg text-dls-text break-words ${summary().mono ? "font-mono" : ""}`}>
                  {summary().value}
                </div>
              </div>
              <div class="flex items-center gap-2">
                <FolderOpen size={14} class="shrink-0" />
                <span class="font-mono text-dls-text break-all">{props.job.workdir ?? t("scheduled.default")}</span>
              </div>
              <Show when={props.job.run?.attachUrl ?? props.job.attachUrl}>
                <div class="flex items-center gap-2">
                  <Terminal size={14} class="shrink-0" />
                  <span class="font-mono text-dls-text break-all">{props.job.run?.attachUrl ?? props.job.attachUrl}</span>
                </div>
              </Show>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                <div>{t("scheduled.created")} {toRelative(props.job.createdAt)}</div>
                <Show when={isAgentLab() || props.job.run?.agent}>
                  <div>{t("scheduled.agent")} {props.job.run?.agent ? humanizeAgentName(props.job.run.agent) : t("scheduled.agent_default")}</div>
                </Show>
                <Show when={props.job.run?.model}>
                  <div>{t("scheduled.model")} {props.modelLabel ?? props.job.run?.model}</div>
                </Show>
              </div>
            </div>

            <div class="flex items-center gap-1.5 border-t border-dls-border py-2.5 pl-5 pr-3">
              {enabledSwitch()}
              {runButton()}
              <div class="ml-auto flex items-center gap-1">
                <Show when={isAgentLab()}>
                  <button
                    type="button"
                    onClick={() => {
                      skipFocusRestore = true;
                      props.onToggleExpanded();
                      props.onEdit();
                    }}
                    disabled={actionDisabled()}
                    class="flex items-center gap-1 rounded-control px-2 py-1.5 text-caption font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Pencil size={12} />
                    {t("scheduled.edit")}
                  </button>
                </Show>
                <button
                  type="button"
                  onClick={() => {
                    skipFocusRestore = true;
                    props.onToggleExpanded();
                    props.onDelete();
                  }}
                  disabled={!props.supported || props.busy}
                  class="flex items-center gap-1 rounded-control px-2 py-1.5 text-caption font-medium text-dls-danger-text transition-colors hover:bg-dls-danger-bg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 size={12} />
                  {t("scheduled.delete")}
                </button>
              </div>
            </div>
          </div>
        </Portal>
        )}
      </Show>
    </div>
  );
};
