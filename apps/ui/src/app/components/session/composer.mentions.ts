import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import fuzzysort from "fuzzysort";

import type { ComposerPart } from "../../types";
import { listedWorkspaceFiles } from "../../lib/workspace-file-search";
import {
  buildRangeFromOffsets,
  createMentionSpan,
  getSelectionOffsets,
  normalizeText,
  readEditorText,
} from "./composer.editor";
import type { MentionGroup, MentionOption } from "./composer.types";

const MENTION_SEARCH_DEBOUNCE_MS = 150;
const MENTION_VISIBLE_LIMIT = 10;

type ComposerMentionsDeps = {
  editor: () => HTMLDivElement | undefined;
  /** Shell mode has no mentions. */
  isShellMode: () => boolean;
  agentOptions: () => Agent[];
  recentFiles: () => string[];
  searchFiles: (query: string) => Promise<string[]>;
  loadAgentOptions: () => Promise<Agent[]>;
  /** Called after a mention lands in the editor, so the draft is republished. */
  onInserted: () => void;
};

export type ComposerMentions = ReturnType<typeof createComposerMentions>;

/**
 * Agents first, then files, then recents — with recently used files taking the
 * id of a search hit for the same path, so a path never appears twice.
 */
export function buildMentionGroups(input: {
  query: string;
  agents: Agent[];
  recentFiles: string[];
  searchResults: string[];
  /** Drops recent files known to be deleted. */
  isGone?: (path: string) => boolean;
}): MentionGroup[] {
  const term = input.query.trim().toLowerCase();
  const agents: MentionOption[] = input.agents.map((agent: Agent) => ({
    id: `agent:${agent.name}`,
    kind: "agent" as const,
    label: agent.name,
    value: agent.name,
    display: agent.name,
  }));
  const seen = new Set<string>();
  const recentFiles: MentionOption[] = input.recentFiles
    .filter((file: string) => {
      if (!file) return false;
      if (input.isGone?.(file)) return false;
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    })
    .map((file: string) => ({
      id: `file:${file}`,
      kind: "file" as const,
      label: file,
      value: file,
      display: file,
      recent: true,
    }));
  const searchFiles: MentionOption[] = input.searchResults
    .filter((file: string) => file && !seen.has(file))
    .map((file: string) => ({
      id: `file:${file}`,
      kind: "file" as const,
      label: file,
      value: file,
      display: file,
    }));
  const all = [...agents, ...recentFiles, ...searchFiles];
  const list = term
    ? fuzzysort.go(term, all, { keys: ["display"] }).map((entry) => entry.obj)
    : all;
  const groups: MentionGroup[] = [];
  const bucket = new Map<MentionGroup["category"], MentionOption[]>();
  for (const item of list) {
    const category =
      item.kind === "agent" ? "agent" : item.recent ? "recent" : "file";
    const current = bucket.get(category);
    if (current) {
      current.push(item);
      continue;
    }
    bucket.set(category, [item]);
  }
  const order: MentionGroup["category"][] = ["agent", "file", "recent"];
  for (const category of order) {
    const items = bucket.get(category);
    if (!items?.length) continue;
    groups.push({ category, items });
  }
  return groups;
}

/**
 * Owns the `@` picker: the query behind it, the agent/file options it offers,
 * and the chip inserted when one is chosen.
 */
export function createComposerMentions(deps: ComposerMentionsDeps) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const [searchResults, setSearchResults] = createSignal<string[]>([]);
  /** The term `searchResults` answer; until it matches the query, the listing may belong to another workspace. */
  const [searchedTerm, setSearchedTerm] = createSignal("");
  let pickerRef: HTMLDivElement | undefined;
  let searchRun = 0;

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  // Recents change when the agent writes or deletes, so the cached listing can
  // no longer prove a recent file is gone until a newer one loads.
  const recentFilesKey = createMemo<string | undefined>((previous) => {
    const key = deps.recentFiles().join("\n");
    if (previous !== undefined && key !== previous) listedWorkspaceFiles.invalidate();
    return key;
  }, undefined);

  const groups = createMemo<MentionGroup[]>(() => {
    recentFilesKey();
    if (!open()) return [];
    const term = query().trim();
    return buildMentionGroups({
      query: query(),
      agents: deps.agentOptions(),
      recentFiles: deps.recentFiles(),
      searchResults: searchResults(),
      isGone: term && searchedTerm() === term ? listedWorkspaceFiles.isGone : undefined,
    });
  });

  const options = createMemo(() =>
    groups().flatMap((group: MentionGroup) => group.items),
  );
  const visible = createMemo(() => options().slice(0, MENTION_VISIBLE_LIMIT));

  const updateQuery = (currentText?: string) => {
    const editor = deps.editor();
    if (!editor) return;
    if (deps.isShellMode()) {
      close();
      return;
    }
    const offsets = getSelectionOffsets(editor);
    if (!offsets || offsets.start !== offsets.end) {
      close();
      return;
    }
    const text = currentText ?? readEditorText(editor);
    const before = text.slice(0, offsets.start);
    const match = before.match(/@(\S*)$/);
    if (!match) {
      close();
      return;
    }
    setQuery(match[1] ?? "");
    setOpen(true);
  };

  const insert = (option: MentionOption) => {
    const editor = deps.editor();
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(editor);
    beforeRange.setEnd(range.endContainer, range.endOffset);
    const beforeText = normalizeText(beforeRange.toString());
    const match = beforeText.match(/@(\S*)$/);
    if (!match) return;
    const start = match.index ?? beforeText.length - match[0].length;
    const end = beforeText.length;
    const deleteRange = buildRangeFromOffsets(editor, start, end);
    deleteRange.deleteContents();

    const mentionPart =
      option.kind === "agent"
        ? ({ type: "agent", name: option.value } as ComposerPart)
        : ({
            type: "file",
            path: option.value,
            label: option.label,
          } as ComposerPart);
    const mentionNode = createMentionSpan(
      mentionPart as Extract<ComposerPart, { type: "agent" | "file" }>,
    );
    deleteRange.insertNode(mentionNode);
    mentionNode.after(document.createTextNode(" "));

    const cursor = document.createRange();
    cursor.setStartAfter(mentionNode.nextSibling ?? mentionNode);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
    close();
    deps.onInserted();
  };

  createEffect(() => {
    if (!open()) return;
    options();
    setIndex(0);
  });

  createEffect(
    on(
      open,
      (isOpen) => {
        if (isOpen) void deps.loadAgentOptions();
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!open()) {
      setSearchResults([]);
      setSearchedTerm("");
      return;
    }
    const term = query().trim();
    if (!term) {
      setSearchResults([]);
      setSearchedTerm("");
      return;
    }
    const runId = (searchRun += 1);
    const timeout = window.setTimeout(() => {
      deps
        .searchFiles(term)
        .then((results) => {
          if (runId !== searchRun) return;
          setSearchResults(results);
          setSearchedTerm(term);
        })
        .catch(() => {
          if (runId !== searchRun) return;
          setSearchResults([]);
        });
    }, MENTION_SEARCH_DEBOUNCE_MS);
    onCleanup(() => {
      window.clearTimeout(timeout);
    });
  });

  createEffect(() => {
    if (!open()) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (pickerRef?.contains(target)) return;
      if (deps.editor()?.contains(target)) return;
      close();
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  return {
    open,
    index,
    setIndex,
    options,
    visible,
    updateQuery,
    insert,
    close,
    setPickerRef: (el: HTMLDivElement) => {
      pickerRef = el;
    },
  };
}
