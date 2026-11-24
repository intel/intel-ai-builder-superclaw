/**
 * Learn Dictionary entries from the corrections a user makes to a transcript.
 *
 * Ported from the DictationApp reference (`voice-dictation-team/src/corrections.py`
 * plus the two pure helpers in `src/output/correction_monitor.py`). The rules are
 * the reference's, because each one is there to stop a specific false positive and
 * they are covered by its own suite; the plumbing around them is not, for one
 * reason worth stating: the reference pastes into *other* applications, so it needs
 * ~400 lines of Windows UI Automation to read a foreign text field back. Our
 * transcript lands in our own composer, so the before/after text is simply in hand.
 * Read the reference for its decisions, not its mechanism.
 *
 * Everything here is pure. Storage lives in `voice-input-prefs.ts`, the state and
 * the promotion side effects in `use-voice-corrections.ts`, so the part worth
 * testing — what an edit turns into before it can reach the Dictionary — is
 * testable without a DOM.
 *
 * **What is persisted is deliberately narrow: word pairs, never prose.** The
 * composer's contents are read in memory to diff them and are not stored. A
 * correction record is `{ before, after, count, runIds }` where both sides are at
 * most 40 characters and at most three words. That bound is the privacy property,
 * so it is enforced on read as well as on write.
 */

import { COMMON_ENGLISH_WORDS } from "./common-english-words";

/** Longest accepted entry, matching `voice-dictionary.ts` and the host. */
const MAX_TERM_CHARS = 40;

/**
 * Word count on the mistaken side. The corrected side is always exactly one
 * dictionary term; the mistaken side may be a short mis-hearing that split a word
 * ("L M" -> "LLM", "your aim" -> "LLM"), which is the whole point.
 */
const MAX_ORIGINAL_WORDS = 3;

/**
 * Diff ceiling. Word-level LCS is O(n*m); a dictated segment is a sentence or two,
 * and a pathological paste is not evidence about anybody's vocabulary. Over this,
 * the edit is ignored rather than making the send path wait on a 10^8-cell table.
 */
const MAX_DIFF_WORDS = 400;

/**
 * Kept per record. A record only matters until its corrected form crosses a
 * threshold of 2 or 3 distinct runs, after which the word is in the Dictionary and
 * `promotionCandidates` skips it. Ids beyond that can never change an outcome, and
 * a run id is unique per recording so a dropped one cannot recur and double count.
 */
const MAX_RUN_IDS = 16;

/** Records retained. The reference has no cap; localStorage needs one. */
export const MAX_CORRECTION_RECORDS = 500;

/**
 * Latin-ish runs stay glued through apostrophes and hyphens; a CJK ideograph is its
 * own entry until there is a real language-aware tokenizer. Translated from the
 * reference's Python regex rather than copied: Python's `\w` is Unicode-aware under
 * `re.UNICODE` while JavaScript's is ASCII-only, so the classes are spelled out.
 */
const WORD_RE = /[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*|[㐀-鿿]|[\p{L}\p{N}\p{M}]+/gu;

/** One to three plain words, nothing else. Anchored by the callers below. */
const DICT_TERM_RE =
  /^[\p{L}\p{N}\p{M}_]+(?:['’-][\p{L}\p{N}\p{M}_]+)*(?:\s+[\p{L}\p{N}\p{M}_]+(?:['’-][\p{L}\p{N}\p{M}_]+)*){0,2}$/u;

/**
 * Words that must never be auto-added: the reference's embedded stopword set unioned
 * with the 5,000-word frequency list it loads at runtime.
 *
 * The big list is not optional. Promotion needs only **two** runs for anything that
 * looks like a proper name, and "looks like a proper name" is decided by
 * capitalisation — so without it a capitalised everyday phrase ("This Is Fine")
 * qualifies. Ordinary vocabulary outside the 5k still promotes after three runs, in
 * the reference too (`menagerie` promotes in its own suite). That residue is
 * acceptable because biasing is a prior rather than a substitution, and because the
 * card shows every auto-added word with a way to remove it.
 */
const COMMON_WORDS = new Set([
  ...COMMON_ENGLISH_WORDS,
  ...`a about after again all also am an and any are as at be because been before
being between both but by can could did do does doing down during each few for
from further had has have having he her here hers herself him himself his how i
if in into is it its itself just me more most my myself no nor not now of off on
once only or other our ours ourselves out over own same she should so some such
than that the their theirs them themselves then there these they this those
through to too under until up very was we were what when where which while who
whom why will with would you your yours yourself yourselves`.split(/\s+/),
]);

/** One `(mistaken, corrected)` observation. */
export type CorrectionPair = readonly [original: string, corrected: string];

/**
 * An aggregated observation. `runIds` carries the identity of each recording the
 * pair was seen in, because the threshold counts **distinct runs, not edits**:
 * fixing the same word twice inside one dictation is one piece of evidence, and
 * counting keystrokes would promote on a single typo repair.
 */
export type CorrectionRecord = {
  readonly before: string;
  readonly after: string;
  readonly count: number;
  readonly runIds: readonly string[];
  readonly lastSeen: number;
};

/** Where a Dictionary word came from. Auto words are removable with a tombstone. */
export type DictionaryOrigin = "manual" | "auto";

function words(text: string): string[] {
  return String(text ?? "").match(WORD_RE) ?? [];
}

/** Stable key for dedupe, suppression and explicit restoration. */
export function normalizeDictionaryWord(word: string): string {
  return String(word ?? "")
    .normalize("NFKC")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

type Opcode = {
  readonly tag: "equal" | "replace" | "insert" | "delete";
  readonly i1: number;
  readonly i2: number;
  readonly j1: number;
  readonly j2: number;
};

/**
 * Word-level opcodes, shaped like Python's `SequenceMatcher.get_opcodes`.
 *
 * This is a plain LCS diff, not a port of `SequenceMatcher`'s longest-matching-
 * block recursion. The two can disagree about *which* minimal edit to report when
 * several are equally short; they agree on every case the reference pins, and the
 * filter below only accepts edits so small that there is nothing to disagree about.
 */
function diffOpcodes(a: readonly string[], b: readonly string[]): Opcode[] {
  const n = a.length;
  const m = b.length;
  const stride = m + 1;
  // lcs[i * stride + j] = length of the longest common subsequence of a[i:], b[j:].
  const lcs = new Int32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * stride + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * stride + j + 1] + 1
          : Math.max(lcs[(i + 1) * stride + j], lcs[i * stride + j + 1]);
    }
  }

  const out: Opcode[] = [];
  const push = (tag: Opcode["tag"], i1: number, i2: number, j1: number, j2: number) => {
    out.push({ tag, i1, i2, j1, j2 });
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      const i1 = i;
      const j1 = j;
      while (i < n && j < m && a[i] === b[j]) {
        i++;
        j++;
      }
      push("equal", i1, i, j1, j);
      continue;
    }
    // Consume the whole run of non-equal words on both sides at once, so a
    // substitution arrives as one `replace` rather than a delete beside an insert.
    const i1 = i;
    const j1 = j;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) break;
      if (j >= m || (i < n && lcs[(i + 1) * stride + j] >= lcs[i * stride + j + 1])) i++;
      else j++;
    }
    const deleted = i > i1;
    const inserted = j > j1;
    push(deleted && inserted ? "replace" : deleted ? "delete" : "insert", i1, i, j1, j);
  }
  return out;
}

/**
 * Changed `(original, corrected)` word groups.
 *
 * Punctuation-only, insertion-only and deletion-only edits are ignored on purpose:
 * appended prose is not evidence that a dictated word was misheard, and deleting a
 * word says nothing about what it should have been.
 */
export function extractWordCorrections(before: string, after: string): CorrectionPair[] {
  const old = words(before);
  const next = words(after);
  if (old.length > MAX_DIFF_WORDS || next.length > MAX_DIFF_WORDS) return [];

  const out: CorrectionPair[] = [];
  for (const { tag, i1, i2, j1, j2 } of diffOpcodes(old, next)) {
    if (tag === "equal") continue;
    // The corrected form must be exactly one dictionary word. A short mis-hearing
    // is allowed on the old side; a whole-field rewrite is not.
    if (i2 - i1 < 1 || i2 - i1 > MAX_ORIGINAL_WORDS || j2 - j1 !== 1) continue;
    const original = old.slice(i1, i2).join(" ").trim();
    const corrected = next[j1];
    if (!original || !corrected || original === corrected) continue;
    if (original.length > MAX_TERM_CHARS || corrected.length > MAX_TERM_CHARS) continue;
    out.push([original, corrected]);
  }
  return out;
}

/**
 * True for a short mistaken phrase corrected to one word — the only shape allowed
 * into storage. Re-checked on read, because it is what bounds a stored record to
 * words rather than to whatever prose surrounded them.
 */
export function isSingleWordCorrection(before: string, after: string): boolean {
  const old = words(before);
  const next = words(after);
  return (
    old.length >= 1 &&
    old.length <= MAX_ORIGINAL_WORDS &&
    next.length === 1 &&
    old.join(" ") === String(before ?? "").trim() &&
    next[0] === String(after ?? "").trim() &&
    old.join(" ") !== next[0] &&
    String(before ?? "").trim().length <= MAX_TERM_CHARS &&
    next[0].length <= MAX_TERM_CHARS
  );
}

/**
 * Why a corrected form can never be auto-added, or `""` if it can.
 *
 * A reason rather than a bare predicate, because a rejected word is exactly what
 * someone asks about — "I corrected this three times, why is it not in the
 * Dictionary?" — and a silent drop has no answer.
 */
export function promotionIneligibleReason(word: string): string {
  const display = String(word ?? "")
    .normalize("NFKC")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (!display) return "empty";
  if (display.length > MAX_TERM_CHARS) return "too long";
  if (!DICT_TERM_RE.test(display)) return "not a plain word";
  const tokens = words(display);
  if (tokens.length === 0) return "not a plain word";
  if (tokens.length > MAX_ORIGINAL_WORDS) return "more than three words";
  const normalized = normalizeDictionaryWord(display);
  const normalizedTokens = tokens.map(normalizeDictionaryWord);
  if (
    COMMON_WORDS.has(normalized) ||
    (tokens.length > 1 && normalizedTokens.every((token) => COMMON_WORDS.has(token)))
  ) {
    return "common word";
  }
  // A one-character ASCII "word" is a stray keystroke. A single CJK ideograph is a
  // real term, which is why the length test only applies to ASCII.
  if (display.length < 2 && /^[\x20-\x7e]*$/.test(display)) return "too short";
  if (!/\p{L}/u.test(display)) return "no letters";
  return "";
}

/** Whether a corrected form is safe and useful as a Dictionary term. */
export function isPromotionEligible(word: string): boolean {
  return promotionIneligibleReason(word) === "";
}

/**
 * Distinct runs required before auto-adding: **two** for a probable acronym or
 * proper name, **three** otherwise.
 *
 * The asymmetry is the reference's and it is the right way round. `LLM` or
 * `MiniMax` corrected twice is a name the recognizer does not know; an ordinary
 * lowercase word corrected twice is more often a slip of the tongue.
 */
export function promotionThreshold(word: string): number {
  const letters = [...String(word ?? "")].filter((ch) => /\p{L}/u.test(ch)).join("");
  const acronym = letters.length >= 2 && letters === letters.toUpperCase();
  const tokens = String(word ?? "").split(/\s+/).filter(Boolean);
  const probableName =
    tokens.length > 0 && tokens.every((token) => token[0] === token[0].toUpperCase());
  return acronym || probableName ? 2 : 3;
}

type Target = { word: string; threshold: number; runIds: Set<string> };

/**
 * Fold records into one entry per corrected form, keyed case-insensitively.
 *
 * Shared by `promotionCandidates` and `promotionProgress` so that what the user is
 * shown and what actually gets added can never disagree.
 */
function aggregateTargets(records: readonly CorrectionRecord[]): Map<string, Target> {
  const targets = new Map<string, Target>();
  for (const record of records) {
    const word = record.after.trim();
    const key = normalizeDictionaryWord(word);
    if (!key) continue;
    const threshold = promotionThreshold(word);
    const target = targets.get(key) ?? { word, threshold, runIds: new Set<string>() };
    if (threshold < target.threshold) {
      // Prefer the spelling that supplied the stronger acronym / proper-name
      // evidence, so the result does not depend on record order.
      target.word = word;
      target.threshold = threshold;
    }
    for (const runId of record.runIds) target.runIds.add(runId);
    targets.set(key, target);
  }
  return targets;
}

/**
 * Why a corrected form the loop has seen is not in the Dictionary.
 *
 * A code rather than the English of `promotionIneligibleReason`, because this one is
 * shown to the user and has to be translated. The finer reasons ("common word",
 * "too long") collapse into `unsuitable`: they all mean *never*, and which rule
 * fired is a detail the user cannot act on.
 */
export type PromotionBlock = "waiting" | "unsuitable" | "already_added" | "removed";

/** A corrected form the loop has seen, and how close it is to being added. */
export type PromotionProgress = {
  readonly word: string;
  /** Distinct recordings this fix has been seen in. */
  readonly runs: number;
  readonly threshold: number;
  readonly blockedBy: PromotionBlock;
};

/**
 * Everything the loop has observed, whether or not it can ever be promoted.
 *
 * This exists because the loop is otherwise unobservable: "nothing was recorded"
 * and "recorded once, needs two" look identical from the outside, and so does "this
 * word is a common word and will never be added". AGENTS.md §5c — fail legibly.
 *
 * Most evidence first, so the word about to be added is at the top.
 */
export function promotionProgress(
  records: readonly CorrectionRecord[],
  existingWords: readonly string[],
  suppressedKeys: readonly string[],
): PromotionProgress[] {
  const existing = new Set(existingWords.map(normalizeDictionaryWord));
  const blocked = new Set(suppressedKeys.map(normalizeDictionaryWord));

  const progress: PromotionProgress[] = [];
  for (const [key, target] of aggregateTargets(records)) {
    const blockedBy: PromotionBlock = existing.has(key)
      ? "already_added"
      : blocked.has(key)
        ? "removed"
        : isPromotionEligible(target.word)
          ? "waiting"
          : "unsuitable";
    progress.push({
      word: target.word,
      runs: target.runIds.size,
      threshold: target.threshold,
      blockedBy,
    });
  }
  return progress.sort((a, b) => b.runs - a.runs || a.word.localeCompare(b.word));
}

/**
 * Corrected forms that have crossed their threshold and are not blocked.
 *
 * Evidence is aggregated by **corrected form, not by the exact mistake**: `LM ->
 * LLM` and `L M -> LLM` are two runs of evidence for the same word. Without that,
 * a recognizer that mis-hears a name differently each time would never promote it —
 * which is the case the feature exists for.
 */
export function promotionCandidates(
  records: readonly CorrectionRecord[],
  existingWords: readonly string[],
  suppressedKeys: readonly string[],
): string[] {
  const existing = new Set(existingWords.map(normalizeDictionaryWord));
  const blocked = new Set(suppressedKeys.map(normalizeDictionaryWord));
  const targets = aggregateTargets(records);

  const promoted: string[] = [];
  for (const [key, target] of targets) {
    if (existing.has(key) || blocked.has(key)) continue;
    if (!isPromotionEligible(target.word)) continue;
    if (target.runIds.size < target.threshold) continue;
    promoted.push(target.word);
    existing.add(key);
  }
  return promoted;
}

/**
 * Fold `pairs` observed in run `runId` into `records`.
 *
 * Pairs are keyed case-insensitively, so `LM -> LLM` and `lm -> llm` aggregate,
 * while the first-seen casing is kept for display. A repeat within the same run
 * raises `count` but not the run evidence.
 */
export function recordCorrections(
  records: readonly CorrectionRecord[],
  pairs: readonly CorrectionPair[],
  runId: string,
  now: number = Date.now(),
): CorrectionRecord[] {
  const cleaned = pairs
    .map(([before, after]) => [before.trim(), after.trim()] as CorrectionPair)
    .filter(([before, after]) => isSingleWordCorrection(before, after));
  if (cleaned.length === 0) return [...records];

  const next = records.map((record) => ({ ...record, runIds: [...record.runIds] }));
  const keyOf = (before: string, after: string) =>
    `${normalizeDictionaryWord(before)}\u0000${normalizeDictionaryWord(after)}`;
  const byKey = new Map(next.map((record) => [keyOf(record.before, record.after), record]));

  for (const [before, after] of cleaned) {
    const key = keyOf(before, after);
    let current = byKey.get(key);
    if (!current) {
      current = { before, after, count: 0, runIds: [], lastSeen: now };
      next.push(current);
      byKey.set(key, current);
    }
    current.count += 1;
    current.lastSeen = now;
    if (runId && !current.runIds.includes(runId)) {
      current.runIds.push(runId);
      if (current.runIds.length > MAX_RUN_IDS) current.runIds = current.runIds.slice(-MAX_RUN_IDS);
    }
  }

  next.sort((a, b) => b.lastSeen - a.lastSeen || b.count - a.count);
  return next.slice(0, MAX_CORRECTION_RECORDS);
}

/** Clean a stored list, dropping anything that is not a word-pair record. */
export function normalizeCorrectionRecords(raw: readonly unknown[]): CorrectionRecord[] {
  const out: CorrectionRecord[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const before = String(record.before ?? "").trim();
    const after = String(record.after ?? "").trim();
    // Re-enforced on read: a stored record that is not a word pair is either
    // corrupt or from a build that persisted more than it should have.
    if (!isSingleWordCorrection(before, after)) continue;
    const count = Number(record.count);
    const lastSeen = Number(record.lastSeen);
    const runIds: string[] = [];
    if (Array.isArray(record.runIds)) {
      for (const runId of record.runIds) {
        const value = String(runId).trim();
        if (value && !runIds.includes(value)) runIds.push(value);
      }
    }
    out.push({
      before,
      after,
      count: Number.isFinite(count) ? Math.min(1e9, Math.max(1, Math.trunc(count))) : 1,
      runIds: runIds.slice(-MAX_RUN_IDS),
      lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0,
    });
    if (out.length >= MAX_CORRECTION_RECORDS) break;
  }
  return out;
}

/**
 * Locate the text this app inserted, as `(prefix, suffix, segment)`.
 *
 * Prefix and suffix are immutable anchors used later to read back **only** the
 * dictated segment, so words the user types elsewhere in the composer are never
 * mistaken for corrections. Replacing a selection is covered as well as a plain
 * insertion. Ported from `correction_monitor.locate_pasted_text`.
 */
export function locateInsertedSegment(
  before: string,
  after: string,
  delivered: string,
): { prefix: string; suffix: string; segment: string } | null {
  if (!delivered || before === after) return null;

  let prefixLen = 0;
  const limit = Math.min(before.length, after.length);
  while (prefixLen < limit && before[prefixLen] === after[prefixLen]) prefixLen++;

  let suffixLen = 0;
  const beforeLeft = before.length - prefixLen;
  const afterLeft = after.length - prefixLen;
  while (
    suffixLen < beforeLeft &&
    suffixLen < afterLeft &&
    before[before.length - 1 - suffixLen] === after[after.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const changedEnd = suffixLen ? after.length - suffixLen : after.length;
  const changed = after.slice(prefixLen, changedEnd);
  let start: number;
  let end: number;
  if (changed === delivered) {
    start = prefixLen;
    end = changedEnd;
  } else if (changed.includes(delivered)) {
    start = prefixLen + changed.indexOf(delivered);
    end = start + delivered.length;
  } else {
    // The transcript may also occur elsewhere in the composer from before this
    // insertion. Attributing the wrong occurrence would manufacture corrections,
    // so this fails closed rather than guessing.
    return null;
  }

  return { prefix: after.slice(0, start), suffix: after.slice(end), segment: after.slice(start, end) };
}

/**
 * Read the tracked segment back while its surrounding text is intact. `null` once
 * an anchor no longer matches — the user rewrote around the transcript, and this
 * has no way to say which part of the result was the correction.
 */
export function segmentBetweenAnchors(
  current: string,
  prefix: string,
  suffix: string,
): string | null {
  if (!current.startsWith(prefix)) return null;
  if (suffix && !current.endsWith(suffix)) return null;
  const end = suffix ? current.length - suffix.length : current.length;
  if (end < prefix.length) return null;
  return current.slice(prefix.length, end);
}
