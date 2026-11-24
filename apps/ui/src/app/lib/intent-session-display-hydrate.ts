import type { ClassifierResponseKind } from "../types";
import type { IntentSessionDisplayResult } from "./openwork-server";

export type RenderedClassifierTurn = {
  userText: string;
  response: string;
  time: number;
};

type HydratedClaim = {
  userText: string;
  response: string;
  userTurnID: string | null;
};

type OpenClaim = {
  count: number;
  openedAt: number;
};

// A canned greeting is identical text every time, so text alone cannot tell a
// Slack hello already in the display cache from the desktop hello in flight.
// The cache records server time at the end of classify. Each desktop classify
// keeps the time it started. The 2s slack is clock skew against that start,
// not a budget for the UI to paint and not a single window for the session.
const CLAIM_MATCH_SLACK_MS = 2000;

// Keep this equal to intent_classifier_server._clip_display_text (INTENT_CLASSIFIER_DISPLAY_MAX_TEXT_CHARS).
const DISPLAY_CACHE_TEXT_CHARS = 2000;

// A field at the clip length matches as a prefix. A shorter string stays exact.
function sameDisplayText(cached: string, rendered: string): boolean {
  const left = cached.trim();
  const right = rendered.trim();
  if (left === right) return true;
  if (right.startsWith(left) && cached.length >= DISPLAY_CACHE_TEXT_CHARS) return true;
  if (left.startsWith(right) && rendered.length >= DISPLAY_CACHE_TEXT_CHARS) return true;
  return false;
}

// Turns the display hydrate appended while a desktop classify was in flight.
// The send path consumes one matching claim instead of appending again. The
// queue lives only while that classify is open, so a later identical greeting
// is not swallowed by a Slack turn hydrated earlier.
const waitingBySession = new Map<string, HydratedClaim[]>();
const openClaimsBySession = new Map<string, OpenClaim>();
// Every desktop classify start, not just the latest. A display GET can stay
// in flight across two greetings, and the earlier one is already on screen.
const claimOpenedAtsBySession = new Map<string, number[]>();

function recordedDuringClaim(recordedAtMs: number, openedAt: number): boolean {
  return recordedAtMs >= openedAt - CLAIM_MATCH_SLACK_MS;
}

function rememberClaimWindow(sessionID: string, openedAt: number): void {
  const windows = claimOpenedAtsBySession.get(sessionID);
  if (!windows) {
    claimOpenedAtsBySession.set(sessionID, [openedAt]);
    return;
  }
  if (windows[windows.length - 1] === openedAt) return;
  windows.push(openedAt);
}

function recordedDuringAnyClaim(sessionID: string, recordedAtMs: number): boolean {
  const windows = claimOpenedAtsBySession.get(sessionID);
  if (!windows || windows.length === 0) return true;
  return windows.some((openedAt) => recordedDuringClaim(recordedAtMs, openedAt));
}

export function resetHydrationClaims(): void {
  waitingBySession.clear();
  openClaimsBySession.clear();
  claimOpenedAtsBySession.clear();
}

export function openHydrationClaim(sessionID: string): {
  take: (userText: string, response: string) => boolean;
  close: () => void;
  takenUserTurnID: string | null;
} {
  const sid = sessionID.trim();
  const existing = openClaimsBySession.get(sid);
  const openedAt = existing?.openedAt ?? Date.now();
  openClaimsBySession.set(sid, {
    count: (existing?.count ?? 0) + 1,
    openedAt,
  });
  rememberClaimWindow(sid, openedAt);
  let closed = false;
  let takenUserTurnID: string | null = null;
  return {
    get takenUserTurnID() {
      return takenUserTurnID;
    },
    take(userText: string, response: string): boolean {
      const queue = waitingBySession.get(sid);
      if (!queue) return false;
      const wantedUser = userText.trim();
      const wantedResponse = response.trim();
      const index = queue.findIndex(
        (turn) =>
          sameDisplayText(turn.userText, wantedUser) &&
          sameDisplayText(turn.response, wantedResponse),
      );
      if (index === -1) return false;
      takenUserTurnID = queue[index]?.userTurnID ?? null;
      queue.splice(index, 1);
      return true;
    },
    close(): void {
      if (closed) return;
      closed = true;
      const open = openClaimsBySession.get(sid);
      const remaining = (open?.count ?? 1) - 1;
      if (!open || remaining <= 0) {
        openClaimsBySession.delete(sid);
        waitingBySession.delete(sid);
        return;
      }
      openClaimsBySession.set(sid, { count: remaining, openedAt: open.openedAt });
    },
  };
}

export function noteHydratedTurn(
  sessionID: string,
  userText: string,
  response: string,
  recordedAtMs: number,
  userTurnID: string | null = null,
): void {
  const sid = sessionID.trim();
  const open = openClaimsBySession.get(sid);
  if (!open || open.count <= 0) return;
  if (!recordedDuringClaim(recordedAtMs, open.openedAt)) return;
  const responseText = response.trim();
  if (!responseText) return;
  const queue = waitingBySession.get(sid) ?? [];
  queue.push({
    userText: userText.trim(),
    response: responseText,
    userTurnID,
  });
  waitingBySession.set(sid, queue);
}

export function renderedClassifierPairs(
  userTurns: readonly { id: string; text: string; classifierText?: string }[],
  classifierTurns: readonly {
    text: string;
    afterMessageID: string | null;
    time: number;
  }[],
): RenderedClassifierTurn[] {
  const userTextById = new Map(
    userTurns.map((turn) => [
      turn.id,
      (turn.classifierText ?? turn.text).trim(),
    ]),
  );
  const pairs: RenderedClassifierTurn[] = [];
  for (const turn of classifierTurns) {
    const response = turn.text.trim();
    if (!response) continue;
    pairs.push({
      userText: turn.afterMessageID
        ? (userTextById.get(turn.afterMessageID) ?? "")
        : "",
      response,
      time: turn.time,
    });
  }
  return pairs;
}

function omitAlreadyRenderedDisplayTurns<
  T extends { user_text: string; response: string; recorded_at_ms: number },
>(
  sessionID: string,
  cached: readonly T[],
  rendered: readonly RenderedClassifierTurn[],
): T[] {
  const remaining = rendered.map((turn) => ({
    userText: turn.userText.trim(),
    response: turn.response.trim(),
  }));
  const fresh: T[] = [];
  for (const turn of cached) {
    const response = turn.response.trim();
    if (!response) continue;
    const userText = turn.user_text.trim();
    const openedAtMatches = recordedDuringAnyClaim(
      sessionID,
      turn.recorded_at_ms,
    );
    if (!openedAtMatches) {
      fresh.push(turn);
      continue;
    }
    const index = remaining.findIndex(
      (item) =>
        sameDisplayText(userText, item.userText) &&
        sameDisplayText(response, item.response),
    );
    if (index !== -1) {
      remaining.splice(index, 1);
      continue;
    }
    fresh.push(turn);
  }
  return fresh;
}

function classifierKind(kind: string): ClassifierResponseKind {
  return kind === "greeting" || kind === "ambiguous" ? kind : "generic";
}

export async function hydrateIntentSessionDisplay(input: {
  sessionID: string;
  fetchDisplay: (sessionID: string) => Promise<IntentSessionDisplayResult>;
  renderedTurns: () => readonly RenderedClassifierTurn[];
  appendUserTurn: (
    sessionID: string,
    text: string,
  ) => { id: string } | null | void;
  appendClassifierTurn: (
    sessionID: string,
    text: string,
    kind: ClassifierResponseKind,
    afterMessageID?: string | null,
  ) => void;
}): Promise<void> {
  const sessionID = input.sessionID.trim();
  if (!sessionID) return;

  const display = await input.fetchDisplay(sessionID);
  // Read after the await. A greeting sent while this GET was in flight is
  // already in the transcript, and appending it again is issue #3364.
  const fresh = omitAlreadyRenderedDisplayTurns(
    sessionID,
    display.turns,
    input.renderedTurns(),
  );
  for (const turn of fresh) {
    const response = turn.response.trim();
    const kind = classifierKind(turn.kind);
    const userText = turn.user_text.trim();
    const appendedUser = userText
      ? input.appendUserTurn(sessionID, userText)
      : null;
    // The hydrated user is anchored to the optimistic pending bubble. Once the
    // send path removes that bubble, a reply anchored to the last durable
    // message renders above its prompt. Anchor the reply to this user instead.
    input.appendClassifierTurn(
      sessionID,
      response,
      kind,
      appendedUser?.id,
    );
    noteHydratedTurn(
      sessionID,
      userText,
      response,
      turn.recorded_at_ms,
      appendedUser?.id ?? null,
    );
  }
}

export function beginIntentSessionDisplayHydration(input: {
  enabled: boolean;
  sessionID: string | null;
  hydratedSessionIds: Set<string>;
  fetchDisplay:
    | ((sessionID: string) => Promise<IntentSessionDisplayResult>)
    | null;
  userTurns: () => readonly {
    id: string;
    text: string;
    classifierText?: string;
  }[];
  classifierTurns: () => readonly {
    text: string;
    afterMessageID: string | null;
    time: number;
  }[];
  appendUserTurn: (
    sessionID: string,
    text: string,
  ) => { id: string } | null | void;
  appendClassifierTurn: (
    sessionID: string,
    text: string,
    kind: ClassifierResponseKind,
    afterMessageID?: string | null,
  ) => void;
}): void {
  if (!input.enabled) return;
  const sessionID = input.sessionID?.trim() ?? "";
  if (!sessionID || input.hydratedSessionIds.has(sessionID)) return;
  const renderedTurns = () =>
    renderedClassifierPairs(input.userTurns(), input.classifierTurns());
  if (renderedTurns().length > 0) {
    input.hydratedSessionIds.add(sessionID);
    return;
  }
  const fetchDisplay = input.fetchDisplay;
  if (!fetchDisplay) return;
  // Mark before awaiting so a re-run cannot start a second concurrent fetch.
  input.hydratedSessionIds.add(sessionID);
  void hydrateIntentSessionDisplay({
    sessionID,
    fetchDisplay,
    renderedTurns,
    appendUserTurn: input.appendUserTurn,
    appendClassifierTurn: input.appendClassifierTurn,
  }).catch(() => {
    input.hydratedSessionIds.delete(sessionID);
  });
}
