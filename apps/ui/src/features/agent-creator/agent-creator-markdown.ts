import { t } from "../../i18n";

export type AgentMarkdownFormData = {
  description: string;
  systemPrompt: string;
  selectedTools: string[];
  selectedSkills: string[];
  askTools?: string[];
  protectedFilePipelineEnabled?: boolean;
};

// Pure tool classification, shared by the create-agent category UI
// (agent-creator.tsx) and its unit tests. Kept in this dependency-free module
// (rather than the .tsx component) so it can be imported by bun:test without
// pulling in solid-js/lucide-solid, which require a client rendering context.
export function classifyToolCategory(name: string): string | null {
  if (/^(read|edit|write|list|glob|grep|bash|parse_pdf|ocr)$/.test(name)) {
    return "file-code-engine";
  }
  // local_dr_* readers/query are intentionally hidden by server-side catalog
  // filtering. If that filter ever drifts, categorize them under file-code-engine
  // (instead of leaving them uncategorized/auto-included) so users can still
  // see and disable them explicitly in the creator UI.
  if (/^(local_dr_read_|local_dr_query_table)/.test(name)) return "file-code-engine";
  if (/^(run_email_pipeline|email_send|email_reply|schedule_meeting)$/.test(name)) {
    return "email-calendar-operations";
  }
  if (/^(sc_search_web|sc_fetch_url|webfetch)$/.test(name)) {
    return "web-research-retrieval";
  }
  return null;
}

export function classifyToolRisk(name: string): "low" | "high" {
  if (
    /^(edit|write|bash|email_send|email_reply|schedule_meeting|doom_loop|parse_pdf|automation_create|automation_remove)$/.test(name)
  ) {
    return "high";
  }
  return "low";
}

// Declarative skill -> tool dependencies used by the creator UI.
// Keep this separate from risk classification so the UI can express
// "does this skill need bash?" independently from "is this skill high risk?".
export const SKILL_REQUIRED_TOOLS: Record<string, string[]> = {
  docx: ["bash"],
  "docx-create": ["bash"],
  github: ["bash"],
  pptx: ["bash"],
  "pptx-create": ["bash"],
  spreadsheet: ["bash"],
};

export function requiredToolsFromSkills(skillNames: string[]): string[] {
  const required: string[] = [];
  for (const skillName of skillNames) {
    const tools = SKILL_REQUIRED_TOOLS[skillName] ?? [];
    for (const toolName of tools) required.push(toolName);
  }
  return [...new Set(required)];
}

// classifySkillCategory — skills are gated by the creator capability
// categories as tools. Builtin skills that return null here are auto-included
// for all user-created agents; skills that return a category are only included
// when the user enables that category.
export function classifySkillRisk(name: string): "low" | "high" {
  if (/^(email|docx|docx-create|github|pptx|pptx-create|spreadsheet)$/.test(name)) return "high";
  return "low";
}

export function classifySkillCategory(name: string): string | null {
  if (/^(pdf|docx|docx-create|pptx|pptx-create|spreadsheet)$/.test(name)) return "file-code-engine";
  if (/^(email)$/.test(name)) return "email-calendar-operations";
  // Safety and security review skills guard bash/file/shell operations, and
  // github drives the `gh` CLI — none are usable without file-code-engine
  // capabilities. Returning a category keeps them opt-in; returning null would
  // auto-include them in every user-created agent, including ones that cannot
  // run them.
  if (/^(local-safety-guard|local-security-review|github)$/.test(name)) return "file-code-engine";
  return null;
}

// Capability categories that the live catalog can actually back on this
// machine. The catalog is served from /config/opencode, which holds the
// published Product Profile — so a Profile that ships no email tools and no
// email skills (today: `lite`/`standard`) yields no
// "email-calendar-operations" entry here, and the creator UI drops that card
// instead of offering a package that would select nothing.
//
// Derived from the catalog rather than the Profile directly: the UI must not
// re-resolve capability policy from Profile/model identity (that's ServiceHub's
// job), and the catalog already reflects the active Profile.
export function availableCategoryIds(
  toolNames: readonly string[],
  skillNames: readonly string[],
): Set<string> {
  const ids = new Set<string>();
  for (const name of toolNames) {
    const category = classifyToolCategory(name);
    if (category) ids.add(category);
  }
  for (const name of skillNames) {
    const category = classifySkillCategory(name);
    if (category) ids.add(category);
  }
  return ids;
}

// doom_loop is an OpenCode internal mechanism (loop detection), not a
// user-facing capability. Exclude it from the capability preamble so the
// model's "available tools" list only shows tools the model actually calls.
const PREAMBLE_EXCLUDED_TOOLS = new Set(["doom_loop"]);
const SENSITIVE_FILE_INTERNAL_TOOLS = new Set([
  "confirm_file_protection",
  "run_protected_file_pipeline",
  "local_sensitive_read",
]);

// Generates explicit tool and skill lists for the agent's system prompt.
// Makes the capability boundary unambiguous so the model knows exactly what
// it can and cannot do, mirroring the shipped websearch-agent pattern
// ("Your ONLY tools are sc_search_web and sc_fetch_url"). Skills are listed separately so the
// model knows it can call skill() for those names.
export function generateCapabilityPreamble(
  selectedTools: string[],
  selectedSkills: string[],
  protectedFilePipelineEnabled = false,
): string {
  const visibleTools = selectedTools.filter(
    (name) => !PREAMBLE_EXCLUDED_TOOLS.has(name) && !SENSITIVE_FILE_INTERNAL_TOOLS.has(name),
  );
  if (protectedFilePipelineEnabled) visibleTools.push("confirm_file_protection");

  const toolLine = visibleTools.length === 0
    ? "You have no special tools available."
    : `Your available tools are limited to: ${visibleTools.join(", ")}.`;

  const skillLine = selectedSkills.length > 0
    ? `Your available skills are limited to: ${selectedSkills.join(", ")}. You can call skill() only for these names.`
    : "";

  return [toolLine, skillLine].filter(Boolean).join("\n");
}

// Injected at the START of every user-created agent's system prompt,
// immediately after the capability preamble. Purely behavioral — no tool
// names, no capability categories, no double-negations. The preamble already
// states the positive lists; this guard only covers the "missing tool/skill" case.
export const AGENT_CAPABILITY_GUARD =
  "If asked to perform an action that requires a tool or skill not in your lists above, " +
  "respond immediately: \"I cannot do this because I don't have [the required tool/skill].\" " +
  "Stop there — do not loop.";

const PROTECTED_FILE_ACCESS_DESCRIPTION = [
  "## Protected File Access",
  "For supported user-provided files that may contain sensitive data (.csv, .xlsx, .xls, .parquet, .txt, .md, .html, .htm, or .docx):",
  "1. Call `confirm_file_protection` first with the original request and exact source path(s). Do not read or send the original file to another tool first.",
  "2. Only after it returns `APPROVED`, call `task` for `protected-file-agent` with the original request. That agent runs the protection pipeline and handles masked-output review and response restoration. Do not call `run_protected_file_pipeline` directly or analyze the original file yourself.",
  "3. If it returns `ACTION_DENIED`, `PROTECTION_DECLINED`, or `PROTECTION_DISABLED`, call `task` for `local-file-agent` with the original request and exact source path(s). After a decline, first tell the user that protection was declined and processing will continue without masking via `local-file-agent`. Include the model/locality notice returned by `confirm_file_protection`. This fallback applies only to the current request. For each new request, call `confirm_file_protection` again before delegating.",
  "4. For any other result, including `PROTECTION_FILE_TOO_LARGE` or `PROTECTION_PREFLIGHT_FAILED`, stop and report the error; do not delegate file processing.",
  "5. If protection fails or masked-output review is cancelled, stop and tell the user. Never continue with the original file or use an unprotected fallback.",
].join("\n");

const PROTECTED_FILE_CAPABILITY_GUARD =
  "Do not use tools or skills outside your lists above. The only exception is the file routing above: " +
  "call `task` for `protected-file-agent` only after `APPROVED`, or `local-file-agent` only after `ACTION_DENIED`, `PROTECTION_DECLINED`, or `PROTECTION_DISABLED`. " +
  "For any other " +
  "missing tool or skill, respond immediately: \"I cannot do this because I don't have [the required tool/skill].\" " +
  "Stop there — do not loop or delegate other work.";

export function ensureAgentMarkdownMode(markdown: string, defaultMode: "primary" | "subagent" | "all" = "primary"): string {
  const content = markdown.replace(/^\uFEFF/, "");
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(\s*(?:\r?\n[\s\S]*)?)?$/);
  if (!match) {
    return content;
  }

  const header = match[1] ?? "";
  if (/^\s*mode\s*:/im.test(header)) {
    return content;
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const suffix = match[2] ?? "";
  const nextHeader = `${header}${eol}mode: ${defaultMode}`;
  return `---${eol}${nextHeader}${eol}---${suffix}`;
}

export function generateAgentMarkdown(agent: AgentMarkdownFormData): string {
  const protectedFilePipelineEnabled = agent.protectedFilePipelineEnabled === true;
  // An agent sees only the MCP servers it allows, so without one get_mcp_status always reports none.
  const allowsMcpServer = agent.selectedTools.some((name) => name.endsWith("_*"));
  const selectedTools = [...new Set(agent.selectedTools)]
    .filter((name) => !SENSITIVE_FILE_INTERNAL_TOOLS.has(name))
    .filter((name) => name !== "get_mcp_status" || allowsMcpServer)
    .sort((a, b) => a.localeCompare(b));
  const selectedSkills = [...new Set(agent.selectedSkills)].sort((a, b) => a.localeCompare(b));
  const askTools = new Set((agent.askTools ?? []).filter((name) => selectedTools.includes(name)));

  const lines: string[] = ["---"];

  const description = agent.description.trim();
  if (description) {
    lines.push("description: |-");
    for (const line of description.split(/\r?\n/)) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("mode: primary");

  lines.push("permission:");
  lines.push('  "*": deny');

  const toolPermissionNames = protectedFilePipelineEnabled
    ? [...selectedTools, "confirm_file_protection"].sort((a, b) => a.localeCompare(b))
    : selectedTools;
  for (const toolName of toolPermissionNames) {
    const permission = toolName === "confirm_file_protection" || askTools.has(toolName) ? "ask" : "allow";
    lines.push(`  "${toolName}": ${permission}`);
  }

  lines.push("  skill:");
  lines.push('    "*": deny');
  for (const skillName of selectedSkills) {
    lines.push(`    "${skillName}": allow`);
  }

  // User-created agents cannot delegate by default; this opt-in grants only
  // the protected-file route and its local fallback.
  lines.push("  task:");
  lines.push('    "*": deny');
  if (protectedFilePipelineEnabled) {
    lines.push('    "protected-file-agent": allow');
    lines.push('    "local-file-agent": allow');
  }

  lines.push("---");
  lines.push("");

  // Capability preamble and guard precede user instructions; the protected
  // access flow is added only when the user explicitly enables it.
  lines.push(generateCapabilityPreamble(selectedTools, selectedSkills, protectedFilePipelineEnabled));
  lines.push("");
  if (protectedFilePipelineEnabled) {
    lines.push(PROTECTED_FILE_ACCESS_DESCRIPTION);
    lines.push("");
  }
  lines.push(protectedFilePipelineEnabled ? PROTECTED_FILE_CAPABILITY_GUARD : AGENT_CAPABILITY_GUARD);
  lines.push("");

  const userPrompt = agent.systemPrompt.trim();
  if (userPrompt) {
    lines.push(userPrompt);
    lines.push("");
  }

  return lines.join("\n");
}

const parseYamlScalar = (raw: string): string => {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(\\|"|n|r|t)/g, (_match, code: string) => {
      switch (code) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "\\":
          return "\\";
        case '"':
          return '"';
        default:
          return code;
      }
    });
  }

  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  return value;
};

const foldYamlText = (lines: string[]): string => {
  if (!lines.length) return "";
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(line.trim());
  }

  if (current.length) {
    paragraphs.push(current.join(" "));
  }

  return paragraphs.join("\n\n");
};

export const parseUploadedAgentMarkdown = (raw: string, fileName: string) => {
  const content = raw.replace(/^\uFEFF/, "");
  const delimiterMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/);
  if (!delimiterMatch) {
    return {
      name: "",
      description: "",
      systemPrompt: "",
      invalidFields: [t("agents.field_frontmatter")],
    };
  }

  const header = delimiterMatch[1] ?? "";
  const body = (delimiterMatch[2] ?? "").trim();
  const headerLines = header.split(/\r?\n/);
  let parsedName = "";
  let parsedDescription = "";

  for (let i = 0; i < headerLines.length; i += 1) {
    const line = headerLines[i];
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const rawValue = match[2] ?? "";

    if (key === "name") {
      parsedName = parseYamlScalar(rawValue).trim();
      continue;
    }

    if (key !== "description") {
      continue;
    }

    const trimmedValue = rawValue.trim();
    if (trimmedValue === "|" || trimmedValue === "|-" || trimmedValue === ">" || trimmedValue === ">-") {
      const blockLines: string[] = [];
      while (i + 1 < headerLines.length) {
        const next = headerLines[i + 1];
        if (!next.trim()) {
          blockLines.push("");
          i += 1;
          continue;
        }
        if (/^\s{2,}/.test(next)) {
          blockLines.push(next.replace(/^\s{2}/, ""));
          i += 1;
          continue;
        }
        break;
      }

      parsedDescription = (trimmedValue.startsWith(">") ? foldYamlText(blockLines) : blockLines.join("\n")).trim();
      continue;
    }

    parsedDescription = parseYamlScalar(rawValue).trim();
  }

  const normalizedName = parsedName.trim() || fileName.replace(/\.md$/i, "").trim();
  const invalidFields: string[] = [];

  if (!normalizedName) {
    invalidFields.push(t("agents.field_name"));
  }
  if (!parsedDescription) {
    invalidFields.push(t("agents.field_description"));
  }
  if (!body) {
    invalidFields.push(t("agents.field_system_prompt"));
  }

  return {
    name: normalizedName,
    description: parsedDescription,
    systemPrompt: body,
    invalidFields,
  };
};
