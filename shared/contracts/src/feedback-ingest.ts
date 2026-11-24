import categoriesJson from "./data/feedback-ingest-categories.json" with { type: "json" };
import osJson from "./data/feedback-ingest-os.json" with { type: "json" };

/** Closed enum — keep in sync with `feedback-ingest-categories.json` and Lambda `CATEGORIES`. */
export type FeedbackIngestCategory = "bug" | "idea" | "question" | "other";

const CANONICAL_FEEDBACK_INGEST_CATEGORIES: readonly FeedbackIngestCategory[] = [
  "bug",
  "idea",
  "question",
  "other",
];

function loadFeedbackIngestCategories(
  raw: readonly string[],
): readonly FeedbackIngestCategory[] {
  if (
    raw.length !== CANONICAL_FEEDBACK_INGEST_CATEGORIES.length ||
    !raw.every((value, index) => value === CANONICAL_FEEDBACK_INGEST_CATEGORIES[index])
  ) {
    throw new Error(
      "feedback-ingest-categories.json drifted from FeedbackIngestCategory",
    );
  }
  return raw as readonly FeedbackIngestCategory[];
}

/**
 * Closed feedback category enum shared by the UI modal, Tauri ingest POST, and
 * the AWS feedback-ingest Lambda (`feedback-categories.mjs` + `validation.mjs`).
 */
export const FEEDBACK_INGEST_CATEGORIES = loadFeedbackIngestCategories(categoriesJson);

/** Closed enum — keep in sync with `feedback-ingest-os.json` and Lambda `OSES`. */
export type FeedbackIngestOs = "windows" | "macos" | "linux";

const CANONICAL_FEEDBACK_INGEST_OS: readonly FeedbackIngestOs[] = [
  "windows",
  "macos",
  "linux",
];

function loadFeedbackIngestOs(raw: readonly string[]): readonly FeedbackIngestOs[] {
  if (
    raw.length !== CANONICAL_FEEDBACK_INGEST_OS.length ||
    !raw.every((value, index) => value === CANONICAL_FEEDBACK_INGEST_OS[index])
  ) {
    throw new Error("feedback-ingest-os.json drifted from FeedbackIngestOs");
  }
  return raw as readonly FeedbackIngestOs[];
}

/**
 * Closed client OS enum for feedback ingest (UI, Tauri POST, Lambda validation).
 */
export const FEEDBACK_INGEST_OS_VALUES = loadFeedbackIngestOs(osJson);

const FEEDBACK_INGEST_OS_SET = new Set<string>(FEEDBACK_INGEST_OS_VALUES);

/** Returns a closed `os` value or null when the input is not on the allowlist. */
export function normalizeFeedbackIngestOs(value: string): FeedbackIngestOs | null {
  const normalized = value.trim().toLowerCase();
  if (FEEDBACK_INGEST_OS_SET.has(normalized)) {
    return normalized as FeedbackIngestOs;
  }
  return null;
}
