/**
 * Host-path feedback modal.
 *
 * Default (web + shipping MSI): GitHub issue prefill, then mailto.
 * Debug Tauri (`__BUILD_DEBUG__`): POST to AWS feedback ingest, then GitHub / mailto.
 * Shipping AWS ingest is gated by `FEEDBACK_AWS_INGEST_SHIPPING_ENABLED` (future release).
 * Submit routing: `feedback-submit-routing.ts`. */
import { Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { X } from "lucide-solid";

import { t, currentLocale } from "../../i18n";
import { usePlatform } from "../context/platform";
import { isTauriRuntime } from "../utils";
import {
  FEEDBACK_MODAL_CATEGORIES,
  type FeedbackCategory,
} from "../lib/feedback-categories";
import { submitFeedbackIssueViaAdapter, submitFeedbackViaAdapter } from "../lib/feedback";
import { resolveFeedbackIngestOs } from "../lib/feedback-ingest-os";
import {
  feedbackIngestIdempotencyBodyKey,
  shouldSubmitFeedbackViaAwsIngest,
  submitFeedbackToIngestHost,
} from "../lib/feedback-ingest-host";
import { resolveFeedbackModalSubmitPath } from "../lib/feedback-submit-routing";
import { shouldUseLogAssistedBugReport } from "../lib/bug-report-github";
import { createBugReportFlow } from "../lib/bug-report-flow";
import { ensureFeedbackIssueRepoReady } from "../lib/feedback-issue-repo";
import { trackFeedbackSubmitted, normalizeReleaseChannel } from "../lib/telemetry";
import BugReportLogsDialog from "./bug-report-logs-dialog";
import Button from "./button";

export type FeedbackModalProps = {
  open: boolean;
  appVersion: string | null;
  onClose: () => void;
};

const CATEGORIES: FeedbackCategory[] = [...FEEDBACK_MODAL_CATEGORIES];
const MAX_MESSAGE_CHARS = 4000;

function createFeedbackIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type SubmitState =
  | "idle"
  | "submitting"
  | "success"
  | "fallback"
  | "error"
  | "quota_exceeded";
type FallbackMode = "mailto" | "github_issue";

export default function FeedbackModal(props: FeedbackModalProps) {
  const platform = usePlatform();
  const translate = (key: string) => t(key, currentLocale());
  const bugReportFlow = createBugReportFlow((url) => platform.openLink(url));

  const [message, setMessage] = createSignal("");
  const [category, setCategory] = createSignal<FeedbackCategory>("bug");
  const [attachDiagnostic, setAttachDiagnostic] = createSignal(true);
  const [state, setState] = createSignal<SubmitState>("idle");
  const [fallbackMode, setFallbackMode] = createSignal<FallbackMode>("mailto");
  const [idempotencyKey, setIdempotencyKey] = createSignal("");
  /** Body snapshot last sent (or attempted) on the AWS ingest path; drives key rotation on edit. */
  const [lastIngestBodyKey, setLastIngestBodyKey] = createSignal<string | null>(null);
  /** Stable diagnostic JSON for ingest retries (`generatedAt` must not change between attempts). */
  const [frozenIngestDiagnostic, setFrozenIngestDiagnostic] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.open && idempotencyKey() === "" && shouldSubmitFeedbackViaAwsIngest()) {
      setIdempotencyKey(createFeedbackIdempotencyKey());
    }
  });

  createEffect(() => {
    void message();
    void category();
    void attachDiagnostic();
    setFrozenIngestDiagnostic(null);
  });

  onMount(() => {
    if (!isTauriRuntime()) return;
    void ensureFeedbackIssueRepoReady({ refresh: true }).catch(() => undefined);
  });

  const isLogAssistedBugCategory = createMemo(
    () => category() === "bug" && shouldUseLogAssistedBugReport(),
  );

  const canSubmit = createMemo(() => {
    if (state() === "submitting") return false;
    if (isLogAssistedBugCategory()) return true;
    return message().trim().length > 0;
  });

  const showDiagnosticOption = createMemo(() => !isLogAssistedBugCategory());

  const runLogAssistedBugReport = (outcome: "error" | "success") => {
    const version = props.appVersion ?? "unknown";
    const logAssisted = shouldUseLogAssistedBugReport();
    bugReportFlow.startBugReport({
      sessionTitle: `Feedback ${version}`,
      summary: message().trim() || undefined,
      onPrepared: () => {
        if (logAssisted) props.onClose();
      },
      onComplete: (result) => {
        if (result.ok) {
          void trackFeedbackSubmitted({ feedbackMode: "github_issue", outcome });
          if (!logAssisted) {
            setFallbackMode("github_issue");
            setState("fallback");
          }
          return;
        }
        void fallbackToMailto(outcome === "success" ? "error" : outcome);
      },
    });
    if (logAssisted) {
      setState("idle");
    }
  };

  const resetAndClose = () => {
    bugReportFlow.cancelBugReport();
    setMessage("");
    setCategory("bug");
    setAttachDiagnostic(true);
    setState("idle");
    setFallbackMode("mailto");
    setIdempotencyKey("");
    setLastIngestBodyKey(null);
    setFrozenIngestDiagnostic(null);
    props.onClose();
  };

  const ingestOptionalDebugReport = (): string | null => {
    if (!attachDiagnostic()) {
      return null;
    }
    const frozen = frozenIngestDiagnostic();
    if (frozen !== null) {
      return frozen;
    }
    const snapshot = diagnosticSnapshot();
    setFrozenIngestDiagnostic(snapshot);
    return snapshot;
  };

  const resolveIngestIdempotencyKey = (bodyKey: string): string => {
    if (lastIngestBodyKey() !== null && lastIngestBodyKey() !== bodyKey) {
      const fresh = createFeedbackIdempotencyKey();
      setIdempotencyKey(fresh);
      return fresh;
    }
    let key = idempotencyKey();
    if (key === "") {
      key = createFeedbackIdempotencyKey();
      setIdempotencyKey(key);
    }
    return key;
  };

  const diagnosticSnapshot = () =>
    JSON.stringify(
      {
        appVersion: props.appVersion ?? "unknown",
        os: resolveFeedbackIngestOs(),
        channel: normalizeReleaseChannel(),
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    );

  /** Default GitHub issue prefill for the resolved feedback repo. */
  const openDefaultGithubIssue = async () => {
    const submissionCategory = category();
    const issueMessage = message().trim();
    const version = props.appVersion ?? "unknown";
    const extra = attachDiagnostic() ? diagnosticSnapshot() : undefined;
    return submitFeedbackIssueViaAdapter((url) => platform.openLink(url), {
      category: submissionCategory,
      message: issueMessage,
      appVersion: version,
      additionalContext: extra,
    });
  };

  const finishInternalGithubOpen = async () => {
    try {
      await ensureFeedbackIssueRepoReady({ refresh: true });
    } catch (err) {
      console.warn("[feedback] feedback_issue_repo_slug unavailable:", err);
      await fallbackToMailto("error");
      return;
    }
    const github = await openDefaultGithubIssue();
    if (github.ok) {
      void trackFeedbackSubmitted({ feedbackMode: "github_issue", outcome: "success" });
      setFallbackMode("github_issue");
      setState("fallback");
      return;
    }
    await fallbackToMailto("error");
  };

  const fallbackToMailto = async (outcome: "error" | "success") => {
    const body = [message().trim(), attachDiagnostic() ? `\n\n${diagnosticSnapshot()}` : ""].join("");
    const result = await submitFeedbackViaAdapter((url) => platform.openLink(url), {
      subject: `SuperClaw feedback (${category()})`,
      body,
    });
    void trackFeedbackSubmitted({ feedbackMode: "mailto", outcome: result.ok ? outcome : "error" });
    setFallbackMode("mailto");
    setState(result.ok ? "fallback" : "error");
  };

  /** GitHub issue prefill (web dev UI and shared fallback helpers). */
  const fallbackToGithubIssue = async (outcome: "error" | "success") => {
    if (isTauriRuntime()) {
      try {
        await ensureFeedbackIssueRepoReady({ refresh: true });
      } catch (err) {
        console.warn("[feedback] feedback_issue_repo_slug unavailable:", err);
        void fallbackToMailto(outcome === "success" ? "error" : outcome);
        return;
      }
    }

    const submissionCategory = category();
    const issueMessage = message().trim();
    const version = props.appVersion ?? "unknown";
    const extra = attachDiagnostic() ? diagnosticSnapshot() : undefined;

    if (submissionCategory === "bug" && shouldUseLogAssistedBugReport()) {
      runLogAssistedBugReport(outcome);
      return;
    }

    const result = await submitFeedbackIssueViaAdapter((url) => platform.openLink(url), {
      category: submissionCategory,
      message: issueMessage,
      appVersion: version,
      additionalContext: extra,
    });
    if (result.ok) {
      void trackFeedbackSubmitted({ feedbackMode: "github_issue", outcome });
      setFallbackMode("github_issue");
      setState("fallback");
      return;
    }
    await fallbackToMailto(outcome === "success" ? "error" : outcome);
  };

  const handleSubmit = async () => {
    const trimmed = message().trim();

    if (!isLogAssistedBugCategory() && !trimmed) return;

    const retryAfterQuota = state() === "quota_exceeded";
    const awsIngestEnabled = shouldSubmitFeedbackViaAwsIngest();
    const submitPath = resolveFeedbackModalSubmitPath({
      logAssistedBug: isLogAssistedBugCategory(),
      awsIngestEnabled,
      retryAfterQuota,
    });

    setState("submitting");

    try {
      if (submitPath === "log_assisted_bug") {
        runLogAssistedBugReport("success");
        return;
      }

      if (submitPath === "github_issue") {
        if (retryAfterQuota) {
          await finishInternalGithubOpen();
        } else {
          await fallbackToGithubIssue("success");
        }
        return;
      }

      // Ingest is independent of GitHub repo/DNS discovery; only run ensureFeedbackIssueRepoReady
      // inside finishInternalGithubOpen / fallbackToGithubIssue when opening a GitHub fallback.
      const ingestDebug = ingestOptionalDebugReport();
      const bodyKey = feedbackIngestIdempotencyBodyKey({
        message: trimmed,
        category: category(),
        appVersion: props.appVersion ?? "unknown",
        optionalDebugReport: ingestDebug,
      });
      const ingestKey = resolveIngestIdempotencyKey(bodyKey);
      setLastIngestBodyKey(bodyKey);
      const ingest = await submitFeedbackToIngestHost({
        message: trimmed,
        category: category(),
        appVersion: props.appVersion ?? "unknown",
        optionalDebugReport: ingestDebug,
        idempotencyKey: ingestKey,
      });
      if (ingest.status === "accepted") {
        void trackFeedbackSubmitted({ feedbackMode: "ingest", outcome: "success" });
        setState("success");
        return;
      }
      if (ingest.status === "quota_exceeded") {
        void trackFeedbackSubmitted({ feedbackMode: "ingest", outcome: "error" });
        setState("quota_exceeded");
        return;
      }

      void trackFeedbackSubmitted({ feedbackMode: "ingest", outcome: "error" });
      await finishInternalGithubOpen();
    } catch (error) {
      console.warn("[feedback] submit failed:", error);
      setState("error");
    }
  };

  return (
    <>
      <Show when={props.open}>
        <div class="fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center p-4">
        <div class="border w-full max-w-lg overflow-hidden dls-modal-surface">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-heading font-semibold text-dls-text">
                  {isLogAssistedBugCategory()
                    ? translate("feedback.report_bug_action")
                    : translate("feedback.modal_title")}
                </h3>
                <p class="text-body-lg text-dls-secondary mt-1">
                  {isLogAssistedBugCategory()
                    ? translate("feedback.log_assisted_bug_description")
                    : translate("feedback.modal_description")}
                </p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-pill" onClick={resetAndClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="mt-5">
              <div class="mb-1 text-caption font-medium text-dls-secondary">
                {translate("feedback.category_label")}
              </div>
              <div class="flex flex-wrap gap-2">
                {CATEGORIES.map((value) => (
                  <button
                    type="button"
                    class={`rounded-control border px-3 py-1.5 text-caption transition-colors ${
                      category() === value
                        ? "border-dls-accent bg-dls-accent/10 text-dls-text"
                        : "border-dls-border/60 bg-dls-panel-inset-bg text-dls-secondary hover:bg-dls-hover/60"
                    }`}
                    onClick={() => setCategory(value)}
                  >
                    {translate(`feedback.category_${value}`)}
                  </button>
                ))}
              </div>
            </div>

            <div class="mt-4">
              <Show when={isLogAssistedBugCategory()}>
                <p class="text-caption text-dls-secondary mb-2">
                  {translate("feedback.log_assisted_bug_next_step_hint")}
                </p>
              </Show>
              <label class="block">
                <div class="mb-1 text-caption font-medium text-dls-secondary">
                  {translate("feedback.message_label")}
                </div>
                <textarea
                  rows={isLogAssistedBugCategory() ? 3 : 5}
                  maxlength={MAX_MESSAGE_CHARS}
                  value={message()}
                  onInput={(event) => setMessage(event.currentTarget.value)}
                  placeholder={translate("feedback.message_placeholder")}
                  class="w-full rounded-control bg-dls-surface px-3 py-2 text-body-lg text-dls-text placeholder:text-dls-secondary border border-dls-border shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.3)] focus:border-[var(--dls-accent)] transition-all resize-none"
                />
              </label>
            </div>

            <Show when={showDiagnosticOption()}>
              <label class="mt-3 flex items-start gap-2 text-caption text-dls-secondary">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={attachDiagnostic()}
                  onChange={(event) => setAttachDiagnostic(event.currentTarget.checked)}
                />
                <span>
                  <span class="text-dls-text">{translate("feedback.attach_diagnostic_label")}</span>
                  <br />
                  {translate("feedback.attach_diagnostic_hint")}
                </span>
              </label>
              <Show when={attachDiagnostic()}>
                <pre class="mt-2 text-label text-dls-secondary whitespace-pre-wrap break-words max-h-24 overflow-auto bg-dls-surface-solid border border-dls-border rounded-control p-2">
                  {diagnosticSnapshot()}
                </pre>
              </Show>
            </Show>

            <Show when={state() !== "idle" && state() !== "submitting"}>
              <div
                class={`mt-3 text-caption ${
                  state() === "error" || state() === "quota_exceeded"
                    ? "text-dls-danger-text"
                    : "text-dls-success-text"
                }`}
              >
                {state() === "success" && translate("feedback.submit_success")}
                {state() === "fallback" &&
                  (fallbackMode() === "github_issue"
                    ? translate("feedback.submit_fallback_github")
                    : translate("feedback.submit_fallback"))}
                {state() === "quota_exceeded" && translate("feedback.submit_quota_exceeded")}
                {state() === "error" && translate("feedback.submit_error")}
              </div>
            </Show>

            <div class="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={resetAndClose}>
                {translate("common.cancel")}
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit()}>
                {state() === "submitting"
                  ? translate("feedback.submitting")
                  : isLogAssistedBugCategory()
                    ? translate("feedback.report_bug_action")
                    : translate("feedback.submit")}
              </Button>
            </div>
          </div>
        </div>
        </div>
      </Show>
      <BugReportLogsDialog
        logs={bugReportFlow.logs()}
        summary={bugReportFlow.summaryDraft()}
        onSummaryChange={(value) => bugReportFlow.setSummaryDraft(value)}
        summaryMaxLength={MAX_MESSAGE_CHARS}
        submitting={bugReportFlow.submitting()}
        picking={bugReportFlow.picking()}
        error={bugReportFlow.error()}
        status={bugReportFlow.status()}
        onClose={() => bugReportFlow.cancelBugReport()}
        onPickLogs={() => bugReportFlow.pickBugLogs()}
        onRemoveLog={(path) => bugReportFlow.removeBugLog(path)}
        onSubmit={() => bugReportFlow.submitBugReport()}
      />
    </>
  );
}
