/**
 * Dictionary list arithmetic: normalise, add, remove.
 *
 * Pure and separate from both the storage layer and the Settings card so the one
 * thing worth testing — what the user's typing turns into before it reaches the
 * wire — is testable without a DOM or a localStorage stub.
 *
 * **The limits below must match `asr_manager/api/asr.py`.** They are duplicated
 * rather than imported because nothing generates constants across the host/UI
 * boundary for this service (the transcribe contract lives in
 * `host/asr_manager/README.md`, not in `shared/contracts`). Diverging is a real
 * failure mode with a specific shape: the host 400s a recording the UI let the
 * user build, which surfaces as a broken microphone rather than as a full list.
 * So the UI refuses at the boundary the host refuses at, and a mismatch shows up
 * in `voice-dictionary.test.ts` rather than in a field report.
 */

/** Max entries. Host: `_MAX_DICTIONARY_WORDS`. */
export const MAX_DICTIONARY_WORDS = 250;

/** Max characters per entry, measured after trimming. Host: `_MAX_DICTIONARY_ENTRY_CHARS`. */
export const MAX_DICTIONARY_ENTRY_CHARS = 100;

/** Why {@link addDictionaryWord} refused. `null` means it was accepted. */
export type DictionaryRejection = "empty" | "duplicate" | "too_long" | "list_full";

/**
 * Clean a stored or pasted list into what the host will accept: trim each entry,
 * drop blanks and exact duplicates, drop over-long entries, cap the length.
 *
 * Over-long entries are DROPPED here, not rejected. This runs on read, where the
 * input is whatever is already in localStorage — a value the user cannot see and
 * cannot fix — so refusing the whole list would disable the Dictionary with no way
 * to recover. {@link addDictionaryWord} is the interactive path and does report it.
 *
 * Casing is preserved: the host's `hotword_forms` already biases the verbatim,
 * lowercase and Capitalised variants of every entry, so `NVMe` and `nvme` are not
 * duplicates and lowercasing would discard the form the user typed on purpose.
 */
export function normalizeDictionary(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const word = entry.trim();
    if (!word || word.length > MAX_DICTIONARY_ENTRY_CHARS || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_DICTIONARY_WORDS) break;
  }
  return out;
}

/**
 * Add one entry. Returns the rejection reason instead of throwing, because every
 * one of them is a message the card renders next to the input.
 *
 * Newest first: a user adding a word wants to see that it landed, and on a
 * 200-entry list appending would put it off the bottom of the card.
 */
export function addDictionaryWord(
  current: readonly string[],
  candidate: string,
): { words: string[]; rejection: DictionaryRejection | null } {
  const word = candidate.trim();
  if (!word) return { words: [...current], rejection: "empty" };
  if (word.length > MAX_DICTIONARY_ENTRY_CHARS) {
    return { words: [...current], rejection: "too_long" };
  }
  if (current.includes(word)) return { words: [...current], rejection: "duplicate" };
  if (current.length >= MAX_DICTIONARY_WORDS) {
    return { words: [...current], rejection: "list_full" };
  }
  return { words: [word, ...current], rejection: null };
}

/** Remove one entry by exact value. Absent is a no-op, not an error. */
export function removeDictionaryWord(current: readonly string[], word: string): string[] {
  return current.filter((entry) => entry !== word);
}
