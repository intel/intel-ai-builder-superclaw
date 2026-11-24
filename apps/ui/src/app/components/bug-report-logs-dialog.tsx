import { For, Show } from "solid-js";
import { Loader2, Upload, X } from "lucide-solid";
import { Portal } from "solid-js/web";

import type { BugLogEntry } from "../lib/bug-report-github";
import { formatBugLogBytes } from "../lib/bug-report-github";

export type BugReportLogsDialogProps = {
  logs: BugLogEntry[] | null;
  summary: string;
  onSummaryChange: (value: string) => void;
  summaryMaxLength?: number;
  submitting: boolean;
  picking: boolean;
  error: string | null;
  status: string | null;
  onClose: () => void;
  onPickLogs: () => void;
  onRemoveLog: (path: string) => void;
  onSubmit: () => void;
};

export default function BugReportLogsDialog(props: BugReportLogsDialogProps) {
  return (
    <Show when={props.logs !== null}>
      <Portal>
        <div
          class="fixed inset-0 z-[60] flex items-center justify-center dls-modal-backdrop p-4"
          onClick={() => {
            if (!props.submitting) props.onClose();
          }}
        >
          <div
            class="w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col border p-5 dls-modal-surface"
            role="dialog"
            aria-label="Report a bug with logs"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="text-heading font-semibold text-dls-text mb-1">
              Attach recent logs to a bug report
            </h2>
            <p class="text-body-lg text-dls-secondary mb-3">
              The latest 2 app-start log files are uploaded to a GitHub gist via your local{" "}
              <code>gh</code> CLI, attached in GitHub issues when you submit it.
            </p>
            <div class="rounded-inset border border-dls-warning-border bg-dls-warning-bg px-3 py-2 mb-3 text-caption text-dls-warning-text">
              Warning: logs may contain file paths, prompt fragments, or secrets (e.g.{" "}
              <code>sk-*</code> / <code>Bearer</code> tokens from llmrouter_manager). They are
              uploaded as-is. Only continue if you are comfortable sharing them on GitHub.
            </div>
            <label class="block mb-3">
              <span class="text-body-lg font-medium text-dls-text">What happened?</span>
              <textarea
                rows={3}
                maxlength={props.summaryMaxLength ?? 4000}
                value={props.summary}
                disabled={props.submitting}
                onInput={(event) => props.onSummaryChange(event.currentTarget.value)}
                placeholder="Brief description for the GitHub issue summary field (optional)"
                class="mt-1 w-full rounded-inset border border-dls-border/60 bg-dls-surface px-3 py-2 text-body-lg text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.3)] resize-none"
              />
            </label>
            <div class="flex items-center justify-between mb-2">
              <span class="text-body-lg font-medium text-dls-text">
                Files to attach ({props.logs?.length ?? 0})
              </span>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-control border border-transparent bg-[var(--dls-accent)] px-3 py-1.5 text-body-lg text-white shadow-sm hover:bg-[var(--dls-accent-hover)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.45)] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={props.submitting || props.picking}
                onClick={() => props.onPickLogs()}
              >
                <Upload size={13} />
                {props.picking ? "Opening" : "Select files"}
              </button>
            </div>
            <div class="flex-1 overflow-y-auto rounded-inset border border-dls-border/60 divide-y divide-dls-border/40">
              <Show
                when={(props.logs?.length ?? 0) > 0}
                fallback={
                  <div class="px-3 py-4 text-caption text-dls-secondary">
                    No files selected. Use “Select files” to add logs.
                  </div>
                }
              >
                <For each={props.logs ?? []}>
                  {(log) => (
                    <div class="flex items-center gap-2 px-3 py-2">
                      <span
                        class={`shrink-0 rounded-control px-1.5 py-0.5 text-caption ${
                          log.origin === "auto"
                            ? "bg-dls-hover text-dls-secondary"
                            : "bg-[rgb(var(--dls-accent-rgb)/0.15)] text-[var(--dls-accent)]"
                        }`}
                      >
                        {log.origin === "auto" ? "auto" : "added"}
                      </span>
                      <span class="flex-1 truncate text-caption text-dls-text" title={log.path}>
                        {log.relativePath}
                      </span>
                      <span class="shrink-0 text-caption tabular-nums text-dls-secondary">
                        {formatBugLogBytes(log.sizeBytes)}
                        {log.truncated ? " (tail)" : ""}
                      </span>
                      <button
                        type="button"
                        class="shrink-0 rounded-compact p-0.5 text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors disabled:opacity-50"
                        title="Remove from upload"
                        aria-label="Remove from upload"
                        disabled={props.submitting}
                        onClick={() => props.onRemoveLog(log.path)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
            <Show when={props.error}>
              <p class="mt-2 text-caption text-dls-danger-text">{props.error}</p>
            </Show>
            <div class="mt-4 flex items-center justify-end gap-3">
              <Show when={props.submitting && props.status}>
                <span class="mr-auto inline-flex items-center gap-1.5 text-caption text-dls-secondary">
                  <Loader2 size={13} class="animate-spin" />
                  {props.status}
                </span>
              </Show>
              <button
                type="button"
                class="rounded-inset px-3 py-1.5 text-body-lg text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors disabled:opacity-50"
                disabled={props.submitting}
                onClick={() => props.onClose()}
              >
                Cancel
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-inset bg-[var(--dls-accent)] px-3 py-1.5 text-body-lg text-white hover:bg-[var(--dls-accent-hover)] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                disabled={props.submitting || (props.logs?.length ?? 0) === 0}
                onClick={() => props.onSubmit()}
              >
                <Show when={props.submitting}>
                  <Loader2 size={14} class="animate-spin" />
                </Show>
                {props.submitting ? "Preparing…" : "Upload logs & open draft"}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
