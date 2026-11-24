/**
 * Settings → Voice input → Dictionary.
 *
 * Names, project names and jargon the on-device decoder should bias toward. Its
 * own file rather than another card inside `settings.voice-input-section.tsx`
 * because that file was already 405 lines and this card carries an input, a
 * rejection state and a list — the section stays readable and both stay under the
 * 800-line limit.
 *
 * The card shows a summary (count, the first few words, [Manage words]); the full
 * list lives in `settings.voice-dictionary-dialog.tsx`, because a chip per word
 * fills the page once the list grows into the hundreds.
 *
 * Two product rules are visible in the markup:
 *
 *  * **On-device only.** The cloud engine is the browser's Web Speech API, which
 *    has no hotword surface at all. The card is rendered disabled (not hidden) in
 *    cloud mode, because hiding it would make an entered Dictionary look lost.
 *  * **A refused word stays in the input** next to the reason, rather than being
 *    cleared. Retyping a long or duplicate word to find out what was wrong with
 *    it is worse than seeing it sit there.
 */
import { BookMarked, Plus } from "lucide-solid";
import { For, Show, createSignal } from "solid-js";

import {
  MAX_DICTIONARY_WORDS,
  type DictionaryRejection,
  type PromotionBlock,
  type VoiceInputController,
} from "~/features/voice-input";

import { t } from "../../i18n";
import Button from "../components/button";
import { formControlClass } from "~/shared/ui/text-input";

import VoiceDictionaryDialog from "./settings.voice-dictionary-dialog";

/** Words shown on the card before "+N more". */
const PREVIEW_COUNT = 6;

const REJECTION_KEY: Record<DictionaryRejection, string> = {
  empty: "voice.dictionary_error_empty",
  duplicate: "voice.dictionary_error_duplicate",
  too_long: "voice.dictionary_error_too_long",
  list_full: "voice.dictionary_error_full",
};

/** `waiting` is absent: it carries the run count and is formatted inline. */
const PROGRESS_BLOCK_KEY: Record<Exclude<PromotionBlock, "waiting">, string> = {
  unsuitable: "voice.dictionary_progress_unsuitable",
  already_added: "voice.dictionary_progress_already_added",
  removed: "voice.dictionary_progress_removed",
};

export default function VoiceDictionaryCard(props: { voice: VoiceInputController }) {
  const voice = props.voice;
  const [draft, setDraft] = createSignal("");
  const [managing, setManaging] = createSignal(false);

  /**
   * On-device mode only. `localAvailable()` is false while the catalog probe is
   * still running, so this also covers the startup window — an Add that reached
   * storage before the service was known to exist would be stored fine, but the
   * card would be claiming an effect it cannot yet have.
   */
  const active = () => voice.mode() === "local" && voice.localAvailable();

  const submit = () => {
    // `addDictionaryEntry` reports "empty" for a blank draft, which would put an
    // error under an untouched input the moment the user pressed Enter on it.
    if (!draft().trim()) return;
    if (voice.addDictionaryEntry(draft())) setDraft("");
  };

  const learnedCount = () =>
    voice.dictionary().filter((word) => voice.originOf(word) === "auto").length;
  const hiddenCount = () => voice.dictionary().length - PREVIEW_COUNT;

  return (
    <div
      class="bg-dls-panel-bg border border-dls-panel-border rounded-card p-5 space-y-3"
      data-testid="voice-dictionary-card"
      data-settings-anchor="voice_dictionary"
    >
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <BookMarked size={16} class="text-dls-secondary" />
          <div class="text-body-lg font-medium text-dls-text">{t("voice.dictionary_heading")}</div>
        </div>
        <span class="text-caption tabular-nums text-dls-secondary" data-testid="voice-dictionary-count">
          {voice.dictionary().length} / {MAX_DICTIONARY_WORDS}
        </span>
      </div>

      <p class="text-caption text-dls-secondary leading-relaxed">{t("voice.dictionary_desc")}</p>

      <Show when={!active()}>
        <div
          class="rounded-inset border border-dls-panel-inset-border bg-dls-panel-inset-bg p-3 text-caption text-dls-secondary"
          data-testid="voice-dictionary-inactive"
        >
          {t("voice.dictionary_local_only")}
        </div>
      </Show>

      <div class="flex flex-wrap items-center gap-2">
        <input
          type="text"
          class={`${formControlClass} min-w-[220px] flex-1 placeholder:text-dls-secondary disabled:opacity-50`}
          placeholder={t("voice.dictionary_placeholder_input")}
          value={draft()}
          disabled={!active()}
          // Longer than the cap is refused with a reason rather than truncated at
          // the keystroke: a maxlength that silently stops accepting characters
          // reads as a broken keyboard.
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // The composer treats Enter as send; this input is inside Settings,
            // but stopping it keeps the card safe to reuse anywhere.
            event.preventDefault();
            event.stopPropagation();
            submit();
          }}
          data-testid="voice-dictionary-input"
        />
        <Button
          variant="secondary"
          class="text-caption h-8 py-0 px-3"
          disabled={!active() || !draft().trim()}
          onClick={submit}
          data-testid="voice-dictionary-add"
        >
          <Plus size={13} class="mr-1" />
          {t("voice.dictionary_add")}
        </Button>
      </div>

      <Show when={voice.dictionaryRejection()}>
        {(reason) => (
          <div
            class="rounded-inset border border-dls-danger-border bg-dls-danger-bg p-3 text-caption text-dls-danger-text"
            data-testid="voice-dictionary-rejection"
          >
            {t(REJECTION_KEY[reason()])}
          </div>
        )}
      </Show>

      <Show
        when={voice.dictionary().length > 0}
        fallback={
          <p class="text-caption text-dls-secondary" data-testid="voice-dictionary-empty">
            {t("voice.dictionary_empty")}
          </p>
        }
      >
        <div class="space-y-2" data-testid="voice-dictionary-summary">
          <p class="text-caption text-dls-secondary" data-testid="voice-dictionary-summary-text">
            {t("voice.dictionary_summary")
              .replace("{n}", String(voice.dictionary().length))
              .replace("{m}", String(learnedCount()))}
          </p>
          <ul class="flex flex-wrap items-center gap-1.5" data-testid="voice-dictionary-list">
            <For each={voice.dictionary().slice(0, PREVIEW_COUNT)}>
              {(word) => (
                <li class="inline-flex max-w-full items-center gap-1 rounded-pill border border-dls-panel-badge-border bg-dls-panel-badge-bg px-2.5 py-1 text-caption text-dls-panel-text">
                  <span class="truncate">{word}</span>
                  {/*
                    Provenance is on the chip, not in a separate section. A word the
                    app added is one the user never typed, so without the badge the
                    list gives them no way to tell an unfamiliar entry from a typo of
                    their own — and removing it means something different.
                  */}
                  <Show when={voice.originOf(word) === "auto"}>
                    <span
                      class="rounded-pill bg-dls-panel-badge-bg px-1.5 text-tiny leading-4 text-dls-panel-icon"
                      data-testid={`voice-dictionary-origin-${word}`}
                    >
                      {t("voice.dictionary_origin_auto")}
                    </span>
                  </Show>
                </li>
              )}
            </For>
            <Show when={hiddenCount() > 0}>
              <li class="text-caption text-dls-secondary" data-testid="voice-dictionary-more">
                {t("voice.dictionary_more").replace("{n}", String(hiddenCount()))}
              </li>
            </Show>
          </ul>
        </div>
      </Show>

      {/* Shown on an empty list too: Import lives in the dialog. */}
      <Button
        variant="outline"
        class="text-caption h-8 py-0 px-3"
        onClick={() => setManaging(true)}
        data-testid="voice-dictionary-manage"
      >
        {t("voice.dictionary_manage")}
      </Button>

      <VoiceDictionaryDialog
        open={managing()}
        voice={voice}
        active={active()}
        onClose={() => setManaging(false)}
      />

      <p class="text-caption text-dls-secondary leading-relaxed" data-testid="voice-dictionary-learned">
        {t("voice.dictionary_learned_desc")}
      </p>

      {/*
        Evidence in progress, answering "I corrected it twice, why is it not here?".
        Hidden until there is something to list: the paragraph above already says
        what counts as a correction.
      */}
      <Show when={voice.correctionProgress().length > 0}>
        <div class="space-y-1.5 border-t border-dls-border/40 pt-3">
          <div class="text-caption font-medium text-dls-text">
            {t("voice.dictionary_progress_heading")}
          </div>
          <ul class="space-y-1" data-testid="voice-dictionary-progress">
            <For each={voice.correctionProgress()}>
              {(entry) => (
                <li
                  class="flex items-baseline justify-between gap-3 text-caption"
                  data-testid={`voice-dictionary-progress-${entry.word}`}
                >
                  <span class="truncate text-dls-text">{entry.word}</span>
                  <span class="shrink-0 tabular-nums text-dls-secondary">
                    {entry.blockedBy === "waiting"
                      ? t("voice.dictionary_progress_waiting")
                          .replace("{runs}", String(entry.runs))
                          .replace("{threshold}", String(entry.threshold))
                      : t(PROGRESS_BLOCK_KEY[entry.blockedBy])}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
}
