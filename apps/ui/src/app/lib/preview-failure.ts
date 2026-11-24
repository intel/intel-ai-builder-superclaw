import { OpenworkServerError } from "./openwork-server";
import { t } from "../../i18n";

/**
 * Classification of a failed file-preview attempt.
 *
 * The distinction that matters is between a *verdict* and a *non-answer*:
 *
 * - `conversion-timeout` / `conversion-failed` / `too-large` / `unsupported`
 *   are verdicts. The server looked at the file and rejected it, so we can
 *   name what is wrong with it.
 * - `client-timeout` and `unknown` are NOT verdicts. The client gave up (or
 *   something unrelated broke) before the server produced an answer, so the
 *   document may well be fine. Telling the user "conversion failed" here would
 *   be inventing a conclusion we never obtained.
 *
 * Classification is driven by the structured `code` on OpenworkServerError,
 * never by matching words in the message text — message copy changes and gets
 * localized, and a text match would silently start misclassifying.
 */
export type PreviewFailureKind =
  | "package-required"
  | "conversion-timeout"
  | "conversion-failed"
  | "too-large"
  | "unsupported"
  | "not-found"
  | "unavailable"
  | "client-timeout"
  | "unknown";

export type PreviewFailure = {
  kind: PreviewFailureKind;
  message: string;
  /** True when the server never returned a verdict about the file itself. */
  indeterminate: boolean;
};

/**
 * Server error codes emitted by the preview routes in
 * sandbox/server/src/server.ts. Keep in sync with the ApiError codes there.
 */
const SERVER_CODE_MAP: Record<string, { kind: PreviewFailureKind; message: string }> = {
  office_conversion_timeout: {
    kind: "conversion-timeout",
    message:
      "This document took too long to convert for preview. It may be very large or complex — try opening it in its native app.",
  },
  office_conversion_failed: {
    kind: "conversion-failed",
    message: "This document could not be converted for preview.",
  },
  file_too_large: {
    kind: "too-large",
    message: "This file is too large to preview. Please open it manually.",
  },
  unsupported_preview_type: {
    kind: "unsupported",
    message: "This file type cannot be previewed.",
  },
  inbox_item_not_found: {
    kind: "not-found",
    message: "This file is no longer available.",
  },
  project_item_not_found: {
    kind: "not-found",
    message: "This file is no longer available.",
  },
  project_item_access_denied: {
    kind: "unavailable",
    message: "You don't have permission to preview this file.",
  },
  project_item_read_failed: {
    kind: "unavailable",
    message: "Unable to read this file for preview. Please try again.",
  },
  inbox_disabled: {
    kind: "unavailable",
    message: "File preview is unavailable in this mode.",
  },
  projects_disabled: {
    kind: "unavailable",
    message: "File preview is unavailable in this mode.",
  },
};

/**
 * The client-side abort message produced by fetchWithTimeout in
 * openwork-server.ts. Matched only as a last resort, after structured codes
 * have been ruled out, and only to decide that the outcome is *indeterminate*
 * — never to claim something is wrong with the document.
 */
const CLIENT_TIMEOUT_MESSAGE = "Request timed out.";

export function classifyPreviewFailure(error: unknown): PreviewFailure {
  if (error instanceof OpenworkServerError) {
    // The sandbox has no Office converter, so this is a verdict on the
    // environment, not on the document. The caller may offer to install it.
    if (error.code === "office_preview_not_installed") {
      return {
        kind: "package-required",
        message: t("session.office_preview_unavailable"),
        indeterminate: false,
      };
    }
    const mapped = SERVER_CODE_MAP[error.code];
    if (mapped) {
      return { ...mapped, indeterminate: false };
    }
    // The server answered, but with a code we do not model. Surface it as
    // indeterminate rather than guessing at a document-specific cause.
    return {
      kind: "unknown",
      message: "This file could not be previewed.",
      indeterminate: true,
    };
  }

  if (error instanceof Error && error.message === CLIENT_TIMEOUT_MESSAGE) {
    return {
      kind: "client-timeout",
      // Deliberately does not blame the document: the conversion may have been
      // progressing normally when the client stopped waiting.
      message: "Preview took too long to load. Please try again.",
      indeterminate: true,
    };
  }

  return {
    kind: "unknown",
    message: error instanceof Error && error.message
      ? error.message
      : "Unable to read file",
    indeterminate: true,
  };
}
