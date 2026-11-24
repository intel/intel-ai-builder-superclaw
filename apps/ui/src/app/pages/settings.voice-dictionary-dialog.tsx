/**
 * Settings → Voice input → Dictionary → Manage words.
 *
 * The full word list, moved off the card because a chip per word does not scale:
 * 200+ chips fill the page. Search, an All / Learned filter, multi-select remove,
 * and plain-text import/export.
 *
 * Every mutation goes through the controller one word at a time, never by
 * rewriting the array: removing a learned word must tombstone it, or the next
 * recording learns it straight back, and importing must apply the same
 * duplicate, length and limit rules as typing a word in.
 *
 * Modal shape follows `remove-provider-dialog.tsx`: a Portal so the backdrop
 * covers the window, Tab kept inside, Escape closes.
 */
import { X } from "lucide-solid";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
} from "solid-js";
import { Portal } from "solid-js/web";

import { MAX_DICTIONARY_WORDS, type VoiceInputController } from "~/features/voice-input";
import { Tooltip } from "~/shared/ui/tooltip";

import { t } from "../../i18n";
import Button from "../components/button";
import { isTauriRuntime } from "../utils";
import { revealItemInDir } from "./settings.platform-actions";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

type Filter = "all" | "learned";

export type VoiceDictionaryDialogProps = {
  open: boolean;
  voice: VoiceInputController;
  /** False in cloud mode: the list can be viewed and exported, not changed. */
  active: boolean;
  onClose: () => void;
};

export default function VoiceDictionaryDialog(props: VoiceDictionaryDialogProps) {
  return (
    <Show when={props.open}>
      <DialogBody {...props} />
    </Show>
  );
}

/** Mounted per opening, so search, filter and selection start fresh each time. */
function DialogBody(props: VoiceDictionaryDialogProps) {
  const voice = props.voice;
  const titleId = createUniqueId();
  // Whatever opened the dialog gets focus back on close, or keyboard users land on <body>.
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  onCleanup(() => {
    if (opener?.isConnected) opener.focus();
  });
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<Filter>("all");
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [note, setNote] = createSignal<string | null>(null);
  const [exporting, setExporting] = createSignal(false);
  let dialogRef: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;

  const learnedCount = createMemo(
    () => voice.dictionary().filter((word) => voice.originOf(word) === "auto").length,
  );

  const visible = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return voice.dictionary().filter((word) => {
      if (filter() === "learned" && voice.originOf(word) !== "auto") return false;
      return !needle || word.toLowerCase().includes(needle);
    });
  });

  /** Selection survives a removal elsewhere only for words still in the list. */
  const selectedWords = () => voice.dictionary().filter((word) => selected().has(word));

  const toggle = (word: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(word)) next.delete(word);
      else next.add(word);
      return next;
    });
  };

  /** Scoped to what search and the filter show, so "Learned → Select all" clears only learned words. */
  const visibleSelectedCount = () => visible().filter((word) => selected().has(word)).length;
  const allVisibleSelected = () =>
    visible().length > 0 && visibleSelectedCount() === visible().length;

  const toggleAllVisible = () => {
    const clear = allVisibleSelected();
    setSelected((current) => {
      const next = new Set(current);
      for (const word of visible()) {
        if (clear) next.delete(word);
        else next.add(word);
      }
      return next;
    });
  };

  const removeSelected = () => {
    for (const word of selectedWords()) voice.removeDictionaryEntry(word);
    setSelected(new Set<string>());
  };

  const exportWords = async () => {
    const words = voice.dictionary();
    const content = `${words.join("\n")}\n`;
    const saved = (path: string) =>
      t("voice.dictionary_export_saved").replace("{n}", String(words.length)).replace("{path}", path);
    // The Tauri webview ignores `<a download>`, so the installed app writes natively.
    if (!isTauriRuntime()) {
      const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "dictionary.txt";
      link.click();
      URL.revokeObjectURL(url);
      setNote(saved("dictionary.txt"));
      return;
    }
    setExporting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke<string>("write_voice_dictionary_export", { content });
      setNote(saved(path));
      try {
        await revealItemInDir(path);
      } catch {
        // Best effort: the note already says where the file is.
      }
    } catch (error) {
      setNote(
        t("voice.dictionary_export_failed").replace(
          "{error}",
          error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      setExporting(false);
    }
  };

  const importFile = async (file: File) => {
    let text: string;
    try {
      text = await file.text();
    } catch {
      setNote(t("voice.dictionary_import_failed"));
      return;
    }
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let added = 0;
    for (const line of lines) {
      if (voice.addDictionaryEntry(line)) added += 1;
    }
    // The per-word reasons are summarised below; the card's rejection box must not
    // keep showing whichever word happened to be refused last.
    voice.clearDictionaryRejection();
    setNote(
      t("voice.dictionary_import_result")
        .replace("{added}", String(added))
        .replace("{skipped}", String(lines.length - added)),
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef) return;
    const focusable = dialogRef.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const filterClass = (value: Filter) =>
    `rounded-subtle border px-2 py-1 text-caption ${
      filter() === value
        ? "border-dls-muted bg-dls-surface-muted text-dls-text"
        : "border-dls-border bg-transparent text-dls-secondary hover:bg-dls-hover"
    }`;

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[100000] flex items-center justify-center bg-black/55 font-sans"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="voice-dictionary-dialog"
        onKeyDown={onKeyDown}
      >
        <div
          ref={(el) => {
            dialogRef = el;
            queueMicrotask(() => el.querySelector<HTMLElement>("input[type=search]")?.focus());
          }}
          class="flex max-h-[80vh] w-[min(560px,92vw)] flex-col gap-3 rounded-dialog border border-dls-panel-border bg-dls-surface-solid p-5 shadow-[var(--dls-card-shadow)]"
        >
          <div class="flex items-center justify-between gap-3">
            <h3 id={titleId} class="text-body-lg font-semibold text-dls-text">
              {t("voice.dictionary_dialog_title")
                .replace("{n}", String(voice.dictionary().length))
                .replace("{max}", String(MAX_DICTIONARY_WORDS))}
            </h3>
            <button
              type="button"
              class="rounded-compact p-1 text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
              aria-label={t("voice.dictionary_dialog_close")}
              onClick={props.onClose}
              data-testid="voice-dictionary-dialog-close"
            >
              <X size={14} />
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <input
              type="search"
              class="min-w-[180px] flex-1 rounded-subtle border border-dls-border bg-dls-surface-solid px-2 py-1.5 text-caption text-dls-text placeholder:text-dls-secondary"
              placeholder={t("voice.dictionary_search_placeholder")}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              data-testid="voice-dictionary-search"
            />
            <button
              type="button"
              class={filterClass("all")}
              aria-pressed={filter() === "all"}
              onClick={() => setFilter("all")}
              data-testid="voice-dictionary-filter-all"
            >
              {t("voice.dictionary_filter_all")}
            </button>
            <button
              type="button"
              class={filterClass("learned")}
              aria-pressed={filter() === "learned"}
              onClick={() => setFilter("learned")}
              data-testid="voice-dictionary-filter-learned"
            >
              {t("voice.dictionary_filter_learned").replace("{m}", String(learnedCount()))}
            </button>
          </div>

          <label class="-mb-1 flex w-fit cursor-pointer items-center gap-2 px-3 text-caption text-dls-secondary">
            <input
              ref={(el) => {
                createEffect(() => {
                  el.indeterminate = visibleSelectedCount() > 0 && !allVisibleSelected();
                });
              }}
              type="checkbox"
              checked={allVisibleSelected()}
              disabled={!props.active || visible().length === 0}
              onChange={toggleAllVisible}
              data-testid="voice-dictionary-select-all"
            />
            {t("voice.dictionary_select_all")}
          </label>

          {/* Ten rows tall: 10 × 28px rows + 9 row borders + 2px frame. Keep in step with the row height. */}
          <div class="max-h-[291px] min-h-0 overflow-y-auto rounded-inset border border-dls-border/40">
            <Show
              when={visible().length > 0}
              fallback={
                <p class="p-3 text-caption text-dls-secondary" data-testid="voice-dictionary-no-matches">
                  {voice.dictionary().length === 0
                    ? t("voice.dictionary_empty")
                    : t("voice.dictionary_no_matches")}
                </p>
              }
            >
              <ul data-testid="voice-dictionary-rows">
                <For each={visible()}>
                  {(word) => (
                    <li class="border-b border-dls-border/30 last:border-b-0">
                      <label class="flex h-7 cursor-pointer items-center gap-2 px-3 text-caption text-dls-text">
                        <input
                          type="checkbox"
                          checked={selected().has(word)}
                          disabled={!props.active}
                          aria-label={t("voice.dictionary_select").replace("{word}", word)}
                          onChange={() => toggle(word)}
                          data-testid={`voice-dictionary-select-${word}`}
                        />
                        <span class="min-w-0 flex-1 truncate">{word}</span>
                        <Show when={voice.originOf(word) === "auto"}>
                          <span class="rounded-pill bg-dls-panel-badge-bg px-1.5 text-tiny leading-4 text-dls-panel-icon">
                            {t("voice.dictionary_origin_auto")}
                          </span>
                        </Show>
                      </label>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>

          <p
            role="status"
            aria-live="polite"
            class="break-all text-caption text-dls-secondary empty:sr-only"
            data-testid="voice-dictionary-note"
          >
            {note()}
          </p>

          <div class="flex flex-wrap items-center gap-2">
            <input
              ref={(el) => {
                fileInput = el;
              }}
              type="file"
              accept=".txt,text/plain"
              class="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void importFile(file);
              }}
              data-testid="voice-dictionary-import-input"
            />
            <Tooltip
              content={t("voice.dictionary_import_hint").replace("{max}", String(MAX_DICTIONARY_WORDS))}
              placement="bottom"
              zIndexClass="z-[100001]"
            >
              <Button
                variant="outline"
                class="text-caption h-8 py-0 px-3"
                disabled={!props.active}
                onClick={() => fileInput?.click()}
                data-testid="voice-dictionary-import"
              >
                {t("voice.dictionary_import")}
              </Button>
            </Tooltip>
            <Tooltip content={t("voice.dictionary_export_hint")} placement="bottom" zIndexClass="z-[100001]">
              <Button
                variant="outline"
                class="text-caption h-8 py-0 px-3"
                disabled={voice.dictionary().length === 0 || exporting()}
                onClick={() => void exportWords()}
                data-testid="voice-dictionary-export"
              >
                {t("voice.dictionary_export")}
              </Button>
            </Tooltip>
            <span class="ml-auto text-caption tabular-nums text-dls-secondary" data-testid="voice-dictionary-selected">
              {t("voice.dictionary_selected").replace("{k}", String(selectedWords().length))}
            </span>
            <Button
              variant="outline"
              class="text-caption h-8 py-0 px-3"
              disabled={!props.active || selectedWords().length === 0}
              onClick={removeSelected}
              data-testid="voice-dictionary-remove-selected"
            >
              {t("voice.dictionary_remove_selected")}
            </Button>
            <Button
              variant="secondary"
              class="text-caption h-8 py-0 px-3"
              onClick={props.onClose}
              data-testid="voice-dictionary-done"
            >
              {t("voice.dictionary_done")}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
