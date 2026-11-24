import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { recordPerfLog } from "~/shared/platform/log/perf-log";
import type { MessageWithParts } from "../types";
import {
  RUN_ELAPSED_KEY_PREFIX,
  RUN_TICK_INTERVAL_MS,
  parseRunElapsedEntry,
} from "./session.view-tuning";

type Part = MessageWithParts["parts"][number];

type RunPhase = "idle" | "sending" | "retrying" | "thinking" | "responding" | "error";
type StallStage = "none" | "soft" | "hard";

/**
 * Reactive inputs arrive as thunks so the memos track in the caller's scope.
 * Everything here is read-only except the four action callbacks at the end; the
 * run's own state is owned by this controller rather than passed in.
 */
type RunLifecycleDeps = {
  messages: () => MessageWithParts[];
  sessionStatus: () => string;
  /**
   * Whether the selected session has a status entry at all. `sessionStatus`
   * reads a missing entry as "idle" (the status map is cleared on reconnect and
   * workspace switches), which must not count as the run having finished.
   * Treated as always known when omitted.
   */
  sessionStatusKnown?: () => boolean;
  error: () => unknown;
  totalPartCount: () => number;
  selectedSessionId: () => string | null;
  developerMode: () => boolean;
  debugObservabilityAvailable: () => boolean;
  renderedMessageCount: () => number;
  hiddenMessageCount: () => number;
  lastPromptSent: () => string;
  sessionReadOnly: () => boolean;
  notify: (message: string) => void;
  notifySessionReadOnly: () => void;
  abortSession: (sessionId: string) => Promise<void>;
  retryLastPrompt: () => void;
};

type RunLifecycleController = {
  /** Wall-clock start of the in-flight run, or null when idle. */
  runStartedAt: () => number | null;
  phase: () => RunPhase;
  label: () => string;
  showIndicator: () => boolean;
  isGenerating: () => boolean;
  responseStarted: () => boolean;
  thinkingStatus: () => string | null;
  elapsedLabel: () => string;
  /** Ticks while a run is in flight; subscribe to re-run on each interval. */
  tick: () => number;
  /** Per-assistant-message run durations, persisted per session. */
  elapsedByMessageId: () => Record<string, number>;
  /**
   * Install the stored durations for a session. `sessionID` is the session the
   * record describes, and is null when the caller could not determine it (a
   * failed read) — the controller then treats the map as untrusted rather than
   * attributing it to whichever session is open.
   */
  loadElapsedByMessageId: (
    sessionID: string | null,
    record: Record<string, number>,
  ) => void;
  start: () => void;
  clearPending: () => void;
  /**
   * Bind the in-flight run to the session the turn was dispatched to. Called
   * by the page from `sendPrompt`'s `onSessionResolved`, which is the only
   * source that knows the real target: a first prompt creates its session
   * mid-dispatch, and the user can select a different one while that is in
   * flight.
   */
  adoptSession: (sessionID: string) => void;
  markBegun: () => void;
  noteProgress: () => void;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
};

/** Maps a streaming part to the short status shown beside the run indicator. */
function statusFromPart(part: Part | null): string | null {
  if (!part) return null;
  if (part.type === "tool") {
    const tool =
      typeof (part as { tool?: unknown }).tool === "string"
        ? (part as { tool: string }).tool
        : "";
    switch (tool) {
      case "task":
        return "Delegating";
      case "todowrite":
      case "todoread":
        return "Planning";
      case "read":
        return "Gathering context";
      case "list":
      case "grep":
      case "glob":
        return "Searching codebase";
      case "webfetch":
        return "Searching the web";
      case "edit":
      case "write":
      case "apply_patch":
        return "Writing file";
      case "bash":
        return "Running shell";
      default:
        return "Working";
    }
  }
  if (part.type === "reasoning") return "Working";
  if (part.type === "text") return "Working";
  return null;
}

/**
 * Keep these thresholds user-friendly:
 * - "Still working" should appear quickly enough to reassure, but not so quickly
 *   it feels noisy.
 * - "Taking longer than usual" should appear late enough to avoid false alarms.
 */
export function stallThresholdsForPhase(phase: RunPhase): {
  softMs: number;
  hardMs: number;
} {
  if (phase === "sending" || phase === "retrying") {
    return { softMs: 8_000, hardMs: 20_000 };
  }
  if (phase === "thinking") return { softMs: 25_000, hardMs: 70_000 };
  if (phase === "responding") return { softMs: 25_000, hardMs: 90_000 };
  return { softMs: 0, hardMs: 0 };
}

function formatRunElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

const messageIdOf = (message: MessageWithParts | undefined): string | null => {
  const info = message?.info as { id?: string | number; role?: string } | undefined;
  if (typeof info?.id === "string") return info.id;
  if (typeof info?.id === "number") return String(info.id);
  return null;
};

const roleOf = (message: MessageWithParts | undefined): string | undefined =>
  (message?.info as { role?: string } | undefined)?.role;

export function createRunLifecycle(
  deps: RunLifecycleDeps,
): RunLifecycleController {
  const [runStartedAt, setRunStartedAt] = createSignal<number | null>(null);
  // The session the in-flight run was started for. Compared on completion
  // rather than trusting whichever session is selected by then.
  const [runSessionId, setRunSessionId] = createSignal<string | null>(null);
  const [runHasBegun, setRunHasBegun] = createSignal(false);
  const [runLastProgressAt, setRunLastProgressAt] = createSignal<number | null>(
    null,
  );
  const [runBaseline, setRunBaseline] = createSignal<{
    assistantId: string | null;
    partCount: number;
  }>({ assistantId: null, partCount: 0 });
  const [abortBusy, setAbortBusy] = createSignal(false);
  const [runTick, setRunTick] = createSignal(Date.now());
  const [elapsedByMessageId, setElapsedByMessageId] = createSignal<
    Record<string, number>
  >({});
  // Which session `elapsedByMessageId` describes, or null when that is not
  // known. Without it the signal is unusable as a base for a write: after an
  // A->B->A round trip it may still hold B's entries (Finding 2).
  const [elapsedMapSessionId, setElapsedMapSessionId] = createSignal<
    string | null
  >(null);

  const lastAssistantSnapshot = createMemo(() => {
    const messages = deps.messages();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (roleOf(msg) === "assistant") {
        return { id: messageIdOf(msg), partCount: msg.parts.length };
      }
    }
    return { id: null, partCount: 0 };
  });

  const captureBaseline = () => {
    const snapshot = lastAssistantSnapshot();
    setRunBaseline({ assistantId: snapshot.id, partCount: snapshot.partCount });
  };

  // Runs still in flight in a session that is not selected. The run signals
  // above describe one run for the open session, so leaving a running session
  // clears them; without this, coming back restarts the clock at 0ms (#3554).
  const parkedRuns = new Map<
    string,
    { startedAt: number; baseline: { assistantId: string | null; partCount: number } }
  >();

  // Declared before clearPending so clearPending can reset it without a
  // forward reference (it is also mutated inside the stall effect below).
  let lastStallPerfStage: StallStage = "none";

  const clearPending = () => {
    // Keyed by the run's owner: when this clears a pre-ack run after a switch,
    // the selected session is the one being returned to, whose parked run must survive.
    const owner = runSessionId();
    if (owner) parkedRuns.delete(owner);
    // Reset before the signals clear: the stall effect runs after runStartedAt
    // is nulled and sees stallStage()="none". If lastStallPerfStage still reads
    // "soft" or "hard" at that point the effect emits a spurious stall-recovered
    // attributed to the newly selected session (Finding 4).
    lastStallPerfStage = "none";
    batch(() => {
      setRunStartedAt(null);
      setRunSessionId(null);
      setRunHasBegun(false);
      setRunLastProgressAt(null);
      setRunBaseline({ assistantId: null, partCount: 0 });
    });
  };

  const start = () => {
    if (runStartedAt()) return;
    const now = Date.now();
    const sessionId = deps.selectedSessionId();
    const parked = sessionId ? parkedRuns.get(sessionId) : undefined;
    if (sessionId) parkedRuns.delete(sessionId);
    // A parked run only continues while the session still reports activity; a
    // new prompt after it finished must start from a clean clock.
    const status = deps.sessionStatus();
    const resumed =
      parked && (status === "running" || status === "retry") ? parked : undefined;
    // batch() prevents cascading effects between individual signal updates.
    // Without it, setRunStartedAt(now) fires effects immediately (no
    // auto-batching in event handlers), causing the run-complete effect to
    // see stale baseline/runHasBegun values and overwrite the previous
    // query's elapsed time with ~0 ms.
    batch(() => {
      // The parked baseline keeps the run's own assistant message "new", so its
      // duration is still recorded on completion.
      if (resumed) setRunBaseline(resumed.baseline);
      else captureBaseline();
      setRunStartedAt(resumed?.startedAt ?? now);
      setRunSessionId(deps.selectedSessionId());
      setRunLastProgressAt(now);
      setRunHasBegun(false);
    });
  };

  // A parked run only outlives the session being away while it is still going.
  // Once the session is seen idle, a later running status is a new dispatch
  // (retry, edit-and-resend) that never went through start(), so it must not
  // inherit the old clock.
  createEffect(() => {
    const id = deps.selectedSessionId();
    if (!id) return;
    if (deps.sessionStatus() !== "idle") return;
    if (deps.sessionStatusKnown && !deps.sessionStatusKnown()) return;
    parkedRuns.delete(id);
  });

  // Explicitly clear a stale run when the selected session changes away from
  // the run owner, in cases the completion effect cannot handle on its own.
  createEffect(() => {
    const owner = runSessionId();
    if (owner === null || owner === deps.selectedSessionId()) return;

    if (!runHasBegun()) {
      // Pre-ack (Finding 1): the completion effect guards on runHasBegun(), so
      // it never fires in this window. The stale run would block start() on the
      // new session indefinitely.
      clearPending();
      return;
    }

    // Known gap (#3227): if the newly selected session is also running, neither
    // the completion effect (needs "idle") nor this guard fires. The controller
    // stays bound to A and renders A's elapsed timer on B's view. When B
    // eventually becomes idle its completion is discarded as unowned. Clearing
    // here would lose A's timing on the A→B→A round-trip — not better. Full
    // per-session state tracking is the correct fix; deferred.
  });

  const responseStarted = createMemo(() => {
    if (!runStartedAt()) return false;
    const baseline = runBaseline();
    const snapshot = lastAssistantSnapshot();
    if (!snapshot.id && !baseline.assistantId) return false;
    if (snapshot.id && snapshot.id !== baseline.assistantId) return true;
    return (
      snapshot.id === baseline.assistantId &&
      snapshot.partCount > baseline.partCount
    );
  });

  const phase = createMemo<RunPhase>(() => {
    if (deps.error() && (runStartedAt() !== null || runHasBegun())) return "error";
    const status = deps.sessionStatus();
    const started = runStartedAt() !== null;
    if (status === "idle") {
      if (!started) return "idle";
      return responseStarted() ? "responding" : "sending";
    }
    if (status === "retry") return responseStarted() ? "responding" : "retrying";
    if (responseStarted()) return "responding";
    return "thinking";
  });

  const showIndicator = createMemo(() => phase() !== "idle");
  const isGenerating = createMemo(() => {
    const current = phase();
    return current !== "idle" && current !== "error";
  });

  const latestPart = createMemo<Part | null>(() => {
    if (!showIndicator()) return null;
    const baseline = runBaseline();
    const messages = deps.messages();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (roleOf(msg) !== "assistant") continue;
      const messageId = messageIdOf(msg);
      if (!messageId) continue;
      if (baseline.assistantId && messageId === baseline.assistantId) {
        if (msg.parts.length <= baseline.partCount) return null;
        return msg.parts[msg.parts.length - 1] ?? null;
      }
      if (!msg.parts.length) continue;
      return msg.parts[msg.parts.length - 1] ?? null;
    }
    return null;
  });

  const thinkingStatus = createMemo(() => {
    const status = statusFromPart(latestPart());
    if (status) return status;
    if (phase() === "thinking") return "Working";
    return null;
  });

  const label = createMemo(() => {
    switch (phase()) {
      case "sending":
        return "Sending";
      case "retrying":
        return "Retrying";
      case "responding":
        return "Responding";
      case "thinking":
        return "Working";
      case "error":
        return "Run failed";
      default:
        return "";
    }
  });

  const elapsedMs = createMemo(() => {
    const started = runStartedAt();
    if (!started) return 0;
    return Math.max(0, runTick() - started);
  });

  const elapsedLabel = createMemo(() => formatRunElapsed(elapsedMs()));

  const stallMs = createMemo(() => {
    if (!showIndicator()) return 0;
    if (phase() === "error") return 0;
    const last = runLastProgressAt() ?? runStartedAt() ?? Date.now();
    return Math.max(0, runTick() - last);
  });

  const stallStage = createMemo<StallStage>(() => {
    if (!showIndicator()) return "none";
    if (phase() === "error") return "none";
    const ms = stallMs();
    const { softMs, hardMs } = stallThresholdsForPhase(phase());
    if (!softMs || !hardMs) return "none";
    if (ms >= hardMs) return "hard";
    if (ms >= softMs) return "soft";
    return "none";
  });

  // Records the run's duration against the assistant message it produced, then
  // resets the run state so the next prompt starts from a clean baseline.
  createEffect(() => {
    if (!runStartedAt()) return;
    if (deps.sessionStatus() === "idle" && runHasBegun()) {
      const startedAt = runStartedAt();
      if (startedAt === null) return;
      const elapsed = Date.now() - startedAt;
      const assistantId = lastAssistantSnapshot().id;
      const baseline = runBaseline();
      const sessionId = deps.selectedSessionId();
      const ownerSessionId = runSessionId();
      // Compute ownership BEFORE telemetry so we never emit "complete" for a
      // session the controller does not own (Finding 3).
      const ownsResult = ownerSessionId !== null && ownerSessionId === sessionId;
      // A run whose session is no longer selected cannot be attributed: both
      // lastAssistantSnapshot() and elapsedByMessageId() describe the session
      // open now, so recording would stamp this run's duration onto another
      // session's message and persist that session's map under its own key.
      // Discard the sample rather than guess (#3070).
      //
      // This effect is registered when the page creates the controller, which
      // is before the session-change effect that reloads the map, so on a
      // switch it runs while the map still belongs to the previous session.
      // Without this guard the write also destroys the new session's history.
      if (ownsResult) {
        recordPerfLog(deps.debugObservabilityAvailable(), "session.run", "complete", {
          sessionID: sessionId,
          runSessionID: ownerSessionId,
          assistantMessageId: assistantId,
          elapsedMs: elapsed,
          messageCount: deps.messages().length,
          partCount: deps.totalPartCount(),
        });
      }
      // Only record elapsed for a NEW assistant message produced by this run.
      // If assistantId still equals the baseline (pre-run) id, no new message
      // appeared yet — skip to avoid overwriting a previous query's time.
      if (ownsResult && assistantId && assistantId !== baseline.assistantId) {
        // The in-memory signal is only a safe base when it is known to describe
        // this session: after an A→B→A round trip it can still hold B's entries,
        // and spreading those would corrupt A's history (Finding 2). When it
        // does describe this session it is authoritative, because every write
        // below updates it and the stored copy together, so it is a superset of
        // what is persisted whenever a `setItem` has failed.
        //
        // Otherwise fall back to the stored copy. parseRunElapsedEntry handles
        // both the current { d, t } envelope and the legacy plain Record format,
        // so history survives the first write after an upgrade (Finding B). A
        // read that fails or finds nothing leaves the base empty, which is all
        // that can be claimed in that case.
        let baseMap: Record<string, number> = {};
        if (sessionId && elapsedMapSessionId() === sessionId) {
          baseMap = elapsedByMessageId();
        } else if (sessionId) {
          try {
            const raw = window.localStorage.getItem(`${RUN_ELAPSED_KEY_PREFIX}${sessionId}`);
            if (raw) baseMap = parseRunElapsedEntry(raw).data;
          } catch {
            /* ignore */
          }
        }
        const next = { ...baseMap, [assistantId]: elapsed };
        batch(() => {
          // The map now provably describes this session, whether or not the
          // persist below succeeds.
          setElapsedMapSessionId(sessionId);
          setElapsedByMessageId(next);
        });
        if (sessionId) {
          try {
            window.localStorage.setItem(
              `${RUN_ELAPSED_KEY_PREFIX}${sessionId}`,
              JSON.stringify({ d: next, t: Date.now() }),
            );
          } catch {
            /* ignore */
          }
        }
      }
      // The run is not over, only out of view: its own session is not the one
      // reporting idle. Park it so returning to that session resumes the clock.
      if (!ownsResult && ownerSessionId !== null) {
        parkedRuns.set(ownerSessionId, { startedAt, baseline });
      } else if (ownerSessionId !== null) {
        parkedRuns.delete(ownerSessionId);
      }
      // Reset lastStallPerfStage before runStartedAt clears so the stall
      // effect does not emit a spurious stall-recovered attributed to the
      // newly selected session when an owned or discarded run ends (Finding 4).
      lastStallPerfStage = "none";
      // Deliberately not batched, matching the original ordering: downstream
      // effects observe runStartedAt clearing before runHasBegun.
      setRunStartedAt(null);
      setRunSessionId(null);
      setRunHasBegun(false);
      setRunLastProgressAt(null);
      setRunBaseline({ assistantId: null, partCount: 0 });
    }
  });

  createEffect(() => {
    if (!isGenerating()) return;
    setRunTick(Date.now());
    const id = window.setInterval(() => setRunTick(Date.now()), RUN_TICK_INTERVAL_MS);
    onCleanup(() => window.clearInterval(id));
  });

  createEffect(() => {
    if (!deps.developerMode()) {
      lastStallPerfStage = "none";
      return;
    }

    // Only emit stall telemetry for the session that owns the current run.
    // When the user switches sessions, the phase change (running→idle on the new
    // session) alters stallStage before the completion effect clears the run.
    // Without this guard, the stall effect fires first and emits spurious events
    // (e.g. stall-hard or stall-recovered) attributed to the new session's ID.
    //
    // The comparison is a plain inequality so an unowned run is covered too: a
    // draft's owner stays null until the dispatch resolves, and selecting a
    // session inside that window would otherwise let a stalling draft emit
    // under an id that never owned it (the events below stamp the *selected*
    // session). null === null — a draft with nothing selected — still emits.
    if (runSessionId() !== deps.selectedSessionId()) {
      lastStallPerfStage = "none";
      return;
    }

    const stage = stallStage();
    if (stage === lastStallPerfStage) return;

    const previous = lastStallPerfStage;
    lastStallPerfStage = stage;

    if (stage === "none") {
      if (previous !== "none") {
        recordPerfLog(true, "session.run", "stall-recovered", {
          sessionID: deps.selectedSessionId(),
          phase: phase(),
          elapsedMs: elapsedMs(),
          messageCount: deps.messages().length,
          partCount: deps.totalPartCount(),
        });
      }
      return;
    }

    recordPerfLog(true, "session.run", stage === "soft" ? "stall-soft" : "stall-hard", {
      sessionID: deps.selectedSessionId(),
      phase: phase(),
      stallMs: stallMs(),
      elapsedMs: elapsedMs(),
      messageCount: deps.messages().length,
      renderedMessageCount: deps.renderedMessageCount(),
      hiddenMessageCount: deps.hiddenMessageCount(),
      partCount: deps.totalPartCount(),
    });
  });

  const cancel = async () => {
    if (abortBusy()) return;
    const sessionId = deps.selectedSessionId();
    if (!sessionId) {
      deps.notify("No session selected");
      return;
    }

    setAbortBusy(true);
    deps.notify("Stopping the run...");
    try {
      await deps.abortSession(sessionId);
      deps.notify("Stopped.");
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : "Failed to stop");
    } finally {
      clearPending();
      setAbortBusy(false);
    }
  };

  const retry = async () => {
    // Read-only sessions (confirmed subtasks, or any session whose metadata is
    // still loading) must not mutate history. Backstop for stale UI / shortcuts.
    if (deps.sessionReadOnly()) {
      deps.notifySessionReadOnly();
      return;
    }
    if (!deps.lastPromptSent().trim()) {
      deps.notify("Nothing to retry yet");
      return;
    }

    if (abortBusy()) return;
    setAbortBusy(true);
    deps.notify("Trying again...");
    try {
      const sessionId = deps.selectedSessionId();
      if (isGenerating() && sessionId) await deps.abortSession(sessionId);
    } catch {
      // If abort fails, still allow the retry. Users care more about forward motion.
    } finally {
      setAbortBusy(false);
    }

    deps.retryLastPrompt();
  };

  return {
    runStartedAt,
    phase,
    label,
    showIndicator,
    isGenerating,
    responseStarted,
    thinkingStatus,
    elapsedLabel,
    tick: runTick,
    elapsedByMessageId,
    loadElapsedByMessageId: (
      sessionID: string | null,
      record: Record<string, number>,
    ) => {
      batch(() => {
        setElapsedMapSessionId(sessionID);
        setElapsedByMessageId(record);
      });
    },
    start,
    clearPending,
    adoptSession: (sessionID: string) => {
      // Only while unset. The dispatch reports once per turn, but a retry of
      // an in-flight run would otherwise re-bind a run that is already owned.
      if (runStartedAt() !== null && runSessionId() === null) {
        setRunSessionId(sessionID);
      }
    },
    markBegun: () => setRunHasBegun(true),
    noteProgress: () => setRunLastProgressAt(Date.now()),
    cancel,
    retry,
  };
}
