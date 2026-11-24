import { marked } from "marked";
import {
  formatInternalProviderModelLabel, isInternalProviderID,
} from "~/shared/util/model-ref";
import type { ModelBadgeDescriptor } from "~/shared/util/model-ref";
import { getModelRouteAlias } from "~/shared/util/model-ref";
import { UNSAFE_SCHEMES, escapeHtml } from "../part-view.links";

// Research reports use "~$109B" for approximate figures; marked's default
// del rule pairs SINGLE tildes, striking through everything between two
// approximations. Require the standard double-tilde form instead.
marked.use({
  tokenizer: {
    del(src: string) {
      const match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
      if (!match) return undefined;
      return {
        type: "del",
        raw: match[0],
        text: match[1],
        tokens: this.lexer.inlineTokens(match[1]),
      };
    },
  },
});

// The summary is agent output bound to innerHTML: escape raw HTML (including
// text marked trusts inside a raw `<code>`/`<pre>` tag) and drop
// script-capable link schemes. Every `&` left in the href is escaped so the
// browser cannot decode `javascript&#58;` into a scheme after the check.
const reportRenderer = new marked.Renderer();
reportRenderer.html = ({ text }) => escapeHtml(text);
const renderDefaultText = reportRenderer.text.bind(reportRenderer);
reportRenderer.text = (token) =>
  renderDefaultText(token.type === "text" ? { ...token, escaped: false } : token);
const renderDefaultLink = reportRenderer.link.bind(reportRenderer);
reportRenderer.link = (token) => {
  const href = token.href.replace(/&amp;/gi, "&");
  return UNSAFE_SCHEMES.test(href.trim())
    ? reportRenderer.parser.parseInline(token.tokens)
    : renderDefaultLink({ ...token, href: href.replace(/&/g, "&amp;") });
};

// Render a hybrid-DR report summary (markdown) to HTML so `#`/`##` show as
// headings instead of literal text in the "Final report summary" card.
export function renderReportMarkdown(md: string | null): string {
  try {
    const result = marked.parse(md ?? "", { async: false, renderer: reportRenderer });
    return typeof result === "string" ? result : "";
  } catch {
    return "";
  }
}

/** Format token count compactly: 1234 → "1.2k", 123456 → "123.5k", 1500000 → "1.50M" */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(2)}M`;
}

/**
 * Format a per-turn token summary as one combined total plus a local/cloud
 * percentage split, e.g. "58.3k tokens (63% local, 37% cloud)" or
 * "58.3k tokens (100% local)" when every contributing call ran on one side.
 *
 * "100% local"/"100% cloud" is an exact claim, not a rounded one: a turn that
 * made even a single token's worth of calls on the other side always renders
 * as a split. Rounding alone would erase a side worth <0.5% of the total and
 * report e.g. 999_600 local + 400 cloud as "100% local", which is exactly the
 * claim a user relies on being true.
 */
export function formatTokenSummary(info: { input: number; output: number; local: number; cloud: number }): string {
  // local+cloud, not input+output: an event recorded with only `total_tokens`
  // (no prompt/completion split) still counts here.
  const total = info.local + info.cloud;
  const formattedTotal = formatTokens(total);
  if (total === 0) return `${formattedTotal} tokens`;
  if (info.cloud === 0) return `${formattedTotal} tokens (100% local)`;
  if (info.local === 0) return `${formattedTotal} tokens (100% cloud)`;
  // Genuinely mixed: clamp so neither side rounds away to 0% or up to 100%.
  const localPct = Math.min(99, Math.max(1, Math.round((info.local / total) * 100)));
  return `${formattedTotal} tokens (${localPct}% local, ${100 - localPct}% cloud)`;
}

/** Format elapsed milliseconds: <1000 → "823ms", ≥1000 → "12.3s", ≥60000 → "2m 5s" */
export function formatElapsedMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Extract model info from message info if available */
export function getMessageModelInfo(
  info: unknown,
): { modelID: string; providerID: string } | null {
  const record = info as Record<string, unknown>;
  if (record?.role !== "assistant") return null;

  const modelID =
    typeof record.modelID === "string" ? record.modelID.trim() : "";
  const providerID =
    typeof record.providerID === "string" ? record.providerID.trim() : "";

  // Only return if there's meaningful data
  if (!modelID && !providerID) return null;

  return { modelID, providerID };
}

/** Format model display label */
export function formatModelLabel(modelInfo: {
  modelID: string;
  providerID: string;
}): string {
  const { modelID, providerID } = modelInfo;
  const trimmedModelID = modelID.trim();
  const trimmedProviderID = providerID.trim();

  if (!trimmedModelID && !trimmedProviderID) return "";
  if (!trimmedProviderID) return trimmedModelID;
  if (!trimmedModelID) return trimmedProviderID;
  if (isInternalProviderID(trimmedProviderID)) {
    return formatInternalProviderModelLabel(trimmedProviderID, trimmedModelID);
  }

  return `${trimmedProviderID}/${trimmedModelID}`;
}

/** Served model label when the router has records for the turn else the route label. */
export function messageModelBadgeLabel(
  info: unknown,
  servedByMessageId: Record<string, ModelBadgeDescriptor> | undefined,
): ModelBadgeDescriptor | null {
  const modelInfo = getMessageModelInfo(info);
  const id = String((info as { id?: unknown })?.id ?? "");
  const served =
    modelInfo && isInternalProviderID(modelInfo.providerID)
      ? id ? servedByMessageId?.[id] : undefined
      : undefined;
  if (served) return served;
  if (!modelInfo?.modelID) return null;
  if (isInternalProviderID(modelInfo.providerID)) {
    const alias = getModelRouteAlias(modelInfo.modelID);
    if (alias) return { kind: "route", alias };
  }
  return { kind: "model", value: formatModelLabel(modelInfo) };
}

export const VIRTUALIZATION_THRESHOLD = 500;

export const VIRTUAL_OVERSCAN = 4;

/**
 * Slack allowed when deciding whether the user is parked at the bottom of the
 * Activity timeline. Matches the 2px-style tolerance the session page uses for
 * its own bottom detection, widened slightly because step rows have sub-pixel
 * line heights.
 */
export const TIMELINE_BOTTOM_STICK_PX = 8;
