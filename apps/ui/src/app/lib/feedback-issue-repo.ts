import { isTauriRuntime } from "../utils";
import { feedbackIssueRepoSlug as fetchFeedbackIssueRepoSlug } from "./tauri";

/**
 * Feedback repository routing.
 *
 * `intel/intel-ai-builder` is the public source default, matching Rust.
 * `SUPERCLAW_FEEDBACK_ISSUE_REPO_PUBLIC` overrides it in a release bake.
 * A release may also bake a corp-network target from
 * `SUPERCLAW_FEEDBACK_ISSUE_REPO_INTERNAL`. The enterprise probe host is
 * `SUPERCLAW_FEEDBACK_ENTERPRISE_PROBE_HOST`. The mailto fallback is
 * `SUPERCLAW_FEEDBACK_EMAIL`. The internal slug, probe host, and email are
 * not stored in this source. The corp-network target is used only when the
 * executable is Intel-signed and that probe host resolves. An empty probe host
 * does not resolve.
 */

/** Source default. A release bake of `SUPERCLAW_FEEDBACK_ISSUE_REPO_PUBLIC` overrides it. */
export const FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT = "intel/intel-ai-builder";

function isGithubSlugPart(part: string): boolean {
  return part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/.test(part);
}

/** `owner/name` with the same character set the Rust host accepts. `.` and `..` are not components. */
export function isGithubIssueRepoSlug(slug: string): boolean {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slug.indexOf("/", slash + 1) !== -1) return false;
  return isGithubSlugPart(slug.slice(0, slash)) && isGithubSlugPart(slug.slice(slash + 1));
}

function sameFeedbackRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class FeedbackIssueRepoNotReadyError extends Error {
  constructor(message = "Feedback GitHub repo routing is not ready") {
    super(message);
    this.name = "FeedbackIssueRepoNotReadyError";
  }
}

export class FeedbackIssueRepoResolveError extends Error {
  constructor(message = "Could not resolve feedback GitHub repo from host") {
    super(message);
    this.name = "FeedbackIssueRepoResolveError";
  }
}

/** True when the host marked the selected repository as the corp-network target. */
export function isInternalFeedbackIssueRepo(issueRepo?: string): boolean {
  if (!cachedInternal || cachedRepo === null) return false;
  const explicit = issueRepo?.trim();
  if (!explicit) return true;
  return sameFeedbackRepo(explicit, cachedRepo);
}

let cachedRepo: string | null = null;
let cachedPublicRepo: string | null = null;
let cachedInternal = false;
let cachedFeedbackEmail: string | null = null;
let refreshPromise: Promise<string> | null = null;

function isFeedbackEmail(value: string): boolean {
  const at = value.indexOf("@");
  return at > 0 && value.indexOf("@", at + 1) === -1 && !/\s/.test(value) && value.slice(at + 1).includes(".");
}

/** Baked mailto target from the host. Empty when the release variable is unset. */
export function setFeedbackEmailCache(email: string): void {
  const trimmed = email.trim();
  cachedFeedbackEmail = isFeedbackEmail(trimmed) ? trimmed : null;
}

export function getFeedbackEmailSync(): string {
  return cachedFeedbackEmail ?? "";
}

export function setFeedbackIssueRepoCache(repo: string, publicRepo?: string, internal = false): void {
  const slug = repo.trim();
  if (!isGithubIssueRepoSlug(slug)) {
    cachedRepo = null;
    cachedPublicRepo = null;
    cachedInternal = false;
    return;
  }
  cachedRepo = slug;
  const declaredPublic = publicRepo?.trim() ?? "";
  cachedPublicRepo = isGithubIssueRepoSlug(declaredPublic) ? declaredPublic : null;
  cachedInternal =
    internal && (cachedPublicRepo === null || !sameFeedbackRepo(slug, cachedPublicRepo));
}

/** True after {@link refreshFeedbackIssueRepo} / {@link ensureFeedbackIssueRepoReady} has set the slug. */
export function isFeedbackIssueRepoReady(): boolean {
  return cachedRepo !== null;
}

/**
 * Slug for GitHub issue URLs. Call only after {@link isFeedbackIssueRepoReady} (or an explicit
 * `issueRepo` test override). Until ready, do not open GitHub — use {@link ensureFeedbackIssueRepoReady}.
 */
export function getFeedbackIssueRepoSync(): string {
  if (cachedRepo === null) {
    throw new FeedbackIssueRepoNotReadyError();
  }
  return cachedRepo;
}

/** Desktop: wait for Tauri `feedback_issue_repo_slug` before routing bug/feedback to GitHub.
 *  The host probes corp DNS only for an Intel-signed binary that baked a feedback
 *  repository. A public or source build returns the public repo and does not probe. */
export function ensureFeedbackIssueRepoReady(options?: {
  /** Re-query the corp DNS probe (avoids a stale public slug from an early app boot). */
  refresh?: boolean;
}): Promise<string> {
  if (options?.refresh) {
    cachedRepo = null;
    cachedPublicRepo = null;
    refreshPromise = null;
    return resolveFeedbackIssueRepoSlug();
  }
  if (cachedRepo !== null) {
    return Promise.resolve(cachedRepo);
  }
  if (!refreshPromise) {
    refreshPromise = refreshFeedbackIssueRepo();
  }
  return refreshPromise;
}

function usePublicFeedbackDefault(): string {
  setFeedbackIssueRepoCache(
    FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT,
    FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT,
  );
  return FEEDBACK_ISSUE_REPO_PUBLIC_DEFAULT;
}

export async function refreshFeedbackIssueRepo(): Promise<string> {
  try {
    if (!isTauriRuntime()) {
      return usePublicFeedbackDefault();
    }
    return await resolveFeedbackIssueRepoSlug();
  } finally {
    refreshPromise = null;
  }
}

/** Fresh slug from the host (always invokes Tauri on desktop). Use when opening GitHub. */
export async function resolveFeedbackIssueRepoSlug(): Promise<string> {
  if (!isTauriRuntime()) {
    return usePublicFeedbackDefault();
  }
  let raw: unknown;
  try {
    raw = await fetchFeedbackIssueRepoSlug();
  } catch (err) {
    console.warn("[feedback] feedback_issue_repo_slug failed:", err);
    throw new FeedbackIssueRepoResolveError();
  }
  setFeedbackEmailCache(readHostFeedbackEmail(raw));
  const choice = readHostFeedbackIssueRepo(raw);
  if (choice) {
    setFeedbackIssueRepoCache(choice.slug, choice.publicSlug ?? undefined, choice.internal);
    return choice.slug;
  }
  console.warn("[feedback] feedback_issue_repo_slug returned unexpected slug");
  return usePublicFeedbackDefault();
}

/** @internal Test isolation only. */
function readHostFeedbackEmail(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const email = (raw as { email?: unknown }).email;
  return typeof email === "string" ? email : "";
}

function readHostFeedbackIssueRepo(
  raw: unknown,
): { slug: string; publicSlug: string | null; internal: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { slug?: unknown; publicSlug?: unknown; internal?: unknown };
  const slug = typeof record.slug === "string" ? record.slug.trim() : "";
  if (!isGithubIssueRepoSlug(slug)) return null;
  const declaredPublic = typeof record.publicSlug === "string" ? record.publicSlug.trim() : "";
  const publicSlug = isGithubIssueRepoSlug(declaredPublic) ? declaredPublic : null;
  return {
    slug,
    publicSlug,
    internal: record.internal === true && (publicSlug === null || !sameFeedbackRepo(slug, publicSlug)),
  };
}

export function resetFeedbackIssueRepoStateForTests(): void {
  cachedRepo = null;
  cachedPublicRepo = null;
  cachedInternal = false;
  cachedFeedbackEmail = null;
  refreshPromise = null;
}
