/** Deep-research report discovery for the Session view: works out which report and
 * summary files a run produced, and which message the summary card sits under.
 * Pure - unit-testable. */

import type { Part } from "@opencode-ai/sdk/v2/client";
import type { ArtifactItem, MessageWithParts } from "../types";

export type ReportSummaryCandidate = {
  id: string;
  afterMessageId: string;
  path: string;
  summaryPath: string;
  displayPath: string;
  truncateSummary: boolean;
  inlineSummary: string | null;
};

/** `state` is status-discriminated in the SDK and the fields we read only exist on
 * the completed variant, so read it loosely rather than narrowing per status. */
type ToolState = { status?: unknown; output?: unknown; metadata?: unknown };

const toolState = (part: Part): ToolState => {
  const state = (part as { state?: unknown }).state;
  return state && typeof state === "object" ? (state as ToolState) : {};
};

const toolName = (part: Part) => {
  const tool = (part as { tool?: unknown }).tool;
  return typeof tool === "string" ? tool.trim() : "";
};

/** A run that is still going, or that failed, has no final report to show. */
const isToolIncomplete = (state: ToolState) =>
  state.status === "running" ||
  state.status === "pending" ||
  state.status === "error";

/** Hybrid metadata may carry the key with an empty value, so keep looking. */
const firstNonEmptyString = (...candidates: unknown[]) => {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  return "";
};

/** The legacy tool instead commits to the first key that is present at all: a key
 * holding a non-string is treated as "no report", not as a reason to try the next. */
const firstPresentPath = (...candidates: unknown[]) => {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : null;
  }
  return null;
};

const messageHasAssistantText = (message: MessageWithParts) =>
  message.info.role === "assistant" &&
  message.parts.some(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0,
  );

/** Newest-first scan for a message id, skipping messages the predicate rejects and
 * those with no usable id. Returns "" when nothing in the range qualifies. */
const lastMessageIdWhere = (
  messages: MessageWithParts[],
  from: number,
  to: number,
  accept: (message: MessageWithParts) => boolean,
) => {
  for (let index = from; index >= to; index -= 1) {
    const candidate = messages[index];
    if (!candidate || !accept(candidate)) continue;
    const id = String(candidate.info.id ?? "").trim();
    if (id) return id;
  }
  return "";
};

/** The report card belongs under the assistant's closing text for that turn, which
 * is the last assistant message with text before the user speaks again. */
export const findReportSummaryAnchorMessageId = (
  messages: MessageWithParts[],
  reportMessageIndex: number,
  fallbackMessageId: string,
) => {
  let endIndex = messages.length;
  for (
    let index = reportMessageIndex + 1;
    index < messages.length;
    index += 1
  ) {
    if (messages[index]?.info?.role === "user") {
      endIndex = index;
      break;
    }
  }
  return (
    lastMessageIdWhere(
      messages,
      endIndex - 1,
      reportMessageIndex,
      messageHasAssistantText,
    ) || fallbackMessageId
  );
};

/** No report tool part to anchor to, so fall back to the newest assistant text, or
 * failing that the newest message of any kind. */
const findFallbackReportSummaryAnchorMessageId = (
  messages: MessageWithParts[],
) => {
  const last = messages.length - 1;
  return (
    lastMessageIdWhere(messages, last, 0, messageHasAssistantText) ||
    lastMessageIdWhere(messages, last, 0, () => true)
  );
};

const isUiSummaryArtifactPath = (path: string) =>
  /(?:^|\/)reports\/ui_summary\.md$/i.test(path.trim().replace(/[\\/]+/g, "/"));

const deriveExecutiveReportPathFromSummaryPath = (path: string) =>
  path.replace(/ui_summary\.md$/i, "executive_report.md");

const parseToolOutputObject = (
  state: ToolState,
): Record<string, unknown> | null => {
  const rawOutput = state.output;
  if (rawOutput && typeof rawOutput === "object")
    return rawOutput as Record<string, unknown>;
  const output = typeof rawOutput === "string" ? rawOutput.trim() : "";
  if (!output) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Legacy path: the report pipeline tool reports one file, used as both the report
 * and its summary. Older wrappers returned it JSON-encoded, or as loose text. */
export const extractDeepResearchReportPath = (part: Part): string | null => {
  if (
    part.type !== "tool" ||
    toolName(part) !== "deep_research_report_pipeline"
  )
    return null;
  const state = toolState(part);
  if (isToolIncomplete(state)) return null;

  const reportPathIn = (record: Record<string, unknown>) =>
    firstPresentPath(
      record.final_report_path,
      record.report_path,
      record.file_path,
    );

  const rawOutput = state.output;
  if (rawOutput && typeof rawOutput === "object")
    return reportPathIn(rawOutput as Record<string, unknown>);

  const output = typeof rawOutput === "string" ? rawOutput.trim() : "";
  if (!output) return null;
  try {
    return reportPathIn(JSON.parse(output) as Record<string, unknown>);
  } catch {
    const keyMatch = output.match(
      /["'](?:final_report_path|report_path|file_path)["']\s*:\s*["']([^"']+final_report\.md)["']/i,
    );
    if (keyMatch?.[1]?.trim()) return keyMatch[1].trim();
    const pathMatch = output.match(
      /(?:file:\/\/)?(?:[A-Za-z]:)?[^\s"'`<>]*final_report\.md/i,
    );
    return pathMatch?.[0]?.trim() ?? null;
  }
};

/** Hybrid path: the post-polish sidecar publishes both paths via
 * `context.metadata(...)`; the legacy wrapper returned them as a JSON blob. */
export const extractHybridDeepResearchReportPaths = (
  part: Part,
): {
  reportPath: string;
  summaryPath: string;
  inlineSummary: string | null;
} | null => {
  if (
    part.type !== "tool" ||
    toolName(part) !== "hybrid_dr_post_polish_processor"
  )
    return null;
  const state = toolState(part);
  if (isToolIncomplete(state)) return null;

  const meta = (state.metadata ?? {}) as Record<string, unknown>;
  const parsed = parseToolOutputObject(state);
  const privateSummaryPath = firstNonEmptyString(
    meta.ui_summary_path,
    parsed?.ui_summary_path,
  );
  const privateReportPath = firstNonEmptyString(
    meta.published_executive_report_path,
    meta.executive_report_path,
    parsed?.published_executive_report_path,
    parsed?.executive_report_path,
  );
  const deliverablePath = firstNonEmptyString(
    meta.deliverable_path,
    parsed?.deliverable_path,
  );
  const inlineSummary =
    firstNonEmptyString(meta.summary, parsed?.summary) || null;
  const reportPath = deliverablePath || privateReportPath;
  const summaryPath = deliverablePath || privateSummaryPath;
  if (!summaryPath || !reportPath) return null;
  return { reportPath, summaryPath, inlineSummary };
};

/** Tools report absolute host paths; the preview reads workspace-relative ones. */
export const normalizeReportPathForPreview = (
  path: string,
  activeWorkspaceRoot: string,
) => {
  const normalized = path
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/[\\/]+/g, "/");
  if (!normalized) return "";

  const root = activeWorkspaceRoot
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  if (root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1);
  }

  return normalized
    .replace(/^\.\/+/, "")
    .replace(/^\/+workspace\//i, "")
    .replace(/^workspace\//i, "");
};

export const collectReportSummaryCandidates = (input: {
  messages: MessageWithParts[];
  artifacts: ArtifactItem[];
  workingFiles: string[];
  activeWorkspaceRoot: string;
}): ReportSummaryCandidate[] => {
  const { messages, artifacts, workingFiles, activeWorkspaceRoot } = input;
  const candidates: ReportSummaryCandidate[] = [];
  const seenSummaryPaths = new Set<string>();
  const forPreview = (path: string) =>
    normalizeReportPathForPreview(path, activeWorkspaceRoot);

  const addCandidate = (
    id: string,
    afterMessageId: string,
    rawReportPath: string,
    rawSummaryPath: string,
    truncateSummary: boolean,
    inlineSummary: string | null,
  ) => {
    const path = forPreview(rawReportPath);
    const summaryPath = forPreview(rawSummaryPath);
    if (!path || !summaryPath) return;
    const key = summaryPath.toLowerCase();
    if (seenSummaryPaths.has(key)) return;
    seenSummaryPaths.add(key);
    candidates.push({
      id,
      afterMessageId,
      path,
      summaryPath,
      displayPath: path,
      truncateSummary,
      inlineSummary,
    });
  };

  messages.forEach((message, messageIndex) => {
    if (!message) return;
    const messageId = String(message?.info?.id ?? "").trim();
    if (!messageId) return;
    for (const part of message.parts) {
      const hybridPaths = extractHybridDeepResearchReportPaths(part);
      const legacyPath = hybridPaths
        ? null
        : extractDeepResearchReportPath(part);
      const reportPath = hybridPaths?.reportPath ?? legacyPath;
      const summaryPath = hybridPaths?.summaryPath ?? legacyPath;
      if (!reportPath || !summaryPath) continue;
      addCandidate(
        `${messageId}:${String(part.id ?? reportPath).trim()}`,
        findReportSummaryAnchorMessageId(messages, messageIndex, messageId),
        reportPath,
        summaryPath,
        !hybridPaths,
        hybridPaths?.inlineSummary ?? null,
      );
    }
  });

  // Installed/OpenCode-native Hybrid DR can run post-polish straight from the
  // phase-gate plugin, so no tool part carries `ui_summary_path` - but the files
  // still show up in the artifact/working-file lists. Fall back to those so
  // desktop gets the same final-summary card as the web/tool paths. When a tool
  // part already produced a card, skip the fallback: the artifact scan would
  // surface the same report a second time under its sidecar path.
  if (candidates.length > 0) return candidates;
  const fallbackAnchor = findFallbackReportSummaryAnchorMessageId(messages);
  if (!fallbackAnchor) return candidates;

  const artifactPaths = [
    ...artifacts.flatMap((artifact) => [artifact?.path, artifact?.name]),
    ...workingFiles,
  ];
  for (const rawPath of artifactPaths) {
    const summaryPath = String(rawPath ?? "").trim();
    if (!summaryPath || !isUiSummaryArtifactPath(summaryPath)) continue;
    addCandidate(
      `${fallbackAnchor}:artifact:${summaryPath}`,
      fallbackAnchor,
      deriveExecutiveReportPathFromSummaryPath(summaryPath),
      summaryPath,
      false,
      null,
    );
  }
  return candidates;
};

export const shouldStartReportSummaryLoad = (
  state: { attemptKey?: string; [key: string]: unknown } | null | undefined,
  attemptKey: string,
) => state?.attemptKey !== attemptKey;

const REPORT_SUMMARY_PREVIEW_CHARS = 500;

export const summarizeReportMarkdown = (content: string) => {
  const chars = Array.from(content.trim());
  const preview = chars.slice(0, REPORT_SUMMARY_PREVIEW_CHARS).join("");
  return chars.length > REPORT_SUMMARY_PREVIEW_CHARS
    ? `${preview}...`
    : preview;
};
