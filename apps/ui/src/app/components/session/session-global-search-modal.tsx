import {
  For,
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  type JSX,
} from "solid-js";
import { FileText, Loader2, MessageSquare, Search, X } from "lucide-solid";

import { t } from "../../../i18n";
import type { CommandPaletteSessionOption } from "../../pages/session.command-palette";
import {
  runGlobalSessionSearch,
  tokenizeGlobalSearchQuery,
  type GlobalSessionSearchBackend,
  type GlobalSessionSearchResult,
} from "../../pages/session-global-search";
import type { MessageWithParts } from "../../types";

export type SessionGlobalSearchModalProps = {
  open: boolean;
  onClose: () => void;
  sessionOptions: CommandPaletteSessionOption[];
  getMessagesBySessionId: (sessionId: string) => MessageWithParts[];
  ensureSessionLoaded: (sessionId: string) => Promise<void> | void;
  loadEarlierMessages: (sessionId: string) => Promise<void> | void;
  sessionMessageHistoryComplete: (sessionId: string) => boolean;
  contentScanWorkspaceId: string;
  searchBackend?: GlobalSessionSearchBackend;
  onSelectResult: (result: GlobalSessionSearchResult, query: string) => Promise<void> | void;
};

function HighlightedMatch(props: { text: string; query: string }) {
  const terms = tokenizeGlobalSearchQuery(props.query);
  const lowerText = props.text.toLowerCase();
  const parts: JSX.Element[] = [];
  let cursor = 0;

  while (cursor < props.text.length) {
    let matchIndex = -1;
    let matchedTerm = "";
    for (const term of terms) {
      const index = lowerText.indexOf(term, cursor);
      if (index !== -1 && (matchIndex === -1 || index < matchIndex)) {
        matchIndex = index;
        matchedTerm = term;
      }
    }
    if (matchIndex === -1) break;

    if (matchIndex > cursor) parts.push(props.text.slice(cursor, matchIndex));
    const matchEnd = matchIndex + matchedTerm.length;
    parts.push(
      <mark class="rounded-micro bg-dls-active px-0.5 font-semibold text-dls-text">
        {props.text.slice(matchIndex, matchEnd)}
      </mark>,
    );
    cursor = matchEnd;
  }

  if (!parts.length) return props.text;
  if (cursor < props.text.length) parts.push(props.text.slice(cursor));
  return parts;
}

export default function SessionGlobalSearchModal(
  props: SessionGlobalSearchModalProps,
) {
  const [query, setQuery] = createSignal("");
  const [debouncedQuery, setDebouncedQuery] = createSignal("");
  const [results, setResults] = createSignal<GlobalSessionSearchResult[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [opening, setOpening] = createSignal(false);
  const [statusNote, setStatusNote] = createSignal<string | null>(null);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const listboxId = createUniqueId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  let inputEl: HTMLInputElement | undefined;
  let abortController: AbortController | undefined;

  createEffect(() => {
    if (!props.open) return;
    requestAnimationFrame(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  });

  createEffect(() => {
    if (!props.open) {
      setQuery("");
      setDebouncedQuery("");
      setResults([]);
      setStatusNote(null);
      setFailed(false);
      setActiveIndex(0);
      abortController?.abort();
      abortController = undefined;
    }
  });

  createEffect(() => {
    const value = query();
    if (typeof window === "undefined") {
      setDebouncedQuery(value);
      return;
    }
    const id = window.setTimeout(() => setDebouncedQuery(value), 200);
    onCleanup(() => window.clearTimeout(id));
  });

  createEffect(() => {
    const q = debouncedQuery().trim();
    if (!props.open || !q) {
      setResults([]);
      setStatusNote(null);
      setFailed(false);
      setSearching(false);
      abortController?.abort();
      abortController = undefined;
      return;
    }

    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    setSearching(true);
    setStatusNote(null);
    setFailed(false);
    setActiveIndex(0);

    void runGlobalSessionSearch({
      options: props.sessionOptions,
      query: q,
      searchBackend: props.searchBackend,
      getMessagesBySessionId: props.getMessagesBySessionId,
      ensureSessionLoaded: props.ensureSessionLoaded,
      loadEarlierMessages: props.loadEarlierMessages,
      isMessageHistoryComplete: props.sessionMessageHistoryComplete,
      contentScanWorkspaceId: props.contentScanWorkspaceId,
      signal: controller.signal,
    })
      .then((outcome) => {
        if (controller.signal.aborted) return;
        setResults(outcome.results);
        const notes: string[] = [];
        if (outcome.metadataTruncated) {
          notes.push(t("session.global_search_truncated_metadata"));
        }
        if (outcome.contentSearchIncomplete) {
          notes.push(t("session.global_search_incomplete_content"));
        }
        setStatusNote(notes.length ? notes.join(" ") : null);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setResults([]);
        setFailed(true);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setSearching(false);
      });

    onCleanup(() => controller.abort());
  });

  const selectAt = async (index: number) => {
    const item = results()[index];
    const q = debouncedQuery().trim();
    if (!item || !q || opening()) return;
    // Stays open while older history loads, so the spinner covers the wait.
    setOpening(true);
    try {
      await props.onSelectResult(item, q);
    } finally {
      setOpening(false);
      props.onClose();
    }
  };
  const reportSelectionFailure = () => {
    console.warn("[session-global-search] could not open selected result");
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[60] dls-modal-backdrop flex items-start justify-center overflow-y-auto p-4"
        onClick={() => props.onClose()}
      >
        <div
          class="mt-10 w-full max-w-2xl overflow-hidden border dls-modal-surface"
          onClick={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={t("session.global_search_title")}
        >
          <div class="space-y-2 border-b border-dls-border px-4 py-3">
            <div class="flex items-center gap-2">
              <Search size={14} class="shrink-0 text-dls-secondary" />
              <input
                ref={(el) => {
                  inputEl = el;
                }}
                type="text"
                role="combobox"
                aria-label={t("session.global_search_title")}
                aria-autocomplete="list"
                aria-controls={results().length > 0 ? listboxId : undefined}
                aria-expanded={results().length > 0}
                aria-activedescendant={
                  results().length > 0 ? optionId(activeIndex()) : undefined
                }
                data-testid="session-global-search-input"
                value={query()}
                placeholder={t("session.global_search_placeholder")}
                class="min-w-0 flex-1 bg-transparent text-body-lg text-dls-text placeholder:text-dls-secondary focus:outline-none"
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  const total = results().length;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    props.onClose();
                    return;
                  }
                  if (event.key === "ArrowDown" && total > 0) {
                    event.preventDefault();
                    setActiveIndex((current) => (current + 1) % total);
                    return;
                  }
                  if (event.key === "ArrowUp" && total > 0) {
                    event.preventDefault();
                    setActiveIndex(
                      (current) => (current - 1 + total) % total,
                    );
                    return;
                  }
                  if (event.key === "Enter") {
                    if (event.isComposing || event.keyCode === 229) return;
                    event.preventDefault();
                    selectAt(activeIndex()).catch(reportSelectionFailure);
                  }
                }}
              />
              <Show when={searching() || opening()}>
                <Loader2 size={14} class="animate-spin text-dls-secondary" />
              </Show>
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                onClick={() => props.onClose()}
                aria-label={t("common.close")}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div class="max-h-[56vh] overflow-y-auto p-2">
            <Show
              when={debouncedQuery().trim()}
              fallback={
                <div class="px-3 py-6 text-center text-body-lg text-dls-secondary">
                  {t("session.global_search_empty_query")}
                </div>
              }
            >
              <Show
                when={results().length > 0}
                fallback={
                  <div class="px-3 py-6 text-center text-body-lg text-dls-secondary">
                    {searching()
                      ? t("session.global_search_searching")
                      : failed()
                        ? t("session.global_search_failed")
                        : t("session.global_search_no_matches")}
                  </div>
                }
              >
                <div
                  id={listboxId}
                  role="listbox"
                  aria-label={t("session.global_search_title")}
                >
                  <For each={results()}>
                    {(item, index) => (
                      <button
                        type="button"
                        id={optionId(index())}
                        role="option"
                        aria-selected={activeIndex() === index()}
                        tabIndex={-1}
                        data-testid="session-global-search-result"
                        class={`mb-1 w-full rounded-inset px-3 py-2.5 text-left transition-colors ${
                          activeIndex() === index()
                            ? "bg-dls-active text-dls-text"
                            : "hover:bg-dls-hover text-dls-text"
                        }`}
                        onClick={() => selectAt(index()).catch(reportSelectionFailure)}
                      >
                        <div class="flex items-start gap-3">
                          <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-dls-hover text-dls-secondary">
                            {item.matchKind === "content" ? (
                              <MessageSquare size={15} />
                            ) : (
                              <FileText size={15} />
                            )}
                          </div>
                          <div class="min-w-0 flex-1">
                            <div class="flex items-start justify-between gap-3">
                              <div class="truncate text-body-lg font-medium">
                                <HighlightedMatch
                                  text={item.title}
                                  query={debouncedQuery()}
                                />
                              </div>
                              <span class="shrink-0 rounded-control border border-dls-border px-1.5 py-0.5 text-micro uppercase text-dls-secondary">
                                {item.matchKind === "content"
                                  ? t("session.global_search_match_content")
                                  : t("session.global_search_match_title")}
                              </span>
                            </div>
                            <div class="truncate text-label text-dls-secondary">
                              {item.workspaceTitle}
                            </div>
                            <Show when={item.snippet}>
                              {(snippet) => (
                                <div class="mt-1 line-clamp-2 text-caption text-dls-secondary">
                                  <HighlightedMatch
                                    text={snippet()}
                                    query={debouncedQuery()}
                                  />
                                </div>
                              )}
                            </Show>
                          </div>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>

          <Show when={statusNote()}>
            {(note) => (
              <div class="border-t border-dls-border px-4 py-2 text-label text-dls-secondary">
                {note()}
              </div>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
}
