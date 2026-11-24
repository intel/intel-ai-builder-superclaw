// The channel adapter shape the bridge holds in its adapters map, the
// bounded-start result, and the bounded stop the control-plane handlers use.
//
// It lives in its own module so the health control-plane handlers, which start
// and stop adapters, can share the type with bridge.ts without importing it
// back. The narrower structural subsets used elsewhere (DeliveryAdapter in
// outbound-delivery.ts, StatusAdapter in run-status.ts) are satisfied by this.

import { setTimeout as delay } from "node:timers/promises";

import type { ChannelName } from "./config.js";
import type { MessageDeliveryResult, OutboundMessage } from "./media.js";

export type Adapter = {
  key: string;
  name: ChannelName;
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The bot this adapter is, once it has started; Telegram only. */
  botInfo?: () => { id: number; username?: string; name?: string } | null;
  sendMessage?: (peerId: string, message: OutboundMessage) => Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
  updateMessage?: (
    peerId: string,
    ts: string,
    message: { text?: string; blocks?: object[] },
  ) => Promise<{ ts: string }>;
  sendFile?: (peerId: string, filePath: string, caption?: string, data?: Uint8Array) => Promise<void>;
  sendTyping?: (peerId: string) => Promise<void>;
  setStatus?: (peerId: string, threadTs: string, status: string) => Promise<{ ok: boolean; error?: string }>;
  clearStatus?: (peerId: string, threadTs: string) => Promise<{ ok: boolean; error?: string }>;
};

export type AdapterStartResult =
  | { status: "started" }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

/** A stop that cannot outlast its budget, so a wedged disconnect frees the slot. */
export type AdapterStopResult = { status: "stopped" | "timeout" } | { status: "error"; error: unknown };

/**
 * Stop an adapter without waiting on it forever.
 *
 * The per-identity slot queue (`adapter-slot.ts`) holds its slot across this
 * stop, and Slack's `socket.disconnect()` carries no bound of its own. An
 * unbounded stop therefore blocks every later upsert and delete for that
 * identity until the process restarts. On timeout the stop is abandoned, not
 * cancelled: the caller drops the adapter from the map either way, and a late
 * rejection is swallowed rather than surfacing as an unhandled rejection.
 */
async function awaitStop(adapter: Adapter): Promise<AdapterStopResult> {
  try {
    await adapter.stop();
    return { status: "stopped" };
  } catch (error) {
    return { status: "error", error };
  }
}

async function awaitStopTimeout(timeoutMs: number, signal: AbortSignal): Promise<AdapterStopResult> {
  try {
    await delay(timeoutMs, undefined, { signal });
  } catch {
    // Aborting the timer once stop wins rejects the delay. That is the same
    // outcome as the timer firing: this leg of the race lost.
  }
  return { status: "timeout" };
}

export async function stopAdapterBounded(adapter: Adapter, timeoutMs: number): Promise<AdapterStopResult> {
  // Attached before the race, and awaitStop never rejects, so abandoning the
  // loser cannot surface as an unhandled rejection.
  const outcome = awaitStop(adapter);
  const timeoutAbort = new AbortController();
  const winner = await Promise.race([outcome, awaitStopTimeout(timeoutMs, timeoutAbort.signal)]);
  if (winner.status !== "timeout") timeoutAbort.abort();
  return winner;
}
