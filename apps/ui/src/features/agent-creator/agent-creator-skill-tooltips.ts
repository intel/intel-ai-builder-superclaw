import { t } from "../../i18n";
import { normalizeStepText, truncateStepText } from "../../shared/util/tool-summary";

/** Max length for catalog-description tooltips when no curated i18n copy exists. */
export const SKILL_CATALOG_TOOLTIP_MAX = 140;

/**
 * Shorten SKILL.md routing descriptions for Agent Creator tooltips only.
 * Prefers the first sentence when it fits; otherwise hard-truncates with ellipsis.
 */
export function summarizeSkillCatalogDescription(
  description: string,
  max = SKILL_CATALOG_TOOLTIP_MAX,
): string {
  const normalized = normalizeStepText(description);
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;

  const firstSentence = normalized.match(/^.*?(?:[.!?](?=\s+\p{Lu})|[。！？])/u)?.[0];
  if (firstSentence && firstSentence.length <= max) {
    return firstSentence;
  }

  return truncateStepText(normalized, max);
}

/**
 * Agent Creator skill name → i18n key. Copy lives in en.agents.ts / zh.agents.ts
 * (`agents.skill_tooltip_*`). SKILL.md `description` stays verbose for routing.
 */
export const AGENT_CREATOR_SKILL_TOOLTIP_KEYS: Readonly<Record<string, string>> = {
  pdf: "agents.skill_tooltip_pdf",
  docx: "agents.skill_tooltip_docx",
  "docx-create": "agents.skill_tooltip_docx-create",
  pptx: "agents.skill_tooltip_pptx",
  "pptx-create": "agents.skill_tooltip_pptx-create",
  spreadsheet: "agents.skill_tooltip_spreadsheet",
  github: "agents.skill_tooltip_github",
  email: "agents.skill_tooltip_email",
  "local-safety-guard": "agents.skill_tooltip_local-safety-guard",
  "local-security-review": "agents.skill_tooltip_local-security-review",
  "humanizer-lite": "agents.skill_tooltip_humanizer-lite",
  "frontend-design": "agents.skill_tooltip_frontend-design",
  "news-summarizer": "agents.skill_tooltip_news-summarizer",
  "ocr-document-parse": "agents.skill_tooltip_ocr-document-parse",
  translate: "agents.skill_tooltip_translate",
  "resume-tailor": "agents.skill_tooltip_resume-tailor",
  "interview-prep-generator": "agents.skill_tooltip_interview-prep-generator",
  "skill-creator": "agents.skill_tooltip_skill-creator",
  "skill-finder": "agents.skill_tooltip_skill-finder",
};

/**
 * A workspace skill may reuse a shipped skill's name, so curated copy applies to it
 * only when its description still matches the bundled template it was installed from.
 */
export function agentCreatorSkillTooltip(
  item: { name: string; description?: string; source?: "workspace-user" | "builtin" },
  shippedDescription?: string,
): string {
  const key = item.name.trim();
  const i18nKey = Object.hasOwn(AGENT_CREATOR_SKILL_TOOLTIP_KEYS, key)
    ? AGENT_CREATOR_SKILL_TOOLTIP_KEYS[key]
    : undefined;
  const catalog = normalizeStepText(item.description);
  const isShipped =
    item.source !== "workspace-user" ||
    (shippedDescription !== undefined && normalizeStepText(shippedDescription) === catalog);
  if (i18nKey && isShipped) return t(i18nKey);

  return summarizeSkillCatalogDescription(catalog);
}
