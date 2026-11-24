// Pure decision logic for the intent-classifier gate in the bridge.
//
// Extracted from `startBridge` so the recovery behaviour can be unit-tested
// without standing up the full bridge. The motivating bug (issue #682): a prompt
// classified `ambiguous` triggers a canned "Clarification Needed" reply and the
// bridge returns WITHOUT caching anything, so every follow-up message is
// re-classified — and if the classifier keeps returning `ambiguous` (which
// conversational / role-play prompts reliably do), the user is trapped in
// clarification cards forever with no way to steer back.

export type ClassifyResult = {
  category: string;
  agent: string | null;
  response: string | null;
  confidence: number;
};

export type IntentGateState = {
  /** Agent already cached for this thread (resolved on an earlier message). */
  cachedAgent: string | undefined;
  /**
   * This thread already received a canned clarification/greeting on the previous
   * message. The recovery escape hatch for issue #682: the user must be able to
   * steer back instead of being re-gated into another canned card.
   */
  alreadyClarified: boolean;
};

export type IntentGateDecision =
  | { action: "use-cached-agent"; agent: string }
  | { action: "send-canned"; text: string }
  | { action: "resolve-agent"; agent: string; notice: string | null }
  | {
      action: "fall-through";
      reason:
        | "no-classifier-result"
        | "post-clarification-recovery"
        | "no-actionable-classification";
    };

/**
 * Converts classifier-facing semantic labels to OpenCode runtime agent keys.
 *
 * Phase 1 intentionally retained `superclaw-default` as the runtime key while
 * exposing `general-task-agent` from the classifier.
 */
export function mapClassifierAgentToRuntimeAgent(agent: string): string {
  return agent === "general-task-agent" ? "superclaw-default" : agent;
}

/**
 * Decide what the intent gate should do for one inbound message.
 *
 * Invariants that matter for issue #682 (ambiguous-loop trap):
 *  - A cached agent always short-circuits (classify once per thread).
 *  - If the thread already produced a canned clarification, NEVER short-circuit
 *    into another canned response — fall through to the default agent so the
 *    user can steer the conversation back. This is the recovery that prevents
 *    the trap, and it holds regardless of what the classifier returns next.
 *  - Only when the thread is fresh (no cached agent, not already clarified) do we
 *    act on a fresh classification.
 */
export function decideIntentGate(
  state: IntentGateState,
  classified: ClassifyResult | null,
): IntentGateDecision {
  if (state.cachedAgent) {
    return { action: "use-cached-agent", agent: state.cachedAgent };
  }
  if (state.alreadyClarified) {
    // Recovery: do not re-gate a user who already saw a clarification card.
    return { action: "fall-through", reason: "post-clarification-recovery" };
  }
  if (!classified) {
    return { action: "fall-through", reason: "no-classifier-result" };
  }
  if (classified.response && !classified.agent) {
    return { action: "send-canned", text: classified.response };
  }
  if (classified.agent) {
    return { action: "resolve-agent", agent: classified.agent, notice: classified.response };
  }
  return { action: "fall-through", reason: "no-actionable-classification" };
}
