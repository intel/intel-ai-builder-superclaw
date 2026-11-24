import { marked } from "marked";

/**
 * A Markdown file's YAML frontmatter (group 1) and body (group 2). Blank lines
 * after the closing `---` are dropped (the skill editor writes one back on
 * save), but indentation on the body's first line is kept.
 */
export const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n(?:[ \t]*\r?\n)*|$)([\s\S]*)$/;

/**
 * A frontmatter file (SKILL.md, an agent .md) as Markdown for a read-only
 * preview: the body, then the frontmatter as a fenced YAML block. Left
 * unfenced, the frontmatter's closing `---` would turn the YAML lines above it
 * into a setext heading.
 */
export function frontmatterFileForPreview(content: string): string {
  const match = content.match(FRONTMATTER);
  if (!match) return content;
  const body = closeDanglingFence((match[2] ?? "").trimEnd());
  const frontmatter = match[1].trim();
  const backtickRuns = frontmatter.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...backtickRuns.map((run) => run.length + 1)));
  const yaml = `${fence}yaml\n${frontmatter}\n${fence}\n`;
  return body ? `${body}\n\n---\n\n${yaml}` : yaml;
}

/**
 * A fenced code block left open runs to the end of the document, which would
 * pull the appended rule and frontmatter into it. Only a top-level fence can:
 * one inside a list or blockquote ends with its container at the rule.
 */
function closeDanglingFence(body: string): string {
  const tokens = marked.lexer(body);
  const last = tokens[tokens.length - 1];
  if (last?.type !== "code" || last.codeBlockStyle === "indented") return body;
  const opening = last.raw.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
  if (!opening) return body;
  const lines = last.raw.trimEnd().split("\n");
  const closing = lines.length > 1 ? lines[lines.length - 1].replace(/^ {0,3}/, "").trimEnd() : "";
  const closed = closing.length >= opening.length && [...closing].every((char) => char === opening[0]);
  return closed ? body : `${body}\n${opening}`;
}
