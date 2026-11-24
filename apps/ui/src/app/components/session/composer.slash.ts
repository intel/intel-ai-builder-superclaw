import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import fuzzysort from "fuzzysort";

import type { SlashCommandOption } from "../../types";
import {
  buildPartsFromEditor,
  buildRangeFromOffsets,
  createSlashSpan,
  getSelectionOffsets,
  normalizeText,
  partsToText,
  readEditorText,
} from "./composer.editor";

const SLASH_RESULT_LIMIT = 15;

type ComposerSlashDeps = {
  editor: () => HTMLDivElement | undefined;
  /** Shell mode has no slash commands. */
  isShellMode: () => boolean;
  listCommands: () => Promise<SlashCommandOption[]>;
  commandsVersion: () => number | undefined;
  /** Publishes the chip's text as a draft without echoing it back into the editor. */
  emitCommandDraft: (text: string) => void;
  /** Called after a chip lands beside other text, so the draft is republished. */
  onInserted: () => void;
};

export type ComposerSlash = ReturnType<typeof createComposerSlash>;

const SLASH_TOKEN_BEFORE_CARET = /(^|\s)\/(\S*)$/;

/**
 * The `/query` being typed at the end of `textBeforeCaret`, or null. The slash
 * must start a word so paths and URLs (`a/b`, `https://`) never open the picker.
 */
export function slashQueryBeforeCaret(textBeforeCaret: string): string | null {
  const match = textBeforeCaret.match(SLASH_TOKEN_BEFORE_CARET);
  return match ? (match[2] ?? "") : null;
}

/**
 * Whether the `/query` at the end of `textBeforeCaret` is the first thing in
 * the message. Only a leading command may be accepted with Enter; mid-sentence,
 * Enter sends the text as written, since `/name` there is as likely a reference
 * (a folder, a path) as an invocation.
 */
export function isLeadingSlashToken(textBeforeCaret: string): boolean {
  const match = textBeforeCaret.match(SLASH_TOKEN_BEFORE_CARET);
  if (!match || match.index === undefined) return false;
  return textBeforeCaret.slice(0, match.index).trim() === "";
}

/**
 * The space typed text needs after a chip. A plain trailing space in a
 * contenteditable collapses, and Chromium then inserts the next keystroke
 * before it, gluing the text to the chip; a no-break space does not collapse.
 * `normalizeText` turns it back into a plain space when the draft is read.
 */
const insertSpaceAfterChip = (chip: HTMLElement): Text => {
  const spacer = document.createTextNode("\u00a0");
  chip.after(spacer);
  return spacer;
};

const placeCaretAfter = (spacer: Text, selection: Selection) => {
  const cursor = document.createRange();
  cursor.setStart(spacer, spacer.length);
  cursor.collapse(true);
  selection.removeAllRanges();
  selection.addRange(cursor);
};

/**
 * OpenCode only runs a command that opens the message, so a command chip placed
 * mid-text is moved to the front and everything around it becomes its arguments.
 * Returns a reordered copy of the editor, or null when it holds no chip. The chip
 * node itself moves, so plain text spelling the same `/name` stays where it is.
 * Mention and paste chips are left where they are, and so is `/compact`: it
 * takes no arguments, so text around it is a message, not a compaction.
 */
export function withSlashChipFirst(editor: HTMLElement): HTMLElement | null {
  const copy = editor.cloneNode(true) as HTMLElement;
  const chip = copy.querySelector("[data-slash-command]");
  if (!chip || chip.getAttribute("data-slash-command") === "compact") return null;
  const after = chip.nextSibling;
  if (after && after.nodeType === Node.TEXT_NODE) {
    after.textContent = (after.textContent ?? "").replace(/^[ \t\u00a0]/, "");
  }
  chip.remove();
  const first = copy.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE) {
    first.textContent = (first.textContent ?? "").trimStart();
  }
  copy.prepend(chip, document.createTextNode(" "));
  return copy;
}

/**
 * The editor's parts with its command chip moved first, so a sent or restored
 * "/name ..." runs as that command. `typedText` maps the chip-first text back
 * to the editor's own order, which voice corrections anchor on.
 */
export function readChipFirstParts(
  editor: HTMLElement,
  pasteTextById: Map<string, string>,
  reorder: boolean,
) {
  const reordered = reorder ? withSlashChipFirst(editor) : null;
  const parts = buildPartsFromEditor(reordered ?? editor, pasteTextById);
  const typedText = (text: string) =>
    reordered ? normalizeText(partsToText(buildPartsFromEditor(editor, pasteTextById))) : text;
  return { parts, typedText };
}

/** Fuzzy-matches the typed command against name and description. */
export function filterSlashCommands(
  query: string,
  commands: SlashCommandOption[],
): SlashCommandOption[] {
  const term = query.trim().toLowerCase();
  if (!term) return commands.slice(0, SLASH_RESULT_LIMIT);
  return fuzzysort
    .go(term, commands, { keys: ["name", "description"] })
    .map((entry) => entry.obj)
    .slice(0, SLASH_RESULT_LIMIT);
}

/**
 * Owns the `/command` picker: its query, the command cache behind it, and the
 * chip that replaces the typed text once a command is chosen.
 */
export function createComposerSlash(deps: ComposerSlashDeps) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const [commands, setCommands] = createSignal<SlashCommandOption[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [prefilled, setPrefilled] = createSignal(false);

  const close = () => {
    setOpen(false);
    setQuery("");
    setPrefilled(false);
  };

  const [leading, setLeading] = createSignal(true);

  // `/compact` takes no arguments and runs instead of a prompt, so offered
  // mid-text it would silently drop the rest of the message.
  const filtered = createMemo(() =>
    open()
      ? filterSlashCommands(
          query(),
          leading() ? commands() : commands().filter((cmd) => cmd.name !== "compact"),
        )
      : [],
  );

  const updateQuery = (currentText?: string) => {
    const editor = deps.editor();
    if (!editor) return;
    if (deps.isShellMode()) {
      close();
      return;
    }
    // One command per message: OpenCode runs a single command per turn.
    if (editor.querySelector("[data-slash-command]")) {
      close();
      return;
    }
    const text = currentText ?? readEditorText(editor);
    const offsets = getSelectionOffsets(editor);
    let slashQuery: string | null;
    const hasCaret =
      offsets !== null && editor.contains(window.getSelection()?.anchorNode ?? null);
    if (hasCaret) {
      if (offsets.start !== offsets.end) {
        close();
        return;
      }
      slashQuery = slashQueryBeforeCaret(text.slice(0, offsets.start));
      setLeading(isLeadingSlashToken(text.slice(0, offsets.start)));
    } else {
      setLeading(true);
      // No caret in the editor (e.g. a "/skill-creator" prefill from another page).
      slashQuery = text.match(/^\/(\S*)$/)?.[1] ?? null;
    }
    if (slashQuery === null) {
      close();
      return;
    }
    setPrefilled(!hasCaret);
    setQuery(slashQuery);
    setOpen(true);
  };

  /** Whether the open `/query` may be accepted with Enter (see `isLeadingSlashToken`). */
  const acceptsEnter = () => {
    const editor = deps.editor();
    if (!editor) return false;
    if (prefilled()) return true;
    const offsets = getSelectionOffsets(editor);
    if (!offsets) return false;
    return isLeadingSlashToken(readEditorText(editor).slice(0, offsets.start));
  };

  /** Replaces the `/query` before the caret with a chip; false when there is none. */
  const insertAtCaret = (editor: HTMLDivElement, cmd: SlashCommandOption) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.endContainer)) return false;
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(editor);
    beforeRange.setEnd(range.endContainer, range.endOffset);
    const beforeText = normalizeText(beforeRange.toString());
    const match = beforeText.match(SLASH_TOKEN_BEFORE_CARET);
    if (!match || match.index === undefined) return false;
    const start = match.index + (match[1]?.length ?? 0);
    const deleteRange = buildRangeFromOffsets(editor, start, beforeText.length);
    deleteRange.deleteContents();

    const chip = createSlashSpan(cmd);
    deleteRange.insertNode(chip);
    placeCaretAfter(insertSpaceAfterChip(chip), selection);
    return true;
  };

  const select = (cmd: SlashCommandOption) => {
    const editor = deps.editor();
    if (!editor) return;
    close();
    const isWholeInput = /^\/\S*$/.test(partsToText(buildPartsFromEditor(editor)).trim());
    if (!isWholeInput) {
      if (insertAtCaret(editor, cmd)) deps.onInserted();
      return;
    }
    // Replace editor content with a styled "/<command>" chip and a trailing space for args.
    const text = `/${cmd.name} `;
    editor.innerHTML = "";
    const chip = createSlashSpan(cmd);
    editor.appendChild(chip);
    const spacer = insertSpaceAfterChip(chip);
    deps.emitCommandDraft(text);
    editor.focus();
    const selection = window.getSelection();
    if (selection) placeCaretAfter(spacer, selection);
  };

  createEffect(() => {
    if (!open()) return;
    filtered();
    setIndex(0);
  });

  // Typing re-checks the query but moving the caret (click, arrows, Home) does
  // not, so an open picker would otherwise accept a /query the caret has left.
  // A selection outside the editor (e.g. transcript text) closes it rather than
  // re-checking, which would read the draft as a prefill and accept it.
  createEffect(() => {
    if (!open()) return;
    const recheck = () => {
      const editor = deps.editor();
      if (editor?.contains(window.getSelection()?.anchorNode ?? null)) updateQuery();
      else if (!prefilled()) close();
    };
    document.addEventListener("selectionchange", recheck);
    onCleanup(() => document.removeEventListener("selectionchange", recheck));
  });

  // Refresh commands when commandsVersion changes (after skill import/uninstall/update)
  // or when slash picker opens. Always refresh cache unconditionally to ensure
  // users can use updated skills even when typing "/skill-name" directly without
  // opening the slash picker first.
  createEffect(() => {
    const version = deps.commandsVersion();
    const isOpen = open();
    let cancelled = false;

    // Only show loading indicator when picker is open
    if (isOpen) setLoading(true);

    deps
      .listCommands()
      .then((next) => {
        // Prevent race condition: only accept response for current version
        if (cancelled || deps.commandsVersion() !== version) {
          return;
        }
        setCommands(next);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  // A programmatic prefill of an exact /command (e.g. "/skill-creator" from the
  // Skills page) becomes a chip on its own. Typed text never does: a name the
  // user types may be a reference rather than an invocation, so it needs Tab,
  // a click, or Enter on a leading command.
  createEffect(() => {
    if (!open() || !prefilled()) return;
    const term = query().trim();
    if (!term) return;
    const cmd = commands().find((candidate) => candidate.name === term);
    if (!cmd) return;
    select(cmd);
  });

  return {
    open,
    query,
    index,
    setIndex,
    commands,
    loading,
    filtered,
    updateQuery,
    acceptsEnter,
    select,
    close,
  };
}
