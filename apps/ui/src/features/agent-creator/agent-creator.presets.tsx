/** Capability category catalogue for the agent creator. */
import type { CapabilityCategory } from "./agent-creator.types";

export const CAPABILITY_CATEGORIES: CapabilityCategory[] = [
  {
    id: "file-code-engine",
    labelKey: "agents.category_file_code_engine_label",
    descriptionKey: "agents.category_file_code_engine_description",
  },
  {
    id: "email-calendar-operations",
    labelKey: "agents.category_email_calendar_operations_label",
    descriptionKey: "agents.category_email_calendar_operations_description",
  },
  {
    id: "web-research-retrieval",
    labelKey: "agents.category_web_research_retrieval_label",
    descriptionKey: "agents.category_web_research_retrieval_description",
  },
];
