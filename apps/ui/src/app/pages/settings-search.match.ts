/**
 * The matcher behind the Settings search (#3836). Local and synchronous: no
 * network or model call.
 *
 * A Latin-script query word matches a word that starts with it, ignoring case
 * and accents ("appear" finds Appearance). Words of five letters or more may
 * carry one typo, and words of eight or more two, with a doubled letter
 * counting once ("telemtry", "aparence"). A Chinese query matches by substring.
 *
 * Every query word must match within one field; a label outranks a keyword,
 * which outranks a description. An entry whose fields only match the query
 * between them still matches, below any single field.
 */

export type SearchFieldKind = "label" | "keyword" | "description";

export type PreparedSearchField = {
  kind: SearchFieldKind;
  words: string[];
  /** The normalized text without spaces, for substring matching of Chinese. */
  compact: string;
};

type TokenMatch = "whole" | "prefix" | "fuzzy";

const KIND_SCORE: Record<SearchFieldKind, number> = { label: 300, keyword: 200, description: 100 };
const SPREAD_SCORE = 50;
const FUZZY_PENALTY = 40;
const WHOLE_WORD_BONUS = 20;
const MIN_FUZZY_LENGTH = 5;

const HAN = /\p{Script=Han}/u;

export const normalizeSearchText = (text: string): string =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

const splitWords = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export const searchTokens = (query: string): string[] => splitWords(normalizeSearchText(query));

export function prepareSearchField(kind: SearchFieldKind, text: string): PreparedSearchField {
  const normalized = normalizeSearchText(text);
  return { kind, words: splitWords(normalized), compact: normalized.replace(/\s+/g, "") };
}

const collapseDoubles = (word: string): string => word.replace(/(.)\1+/gu, "$1");

const allowedTypos = (length: number): number => (length >= 8 ? 2 : length >= MIN_FUZZY_LENGTH ? 1 : 0);

/** The fewest edits that turn `query` into some prefix of `word`. */
function prefixEditDistance(query: string, word: string): number {
  let previous = Array.from({ length: word.length + 1 }, (_, j) => j);
  for (let i = 1; i <= query.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= word.length; j += 1) {
      const substitution = previous[j - 1] + (query[i - 1] === word[j - 1] ? 0 : 1);
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, substitution);
    }
    previous = row;
  }
  return Math.min(...previous);
}

function matchToken(token: string, field: PreparedSearchField): TokenMatch | null {
  if (HAN.test(token)) {
    if (field.compact === token) return "whole";
    return field.compact.includes(token) ? "prefix" : null;
  }
  let found: TokenMatch | null = null;
  for (const word of field.words) {
    if (word === token) return "whole";
    if (word.startsWith(token)) found = "prefix";
  }
  if (found) return found;
  const collapsed = collapseDoubles(token);
  const typos = allowedTypos(collapsed.length);
  if (typos === 0) return null;
  // Both sides five letters or more, so "model" never reaches "mode".
  const near = field.words.some(
    (word) => word.length >= MIN_FUZZY_LENGTH && prefixEditDistance(collapsed, collapseDoubles(word)) <= typos,
  );
  return near ? "fuzzy" : null;
}

const RANK: Record<TokenMatch, number> = { whole: 3, prefix: 2, fuzzy: 1 };

function adjust(matches: TokenMatch[]): number {
  let score = 0;
  if (matches.includes("fuzzy")) score -= FUZZY_PENALTY;
  if (matches.every((match) => match === "whole")) score += WHOLE_WORD_BONUS;
  return score;
}

/** How well `tokens` match an entry's fields, or null when they do not. */
export function scoreSearchFields(tokens: readonly string[], fields: readonly PreparedSearchField[]): number | null {
  if (tokens.length === 0) return null;
  let best: number | null = null;
  for (const field of fields) {
    const matches: TokenMatch[] = [];
    for (const token of tokens) {
      const match = matchToken(token, field);
      if (!match) break;
      matches.push(match);
    }
    if (matches.length !== tokens.length) continue;
    const score = KIND_SCORE[field.kind] + adjust(matches);
    if (best === null || score > best) best = score;
  }
  if (best !== null) return best;

  const spread: TokenMatch[] = [];
  for (const token of tokens) {
    let bestMatch: TokenMatch | null = null;
    for (const field of fields) {
      const match = matchToken(token, field);
      if (match && (!bestMatch || RANK[match] > RANK[bestMatch])) bestMatch = match;
    }
    if (!bestMatch) return null;
    spread.push(bestMatch);
  }
  return SPREAD_SCORE + adjust(spread);
}
