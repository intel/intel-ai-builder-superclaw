const TABLE_RE = /^(\|.*\|(?:\n\|[\s:|-]*\|)(?:\n\|.*\|)*)$/m;
const CODE_FENCE_RE = /```[\s\S]*?```/;
const HEADER_RE = /^(#{1,3})\s+(.+)$/;
const DIVIDER_RE = /^\s{0,3}(?:---|\*\*\*|___)\s*$/;

const MAX_HEADER_TEXT = 150;
const MAX_MARKDOWN_TEXT = 12_000;
const MAX_BLOCKS = 45;

function stripMarkdownFormatting(text: string): string {
  // Strip bold: **text** → text
  let result = text.replace(/\*\*([^\*]+)\*\*/g, "$1");
  // Strip underline: __text__ → text
  result = result.replace(/__([^_]+)__/g, "$1");
  // Strip strikethrough: ~~text~~ → text
  result = result.replace(/~~([^~]+)~~/g, "$1");
  // Strip inline code: `text` → text (but NOT triple backticks)
  result = result.replace(/`([^`]+)`/g, "$1");
  // Strip italic single asterisk: *text* → text
  result = result.replace(/\*([^\*]+)\*/g, "$1");
  // Strip italic single underscore: _text_ → text
  result = result.replace(/_([^_]+)_/g, "$1");
  return result;
}

type SlackBlock =
  | {
      type: "header";
      text: { type: "plain_text"; text: string; emoji: true };
    }
  | { type: "divider" }
  | { type: "markdown"; text: string };

export function isComplex(text: string): boolean {
  if (!text || !text.trim()) {
    return false;
  }

  if (TABLE_RE.test(text)) {
    return true;
  }
  if (CODE_FENCE_RE.test(text)) {
    return true;
  }
  if (/^\s*```/m.test(text)) {
    return true;
  }
  if (/^#{1,3}\s+\S/m.test(text)) {
    return true;
  }
  if (/^\s{0,3}(?:---|\*\*\*|___)\s*$/m.test(text)) {
    return true;
  }

  return false;
}

export function markdownToBlocks(text: string): object[] | null {
  if (!text || !text.trim()) {
    return null;
  }

  const blocks: SlackBlock[] = [];
  const markdownBuffer: string[] = [];
  const lines = text.split(/\r?\n/);
  let idx = 0;

  const flushMarkdown = () => {
    if (markdownBuffer.length === 0) {
      return;
    }
    const content = markdownBuffer.join("\n").replace(/^\n+|\n+$/g, "");
    markdownBuffer.length = 0;
    if (!content) {
      return;
    }
    appendMarkdown(blocks, content);
  };

  while (idx < lines.length) {
    const line = lines[idx] ?? "";
    const headerMatch = line.match(HEADER_RE);
    if (headerMatch) {
      flushMarkdown();
      const raw = stripMarkdownFormatting((headerMatch[2] ?? "").trim());
      const headerText =
        raw.length > MAX_HEADER_TEXT ? `${raw.slice(0, MAX_HEADER_TEXT - 1)}…` : raw;

      if (headerText) {
        blocks.push({
          type: "header",
          text: {
            type: "plain_text",
            text: headerText,
            emoji: true,
          },
        });
      }

      idx += 1;
      continue;
    }

    if (DIVIDER_RE.test(line)) {
      flushMarkdown();
      blocks.push({ type: "divider" });
      idx += 1;
      continue;
    }

    if (/^\s*```/.test(line)) {
      flushMarkdown();
      const fenceLines = [line];
      idx += 1;
      while (idx < lines.length) {
        const nextLine = lines[idx] ?? "";
        fenceLines.push(nextLine);
        if (/^\s*```\s*$/.test(nextLine)) {
          idx += 1;
          break;
        }
        idx += 1;
      }
      appendMarkdown(blocks, fenceLines.join("\n"));
      continue;
    }

    if (line.trimStart().startsWith("|")) {
      const tableLines = [line];
      let j = idx + 1;
      while (j < lines.length && (lines[j] ?? "").trimStart().startsWith("|")) {
        tableLines.push(lines[j] ?? "");
        j += 1;
      }

      const candidate = tableLines.join("\n");
      if (TABLE_RE.test(candidate)) {
        flushMarkdown();
        appendMarkdown(blocks, candidate);
        idx = j;
        continue;
      }
    }

    markdownBuffer.push(line);
    idx += 1;
  }

  flushMarkdown();

  if (blocks.length === 0) {
    return null;
  }

  if (blocks.length > MAX_BLOCKS) {
    const truncated = blocks.slice(0, MAX_BLOCKS - 1);
    truncated.push({ type: "markdown", text: "(truncated — full response in thread)" });
    return truncated as object[];
  }

  return blocks as object[];
}

function appendMarkdown(blocks: SlackBlock[], text: string): void {
  const parts = splitMarkdown(text, MAX_MARKDOWN_TEXT);
  for (const part of parts) {
    if (blocks.length >= MAX_BLOCKS) {
      return;
    }

    const last = blocks[blocks.length - 1];
    if (last?.type === "markdown") {
      const candidate = `${last.text}\n\n${part}`.trim();
      if (candidate.length <= MAX_MARKDOWN_TEXT) {
        last.text = candidate;
        continue;
      }
    }

    blocks.push({ type: "markdown", text: part });
  }
}

function splitMarkdown(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitAt <= 0) {
      splitAt = maxLen;
    }

    const chunk = remaining.slice(0, splitAt).replace(/^\n+|\n+$/g, "");
    if (chunk) {
      chunks.push(chunk);
    }

    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  return chunks;
}
