import {
  submitBugReportViaAdapter,
  type FeedbackBugReportOptions,
  type FeedbackOpenLink,
  type FeedbackSubmitResult,
} from "./feedback";
import type { CollectedLog } from "./tauri";
import { isTauriRuntime } from "../utils";
import {
  getFeedbackIssueRepoSync,
  isFeedbackIssueRepoReady,
  isInternalFeedbackIssueRepo,
} from "./feedback-issue-repo";

export type BugLogEntry = CollectedLog & { origin: "auto" | "added" };

/** Log + gist flow: a prepared corp-network feedback target, not the public repository. */
export function shouldUseLogAssistedBugReportForIssueRepo(issueRepo: string): boolean {
  return isInternalFeedbackIssueRepo(issueRepo);
}

export function shouldUseLogAssistedBugReport(): boolean {
  return (
    isTauriRuntime() &&
    isFeedbackIssueRepoReady() &&
    shouldUseLogAssistedBugReportForIssueRepo(getFeedbackIssueRepoSync())
  );
}

export function gistFileName(relativePath: string): string {
  return relativePath.replace(/[\\/]+/g, "__");
}

export function mergeBugReportAdditionalContext(
  parts: (string | undefined | null)[],
): string | undefined {
  const joined = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  return joined.length > 0 ? joined : undefined;
}

export type BugReportPrefillParams = {
  sessionTitle: string;
  summary?: string;
  gistUrl?: string | null;
  extraContext?: string;
  issueRepo?: string;
};

/** Shared shape for URL build + {@link submitBugReportViaAdapter} (session / modal log-assisted flow). */
export function bugReportPrefillOptions(params: BugReportPrefillParams): FeedbackBugReportOptions {
  const gistPart = params.gistUrl
    ? `Recent logs uploaded as a gist: ${params.gistUrl}`
    : undefined;
  return {
    sessionTitle: params.sessionTitle,
    summary: params.summary,
    additionalContext: mergeBugReportAdditionalContext([gistPart, params.extraContext]),
    issueRepo: params.issueRepo,
  };
}

export async function submitBugReportPrefillViaAdapter(
  openLink: FeedbackOpenLink,
  params: BugReportPrefillParams,
): Promise<FeedbackSubmitResult> {
  return submitBugReportViaAdapter(openLink, bugReportPrefillOptions(params));
}

export function formatBugLogBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
