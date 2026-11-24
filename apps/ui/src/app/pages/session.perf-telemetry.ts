import { createEffect, onCleanup } from "solid-js";
import { perfNow, recordPerfLog } from "~/shared/platform/log/perf-log";
import {
  MAIN_THREAD_LAG_INTERVAL_MS,
  MAIN_THREAD_LAG_WARN_MS,
} from "./session.view-tuning";

/**
 * Every reading is a thunk so the effects below track the session page's own
 * signals. Nothing here is observable in a release build: both effects return
 * immediately unless developer mode is on.
 */
type PerfTelemetryDeps = {
  developerMode: () => boolean;
  selectedSessionId: () => string | null;
  sessionStatus: () => string;
  messageCount: () => number;
  partCount: () => number;
  /** Rows actually committed to the DOM, after render batching. */
  batchedRenderedCount: () => number;
  renderedMessageCount: () => number;
  hiddenMessageCount: () => number;
  messageWindowExpanded: () => boolean;
  searchActive: () => boolean;
};

/**
 * Developer-mode performance probes for the session page: main-thread lag and
 * message-window state transitions. Call once from the component body.
 */
export function createPerfTelemetry(deps: PerfTelemetryDeps): void {
  createEffect(() => {
    if (!deps.developerMode()) return;
    if (typeof window === "undefined") return;

    let expectedAt = perfNow() + MAIN_THREAD_LAG_INTERVAL_MS;
    const interval = window.setInterval(() => {
      const now = perfNow();
      const lagMs = Math.round((now - expectedAt) * 100) / 100;
      expectedAt = now + MAIN_THREAD_LAG_INTERVAL_MS;
      if (lagMs < MAIN_THREAD_LAG_WARN_MS) return;

      recordPerfLog(true, "session.main-thread", "lag", {
        lagMs,
        sessionID: deps.selectedSessionId(),
        status: deps.sessionStatus(),
        messageCount: deps.messageCount(),
        partCount: deps.partCount(),
        renderedMessageCount: deps.batchedRenderedCount(),
      });
    }, MAIN_THREAD_LAG_INTERVAL_MS);

    onCleanup(() => {
      window.clearInterval(interval);
    });
  });

  // Logged only on change, so a streaming run does not emit one entry per token.
  let lastWindowSignature = "";
  createEffect(() => {
    if (!deps.developerMode()) {
      lastWindowSignature = "";
      return;
    }

    const sessionID = deps.selectedSessionId();
    const messageCount = deps.messageCount();
    const partCount = deps.partCount();
    const renderedMessageCount = deps.renderedMessageCount();
    const hiddenMessageCount = deps.hiddenMessageCount();
    const expanded = deps.messageWindowExpanded();
    const searchActive = deps.searchActive();

    const signature = [
      sessionID ?? "",
      messageCount,
      partCount,
      renderedMessageCount,
      hiddenMessageCount,
      expanded ? "1" : "0",
      searchActive ? "1" : "0",
    ].join("|");

    if (signature === lastWindowSignature) return;
    lastWindowSignature = signature;

    recordPerfLog(true, "session.window", "state", {
      sessionID,
      messageCount,
      renderedMessageCount,
      hiddenMessageCount,
      partCount,
      expanded,
      searchActive,
    });
  });
}
