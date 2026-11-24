// How a run's progress is shown to the user: Slack's native thread shimmer, the
// editable placeholder message adapters without native status fall back to, the
// typing indicator loop, and the reporter's thinking/done lines.
//
// Extracted from `startBridge`. The ordering guarantees in here are load-bearing
// and were the subject of real bugs, so they are documented at each site rather
// than in a summary.

import { setTimeout as delay } from "node:timers/promises";

import type { Logger } from "pino";

import type { ChannelName } from "./config.js";
import type { MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import type { RunState } from "./run-state.js";
import { parseSlackPeerId } from "./slack.js";

/** The slice of a channel adapter status presentation touches. */
export type StatusAdapter = {
  updateMessage?: (
    peerId: string,
    ts: string,
    message: { text?: string; blocks?: object[] },
  ) => Promise<{ ts: string }>;
  sendTyping?: (peerId: string) => Promise<void>;
  setStatus?: (peerId: string, threadTs: string, status: string) => Promise<{ ok: boolean; error?: string }>;
  clearStatus?: (peerId: string, threadTs: string) => Promise<{ ok: boolean; error?: string }>;
};

export type RunStatusDeps = {
  adapters: Map<string, StatusAdapter>;
  logger: Logger;
  deliverParts: (
    channel: ChannelName,
    identityId: string,
    peerId: string,
    parts: OutboundMessagePart[],
    options?: { kind?: "reply" | "system" | "tool"; display?: boolean },
  ) => Promise<MessageDeliveryResult>;
  /** Placeholder status messages per peerId, shared with the inbound handler. */
  activeStatusMessages: Map<string, { ts: string; channelId: string; finalized: boolean }>;
  lastStatusUpdateMs: Map<string, number>;
  typingLoops: Map<string, NodeJS.Timeout>;
  modelLabelForRun: (run: RunState) => string | null;
  formatPeer: (channel: ChannelName, peerId: string) => string;
  reportStatus?: (text: string) => void;
  channelLabels: Record<ChannelName, string>;
  typingIntervalMs: number;
};

export const createRunStatus = (deps: RunStatusDeps) => {
  const nativeStatusThreadTs = (run: RunState): string | undefined => parseSlackPeerId(run.peerId).threadTs;

  // Per-peerId serialization of native status writes. Slack gives no cross-call
  // ordering guarantee, so a slow in-flight setStatus can land AFTER a later clear
  // and re-show the shimmer. Chaining all native writes per peerId makes the clear
  // wait for any in-flight set, so the clear is always the last write to land.
  const nativeStatusChains = new Map<string, Promise<unknown>>();
  const withNativeStatusLock = <T>(peerId: string, op: () => Promise<T>): Promise<T> => {
    const prev = nativeStatusChains.get(peerId) ?? Promise.resolve();
    const result = prev.then(op, op);
    const tail = result.catch(() => {});
    nativeStatusChains.set(peerId, tail);
    void tail.then(() => {
      if (nativeStatusChains.get(peerId) === tail) nativeStatusChains.delete(peerId);
    });
    return result;
  };

  const updateStatusMessage = async (
    run: RunState,
    text: string,
    options: { throttle?: boolean } = {},
  ): Promise<boolean> => {
    const statusEntry = deps.activeStatusMessages.get(run.peerId);
    const adapter = deps.adapters.get(run.adapterKey);
    if (!statusEntry || statusEntry.finalized || !adapter?.updateMessage) return false;

    if (options.throttle !== false) {
      const now = Date.now();
      const lastUpdate = deps.lastStatusUpdateMs.get(run.peerId) ?? 0;
      if (now - lastUpdate < 1_000) return true;
      deps.lastStatusUpdateMs.set(run.peerId, now);
    }

    try {
      await adapter.updateMessage(run.peerId, statusEntry.ts, { text });
    } catch (error) {
      deps.logger.warn({ error, channel: run.channel, identityId: run.identityId }, "status message update failed");
    }
    if (statusEntry.finalized) {
      deps.activeStatusMessages.delete(run.peerId);
      deps.lastStatusUpdateMs.delete(run.peerId);
    }
    return true;
  };

  // Split from emitStatus so concurrent session.status events cannot race a
  // second placeholder into existence.
  const beginStatus = async (run: RunState, statusText: string): Promise<void> => {
    const adapter = deps.adapters.get(run.adapterKey);
    if (run.nativeStatusEligible && adapter?.setStatus) {
      const threadTs = nativeStatusThreadTs(run);
      if (threadTs) {
        const result = await withNativeStatusLock(run.peerId, () =>
          run.completed
            ? Promise.resolve<{ ok: boolean; error?: string }>({ ok: false })
            : // setStatus is non-null here: the enclosing branch tested adapter?.setStatus.
              adapter.setStatus!(run.peerId, threadTs, statusText),
        );
        if (result.ok) {
          run.nativeStatusActive = true;
          run.nativeStatusShown = true;
          return;
        }
        run.nativeStatusEligible = false;
      }
    }
    if (adapter?.updateMessage) {
      const placeholderDelivery = await deps.deliverParts(
        run.channel,
        run.identityId,
        run.peerId,
        [{ type: "text", text: statusText }],
        { kind: "system" },
      );
      const placeholderResult = placeholderDelivery.partResults[0];
      if (placeholderResult?.providerMessageId && placeholderResult.providerChannelId) {
        deps.activeStatusMessages.set(run.peerId, {
          ts: placeholderResult.providerMessageId,
          channelId: placeholderResult.providerChannelId,
          finalized: false,
        });
      }
    }
  };

  // Returns false when no status was emitted, so non-updateMessage adapters
  // (Telegram) can fall back to posting a message. Also the hook T3 reuses.
  const emitStatus = async (
    run: RunState,
    statusText: string,
    options: { throttle?: boolean } = {},
  ): Promise<boolean> => {
    if (run.nativeStatusActive) {
      const adapter = deps.adapters.get(run.adapterKey);
      const threadTs = nativeStatusThreadTs(run);
      if (adapter?.setStatus && threadTs) {
        // Native setStatus intentionally ignores throttle: seenToolStates already dedupes
        // identical rapid updates per callId+status, and native setStatus has a much higher
        // rate limit (~600/min vs chat.update's 50/min), so the 1s throttle is unnecessary.
        const result = await withNativeStatusLock(run.peerId, () =>
          run.completed
            ? Promise.resolve<{ ok: boolean; error?: string }>({ ok: false })
            : // setStatus is non-null here: the enclosing branch tested adapter?.setStatus.
              adapter.setStatus!(run.peerId, threadTs, statusText),
        );
        if (result.ok) return true;
        run.nativeStatusActive = false;
        run.nativeStatusEligible = false;
      }
    }
    return updateStatusMessage(run, statusText, options);
  };

  const clearNativeStatus = async (run: RunState): Promise<void> => {
    // Clear if a shimmer is active OR was ever shown. After a mid-run demotion
    // emitStatus flips nativeStatusActive=false WITHOUT clearing, so the last-set
    // shimmer lingers; keying off nativeStatusShown makes the completion clear
    // authoritative regardless of demotion. (D)
    if (!run.nativeStatusActive && !run.nativeStatusShown) return;
    run.nativeStatusActive = false;
    const adapter = deps.adapters.get(run.adapterKey);
    const threadTs = nativeStatusThreadTs(run);
    if (!adapter?.clearStatus || !threadTs) {
      run.nativeStatusShown = false;
      return;
    }
    // The clear is the SOLE authoritative removal of the shimmer (we no longer rely
    // on Slack's post-reply auto-clear), so its result cannot be dropped. A single
    // ok:false — a rate-limit burst that also demoted native mid-run, or a transient
    // error setStatus deems non-retryable — would otherwise leave "🤔 Working on it…"
    // shimmering forever. Verify {ok} and retry; mark cleared only once Slack confirms.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let ok = false;
      try {
        // clearStatus is non-null here: the early return above tested adapter?.clearStatus.
        const result = await withNativeStatusLock(run.peerId, () => adapter.clearStatus!(run.peerId, threadTs));
        ok = result.ok !== false;
      } catch (error) {
        deps.logger.warn(
          { error, channel: run.channel, identityId: run.identityId, attempt },
          "native status clear threw",
        );
      }
      if (ok) {
        run.nativeStatusShown = false;
        return;
      }
      if (attempt < 3) await delay(200 * attempt);
    }
    deps.logger.warn(
      { channel: run.channel, identityId: run.identityId },
      "native status clear unconfirmed after retries; shimmer may linger",
    );
  };

  const reportThinking = (run: RunState) => {
    if (!deps.reportStatus) return;
    const modelLabel = deps.modelLabelForRun(run);
    const nextLabel = modelLabel ? `Thinking (${modelLabel})` : "Thinking...";
    if (run.thinkingLabel === nextLabel && run.thinkingActive) return;
    run.thinkingLabel = nextLabel;
    run.thinkingActive = true;
    deps.reportStatus(
      `[${deps.channelLabels[run.channel]}/${run.identityId}] ${deps.formatPeer(run.channel, run.peerId)} ${nextLabel}`,
    );
  };

  const reportDone = (run: RunState) => {
    if (!deps.reportStatus || !run.thinkingActive) return;
    const modelLabel = deps.modelLabelForRun(run);
    const suffix = modelLabel ? ` (${modelLabel})` : "";
    deps.reportStatus(
      `[${deps.channelLabels[run.channel]}/${run.identityId}] ${deps.formatPeer(run.channel, run.peerId)} Done${suffix}`,
    );
    run.thinkingActive = false;
  };

  const startTyping = (run: RunState) => {
    const adapter = deps.adapters.get(run.adapterKey);
    if (!adapter?.sendTyping) return;
    if (deps.typingLoops.has(run.key)) return;
    const sendTyping = async () => {
      try {
        await adapter.sendTyping?.(run.peerId);
      } catch (error) {
        deps.logger.warn({ error, channel: run.channel, identityId: run.identityId }, "typing update failed");
      }
    };
    void sendTyping();
    const timer = setInterval(sendTyping, deps.typingIntervalMs);
    deps.typingLoops.set(run.key, timer);
  };

  const stopTyping = (key: string) => {
    const timer = deps.typingLoops.get(key);
    if (!timer) return;
    clearInterval(timer);
    deps.typingLoops.delete(key);
  };

  return {
    beginStatus,
    emitStatus,
    clearNativeStatus,
    reportThinking,
    reportDone,
    startTyping,
    stopTyping,
  };
};
