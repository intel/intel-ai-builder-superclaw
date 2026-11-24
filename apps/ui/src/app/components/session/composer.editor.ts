import { X } from "lucide-solid";
import type { ComposerAttachment, ComposerDraft, ComposerPart, PromptMode } from "../../types";
import type { SlashCommandOption } from "../../types";
import { isServer } from "solid-js/web";

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const normalizeText = (value: string) => value.replace(/\u00a0/g, " ");

export const readEditorText = (editor: HTMLElement | undefined) =>
  normalizeText(editor?.textContent ?? "");

export const RECENT_EMIT_TTL_MS = 30_000;

export const MAX_RECENT_EMITS = 400;

/**
 * Recent emits, to tell an echo of the composer's own draft from an external
 * update. Bounded and time-windowed so stale echoes cannot win races.
 */
export const createRecentEmits = () => {
  const recentEmits = new Map<string, number>();
  const remember = (value: string) => {
    const now = Date.now();
    if (recentEmits.has(value)) {
      recentEmits.delete(value);
    }
    recentEmits.set(value, now);

    for (const [key, timestamp] of recentEmits) {
      if (now - timestamp <= RECENT_EMIT_TTL_MS) break;
      recentEmits.delete(key);
    }

    while (recentEmits.size > MAX_RECENT_EMITS) {
      const oldest = recentEmits.keys().next();
      if (oldest.done) break;
      recentEmits.delete(oldest.value);
    }
  };
  return {
    has: (value: string) => recentEmits.has(value),
    remember,
    reset: (value: string) => {
      recentEmits.clear();
      remember(value);
    },
  };
};

export const DRAFT_FLUSH_DEBOUNCE_MS = 500;

export const MIN_DRAFT_FLUSH_DELAY_MS = 100;

export const partsToText = (parts: ComposerPart[]) =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "agent") return `@${part.name}`;
      if (part.type === "file") return `@${part.path}`;
      return part.label;
    })
    .join("");

/** The space typed after a chip can collapse in the editor, gluing the prompt to the mention. */
const needsSeparatorAfterMention = (next: ComposerPart | undefined) =>
  next !== undefined &&
  (next.type !== "text" || /^[\p{L}\p{N}_]/u.test(next.text));

export const partsToResolvedText = (parts: ComposerPart[]) =>
  parts
    .map((part, index) => {
      if (part.type === "text") return part.text;
      if (part.type === "paste") return part.text;
      const mention = part.type === "agent" ? `@${part.name}` : `@${part.path}`;
      return needsSeparatorAfterMention(parts[index + 1]) ? `${mention} ` : mention;
    })
    .join("");

export const draftFromParts = (
  mode: PromptMode,
  parts: ComposerPart[],
  attachments: ComposerAttachment[],
): ComposerDraft => ({
  mode,
  parts,
  attachments,
  text: normalizeText(partsToText(parts)),
  resolvedText: normalizeText(partsToResolvedText(parts)),
});

export const MENTION_CLASS =
  "inline-flex items-center rounded-pill px-2 py-0.5 text-label font-medium bg-dls-panel-badge-bg text-dls-panel-text border border-dls-panel-badge-border";

export const FILE_MENTION_CLASS =
  "inline-flex max-w-[240px] items-center gap-1 rounded-compact border border-dls-border bg-dls-surface px-1.5 py-0.5 align-middle text-label font-medium text-dls-text";

/** The muted "· Text" after a file pill's name. */
export const FILE_MENTION_TYPE_CLASS = "shrink-0 font-normal text-dls-muted";

export const createMentionSpan = (
  part: Extract<ComposerPart, { type: "agent" | "file" }>,
) => {
  const span = document.createElement("span");
  const label = part.type === "agent" ? part.name : (part.label ?? part.path);
  span.contentEditable = "false";
  span.dataset.mentionKind = part.type;
  span.dataset.mentionValue = part.type === "agent" ? part.name : part.path;
  span.dataset.mentionLabel = label;
  if (part.type === "agent") {
    span.textContent = `@${label}`;
    span.className = MENTION_CLASS;
    return span;
  }
  const name = label.split(/[\\/]/).pop() || label;
  // lucide-solid cannot even load under Solid's server build, which `bun test` resolves.
  if (!isServer) {
    void import("./composer.mention-icon").then(
      ({ fileMentionIcon, fileMentionTypeLabel }) => {
        const icon = fileMentionIcon(name);
        if (icon) span.prepend(icon);
        const type = document.createElement("span");
        type.className = FILE_MENTION_TYPE_CLASS;
        type.textContent = `· ${fileMentionTypeLabel(name)}`;
        span.append(type);
      },
      () => undefined,
    );
  }
  const text = document.createElement("span");
  text.className = "truncate";
  text.textContent = name;
  span.appendChild(text);
  span.title = name;
  span.className = FILE_MENTION_CLASS;
  return span;
};
export const createSlashSpan = (cmd: SlashCommandOption) => {
  const span = document.createElement("span");
  span.textContent = `/${cmd.name}`;
  span.contentEditable = "false";
  span.dataset.slashCommand = cmd.name;
  span.dataset.slashSource = cmd.source ?? "command";
  span.title = cmd.source ? `${cmd.source} command` : "command";

  const tone = cmd.source === "skill"
    ? "bg-dls-selection-soft-bg/60 text-dls-selection-text border-dls-selection/30"
    : cmd.source === "mcp"
      ? "bg-dls-secondary-accent-bg text-dls-secondary-accent-text border-dls-secondary-accent/30"
      : "bg-dls-info-bg-subtle text-dls-info-text border-dls-info-border-subtle";

  span.className = `inline-flex items-center rounded-pill px-2 py-0.5 text-label font-semibold border ${tone}`;
  return span;
};

export const insertTextWithBreaks = (target: HTMLElement, text: string) => {
  const chunks = text.split("\n");
  chunks.forEach((chunk, index) => {
    if (chunk.length) {
      target.appendChild(document.createTextNode(chunk));
    }
    if (index < chunks.length - 1) {
      target.appendChild(document.createElement("br"));
    }
  });
};

export const sanitizePastedPlainText = (value: string) =>
  normalizeText(value).replace(/\r\n?/g, "\n");

export const htmlToPlainText = (html: string) => {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.innerText ?? "";
};

export const countLines = (value: string) => (value ? value.split("\n").length : 0);

export const textToFragment = (text: string) => {
  const frag = document.createDocumentFragment();
  const chunks = text.split("\n");
  chunks.forEach((chunk, index) => {
    if (chunk.length) frag.appendChild(document.createTextNode(chunk));
    if (index < chunks.length - 1)
      frag.appendChild(document.createElement("br"));
  });
  return frag;
};

export const buildPartsFromEditor = (
  root: HTMLElement,
  pasteTextById?: Map<string, string>,
): ComposerPart[] => {
  const parts: ComposerPart[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const normalized = normalizeText(text);
    const last = parts[parts.length - 1];
    if (last?.type === "text") {
      last.text += normalized;
      return;
    }
    parts.push({ type: "text", text: normalized });
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.mentionKind) {
      const kind = el.dataset.mentionKind === "agent" ? "agent" : "file";
      if (kind === "agent") {
        parts.push({ type: "agent", name: el.dataset.mentionValue ?? "" });
      } else {
        parts.push({
          type: "file",
          path: el.dataset.mentionValue ?? "",
          label: el.dataset.mentionLabel ?? undefined,
        });
      }
      return;
    }
    if (el.dataset.workspaceFolder) {
      // The brackets keep a path with spaces in one piece, as for a panel selection.
      pushText(`[Selected folder: ${el.dataset.workspaceFolder}]`);
      return;
    }
    if (el.dataset.pasteId) {
      const id = el.dataset.pasteId ?? "";
      const label = el.dataset.pasteLabel ?? el.textContent ?? "[pasted text]";
      const lines = Number(el.dataset.pasteLines ?? "0") || 0;
      const text = pasteTextById?.get(id) ?? label;
      parts.push({ type: "paste", id, label, text, lines });
      return;
    }
    if (el.tagName === "BR") {
      pushText("\n");
      return;
    }
    if (el.tagName === "DIV") {
      if (!el.childNodes.length) {
        pushText("\n");
        return;
      }
      el.childNodes.forEach(walk);
      pushText("\n");
      return;
    }
    el.childNodes.forEach(walk);
  };

  root.childNodes.forEach(walk);
  return parts;
};

export const getSelectionOffsets = (root: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const startRange = range.cloneRange();
  startRange.selectNodeContents(root);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = range.cloneRange();
  endRange.selectNodeContents(root);
  endRange.setEnd(range.endContainer, range.endOffset);
  return {
    start: startRange.toString().length,
    end: endRange.toString().length,
  };
};

export const restoreSelectionOffsets = (
  root: HTMLElement,
  offsets: { start: number; end: number },
) => {
  const selection = window.getSelection();
  if (!selection) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node: Node | null;
  let current = 0;
  let startNode: Node | null = null;
  let endNode: Node | null = null;
  let startOffset = 0;
  let endOffset = 0;

  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!startNode && current + length >= offsets.start) {
      startNode = node;
      startOffset = offsets.start - current;
    }
    if (!endNode && current + length >= offsets.end) {
      endNode = node;
      endOffset = offsets.end - current;
      break;
    }
    current += length;
  }

  const range = document.createRange();
  if (!startNode || !endNode) {
    range.selectNodeContents(root);
    range.collapse(false);
  } else {
    range.setStart(
      startNode,
      clamp(startOffset, 0, (startNode.textContent ?? "").length),
    );
    range.setEnd(
      endNode,
      clamp(endOffset, 0, (endNode.textContent ?? "").length),
    );
  }
  selection.removeAllRanges();
  selection.addRange(range);
};

export const buildRangeFromOffsets = (
  root: HTMLElement,
  start: number,
  end: number,
) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node: Node | null;
  let current = 0;
  let startNode: Node | null = null;
  let endNode: Node | null = null;
  let startOffset = 0;
  let endOffset = 0;

  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!startNode && current + length >= start) {
      startNode = node;
      startOffset = start - current;
    }
    if (!endNode && current + length >= end) {
      endNode = node;
      endOffset = end - current;
      break;
    }
    current += length;
  }

  const range = document.createRange();
  if (!startNode || !endNode) {
    range.selectNodeContents(root);
    range.collapse(false);
    return range;
  }
  range.setStart(
    startNode,
    clamp(startOffset, 0, (startNode.textContent ?? "").length),
  );
  range.setEnd(
    endNode,
    clamp(endOffset, 0, (endNode.textContent ?? "").length),
  );
  return range;
};
