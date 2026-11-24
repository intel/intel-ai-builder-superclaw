/**
 * The Dictionary, and the correction-learning loop that fills it by itself.
 *
 * Split out of `use-voice-input.ts` rather than added to it: that file was at 797
 * lines against AGENTS.md §7's 800, and its own PR said the next change had to split
 * it. This is the seam the split wanted anyway — the Dictionary is the one part of
 * the controller with no connection to download state, device enumeration or the
 * recording lifecycle.
 *
 * ## The loop, and where each half of it lives
 *
 * The composer inserts a transcript, the user fixes a word, the user sends. Only the
 * dictated segment is watched, via immutable prefix/suffix anchors captured at
 * insertion time — so words typed elsewhere in the message are never read as
 * corrections. On send, the segment is diffed against what was inserted and any
 * word-level fix is recorded against that recording's id. When the same corrected
 * form has been seen in enough *separate* recordings (two for an acronym or probable
 * name, three otherwise) it is added to the Dictionary and the user is told.
 *
 * `voice-corrections.ts` holds every rule and is pure. This file holds the state, the
 * storage, and the one side effect — a word appearing in the Dictionary.
 *
 * **On-device dictations only.** The Dictionary reaches the local decoder and nothing
 * else, so learning is gated on the same predicate the Dictionary card uses to enable
 * itself; see `learningActive`.
 *
 * ## When a correction is banked
 *
 * The same five triggers as the reference `_UIAWorker`, which are its `reason` strings:
 *
 * | reference | here |
 * | --- | --- |
 * | `enter` | {@link useVoiceCorrections.commitCorrections} — the composer sent |
 * | `new_dictation` | a second {@link noteTranscriptInserted} into the same draft |
 * | `stable` | the draft sat unchanged for {@link STABLE_MS} |
 * | `focus_lost` | the composer lost focus |
 * | `timeout` | {@link MAX_WATCH_MS} since the transcript landed |
 *
 * An earlier revision of this file banked on send alone, reasoning that we own the
 * composer and so never need timers. That was wrong in a way the reference already
 * knew about: sending a message starts an LLM turn, which has nothing to do with
 * teaching the Dictionary, so it made the user pay for a turn to correct a word — and
 * a dictation that was fixed and then abandoned taught nothing at all.
 *
 * **A commit is final**, as in the reference's `_finish_session(clear_capture=True)`:
 * one per dictation, after which the segment is no longer watched. A later edit to the
 * same segment is not a second observation of the same mis-hearing.
 *
 * Final, but only once there is something to be final about: the three timed triggers
 * fire against a draft the user may not have touched yet, and releasing the segment
 * there is what made the loop learn nothing at all. See {@link commitLatest}.
 *
 * **Never mid-composition.** A `stable` commit while an IME is open would read a
 * half-composed word back as the correction, so composition suspends the window and
 * finalizing restarts it — the reference does the same, and Pinyin or Zhuyin input is
 * exactly the case that needs it.
 */
import { createSignal, onCleanup } from "solid-js";

import { t } from "~/i18n";

import {
  type DictionaryRejection,
  MAX_DICTIONARY_WORDS,
  addDictionaryWord,
  removeDictionaryWord,
} from "./voice-dictionary";
import {
  type CorrectionRecord,
  type DictionaryOrigin,
  extractWordCorrections,
  isSingleWordCorrection,
  locateInsertedSegment,
  normalizeDictionaryWord,
  promotionCandidates,
  promotionProgress,
  recordCorrections,
  segmentBetweenAnchors,
} from "./voice-corrections";
import {
  readVoiceCorrections,
  readVoiceDictionary,
  readVoiceDictionaryAuto,
  readVoiceDictionarySuppressed,
  writeVoiceCorrections,
  writeVoiceDictionary,
  writeVoiceDictionaryAuto,
  writeVoiceDictionarySuppressed,
} from "./voice-input-prefs";

/** What the composer has to remember between inserting a transcript and sending. */
type PendingCapture = {
  readonly runId: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly delivered: string;
};

/**
 * How long the draft must sit unchanged before a correction is banked without a send.
 * Reference parity: `_STABLE_S` in `src/output/correction_monitor.py`.
 */
const STABLE_MS = 5_000;

/**
 * How long a single dictation is watched before whatever the draft says is banked.
 * Reference parity: `_MAX_WATCH_S`.
 *
 * It is not a hard release: like the idle window, a timeout that banks nothing keeps
 * the segment watched, because a user who has not corrected anything after a minute
 * is reading, not finished. Send, blur-with-evidence and the next dictation all end
 * the session, so the capture is still bounded.
 */
const MAX_WATCH_MS = 60_000;

/**
 * How long [Undo] stays on the notice that announced an auto-added word.
 *
 * Longer than the toast's own 2.4 s, which is why the toast is held open for as long
 * as this window stands — an undo the user cannot reach is not an undo. Ten seconds
 * is enough to read a one-line notice and disagree with it, and short enough that the
 * notice is not still sitting there when the next recording finishes.
 */
const UNDO_MS = 10_000;

/**
 * Arms a one-shot timer, returning its canceller. Injected so the tests can drive the
 * stable window and the watch timeout without waiting out real seconds.
 */
export type CorrectionScheduler = (run: () => void, ms: number) => () => void;

const realScheduler: CorrectionScheduler = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

function newRunId(): string {
  // WebView2 has `crypto.randomUUID`; the fallback exists for the test environment
  // and only has to be unique within a session, since a run id is consumed by the
  // next send.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param notify how the user is told a word was added.
 * @param learningActive whether the on-device decoder is the one being corrected. The
 *   Dictionary reaches nothing else, so a cloud dictation must not fill it — see the
 *   call site in `use-voice-input.ts`. Defaults to on for direct tests of the loop.
 */
export function useVoiceCorrections(
  notify: (message: string) => void,
  learningActive: () => boolean = () => true,
  schedule: CorrectionScheduler = realScheduler,
) {
  const storedManual = readVoiceDictionary();
  const storedAuto = readVoiceDictionaryAuto();
  // Each list is capped on read, but the host caps the two combined. A pair stored
  // under an older, higher cap would have every local recording rejected, so trim
  // learned words — never typed ones — to fit, and persist the result.
  const fittedAuto = storedAuto.slice(0, Math.max(0, MAX_DICTIONARY_WORDS - storedManual.length));
  if (fittedAuto.length < storedAuto.length) writeVoiceDictionaryAuto(fittedAuto);
  const [manualWords, setManualWords] = createSignal<string[]>(storedManual);
  const [autoWords, setAutoWords] = createSignal<string[]>(fittedAuto);
  const [suppressed, setSuppressed] = createSignal<string[]>(readVoiceDictionarySuppressed());
  const [records, setRecords] = createSignal<CorrectionRecord[]>(readVoiceCorrections());
  /** Why the last add was refused; cleared by the next successful one. */
  const [dictionaryRejection, setDictionaryRejection] =
    createSignal<DictionaryRejection | null>(null);
  /**
   * Words the last harvest added, for as long as [Undo] applies to them. A list
   * rather than one word because a single recording can push two words over at once,
   * and an [Undo] that took back only one of them would be a lie.
   */
  const [undoableAdd, setUndoableAdd] = createSignal<readonly string[]>([]);

  let pending: PendingCapture | null = null;
  /** The draft as last seen. What a timed commit has to read, since no one hands it
   * text — mirrors the reference's `session["latest"]`. */
  let latestText = "";
  let cancelStable: (() => void) | null = null;
  let cancelWatchdog: (() => void) | null = null;
  let cancelUndo: (() => void) | null = null;
  /** True between `compositionstart` and `compositionend`; suspends `stable`. */
  let composing = false;

  const clearTimers = () => {
    cancelStable?.();
    cancelStable = null;
    cancelWatchdog?.();
    cancelWatchdog = null;
  };

  /**
   * Withdraw the [Undo] offer, leaving the addition standing.
   *
   * Deliberately *not* part of {@link clearTimers}: a commit is what opens the window,
   * and every commit path ends the session, so folding it in would cancel the offer in
   * the same tick it was made.
   */
  const closeUndoWindow = () => {
    cancelUndo?.();
    cancelUndo = null;
    setUndoableAdd([]);
  };

  /** Stop watching the current dictation. Every commit path goes through here. */
  const endSession = () => {
    clearTimers();
    pending = null;
    composing = false;
  };

  // A stable window outliving the composer would fire into a disposed scope.
  onCleanup(clearTimers);
  onCleanup(() => cancelUndo?.());

  /**
   * Bank whatever the draft says now, releasing the segment only if that produced
   * evidence.
   *
   * **A commit that banks nothing is not a commit.** The idle window is armed the
   * moment the transcript lands, so it expires while the draft is still exactly as
   * dictated — the user is reading it, or has typed the rest of their own sentence,
   * neither of which says a word was misheard. Releasing the segment there made
   * every later fix invisible, which is the shape of "the Dictionary never learns
   * anything" in the app while every unit test passed: each one edited the draft
   * before letting the clock run.
   *
   * Finality is about not counting one mis-hearing twice, so it only has to hold
   * once there is something to count. {@link commitCorrections} still ends the
   * session unconditionally — a sent message is gone, however it was serialized.
   */
  const commitLatest = () => {
    const capture = pending;
    if (!capture) return;
    if (harvest(capture, latestText).banked) endSession();
  };

  /**
   * Restart the idle countdown. Called on every draft change, so it must stay cheap.
   * Leaves no timer armed while an IME is composing; `noteCompositionEnd` re-arms it.
   */
  const restartStableWindow = () => {
    cancelStable?.();
    cancelStable = null;
    if (!pending || composing) return;
    cancelStable = schedule(() => {
      cancelStable = null;
      commitLatest();
    }, STABLE_MS);
  };

  /**
   * What the host biases toward: both lists, manual first.
   *
   * Order matters only at the cap — `normalizeDictionary` truncates at
   * {@link MAX_DICTIONARY_WORDS}, and a word the user typed must not be the one
   * dropped to make room for a word the app guessed.
   */
  const dictionary = () => [...manualWords(), ...autoWords()];

  /** Where a word in the combined list came from, for the card's badge. */
  const originOf = (word: string): DictionaryOrigin =>
    manualWords().includes(word) ? "manual" : "auto";

  /**
   * Add one entry by hand. Returns whether it landed so the card can clear its input
   * only on success — retyping a refused word is worse than seeing it sit there next
   * to the reason.
   *
   * Adding a word explicitly also lifts its tombstone: the user asking for it is a
   * stronger signal than the earlier removal, and leaving the tombstone would mean a
   * word the user typed could never be re-learned if they later removed it.
   */
  const addDictionaryEntry = (candidate: string): boolean => {
    const { words, rejection } = addDictionaryWord(dictionary(), candidate);
    setDictionaryRejection(rejection);
    if (rejection !== null) return false;
    // `addDictionaryWord` prepends to the combined list; only the manual half is ours
    // to write, so take the new word from it rather than storing the join.
    const added = words[0];
    setManualWords((current) => {
      const next = [added, ...current];
      writeVoiceDictionary(next);
      return next;
    });
    const key = normalizeDictionaryWord(added);
    setSuppressed((current) => {
      if (!current.includes(key)) return current;
      const next = current.filter((entry) => entry !== key);
      writeVoiceDictionarySuppressed(next);
      return next;
    });
    return true;
  };

  /**
   * Remove one entry. An auto-added word also gets a tombstone, without which the
   * removal is undone by the next recording: the evidence that promoted it is still
   * stored, so it would be promoted straight back and the button would look broken.
   */
  const removeDictionaryEntry = (word: string) => {
    // A removal can free the slot the last add was refused for, so a stale "the
    // Dictionary is full" must not stay on screen next to a list that now has room.
    setDictionaryRejection(null);
    if (manualWords().includes(word)) {
      setManualWords((current) => {
        const next = removeDictionaryWord(current, word);
        writeVoiceDictionary(next);
        return next;
      });
      return;
    }
    setAutoWords((current) => {
      const next = removeDictionaryWord(current, word);
      writeVoiceDictionaryAuto(next);
      return next;
    });
    const key = normalizeDictionaryWord(word);
    setSuppressed((current) => {
      if (current.includes(key)) return current;
      const next = [...current, key];
      writeVoiceDictionarySuppressed(next);
      return next;
    });
  };

  /**
   * Take back the addition the notice is announcing, from the notice itself.
   *
   * This is {@link removeDictionaryEntry} and nothing more, which is the point: the
   * word has to be tombstoned, or the very next recording promotes it straight back
   * off evidence that is still on disk, and [Undo] would read as a button that does
   * nothing. "Do not add this word" and "remove this word I was given" are the same
   * request made a few seconds apart.
   *
   * Saying so out loud afterwards is not decoration. The notice still reads "Added
   * “X” to your Dictionary", and leaving that on screen under a button the user just
   * pressed is the failure mode §5c calls illegible.
   */
  const undoAutoAdd = () => {
    const words = undoableAdd();
    closeUndoWindow();
    if (words.length === 0) return;
    for (const word of words) {
      removeDictionaryEntry(word);
      notify(t("voice.dictionary_auto_add_undone").replace("{word}", word));
    }
  };

  /**
   * A transcript just went into the composer. `before`/`after` are the composer's
   * plain text either side of the insertion, which is what turns the transcript into
   * anchors that survive editing around it.
   *
   * A transcript that cannot be located (the same text already appeared elsewhere in
   * the draft) drops the capture instead of guessing which occurrence was ours.
   *
   * A second dictation into the same draft banks the previous one first. Only one
   * capture can be held at a time — the anchors run to the ends of the draft, so once
   * more text is appended the older capture's suffix would match the whole tail and
   * read dictation two's words back as dictation one's correction. `before` is the
   * last instant its anchors are still exact, so it is harvested here or not at all.
   */
  const noteTranscriptInserted = (before: string, after: string, transcript: string) => {
    // A new recording retires the previous notice, so [Undo] goes with it. Left armed,
    // it would sit on whatever that notice has been replaced by and take back a word
    // the user is no longer being told about. Closed before the hand-off below, which
    // may open a window of its own.
    closeUndoWindow();
    // Gated here rather than at commit time so a cloud dictation leaves no evidence at
    // all, instead of evidence that would promote the moment the user switched engine.
    if (!learningActive()) {
      pending = null;
      return;
    }
    const previous = pending;
    endSession();
    if (previous) harvest(previous, before);
    const located = locateInsertedSegment(before, after, transcript);
    if (!located) return;
    pending = {
      runId: newRunId(),
      prefix: located.prefix,
      suffix: located.suffix,
      delivered: located.segment,
    };
    latestText = after;
    cancelWatchdog = schedule(commitLatest, MAX_WATCH_MS);
    restartStableWindow();
  };

  /**
   * The draft changed. The composer calls this from its debounced flush, where the
   * text is already built, rather than per keystroke.
   */
  const noteDraftChanged = (currentText: string) => {
    if (!pending) return;
    latestText = currentText;
    restartStableWindow();
  };

  /** An IME opened. No commit may land until it closes. */
  const noteCompositionStart = () => {
    if (!pending) return;
    composing = true;
    cancelStable?.();
    cancelStable = null;
  };

  /**
   * An IME closed. Finalizing one composition is not necessarily the end of the
   * sentence, so this restarts the same window rather than committing — the comment
   * the reference leaves at its own `CompositionFinalized` branch.
   */
  const noteCompositionEnd = (currentText: string) => {
    if (!pending) return;
    composing = false;
    latestText = currentText;
    restartStableWindow();
  };

  /**
   * The composer lost focus. The user moved on, so the draft is as corrected as it is
   * going to get; `focus_lost` in the reference.
   */
  const noteComposerBlur = (currentText: string) => {
    if (!pending) return;
    latestText = currentText;
    commitLatest();
  };

  /**
   * The user sent the message. Diff the dictated segment against what was inserted,
   * record any word-level correction, and promote whatever has crossed its threshold.
   *
   * Returns the words added, for tests; the user learns about them from the toast.
   */
  const commitCorrections = (currentText: string): string[] => {
    const capture = pending;
    endSession();
    if (!capture) return [];
    return harvest(capture, currentText).promoted;
  };

  /**
   * Bank one capture against the draft as it stands. Shared by send and by the
   * hand-off in {@link noteTranscriptInserted}; `currentText` is whatever text the
   * capture's anchors were taken from, which is the caller's job to get right.
   *
   * `banked` is whether a word pair reached storage, which is what the timed and
   * blur commits key their finality off — see {@link commitLatest}. It is true for
   * the first observation of a pair as much as the promoting one, and false when the
   * segment is untouched, when the edit is not a mis-hearing, and when the pair
   * cannot be stored.
   */
  const harvest = (
    capture: PendingCapture,
    currentText: string,
  ): { banked: boolean; promoted: string[] } => {
    const nothing = { banked: false, promoted: [] as string[] };
    // Checked again here, not only at capture: the user can dictate on-device and
    // switch to cloud before sending, and a toast announcing an addition must never
    // point at a Dictionary card that is disabled. That drops one recording's
    // evidence, which is the cheaper of the two wrong answers.
    if (!learningActive()) return nothing;

    const segment = segmentBetweenAnchors(currentText, capture.prefix, capture.suffix);
    if (segment === null || segment === capture.delivered) return nothing;

    // Filtered here as well as inside `recordCorrections`, because a pair it would
    // drop is not evidence and must not count as a commit — an insertion-only edit
    // would otherwise end the watch before the user got to the misheard word.
    const pairs = extractWordCorrections(capture.delivered, segment).filter(([before, after]) =>
      isSingleWordCorrection(before.trim(), after.trim()),
    );
    if (pairs.length === 0) return nothing;

    const nextRecords = recordCorrections(records(), pairs, capture.runId);
    setRecords(nextRecords);
    writeVoiceCorrections(nextRecords);

    const existing = dictionary();
    // The cap is on the combined list, so a full Dictionary stops auto-adding rather
    // than silently dropping the user's own words off the end of it.
    const room = MAX_DICTIONARY_WORDS - existing.length;
    if (room <= 0) return { banked: true, promoted: [] };
    const promoted = promotionCandidates(nextRecords, existing, suppressed()).slice(0, room);
    if (promoted.length === 0) return { banked: true, promoted: [] };

    setAutoWords((current) => {
      const next = [...current, ...promoted];
      writeVoiceDictionaryAuto(next);
      return next;
    });
    for (const word of promoted) {
      notify(t("voice.dictionary_auto_added").replace("{word}", word));
    }
    // Opened last, so it is only ever offered for words that actually landed.
    cancelUndo?.();
    setUndoableAdd(promoted);
    cancelUndo = schedule(() => {
      cancelUndo = null;
      setUndoableAdd([]);
    }, UNDO_MS);
    return { banked: true, promoted };
  };

  return {
    // state
    dictionary,
    manualWords,
    autoWords,
    correctionRecords: records,
    /** What the loop has seen but not yet added, for the card to show. */
    correctionProgress: () => promotionProgress(records(), dictionary(), suppressed()),
    dictionaryRejection,
    originOf,
    /**
     * Words the notice on screen is offering to take back, empty when there is no
     * offer. The composer renders [Undo] from this, and the page holds the notice
     * open while it is non-empty — see {@link UNDO_MS}.
     */
    undoableAdd,
    // actions
    addDictionaryEntry,
    removeDictionaryEntry,
    undoAutoAdd,
    clearDictionaryRejection: () => setDictionaryRejection(null),
    noteTranscriptInserted,
    commitCorrections,
    noteDraftChanged,
    noteCompositionStart,
    noteCompositionEnd,
    noteComposerBlur,
  };
}

export type VoiceCorrectionsController = ReturnType<typeof useVoiceCorrections>;
