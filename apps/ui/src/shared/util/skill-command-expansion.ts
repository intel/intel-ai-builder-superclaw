/**
 * OpenCode expands a skill slash command into one user text part: the SKILL.md
 * body, a fixed base-directory footer, then whatever the user typed after the
 * command. The stored message carries no other marker, so this footer is the
 * only way to recognise the expansion when a session is reloaded.
 */
export type SkillCommandExpansion = {
  /** The base directory's folder name; see `resolveSkillName` for the label. */
  skillName: string;
  baseDirectory: string;
  /** SKILL.md body plus footer, exactly as sent to the model. */
  instructions: string;
  /** What the user typed after `/skill-name`; empty when nothing was. */
  arguments: string;
};

const FOOTER_PATTERN =
  /^Base directory for this skill: (.+?)[ \t]*\r?\nRelative paths in this skill\b.*$/gm;

export function parseSkillCommandExpansion(
  text: string,
): SkillCommandExpansion | null {
  let footer: RegExpExecArray | null = null;
  for (const match of text.matchAll(FOOTER_PATTERN)) footer = match;
  if (!footer || footer.index === undefined) return null;

  const baseDirectory = footer[1].trim();
  const skillName = baseDirectory.split(/[\\/]+/).filter(Boolean).pop() ?? "";
  if (!skillName) return null;

  const footerEnd = footer.index + footer[0].length;
  return {
    skillName,
    baseDirectory,
    instructions: text.slice(0, footerEnd).trim(),
    arguments: text.slice(footerEnd).trim(),
  };
}

const pathSegments = (path: string) =>
  path.replace(/[\\/]SKILL\.md$/i, "").split(/[\\/]+/).filter(Boolean);

/**
 * The installed skill's own name for an expansion. OpenCode strips the
 * frontmatter and names only the base directory, and a custom skill's folder
 * need not match its `name`, so the directory is looked up among installed
 * skills: full path first, then folder. Falls back to the folder name.
 */
export function resolveSkillName(
  expansion: SkillCommandExpansion,
  skills: readonly { name: string; path: string }[] = [],
): string {
  const key = (path: string) => pathSegments(path).join("/").toLowerCase();
  const target = key(expansion.baseDirectory);
  const match =
    skills.find((skill) => key(skill.path) === target) ??
    skills.find((skill) => pathSegments(skill.path).pop() === expansion.skillName);
  return match?.name ?? expansion.skillName;
}
