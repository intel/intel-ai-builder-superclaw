import { createSignal, type Accessor } from "solid-js";

import {
  gistFileName,
  shouldUseLogAssistedBugReport,
  submitBugReportPrefillViaAdapter,
  type BugLogEntry,
} from "./bug-report-github";
import type { FeedbackOpenLink } from "./feedback";
import { ensureFeedbackIssueRepoReady } from "./feedback-issue-repo";
import {
  collectRecentLogs,
  createBugGist,
  ghAvailable,
  pickFile,
  readLogFile,
  superclawLogRoot,
} from "./tauri";

export type BugReportFlowResult = {
  ok: boolean;
  reason?: "open_failed" | "submit_failed";
  /** When true, caller may show per-message “opened” affordance (immediate / degraded paths). */
  showInlineFeedback?: boolean;
};

export type BugReportStartParams = {
  /** bug.yml title segment (session name or dashboard context). */
  sessionTitle: string;
  /** bug.yml `summary` when provided (e.g. feedback modal message). */
  summary?: string;
  /** Appended to `additional_context` (e.g. diagnostic JSON). */
  extraContext?: string;
  /** Test override only; production always re-probes via {@link ensureFeedbackIssueRepoReady}. */
  issueRepo?: string;
  /** Repo resolved; the caller can close a parent dialog before the log picker opens. */
  onPrepared?: () => void;
  onComplete?: (result: BugReportFlowResult) => void;
};

export type BugReportFlow = {
  logs: Accessor<BugLogEntry[] | null>;
  summaryDraft: Accessor<string>;
  submitting: Accessor<boolean>;
  picking: Accessor<boolean>;
  error: Accessor<string | null>;
  status: Accessor<string | null>;
  startBugReport: (params: BugReportStartParams) => void;
  setSummaryDraft: (value: string) => void;
  pickBugLogs: () => void;
  removeBugLog: (path: string) => void;
  submitBugReport: () => void;
  cancelBugReport: () => void;
};

export function createBugReportFlow(openLink: FeedbackOpenLink): BugReportFlow {
  const [pendingReport, setPendingReport] = createSignal<BugReportStartParams | null>(null);
  const [summaryDraft, setSummaryDraft] = createSignal("");
  const [logs, setLogs] = createSignal<BugLogEntry[] | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [picking, setPicking] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);
  let reportGeneration = 0;

  const isCurrent = (generation: number) => generation === reportGeneration;

  const openPrefill = (
    params: BugReportStartParams,
    generation: number,
    options?: { gistUrl?: string | null; showInlineFeedback?: boolean },
  ) => {
    void submitBugReportPrefillViaAdapter(openLink, {
      sessionTitle: params.sessionTitle,
      summary: params.summary,
      gistUrl: options?.gistUrl,
      extraContext: params.extraContext,
      issueRepo: params.issueRepo,
    })
      .then((result) => {
        if (!isCurrent(generation)) return;
        params.onComplete?.({
          ok: result.ok,
          reason: result.ok ? undefined : "open_failed",
          showInlineFeedback: options?.showInlineFeedback,
        });
      })
      .catch((err) => {
        if (!isCurrent(generation)) return;
        console.error("[bugReport] submitBugReportPrefillViaAdapter failed", err);
        params.onComplete?.({ ok: false, reason: "submit_failed" });
      });
  };

  const startBugReport = (params: BugReportStartParams) => {
    const generation = ++reportGeneration;
    setSubmitting(false);
    setPicking(false);
    void (async () => {
      const explicitRepo = params.issueRepo?.trim();
      let issueRepo: string;
      try {
        if (explicitRepo) {
          issueRepo = explicitRepo;
        } else {
          // Same corp-DNS routing as Send feedback — refresh so an early public cache cannot stick.
          issueRepo = await ensureFeedbackIssueRepoReady({ refresh: true });
        }
      } catch (err) {
        if (!isCurrent(generation)) return;
        console.error("[bugReport] feedback_issue_repo_slug unavailable", err);
        params.onComplete?.({
          ok: false,
          reason: "submit_failed",
          showInlineFeedback: true,
        });
        return;
      }

      if (!isCurrent(generation)) return;
      const paramsWithRepo = { ...params, issueRepo };
      params.onPrepared?.();

      setPendingReport(paramsWithRepo);
      setSummaryDraft(params.summary?.trim() ?? "");
      setError(null);

      if (!shouldUseLogAssistedBugReport()) {
        openPrefill(paramsWithRepo, generation, { showInlineFeedback: true });
        setPendingReport(null);
        return;
      }

      try {
        const collected = await collectRecentLogs();
        if (!isCurrent(generation)) return;
        setLogs(collected.map((log) => ({ ...log, origin: "auto" as const })));
      } catch (err) {
        if (!isCurrent(generation)) return;
        console.error("[bugReport] collect_recent_logs failed", err);
        openPrefill(paramsWithRepo, generation, { showInlineFeedback: true });
        setPendingReport(null);
      }
    })();
  };

  const cancelBugReport = () => {
    if (submitting()) return;
    reportGeneration += 1;
    setPicking(false);
    setLogs(null);
    setPendingReport(null);
    setSummaryDraft("");
    setError(null);
    setStatus(null);
  };

  const pickBugLogs = () => {
    const generation = reportGeneration;
    void (async () => {
      if (!isCurrent(generation)) return;
      setError(null);
      setPicking(true);
      try {
        const defaultPath = (await superclawLogRoot()) ?? undefined;
        if (!isCurrent(generation)) return;
        const picked = await pickFile({
          title: "Select log files to attach",
          defaultPath,
          multiple: true,
          filters: [{ name: "Log files", extensions: ["log", "txt"] }],
        });
        if (!isCurrent(generation) || picked === null) return;
        const paths = Array.isArray(picked) ? picked : [picked];
        const existingPaths = new Set((logs() ?? []).map((l) => l.path));
        const duplicates: string[] = [];
        const failed: string[] = [];
        const added: BugLogEntry[] = [];
        for (const path of paths) {
          if (existingPaths.has(path)) {
            duplicates.push(path);
            continue;
          }
          try {
            const log = await readLogFile(path);
            added.push({ ...log, origin: "added" });
            existingPaths.add(path);
          } catch (err) {
            failed.push(
              `${path.split(/[\\/]/).pop()} (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
        if (!isCurrent(generation)) return;
        if (added.length > 0) {
          setLogs((current) => [...added, ...(current ?? [])]);
        }
        const notes: string[] = [];
        if (duplicates.length > 0) {
          const names = duplicates.map((p) => p.split(/[\\/]/).pop()).join(", ");
          notes.push(`Already in the list (not added again): ${names}`);
        }
        if (failed.length > 0) {
          notes.push(`Skipped (empty or unreadable): ${failed.join("; ")}`);
        }
        setError(notes.length > 0 ? notes.join(" · ") : null);
      } catch (err) {
        if (!isCurrent(generation)) return;
        console.error("[bugReport] pickBugLogs failed", err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isCurrent(generation)) setPicking(false);
      }
    })();
  };

  const removeBugLog = (path: string) => {
    setLogs((current) => (current ?? []).filter((log) => log.path !== path));
  };

  const submitBugReport = () => {
    const currentLogs = logs();
    const params = pendingReport();
    if (currentLogs === null || params === null) return;
    const generation = reportGeneration;

    void (async () => {
      if (!isCurrent(generation)) return;
      setSubmitting(true);
      setError(null);
      setStatus("Checking GitHub CLI…");
      try {
        let gistUrl: string | null = null;
        if (currentLogs.length > 0 && (await ghAvailable())) {
          if (!isCurrent(generation)) return;
          setStatus(
            `Uploading ${currentLogs.length} log file${currentLogs.length === 1 ? "" : "s"}…`,
          );
          gistUrl = await createBugGist(
            currentLogs.map((log) => ({
              name: gistFileName(log.relativePath),
              content: log.content,
            })),
          );
        }

        if (!isCurrent(generation)) return;
        setStatus("Opening draft issue…");
        openPrefill(
          { ...params, summary: summaryDraft().trim() || undefined },
          generation,
          { gistUrl, showInlineFeedback: false },
        );
        setLogs(null);
        setPendingReport(null);
      } catch (err) {
        if (!isCurrent(generation)) return;
        console.error("[bugReport] submit failed", err);
        setError(err instanceof Error ? err.message : String(err));
        params.onComplete?.({ ok: false, reason: "submit_failed" });
      } finally {
        if (isCurrent(generation)) {
          setSubmitting(false);
          setStatus(null);
        }
      }
    })();
  };

  return {
    logs,
    summaryDraft,
    submitting,
    picking,
    error,
    status,
    startBugReport,
    setSummaryDraft,
    pickBugLogs,
    removeBugLog,
    submitBugReport,
    cancelBugReport,
  };
}
