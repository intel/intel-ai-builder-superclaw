/**
 * Whether a submit turn should spend a call on the Intent Classifier, and how to
 * read the answer when it does. Pure decisions only — no signals, no fetches, so
 * the routing rules can be tested without a session.
 */

import type { IntentClassificationResult } from "~/shared/platform/transport/openwork-server.types";

export type IntentClassifierCallInput = {
  /** A validated Product Profile is active (i.e. the flags below are trustworthy). */
  profileActive: boolean;
  /** `feature_flags.intent_classifier` of the active Profile. */
  profileIntentClassifierEnabled: boolean;
  /** Agent pinned on the session, or null for "Default — let the system decide". */
  sessionAgent: string | null;
  /** Agent already resolved for this turn (leading @mention, session pin). */
  resolvedAgent: string | null;
  /** This session already went through the classifier once. */
  sessionAlreadyResolved: boolean;
  /** Attachments require normal dispatch so workspace references are retained. */
  hasAttachments: boolean;
};

/**
 * Only Profiles that set `intent_classifier` run the sidecar, so on Lite and
 * Standard the classifier proxy has nothing to reach: the call burns the client
 * timeout and then falls through to superclaw-default. Skipping it costs no
 * routing — the sidecar's own `bypass` mode (what these Profiles used when the
 * process was still always-on) answered `superclaw-default` unconditionally,
 * without consulting rules or the LLM.
 *
 * Phrased as "the active Profile says no" rather than "the Profile says yes",
 * because the capability selectors are fail-closed: they report disabled while
 * the Profile is still loading or the host is unreachable. Treating that as
 * "disabled" would silently drop routing on Pro, so an unknown Profile still
 * classifies.
 */
export function shouldCallIntentClassifier(input: IntentClassifierCallInput): boolean {
  if (input.hasAttachments) return false;
  if (input.profileActive && !input.profileIntentClassifierEnabled) return false;
  if (input.sessionAgent !== null) return false;
  if (input.resolvedAgent !== null) return false;
  return !input.sessionAlreadyResolved;
}

/**
 * Marks a session as classified, so `sessionAlreadyResolved` above stays true for
 * the rest of it.
 *
 * A reducer rather than four inline lines at each call site because there are now
 * two: the classifier answered, and the classifier could not be reached. The
 * second exists precisely because it was missing — without it every turn of a
 * session whose sidecar is absent re-paid the full classifier timeout.
 */
export function latchClassifierResolvedSession(
  current: Record<string, true>,
  sessionID: string,
): Record<string, true> {
  return { ...current, [sessionID]: true };
}

/**
 * Whether the classifier is asking for more from the user rather than routing.
 *
 * Two fields say it and the caller has to treat them identically: an explicit
 * intake turn, or a category the classifier could not narrow. Spelled out in one
 * place because both branches that consume it had drifted into repeating the
 * pair.
 */
export function isAmbiguousClassifierTurn(
  classified: Pick<IntentClassificationResult, "category" | "intake_state">,
): boolean {
  return classified.intake_state === "intake_chat" || classified.category === "ambiguous";
}
