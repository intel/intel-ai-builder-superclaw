import { matchLeadingMentionAgent } from "../app.prompt-parts";

type MentionDeps = {
  /** Every agent dispatch honors, including ones the picker hides. */
  roster: readonly { name: string }[];
  selectedAgent: string | null;
  hasSession: boolean;
  pickAgent: (agent: string) => boolean;
};

/**
 * Selects the agent a leading `@agent` names before the send gates run, so
 * that agent's checks (Gmail, cloud risk, file limit, local-model pin) apply.
 * False cancels the send: the user named an agent its model policy refused.
 */
export function selectMentionedAgent(text: string, deps: MentionDeps): boolean {
  const mentioned = matchLeadingMentionAgent(text, deps.roster.map((agent) => agent.name));
  if (!mentioned || mentioned === deps.selectedAgent) return true;
  return deps.pickAgent(mentioned) || !deps.hasSession;
}
