import { t } from "../../i18n";

const AUTOMATION_AGENT_NAME_KEYS = new Map<string, string>([
  ["build", "scheduled.agent_name_build"],
  ["plan", "scheduled.agent_name_plan"],
  ["email-agent", "scheduled.agent_name_email"],
  ["hybrid-deep-research", "scheduled.agent_name_hybrid_deep_research"],
  ["local-file-agent", "scheduled.agent_name_local_file"],
  ["protected-file-agent", "scheduled.agent_name_protected_file"],
  ["websearch-agent", "scheduled.agent_name_web_search"],
  ["llmrouter", "scheduled.agent_name_model_router"],
]);

export const humanizeAgentName = (name: string) => {
  const key = AUTOMATION_AGENT_NAME_KEYS.get(name);
  return key ? t(key) : name;
};
