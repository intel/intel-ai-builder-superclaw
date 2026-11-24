import { createEffect, on, type Accessor } from "solid-js";

/** Cadence of the re-polls that follow a start-up poll's first sight of a new state. */
export const FAST_POLL_MS = 100;

/**
 * Fast re-polls after a new state. Together they cover 1.5 s, which outlasts the gap between the
 * sandbox turning running and its token being issued: one Sandbox Manager health iteration plus
 * the issue itself.
 */
export const FAST_POLL_COUNT = 15;

/** Testable seam for timing: schedules `callback` after `delayMs` and returns its cancel. */
export type PollScheduler = (callback: () => void, delayMs: number) => () => void;

const scheduleWithTimer: PollScheduler = (callback, delayMs) => {
  const id = setTimeout(callback, delayMs);
  return () => clearTimeout(id);
};

export type StartupPoll = {
  /**
   * Run `poll` after the next delay. `state` names what the latest poll saw; `null` samples at
   * the steady cadence, ends any fast re-polls and is never news.
   */
  schedule(state: string | null, poll: () => void): void;
  /** Run the scheduled poll now, and re-poll fast after it. */
  expedite(): void;
  cancel(): void;
};

/**
 * Timer for a start-up readiness poll: `steadyMs` apart, except right after news.
 *
 * Start-up states follow each other closely (the sandbox turns running, then its token is
 * issued), so the first sight of a state is followed by FAST_POLL_COUNT re-polls FAST_POLL_MS
 * apart. Neither the wait's first state nor a state seen before is news, so until something new
 * happens the poll sends exactly the requests a fixed cadence sent. The token poll depends on
 * that: each of its requests makes Sandbox Manager open the Supervisor's evidence file, which the
 * Supervisor replaces by rename while it starts, and on Windows a rename over an open file fails.
 */
export function createStartupPoll(steadyMs: number, scheduler: PollScheduler = scheduleWithTimer): StartupPoll {
  const seen = new Set<string>();
  let fastLeft = 0;
  let scheduled: (() => void) | null = null;
  let cancelScheduled: (() => void) | null = null;

  const cancel = () => {
    cancelScheduled?.();
    cancelScheduled = null;
    scheduled = null;
  };

  return {
    schedule(state, poll) {
      cancel();
      if (state === null) {
        fastLeft = 0;
      } else {
        if (seen.size > 0 && !seen.has(state)) fastLeft = FAST_POLL_COUNT;
        seen.add(state);
      }
      const delayMs = fastLeft > 0 ? FAST_POLL_MS : steadyMs;
      fastLeft = Math.max(0, fastLeft - 1);
      scheduled = poll;
      cancelScheduled = scheduler(() => {
        scheduled = null;
        cancelScheduled = null;
        poll();
      }, delayMs);
    },
    expedite() {
      const poll = scheduled;
      if (!poll) return;
      cancel();
      fastLeft = FAST_POLL_COUNT;
      poll();
    },
    cancel,
  };
}

/**
 * Expedite `poll` each time `ready` turns true, and on nothing else. The expedited poll runs
 * inside the effect, so any signal it reads synchronously must not become a trigger.
 */
export function expediteWhen(ready: Accessor<boolean>, poll: StartupPoll): void {
  createEffect(
    on(ready, (isReady) => {
      if (isReady) poll.expedite();
    }),
  );
}
