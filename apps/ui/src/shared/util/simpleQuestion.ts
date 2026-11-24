import type { ComposerDraft } from "~/shared/types/composer";

const MAX_SIMPLE_LENGTH = 80;

// Anchored greeting / chitchat phrases. Matched against the whole, normalized
// prompt (lowercased, trimmed, trailing punctuation stripped) so that "Hi!" and
// "  hello.  " both qualify but "hi, can you summarize /tmp/notes.pdf" does not.
const SIMPLE_QUESTION_PATTERNS: RegExp[] = [
  /^hi+$/,
  /^hello+$/,
  /^hey+$/,
  /^yo$/,
  /^howdy$/,
  /^good (morning|afternoon|evening|night)$/,
  /^how are you( doing| today)?$/,
  /^how('?s| is) it going$/,
  /^what'?s up$/,
  /^what can you do$/,
  /^who are you$/,
  /^what are you$/,
  /^thanks?$/,
  /^thank you$/,
  /^thx$/,
  /^ty$/,
  /^bye$/,
  /^goodbye$/,
  /^see you$/,
  /^cya$/,
  /^ok$/,
  /^okay$/,
  /^cool$/,
  /^nice$/,
];

const TRAILING_PUNCT = /[.!?,;:\s]+$/;

const normalize = (raw: string): string => {
  return raw.trim().toLowerCase().replace(TRAILING_PUNCT, "").trim();
};

export function isSimpleQuestion(draft: ComposerDraft): boolean {
  if (draft.attachments.length > 0) return false;
  if (draft.parts.some((part) => part.type === "file")) return false;
  if (draft.command) return false;

  const raw = (draft.resolvedText ?? draft.text).trim();
  if (!raw) return false;
  if (raw.length > MAX_SIMPLE_LENGTH) return false;
  if (raw.includes("\n")) return false;

  const normalized = normalize(raw);
  if (!normalized) return false;

  return SIMPLE_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized));
}
