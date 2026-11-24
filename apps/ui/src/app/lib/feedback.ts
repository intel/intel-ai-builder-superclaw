import type { FeedbackCategory } from "./tauri";
import { buildBugReportBodyMarkdown } from "./feedback-issue-body";
import { githubSignInUrlForIssueDraft } from "./feedback-github-open";
import {
  FeedbackIssueRepoNotReadyError,
  FeedbackIssueRepoResolveError,
  getFeedbackEmailSync,
  getFeedbackIssueRepoSync,
  isFeedbackIssueRepoReady,
  isGithubIssueRepoSlug,
  resolveFeedbackIssueRepoSlug,
  FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT,
} from "./feedback-issue-repo";

/** Sync URL builders only — production opens use {@link resolveFeedbackIssueRepoForOpen}. */
function resolveFeedbackIssueRepo(issueRepo?: string): string {
  const trimmedIssueRepo = issueRepo != null ? issueRepo.trim() : "";
  if (trimmedIssueRepo) return trimmedIssueRepo;
  if (isFeedbackIssueRepoReady()) return getFeedbackIssueRepoSync();
  return FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT;
}
/** After {@link ensureFeedbackIssueRepoReady}, reuse cache — do not re-probe DNS on open. */
async function resolveFeedbackIssueRepoForOpen(issueRepo?: string): Promise<string | null> {
  const trimmedIssueRepo = issueRepo != null ? issueRepo.trim() : "";
  if (trimmedIssueRepo) return trimmedIssueRepo;
  if (isFeedbackIssueRepoReady()) return getFeedbackIssueRepoSync();
  try {
    return await resolveFeedbackIssueRepoSlug();
  } catch (err) {
    if (
      err instanceof FeedbackIssueRepoNotReadyError ||
      err instanceof FeedbackIssueRepoResolveError
    ) {
      return null;
    }
    throw err;
  }
}

/** The public repository and a prepared corp-network target both ship `bug.yml`. */
export function feedbackIssueRepoHasBugYmlTemplate(repo: string): boolean {
  return isGithubIssueRepoSlug(repo.trim());
}
const DEFAULT_SUBJECT = "OpenWork Feedback";

export type FeedbackSubmitResult = {
  ok: boolean;
  mode: "mailto" | "github_issue";
  reason?: "missing_mailto" | "missing_issue_url" | "open_failed";
  url?: string;
};

export type FeedbackOpenLink = (url: string) => void | Promise<void>;

async function openLinkViaAdapter(openLink: FeedbackOpenLink, url: string): Promise<boolean> {
  try {
    await openLink(url);
    return true;
  } catch {
    return false;
  }
}

export type FeedbackMailtoOptions = {
  subject?: string;
  body?: string;
};

export type FeedbackBugReportOptions = {
  sessionTitle?: string;
  /** bug.yml `summary` form field. */
  summary?: string;
  /** bug.yml `additional_context` (e.g. gist link from session report-bug). */
  additionalContext?: string;
  /** Test override; production uses {@link getFeedbackIssueRepoSync}. */
  issueRepo?: string;
};

export type FeedbackModalIssueOptions = {
  category: FeedbackCategory;
  message?: string;
  appVersion?: string;
  /** Extra text (e.g. diagnostic snapshot) appended to the issue prefill. */
  additionalContext?: string;
  issueRepo?: string;
};

const FEEDBACK_ISSUE_TITLE_LABEL: Record<FeedbackCategory, string> = {
  bug: "Bug",
  idea: "Idea",
  question: "Question",
  other: "Feedback",
};

export function buildFeedbackMailtoUrl(options?: FeedbackMailtoOptions): string {
  const to = getFeedbackEmailSync().trim();
  if (!to) return "";

  const subject = (options?.subject ?? DEFAULT_SUBJECT).trim();
  const body = (options?.body ?? "").trim();
  const params: string[] = [];
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);

  return `mailto:${to}${params.length ? `?${params.join("&")}` : ""}`;
}

export function buildFeedbackBugReportUrl(options: FeedbackBugReportOptions = {}): string {
  const title = options.sessionTitle?.trim() || "unknown session";
  const repo = resolveFeedbackIssueRepo(options.issueRepo);
  const params = new URLSearchParams({
    title: `[Bug] Bug report: ${title}`,
  });

  if (feedbackIssueRepoHasBugYmlTemplate(repo)) {
    params.set("template", "bug.yml");
    if (options.summary?.trim()) {
      params.set("summary", options.summary.trim());
    }
    if (options.additionalContext?.trim()) {
      params.set("additional_context", options.additionalContext.trim());
    }
  } else {
    params.set(
      "body",
      buildBugReportBodyMarkdown({
        shortDescription: options.summary,
        additionalDetails: options.additionalContext,
      }),
    );
  }

  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}
/** GitHub issue prefill for status-bar / modal feedback (all categories). */
export function buildFeedbackModalIssueUrl(options: FeedbackModalIssueOptions): string {
  const repo = resolveFeedbackIssueRepo(options.issueRepo);
  const version = options.appVersion?.trim() || "unknown";
  const message = options.message?.trim() ?? "";

  if (options.category === "bug") {
    return buildFeedbackBugReportUrl({
      sessionTitle: `Feedback ${version}`,
      summary: message,
      additionalContext: options.additionalContext,
      issueRepo: repo,
    });
  }

  const label = FEEDBACK_ISSUE_TITLE_LABEL[options.category];
  const params = new URLSearchParams({
    title: `[${label}] SuperClaw feedback (${version})`,
  });
  const bodyParts = [message, options.additionalContext?.trim()].filter(
    (part): part is string => Boolean(part),
  );
  if (bodyParts.length > 0) {
    params.set("body", bodyParts.join("\n\n"));
  }
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

export async function submitFeedbackViaAdapter(
  openLink: FeedbackOpenLink,
  options?: FeedbackMailtoOptions,
): Promise<FeedbackSubmitResult> {
  const url = buildFeedbackMailtoUrl(options);
  if (!url) {
    return { ok: false, mode: "mailto", reason: "missing_mailto" };
  }

  const opened = await openLinkViaAdapter(openLink, url);
  return opened
    ? { ok: true, mode: "mailto", url }
    : { ok: false, mode: "mailto", reason: "open_failed", url };
}

export async function submitBugReportViaAdapter(
  openLink: FeedbackOpenLink,
  options: FeedbackBugReportOptions,
): Promise<FeedbackSubmitResult> {
  const issueRepo = await resolveFeedbackIssueRepoForOpen(options.issueRepo);
  if (!issueRepo) {
    return { ok: false, mode: "github_issue", reason: "missing_issue_url" };
  }
  const url = buildFeedbackBugReportUrl({ ...options, issueRepo }).trim();
  if (!url) {
    return { ok: false, mode: "github_issue", reason: "missing_issue_url" };
  }

  const openUrl = githubSignInUrlForIssueDraft(url);
  const opened = await openLinkViaAdapter(openLink, openUrl);
  return opened
    ? { ok: true, mode: "github_issue", url: openUrl }
    : { ok: false, mode: "github_issue", reason: "open_failed", url: openUrl };
}

export async function submitFeedbackIssueViaAdapter(
  openLink: FeedbackOpenLink,
  options: FeedbackModalIssueOptions,
): Promise<FeedbackSubmitResult> {
  const issueRepo = await resolveFeedbackIssueRepoForOpen(options.issueRepo);
  if (!issueRepo) {
    return { ok: false, mode: "github_issue", reason: "missing_issue_url" };
  }
  const url = buildFeedbackModalIssueUrl({ ...options, issueRepo }).trim();
  if (!url) {
    return { ok: false, mode: "github_issue", reason: "missing_issue_url" };
  }

  const openUrl = githubSignInUrlForIssueDraft(url);
  const opened = await openLinkViaAdapter(openLink, openUrl);
  return opened
    ? { ok: true, mode: "github_issue", url: openUrl }
    : { ok: false, mode: "github_issue", reason: "open_failed", url: openUrl };
}
