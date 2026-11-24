import { FRONTMATTER } from "~/shared/util/frontmatter-preview";
import { validateSkillMarkdown } from "~/shared/util/skill-markdown";

export function splitSkillContentForEditor(content: string) {
  const raw = String(content ?? "");
  const match = raw.match(FRONTMATTER);
  if (!match) {
    return { yaml: "", body: raw };
  }

  const header = match[1];
  const body = match[2] ?? "";
  const yaml = header
    .split(/\r?\n/)
    .filter((line) => !/^name\s*:/i.test(line.trim()))
    .join("\n")
    .trim();
  return { yaml, body };
}

function buildSkillContentFromEditor(name: string, yaml: string, body: string) {
  const normalizedYaml = String(yaml ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "---" && !/^name\s*:/i.test(line.trim()))
    .join("\n")
    .trim();
  const normalizedBody = String(body ?? "");
  const header = normalizedYaml ? `name: ${name}\n${normalizedYaml}` : `name: ${name}`;
  return `---\n${header}\n---\n\n${normalizedBody}`;
}

export function validateEditableFrontmatter(name: string, yaml: string, body: string) {
  const content = buildSkillContentFromEditor(name, yaml, body);
  const validated = validateSkillMarkdown(content, { expectedName: name });
  return { content, description: validated.description };
}
