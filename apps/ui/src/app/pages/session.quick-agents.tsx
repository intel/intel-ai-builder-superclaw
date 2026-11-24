/** Quick-agent roster and command-palette mode metadata for the Session view. */

import { t } from "../../i18n";

export type CommandPaletteMode = "root" | "sessions" | "thinking";

export const COMMAND_PALETTE_THINKING_OPTIONS = [
  { value: "none", label: "None", detail: "Fastest responses" },
  { value: "low", label: "Low", detail: "Light reasoning" },
  { value: "medium", label: "Medium", detail: "Balanced depth" },
  { value: "high", label: "High", detail: "Deeper reasoning" },
  { value: "xhigh", label: "X-High", detail: "Maximum effort" },
] as const;

export type QuickAgent = {
  id: string;
  nameKey: string;
  descriptionKey: string;
  model?: string;
  badgeKey?: string;
};

export const QUICK_AGENTS: QuickAgent[] = [
  {
    id: "build",
    nameKey: "composer.quick_agent_build_name",
    descriptionKey: "composer.quick_agent_build_description",
    // model:"llmrouter/auto"  //comment model due to some provider's auto model not working well with agent workloads, will re-enable once we have a better solution for that
  },
  {
    id: "hybrid-deep-research",
    nameKey: "composer.quick_agent_hybrid_deep_research_name",
    descriptionKey: "composer.quick_agent_hybrid_deep_research_description",
  },
  {
    id: "email-agent",
    nameKey: "composer.quick_agent_email_agent_name",
    descriptionKey: "composer.quick_agent_email_agent_description",
  },
];

/* Both helpers must be read inside a reactive scope (a JSX prop or a memo) so
   the names follow a locale switch. */

export function agentDisplayNames(): Record<string, string> {
  return Object.fromEntries(QUICK_AGENTS.map((agent) => [agent.id, t(agent.nameKey)]));
}

export function agentTriggerLabel(agent: string | null): string {
  if (!agent || agent === "superclaw-default") return t("composer.agent_general");
  return agentDisplayNames()[agent] ?? agent;
}

/* ── Run-elapsed localStorage helpers ─────────────────────────────────── */
