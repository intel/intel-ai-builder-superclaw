import {
  type FeedbackIngestOs,
  normalizeFeedbackIngestOs,
} from "@different-ai/openwork-contracts/feedback-ingest";

/** Maps host signals to the closed ingest OS enum (unit-tested; Rust re-validates). */
export function feedbackIngestOsFromSignals(
  platform: string,
  userAgent: string,
): FeedbackIngestOs {
  const platformLower = platform.toLowerCase();
  if (platformLower.includes("win")) {
    return normalizeFeedbackIngestOs("windows") ?? "windows";
  }
  if (platformLower.includes("mac")) {
    return normalizeFeedbackIngestOs("macos") ?? "macos";
  }
  if (platformLower.includes("linux")) {
    return normalizeFeedbackIngestOs("linux") ?? "linux";
  }
  const ua = userAgent.toLowerCase();
  if (ua.includes("windows")) {
    return "windows";
  }
  if (ua.includes("mac os") || ua.includes("macintosh")) {
    return "macos";
  }
  if (ua.includes("linux")) {
    return "linux";
  }
  return "linux";
}

/** Best-effort desktop OS label for feedback ingest (Rust normalizes again at POST). */
export function resolveFeedbackIngestOs(): FeedbackIngestOs {
  if (typeof navigator === "undefined") {
    return "windows";
  }
  return feedbackIngestOsFromSignals(navigator.platform, navigator.userAgent);
}
