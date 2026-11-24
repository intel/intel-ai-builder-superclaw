import { validateSkillMarkdown } from "~/shared/util/skill-markdown";
import { OFFLINE_SKILL_CATALOG } from "./skillhub/catalog";
import skillCreatorTemplate from "./skill-creator.md?raw";
import skillFinderTemplate from "./skill-finder.md?raw";

/** Skill name → description of the SKILL.md template the app installs into a workspace. */
export const BUNDLED_SKILL_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ...OFFLINE_SKILL_CATALOG.map((pkg) => [pkg.name, pkg.description] as const),
  ...[skillCreatorTemplate, skillFinderTemplate].map((template) => {
    const { name, description } = validateSkillMarkdown(template);
    return [name, description] as const;
  }),
]);
