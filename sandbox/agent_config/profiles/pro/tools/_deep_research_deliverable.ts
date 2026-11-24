/**
 * Pure, dependency-free helpers for deciding WHERE the hybrid deep-research
 * report should be materialized as a durable, host-visible deliverable file.
 *
 * Why this exists (issue #1633): the hybrid-deep-research root agent is a thin
 * dispatcher. On a weak on-device driver model it burns its step budget and
 * never performs the "save the report as the file the user asked for" step, so
 * the finished report only lives in the sidecar session dir and the user is
 * left with nothing. hybrid_dr_post_polish_processor therefore writes the
 * report to `/workspace` itself (deterministically, via fs — bypassing the
 * agent permission layer) so a deliverable ALWAYS exists regardless of what the
 * driver model does afterwards.
 *
 * Filename strategy (belt-and-suspenders, combines two independent signals):
 *   1. explicit `output_path` tool arg (the root agent fills it when the user
 *      names a file), then
 *   2. a "save (it/this/the …) as <name>.md" phrase parsed from the user query,
 *      then
 *   3. a slug of the report title, then
 *   4. a fixed default.
 * Whichever wins, the result is always a safe BASENAME under `/workspace`
 * (no directories, no traversal, no absolute paths).
 *
 * No runtime imports — kept pure so it is trivially unit-testable and safe to
 * bundle into the opencode tool (see sibling `_email_helpers.ts` for the
 * shared-helper precedent).
 */

import { join, dirname } from "path";

/** Container default; native backend sets SUPERCLAW_PATH / OPENCODE_DIRECTORY instead. */
export const WORKSPACE_DELIVERABLE_ROOT = "/workspace";

/** Workspace root for deliverables and HDR session dirs (container: /workspace). */
export function workspaceDeliverableRoot(): string {
  const hdrSessions = process.env.HYBRID_DR_SESSION_ROOT?.trim();
  if (hdrSessions) {
    // Native backend sets HYBRID_DR_SESSION_ROOT to <workspace>/deep-research-workspaces/sessions.
    return dirname(dirname(hdrSessions));
  }
  const fromEnv =
    process.env.SUPERCLAW_PATH?.trim() ||
    process.env.OPENCODE_DIRECTORY?.trim() ||
    process.env.WINDOWS_SUPERCLAW_PATH?.trim() ||
    "";
  return fromEnv || WORKSPACE_DELIVERABLE_ROOT;
}

/** Fallback name when no filename can be derived from args, query, or title. */
export const DEFAULT_DELIVERABLE_NAME = "deep_research_report.md";

/**
 * Reduce an arbitrary candidate to a safe `.md` BASENAME, or null if it cannot
 * be made safe. Strips any directory components (so `../x` or `/etc/x.md`
 * collapse to `x.md`), requires an `.md` extension, forbids a leading dot, and
 * allows only `[A-Za-z0-9._-]`.
 */
export function sanitizeDeliverableName(candidate: string | null | undefined): string | null {
  if (typeof candidate !== "string") return null;
  const base = candidate.trim().split(/[\\/]/).pop()?.trim() ?? "";
  if (!base || base.startsWith(".")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  if (!base.toLowerCase().endsWith(".md")) return null;
  // Reject a name that is only the extension (".md" already handled by leading-dot check).
  if (base.length <= 3) return null;
  return base;
}

/**
 * Parse a "save (it|this|the report|…) as <name>.md" instruction out of the raw
 * user query. Returns the raw captured filename (still needs sanitizing) or null.
 */
export function parseSaveAsName(userQuery: string | null | undefined): string | null {
  if (typeof userQuery !== "string" || !userQuery) return null;
  // `save` … `as` <name>.md — allow a few filler words between save and as,
  // and an optional opening quote (straight or curly) before the filename.
  const m = userQuery.match(
    /^[\s\S]*?\bsave\b[\s\S]{0,40}?\bas\b\s*["'`“‘]?\s*([A-Za-z0-9][\w\.\-]*\.md)\b/i,
  );
  return m ? m[1] : null;
}

/** Slugify a report title into a safe `<slug>.md`, or the default if empty. */
export function slugifyTitleToName(title: string | null | undefined): string {
  const slug = (typeof title === "string" ? title : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
    .replace(/_+$/g, "");
  return slug ? `${slug}.md` : DEFAULT_DELIVERABLE_NAME;
}

/**
 * Resolve the deliverable BASENAME from all signals, in priority order:
 * explicit output_path → save-as phrase in the query → title slug → default.
 * Always returns a safe `.md` basename.
 */
export function resolveDeliverableName(opts: {
  outputPath?: string | null;
  userQuery?: string | null;
  title?: string | null;
}): string {
  const fromExplicit = sanitizeDeliverableName(opts.outputPath);
  if (fromExplicit) return fromExplicit;
  const fromQuery = sanitizeDeliverableName(parseSaveAsName(opts.userQuery));
  if (fromQuery) return fromQuery;
  return slugifyTitleToName(opts.title);
}

/** Join a (already-sanitized) basename under the workspace deliverable root. */
export function resolveDeliverablePath(name: string): string {
  return join(workspaceDeliverableRoot(), name);
}
