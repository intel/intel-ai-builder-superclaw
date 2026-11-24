import { Show, createSignal } from "solid-js";

import { t } from "../../../i18n";
import type { BugReportFlowResult } from "../../lib/bug-report-flow";
import { trackFeedbackSubmitted } from "../../lib/telemetry";

type BugReportFeedbackStatus = "idle" | "success" | "error";

export function createBugReportMessageFeedback() {
  const [messageId, setMessageId] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<BugReportFeedbackStatus>("idle");
  let timer: number | null = null;

  const clearLater = (delayMs: number) => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      setStatus("idle");
      setMessageId(null);
      timer = null;
    }, delayMs);
  };

  const show = (id: string, next: BugReportFeedbackStatus, delayMs: number) => {
    setMessageId(id);
    setStatus(next);
    clearLater(delayMs);
  };

  const record = (id: string, result: BugReportFlowResult) => {
    void trackFeedbackSubmitted({
      feedbackMode: "github_issue",
      outcome: result.ok ? "success" : "error",
    });
    if (result.showInlineFeedback) {
      show(id, result.ok ? "success" : "error", 2400);
    }
  };

  return { messageId, status, record };
}

export function BugReportFeedbackNote(props: {
  messageId: string;
  activeId: string | null;
  status: BugReportFeedbackStatus;
}) {
  return (
    <Show when={props.activeId === props.messageId && props.status !== "idle"}>
      <span
        class={`text-label ${props.status === "success" ? "text-dls-success-text" : "text-dls-danger-text"}`}
      >
        {props.status === "success" ? t("feedback.opened") : t("feedback.open_failed")}
      </span>
    </Show>
  );
}
