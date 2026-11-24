export type MaskedReviewOperation = {
  operation_id: string;
  operation_session_id: string;
  source_file_path?: string;
};

export function parseReviewOperations(metadata: unknown): MaskedReviewOperation[] {
  const raw = (metadata as { operations?: unknown } | null | undefined)?.operations;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (op): op is MaskedReviewOperation =>
      typeof op === "object" &&
      op !== null &&
      typeof (op as MaskedReviewOperation).operation_id === "string" &&
      typeof (op as MaskedReviewOperation).operation_session_id === "string",
  );
}

// A placeholder such as <ORG_3>, or ORG_3 as the "Masked:" list shows it.
export function isPlaceholderTerm(term: string): boolean {
  return /^<*[A-Za-z][A-Za-z0-9_]*_\d+>*$/.test(term.trim());
}

export function splitTerms(input: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of input.split(/[,\n;]/)) {
    const term = part.trim();
    if (term && !seen.has(term.toLowerCase())) {
      seen.add(term.toLowerCase());
      terms.push(term);
    }
  }
  return terms;
}
