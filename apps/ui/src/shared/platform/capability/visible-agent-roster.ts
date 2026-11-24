import type { ProductProfileId } from "@different-ai/openwork-contracts/capability";

const FEATURE_GATED_AGENT_NAMES = new Set([
  "superclaw-default",
  "build",
  "email-agent",
  "hybrid-deep-research",
]);
const PICKER_HIDDEN_AGENT_NAMES = new Set(["superclaw-default"]);

/**
 * Agents the backend still registers and can dispatch to, but which we do not
 * offer as a direct user choice at a given product profile.
 *
 * `lite` and `standard` keep `build` in the allowed set on purpose —
 * `superclaw-default` delegates to it through the `superclaw-default->build`
 * task edge, so removing it from the manifest would break coding requests
 * entirely. Hiding it here suppresses only the pill and picker entry: on
 * lite/standard hardware the local model handles a hand-picked coding agent
 * poorly, so the agent should be reached via delegation rather than chosen
 * outright.
 *
 * This is presentation policy, not a security boundary — a session already
 * pinned to a hidden agent keeps running it.
 */
const PROFILE_HIDDEN_AGENT_NAMES: Partial<
  Record<ProductProfileId, ReadonlySet<string>>
> = {
  lite: new Set(["build"]),
  standard: new Set(["build"]),
};

const NO_HIDDEN_AGENTS: ReadonlySet<string> = new Set();

/**
 * Hidden set for a product profile. Only applied when the gate is active:
 * without a validated profile we do not know the id, so we fall back to
 * showing everything (matching the existing dark-safe passthrough).
 */
function hiddenForProfile(
  capabilityActive: boolean,
  profileId: ProductProfileId | null | undefined,
): ReadonlySet<string> {
  if (!capabilityActive || !profileId) return NO_HIDDEN_AGENTS;
  return PROFILE_HIDDEN_AGENT_NAMES[profileId] ?? NO_HIDDEN_AGENTS;
}

export function getVisibleQuickAgents<T extends { id: string }>(
  agents: readonly T[],
  capabilityActive: boolean,
  isAgentAllowed: (agentName: string) => boolean,
  profileId?: ProductProfileId | null,
  availableAgentNames?: ReadonlySet<string>,
): T[] {
  // Pro already lists these agents in the composer dropdown. The chip row
  // repeats them, so it stays off on that profile (#3654).
  if (capabilityActive && profileId === "pro") return [];
  const hidden = hiddenForProfile(capabilityActive, profileId);
  return agents.filter(
    (agent) =>
      (!availableAgentNames || availableAgentNames.has(agent.id)) &&
      (!capabilityActive ||
        (isAgentAllowed(agent.id) && !hidden.has(agent.id))),
  );
}

export function getVisibleAgentOptions<T extends { name: string }>(
  agents: readonly T[],
  capabilityActive: boolean,
  isAgentAllowed: (agentName: string) => boolean,
  profileId?: ProductProfileId | null,
): T[] {
  return agents.filter((agent) =>
    isAgentPickable(agent.name, capabilityActive, isAgentAllowed, profileId),
  );
}

/**
 * Whether the composer's agent picker would offer `agentName` (given the
 * backend lists it). The single rule behind `getVisibleAgentOptions`, exposed
 * so code that selects an agent on the user's behalf honours the same gate.
 */
export function isAgentPickable(
  agentName: string,
  capabilityActive: boolean,
  isAgentAllowed: (agentName: string) => boolean,
  profileId?: ProductProfileId | null,
): boolean {
  return (
    !PICKER_HIDDEN_AGENT_NAMES.has(agentName) &&
    !hiddenForProfile(capabilityActive, profileId).has(agentName) &&
    (!capabilityActive ||
      !FEATURE_GATED_AGENT_NAMES.has(agentName) ||
      isAgentAllowed(agentName))
  );
}

/**
 * True when two (already name-sorted) agent lists name the same agents in
 * the same order. Callers should skip replacing their agent-options signal
 * when this returns true: the picker's `<For>` reconciles by object
 * reference, so swapping in a freshly-fetched-but-identical array remounts
 * every row (visible as a flicker) even though nothing actually changed.
 */
export function agentOptionsUnchanged<T extends { name: string }>(
  previous: readonly T[],
  next: readonly T[],
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((agent, index) => agent.name === next[index]?.name);
}
