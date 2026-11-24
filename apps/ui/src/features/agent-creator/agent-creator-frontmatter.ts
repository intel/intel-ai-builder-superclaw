import { Document, isMap, isNode, isScalar, parseDocument, type Pair, type Scalar } from "yaml";

import { frontmatterFileForPreview } from "~/shared/util/frontmatter-preview";

// Edits one frontmatter value of an existing agent file in place. The edit form
// must not round-trip through parseUploadedAgentMarkdown -> generateAgentMarkdown:
// that parser does not read tools, skills or the permission map, so regenerating
// would silently wipe them. Every byte outside the description pair is kept.

// Same header capture as validateAgentMarkdown, so both see the same frontmatter.
const FRONTMATTER = /^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n|$)[\s\S]*)$/;

const INVALID_FORMAT = "Invalid Agent Markdown format. Add a frontmatter block between '---' lines.";
const INVALID_YAML = "Agent YAML format is invalid. Please check the Frontmatter YAML.";
const NOT_A_MAPPING = "Frontmatter must be a YAML mapping (key/value object).";
export const AGENT_FORM_UNSUPPORTED = "The form cannot edit this file's YAML. Edit it in Markdown.";

type ParsedFrontmatter = {
  prefix: string;
  header: string;
  suffix: string;
  doc: Document.Parsed;
  pair: Pair | undefined;
};

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER);
  if (!match) throw new Error(INVALID_FORMAT);
  const header = match[2] ?? "";
  const doc = parseDocument(header, { uniqueKeys: false });
  if (doc.errors.length > 0) throw new Error(INVALID_YAML);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error(NOT_A_MAPPING);
  // With duplicate keys the last one wins in validateAgentMarkdown's toJS().
  const pairs = doc.contents?.items ?? [];
  const pair = [...pairs].reverse().find((item) => isScalar(item.key) && item.key.value === "description");
  return { prefix: match[1], header, suffix: match[3] ?? "", doc, pair };
}

// Resolved through toJS() like validateAgentMarkdown, so aliases are followed.
function descriptionValue(doc: Document.Parsed): string {
  const value = (doc.toJS({}) as { description?: unknown } | null)?.description;
  return typeof value === "string" ? value : "";
}

/**
 * The description as YAML parses it, or "" if absent. Throws on unparseable
 * frontmatter, and with AGENT_FORM_UNSUPPORTED when an edit could not be
 * written back (a flow mapping, an anchor other keys refer to): such files
 * are edited in Markdown rather than failing at save.
 */
export function readAgentDescription(content: string): string {
  const description = descriptionValue(parseFrontmatter(content).doc);
  for (const probe of ["x", "x\ny"]) {
    try {
      patchAgentDescription(content, probe);
    } catch {
      throw new Error(AGENT_FORM_UNSUPPORTED);
    }
  }
  return description;
}

// The indentation of the line `offset` is on, when only spaces precede it.
function indentAt(header: string, offset: number): string {
  const lead = header.slice(header.lastIndexOf("\n", offset - 1) + 1, offset);
  return /^ *$/.test(lead) ? lead : "";
}

// Keep the author's style. Plain and single-quoted scalars spread over several
// lines are hard to read, so a multi-line value moves them to a literal block,
// the style generateAgentMarkdown writes.
function descriptionStyle(previous: Scalar.Type | undefined, value: string): Scalar.Type {
  const multiline = value.includes("\n");
  if (previous === undefined || previous === "PLAIN" || previous === "QUOTE_SINGLE") {
    return multiline ? "BLOCK_LITERAL" : (previous ?? "PLAIN");
  }
  return previous;
}

// yaml places the comment where the style allows it: after a plain or quoted
// value, or on a block scalar's indicator line.
function emitDescriptionPair(value: string, style: Scalar.Type, comment: string | null | undefined): string {
  const doc = new Document({ description: value });
  const node = doc.get("description", true) as Scalar;
  node.type = style;
  if (comment) node.comment = comment;
  return doc.toString({ lineWidth: 0 }).replace(/\n$/, "");
}

/**
 * Replace the frontmatter `description` value in place, keeping its YAML style
 * and the file's line endings. Returns `content` unchanged when the value is
 * already `description`.
 */
export function patchAgentDescription(content: string, description: string): string {
  const { prefix, header, suffix, doc, pair } = parseFrontmatter(content);
  if (pair && descriptionValue(doc) === description) return content;

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const previousValue = pair?.value;
  const previous = isScalar(previousValue) ? previousValue : undefined;
  const style = descriptionStyle(previous?.type, description);
  const keyRange = pair && isScalar(pair.key) ? pair.key.range : undefined;
  // A root mapping may be indented; block content must sit deeper than its key.
  const firstKey = isMap(doc.contents) ? doc.contents.items[0]?.key : undefined;
  const keyStart = keyRange?.[0] ?? (isNode(firstKey) ? firstKey?.range?.[0] : undefined);
  const indent = keyStart === undefined ? "" : indentAt(header, keyStart);
  const line = emitDescriptionPair(description, style, previous?.comment).split("\n").join(eol + indent);

  let nextHeader: string;
  if (pair && keyRange) {
    // The node end covers the value's trailing comment, which is re-emitted,
    // and its line break, which is kept.
    const nodeEnd = isNode(pair.value) ? pair.value.range?.[2] : undefined;
    let end = Math.max(keyRange[1], nodeEnd ?? keyRange[1]);
    while (end > keyRange[1] && (header[end - 1] === "\n" || header[end - 1] === "\r")) end -= 1;
    nextHeader = header.slice(0, keyRange[0]) + line + header.slice(end);
  } else {
    nextHeader = `${indent}${line}${eol}${header}`;
  }

  const next = prefix + nextHeader + suffix;
  if (!changesOnlyDescription(doc, parseFrontmatter(next).doc, description)) {
    throw new Error(AGENT_FORM_UNSUPPORTED);
  }
  return next;
}

// Every other key must resolve as before: an alias can point at the replaced
// value, or at an earlier anchor of the same name that the old value shadowed.
function changesOnlyDescription(before: Document.Parsed, after: Document.Parsed, description: string): boolean {
  try {
    return descriptionValue(after) === description && otherKeys(after) === otherKeys(before);
  } catch {
    return false;
  }
}

function otherKeys(doc: Document.Parsed): string {
  const data = { ...(doc.toJS({}) as Record<string, unknown> | null) };
  delete data.description;
  return JSON.stringify(data);
}

/**
 * An agent file as Markdown for the read-only preview: the description as
 * plain text, then the shared preview of the rest (the prompt, then the other
 * frontmatter keys as YAML). Files whose description cannot be lifted out
 * cleanly are previewed whole.
 */
export function agentFileForPreview(content: string): string {
  try {
    const { prefix, header, suffix, doc, pair } = parseFrontmatter(content);
    const description = descriptionValue(doc).trim();
    const keyRange = pair && isScalar(pair.key) ? pair.key.range : undefined;
    if (pair && keyRange && description) {
      // From the start of the key's line through the value's line break; the
      // last key has none of its own, so the break before it goes instead.
      let start = header.lastIndexOf("\n", keyRange[0] - 1) + 1;
      const end = (isNode(pair.value) ? pair.value.range?.[2] : undefined) ?? keyRange[1];
      if (end >= header.length && start > 0) {
        start -= 1;
        if (header[start - 1] === "\r") start -= 1;
      }
      const rest = prefix + header.slice(0, start) + header.slice(end) + suffix;
      // Line-based removal is wrong for a flow mapping, and other keys may
      // alias the description, so the rest must resolve exactly as before.
      const after = parseFrontmatter(rest);
      if (isMap(after.doc.contents) && !after.pair && otherKeys(after.doc) === otherKeys(doc)) {
        return `${plainTextAsMarkdown(description)}\n\n---\n\n${frontmatterFileForPreview(rest)}`;
      }
    }
  } catch {
    // Unparseable or unresolvable YAML is shown as written, for repair.
  }
  return frontmatterFileForPreview(content);
}

// Escapes Markdown punctuation and keeps line breaks, so the description reads
// as it does on the agent card.
function plainTextAsMarkdown(text: string): string {
  return text
    .split(/\n[ \t]*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim().replace(/[\\`*_{}[\]()#+\-.!|<>~&=]/g, "\\$&"))
        .join("\\\n"),
    )
    .join("\n\n");
}
