import { parseDocument } from "yaml";

const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type ValidatedSkillMarkdown = {
  name: string;
  description: string;
};

// Validate a SKILL.md frontmatter block (--- ... ---) using a YAML parser.
// Only name/description are validated; other fields are ignored.
// (Unknown fields are allowed so skills can include additional metadata.)
export function validateSkillMarkdown(
  content: string,
  opts?: { expectedName?: string },
): ValidatedSkillMarkdown {
  const raw = String(content ?? "");
  const fmMatch = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!fmMatch) {
    throw new Error("Invalid SKILL.md format. Add a frontmatter block between '---' lines.");
  }

  const frontmatterText = fmMatch[1];
  const doc = parseDocument(frontmatterText, { prettyErrors: false, uniqueKeys: false });
  if (doc.errors.length > 0) {
    const err = doc.errors[0];
    const linePos = err.linePos?.[0];
    if (linePos && Number.isFinite(linePos.line) && Number.isFinite(linePos.col)) {
      throw new Error(
        `Skill YAML format is invalid at line ${linePos.line}, col ${linePos.col}. Please check the Frontmatter YAML.`,
      );
    }
    throw new Error(`Skill YAML format is invalid. Please check the Frontmatter YAML.`);
  }

  const data = doc.toJS({}) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Frontmatter must be a YAML mapping (key/value object).");
  }
  const record = data as Record<string, unknown>;

  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!name) {
    throw new Error("Frontmatter is missing required field: name.");
  }
  if (!description) {
    throw new Error("Frontmatter is missing required field: description.");
  }
  if (name.length > 64 || !SKILL_NAME_REGEX.test(name)) {
    throw new Error(
      "'name' must be kebab-case, 1-64 chars: lowercase letters/digits separated by single hyphens, no leading/trailing '-' and no '--'.",
    );
  }
  if (description.length < 1 || description.length > 1024) {
    throw new Error("'description' must be 1-1024 characters.");
  }
  if (record.license !== undefined && typeof record.license !== "string") {
    throw new Error("'license' must be a string when provided.");
  }
  if (record.compatibility !== undefined && typeof record.compatibility !== "string") {
    throw new Error("'compatibility' must be a string when provided.");
  }
  if (record.metadata !== undefined) {
    if (!record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata)) {
      throw new Error("'metadata' must be a mapping of string keys to string values.");
    }
    for (const [k, v] of Object.entries(record.metadata as Record<string, unknown>)) {
      if (typeof k !== "string" || typeof v !== "string") {
        throw new Error("'metadata' must be a mapping of string keys to string values.");
      }
    }
  }
  if (opts?.expectedName && name !== opts.expectedName) {
    throw new Error(
      `Skill folder name '${opts.expectedName}' must match the 'name' '${name}' declared in SKILL.md.`,
    );
  }
  return { name, description };
}
