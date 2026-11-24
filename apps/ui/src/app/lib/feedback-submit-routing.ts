/**
 * Pure routing for {@link FeedbackModal} submit (unit-tested).
 * See `feedback-ingest-host.ts` for AWS gating and infra README for backend ingest.
 */

export type FeedbackModalSubmitPath =
  | "log_assisted_bug"
  | "aws_ingest"
  | "github_issue";

/** First network action when the user clicks Send in the feedback modal. */
export function resolveFeedbackModalSubmitPath(input: {
  logAssistedBug: boolean;
  awsIngestEnabled: boolean;
  retryAfterQuota: boolean;
}): FeedbackModalSubmitPath {
  if (input.logAssistedBug) {
    return "log_assisted_bug";
  }
  if (!input.awsIngestEnabled || input.retryAfterQuota) {
    return "github_issue";
  }
  return "aws_ingest";
}
