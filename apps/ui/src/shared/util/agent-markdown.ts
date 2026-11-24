import { parseDocument } from "yaml";

const AGENT_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const ALLOWED_MODES = new Set(["primary", "subagent", "all"]);
const ALLOWED_PERMISSIONS = new Set(["allow", "ask", "deny"]);

export type ValidatedAgentMarkdown = {
  name?: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  systemPrompt: string;
};

function parsePermissionScalar(path: string, value: unknown): void {
  if (typeof value !== "string") {
    throw new Error(`Permission at '${path}' must be one of: allow, ask, deny.`);
  }
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_PERMISSIONS.has(normalized)) {
    throw new Error(`Permission at '${path}' must be one of: allow, ask, deny.`);
  }
}

function validatePermissionNode(path: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    parsePermissionScalar(path, value);
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  for (const [nestedKey, nestedValue] of entries) {
    if (!nestedKey.trim()) {
      throw new Error("Permission keys cannot be empty.");
    }
    validatePermissionNode(`${path}.${nestedKey}`, nestedValue);
  }
}

export function validateAgentMarkdown(content: string): ValidatedAgentMarkdown {
  const raw = String(content ?? "");
  const fmMatch = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!fmMatch) {
    throw new Error("Invalid Agent Markdown format. Add a frontmatter block between '---' lines.");
  }

  const frontmatterText = fmMatch[1] ?? "";
  const doc = parseDocument(frontmatterText, { prettyErrors: false, uniqueKeys: false });
  if (doc.errors.length > 0) {
    const err = doc.errors[0];
    const linePos = err.linePos?.[0];
    if (linePos && Number.isFinite(linePos.line) && Number.isFinite(linePos.col)) {
      throw new Error(
        `Agent YAML format is invalid at line ${linePos.line}, col ${linePos.col}. Please check the Frontmatter YAML.`,
      );
    }
    throw new Error("Agent YAML format is invalid. Please check the Frontmatter YAML.");
  }

  const data = doc.toJS({}) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Frontmatter must be a YAML mapping (key/value object).");
  }
  const record = data as Record<string, unknown>;

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name && !AGENT_NAME_REGEX.test(name)) {
    throw new Error("'name' may contain only letters, numbers, hyphens, and underscores.");
  }

  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!description) {
    throw new Error("Frontmatter is missing required field: description.");
  }
  if (description.length > 1024) {
    throw new Error("'description' must be 1-1024 characters.");
  }

  const modeRaw = typeof record.mode === "string" ? record.mode.trim() : "";
  if (!modeRaw) {
    throw new Error("Frontmatter is missing required field: mode.");
  }
  if (!ALLOWED_MODES.has(modeRaw)) {
    throw new Error("'mode' must be one of: primary, subagent, all.");
  }

  const permission = record.permission;
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
    throw new Error("Frontmatter is missing required field: permission mapping.");
  }
  const permissionRecord = permission as Record<string, unknown>;
  for (const [key, value] of Object.entries(permissionRecord)) {
    if (!key.trim()) {
      throw new Error("Permission keys cannot be empty.");
    }
    validatePermissionNode(`permission.${key}`, value);
  }

  const body = raw.slice(fmMatch[0].length).trim();
  if (!body) {
    throw new Error("System prompt body cannot be empty.");
  }

  return {
    name: name || undefined,
    description,
    mode: modeRaw as "primary" | "subagent" | "all",
    systemPrompt: body,
  };
}