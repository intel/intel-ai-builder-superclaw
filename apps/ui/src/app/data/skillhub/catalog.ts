import { validateSkillMarkdown } from "~/shared/util/skill-markdown";

export type OfflineSkillFile = {
  relativePath: string;
  content: string;
};

export type OfflineSkillPackage = {
  id: string;
  name: string;
  description: string;
  template: string;
  files: OfflineSkillFile[];
};

const SKILL_TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown", ".txt", ".text",
  ".py", ".sh", ".bash", ".zsh", ".ps1",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties",
  ".csv", ".tsv", ".xml", ".html", ".htm", ".css", ".scss",
  ".sql", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".r", ".lua", ".pl", ".php", ".swift", ".gitignore", ".example", ".lock", ".gradle", ".dockerfile",
]);

const isTextSkillFile = (relPath: string): boolean => {
  const lower = relPath.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith("/dockerfile")) return true;
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return false;
  return SKILL_TEXT_EXTENSIONS.has(lower.slice(dot));
};

const skillMarkdownFiles = import.meta.glob("./*/SKILL.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const rawTextFiles = import.meta.glob(["./**/*", "!./*/SKILL.md"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function collectOfflineSkillPackages(): OfflineSkillPackage[] {
  const packages: OfflineSkillPackage[] = [];

  for (const [skillMdPath, template] of Object.entries(skillMarkdownFiles)) {
    const folderMatch = skillMdPath.match(/^\.\/([^/]+)\/SKILL\.md$/);
    if (!folderMatch) continue;

    const folder = folderMatch[1];
    let validated: { name: string; description: string };
    try {
      validated = validateSkillMarkdown(template);
    } catch {
      continue;
    }

    const files: OfflineSkillFile[] = [];
    const prefix = `./${folder}/`;

    for (const [rawPath, rawContent] of Object.entries(rawTextFiles)) {
      if (!rawPath.startsWith(prefix)) continue;
      const rel = rawPath.slice(prefix.length);
      if (!rel || rel === "SKILL.md") continue;
      if (!isTextSkillFile(rel)) continue;
      files.push({ relativePath: rel, content: rawContent });
    }

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    packages.push({
      id: validated.name,
      name: validated.name,
      description: validated.description,
      template,
      files,
    });
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

export const OFFLINE_SKILL_CATALOG: OfflineSkillPackage[] = collectOfflineSkillPackages();
