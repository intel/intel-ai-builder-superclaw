import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  untrack,
} from "solid-js";
import { marked } from "marked";
import { File } from "lucide-solid";
import { isTauriRuntime, safeStringify, summarizeStep } from "../utils";
import { sanitizeGuardErrors } from "~/shared/util/guard-messages";
import { sanitizeProtectionMessages } from "~/shared/util/protection-messages";
import { sanitizeToolRejectMessages } from "~/shared/util/tool-reject-messages";
import { usePlatform } from "../context/platform";
import { perfNow, recordPerfLog } from "../lib/perf-log";
import { applyTextHighlights, useThrottledValue } from "./part-view.highlight";
import { fileCardInfo } from "./part-view.file-info";
import { UNSAFE_SCHEMES, classifyLinkTarget, isWorkspaceFilePath, renderInlineTextWithLinks, splitTextTokens } from "./part-view.links";
import { LARGE_TEXT_COLLAPSE_CHAR_THRESHOLD, LARGE_TEXT_PREVIEW_CHARS, expandedLargeTextPartIds, markdownCacheKey, readMarkdownCache, rendererForTone, writeMarkdownCache } from "./part-view.markdown";
import { clampText, normalizeFilePath } from "./part-view.paths";
import type { LinkType, Props } from "./part-view.types";

export default function PartView(props: Props) {
  const platform = usePlatform();
  const p = () => props.part;
  const developerMode = () => props.developerMode ?? false;
  const tone = () => props.tone ?? "light";
  const showThinking = () => props.showThinking ?? true;
  const renderMarkdown = () => props.renderMarkdown ?? false;
  const markdownThrottleMs = () => Math.max(0, props.markdownThrottleMs ?? 100);
  const textPartStableId = createMemo(() => {
    if (p().type !== "text") return "";
    const record = p() as { id?: string | number; messageID?: string | number };
    const partId = record.id;
    if (typeof partId === "string") return partId;
    if (typeof partId === "number") return String(partId);
    if (props.expansionKey) return `key:${props.expansionKey}`;
    const messageId = record.messageID;
    if (typeof messageId === "string") return `msg:${messageId}`;
    if (typeof messageId === "number") return `msg:${String(messageId)}`;
    return "";
  });
  const textSearchId = createMemo(() => {
    const record = p() as {
      id?: string | number;
      searchPartId?: string;
    };
    return typeof record.searchPartId === "string"
      ? record.searchPartId
      : typeof record.id === "string" || typeof record.id === "number"
        ? String(record.id)
        : textPartStableId();
  });
  const isPersistedExpanded = () => {
    const id = textPartStableId();
    return Boolean(id && expandedLargeTextPartIds.has(id));
  };
  const [expandedLongText, setExpandedLongText] = createSignal(
    isPersistedExpanded(),
  );
  createEffect(() => {
    if (!isPersistedExpanded()) return;
    if (expandedLongText()) return;
    setExpandedLongText(true);
  });
  const rawText = createMemo(() => {
    if (p().type !== "text") return "";
    return "text" in p() ? String((p() as { text: string }).text ?? "") : "";
  });
  /**
   * What the user is shown for this part: rawText with internal protection-status
   * directives and any tool-guard error the model quoted back into its answer
   * replaced by user-facing copy, and any llmrouter_manager "Tool call rejected"
   * hardening notice removed outright (a pure-notice part never reaches this
   * component at all — see isToolRejectOnlyTextPart in part-visibility.ts — this
   * only matters when the notice is mixed into real prose). Every text render path
   * below reads this, the plain-text fallbacks included, so a markdown parse
   * failure is not a way back to the raw text.
   *
   * Nothing is rewritten for user messages: this component renders both authors,
   * and a user pasting a log that opens with `BLOCKED:` must still see their own
   * words rather than the safety notice.
   */
  const displayText = createMemo(() => {
    const raw = rawText();
    if (props.isUserMessage) return raw;
    return sanitizeToolRejectMessages(
      sanitizeGuardErrors(sanitizeProtectionMessages(raw)),
    );
  });
  const shouldCollapseLongText = createMemo(
    () =>
      renderMarkdown() &&
      p().type === "text" &&
      rawText().length >= LARGE_TEXT_COLLAPSE_CHAR_THRESHOLD,
  );
  const collapsedLongText = createMemo(
    () =>
      shouldCollapseLongText() &&
      !(expandedLongText() || isPersistedExpanded()),
  );
  const collapsedPreviewText = createMemo(() => {
    const text = displayText();
    if (!collapsedLongText()) return text;
    if (text.length <= LARGE_TEXT_PREVIEW_CHARS) return text;
    return `${text.slice(0, LARGE_TEXT_PREVIEW_CHARS)}\n\n...`;
  });
  const collapsedPreviewMarkdown = createMemo(() => {
    if (!collapsedLongText()) return null;
    const text = collapsedPreviewText();
    if (!text.trim()) return "";
    const toneKey = tone();
    const cacheKey = markdownCacheKey(toneKey, text);
    const cachedHtml = readMarkdownCache(cacheKey);
    if (cachedHtml !== undefined) return cachedHtml;
    try {
      const renderer = rendererForTone(toneKey);
      const result = marked.parse(text, {
        breaks: true,
        gfm: true,
        renderer,
        async: false,
      });
      const html = typeof result === "string" ? result : "";
      if (!html && text.trim()) return null;
      writeMarkdownCache(cacheKey, html);
      return html;
    } catch (error) {
      console.error("Markdown parsing error:", error);
      return null;
    }
  });
  let textContainerEl: HTMLDivElement | undefined;
  // Use higher-contrast text color for outputs
  const textClass = () => (tone() === "dark" ? "text-dls-text" : "text-dls-text");
  const subtleTextClass = () =>
    tone() === "dark" ? "text-dls-text/70" : "text-dls-secondary";
  const panelBgClass = () =>
    tone() === "dark" ? "bg-dls-surface-raised/10" : "bg-dls-surface-raised/30";
  const toolOnly = () => true;
  const showToolOutput = () => developerMode();
  const markdownSource = createMemo(() => {
    if (!renderMarkdown() || p().type !== "text") return "";
    if (collapsedLongText()) return "";
    return displayText();
  });
  const throttledMarkdownSource = useThrottledValue(
    markdownSource,
    markdownThrottleMs,
  );
  const renderedMarkdown = createMemo(() => {
    if (!renderMarkdown() || p().type !== "text") return null;
    if (collapsedLongText()) return null;
    const text = throttledMarkdownSource();
    if (!text.trim()) return "";

    const toneKey = tone();
    const cacheKey = markdownCacheKey(toneKey, text);
    const cachedHtml = readMarkdownCache(cacheKey);
    if (cachedHtml !== undefined) return cachedHtml;

    try {
      const startedAt = perfNow();
      const renderer = rendererForTone(toneKey);
      const result = marked.parse(text, {
        breaks: true,
        gfm: true,
        renderer,
        async: false,
      });
      const parseMs = Math.round((perfNow() - startedAt) * 100) / 100;
      if (developerMode() && (parseMs >= 12 || text.length >= 6_000)) {
        const record = p() as { id?: string; messageID?: string };
        recordPerfLog(true, "session.render", "markdown-parse", {
          partID: record.id ?? null,
          messageID: record.messageID ?? null,
          chars: text.length,
          ms: parseMs,
        });
      }

      const html = typeof result === "string" ? result : "";
      // If marked returned empty HTML for non-empty source, treat as a parse
      // failure so the fallback renders plain text instead of blank space.
      if (!html && text.trim()) {
        return null;
      }
      writeMarkdownCache(cacheKey, html);
      return html;
    } catch (error) {
      console.error("Markdown parsing error:", error);
      return null;
    }
  });

  const openLink = async (href: string, type: LinkType) => {
    if (type === "url") {
      platform.openLink(href);
      return;
    }

    let filePath = normalizeFilePath(href, props.workspaceRoot ?? "");
    if (!filePath) return;

    // When running inside a remote/sandbox workspace the normalized path is a
    // container-side path (e.g. /workspace/src/foo.ts) that doesn't exist on
    // the Windows host.  The parent can supply a resolver that maps it to the
    // host-side equivalent (e.g. C:\Users\…\SuperClawProjects\src\foo.ts).
    if (props.resolveHostPath) {
      const hostPath = await props.resolveHostPath(filePath);
      if (hostPath) filePath = hostPath;
    }

    if (!isTauriRuntime()) {
      platform.openLink(
        href.startsWith("file://") ? href : `file://${filePath}`,
      );
      return;
    }

    try {
      const { openPath, revealItemInDir } =
        await import("@tauri-apps/plugin-opener");
      await revealItemInDir(filePath).catch(() => openPath(filePath));
    } catch {
      platform.openLink(
        href.startsWith("file://") ? href : `file://${filePath}`,
      );
    }
  };

  const openMarkdownLink = async (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;

    // Always prevent default for anchors to stop Tauri WebView from
    // intercepting clicks (e.g. navigating to localhost or opening browser).
    event.preventDefault();
    event.stopPropagation();

    // Check for file links rendered via renderInlineTextWithLinks (data-file-href).
    const fileHref = anchor.getAttribute("data-file-href")?.trim();
    if (fileHref) {
      // Prevent opening files outside the workspace.
      if (!isWorkspaceFilePath(fileHref, props.workspaceRoot ?? "")) return;
      await openLink(fileHref, "file");
      return;
    }

    const href = anchor.getAttribute("href")?.trim();
    if (href && UNSAFE_SCHEMES.test(href)) {
      if (developerMode()) {
        console.warn("Blocked unsafe link:", href);
      }
      return;
    }
    const link = href ? classifyLinkTarget(href) : null;
    if (link) {
      if (
        link.type === "file" &&
        !isWorkspaceFilePath(link.href, props.workspaceRoot ?? "")
      ) {
        return;
      }
      await openLink(link.href, link.type);
    }
  };

  const renderTextWithLinks = () => {
    const text = displayText();
    if (!text) return <span>{""}</span>;

    const tokens = splitTextTokens(text);
    // untrack: workspaceRoot is a static workspace config that never changes
    // mid-session.  Tracking it would cause ALL PartViews to re-render when the
    // workspace connection state updates — catastrophic in long sessions.
    const wsRoot = untrack(() => props.workspaceRoot) ?? "";
    return (
      <span>
        <For each={tokens}>
          {(token) =>
            token.kind === "link" &&
            (token.type === "url" ||
              isWorkspaceFilePath(token.href, wsRoot)) ? (
              <a
                href={token.type === "file" ? "#" : token.href}
                {...(token.type === "url"
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void openLink(token.href, token.type);
                }}
              >
                {token.value}
              </a>
            ) : (
              token.value
            )
          }
        </For>
      </span>
    );
  };

  createEffect(() => {
    if (p().type !== "text" && p().type !== "file") return;
    const root = textContainerEl;
    if (!root) return;
    const query = props.highlightQuery ?? "";
    const markdownSnapshot = renderMarkdown() ? renderedMarkdown() : null;
    const partId = textSearchId();
    const isCollapsedPreview = collapsedLongText();
    const hasHiddenMatch =
      isCollapsedPreview &&
      Boolean(query.trim()) &&
      displayText().toLowerCase().includes(query.trim().toLowerCase());
    queueMicrotask(() => {
      if (!textContainerEl || textContainerEl !== root) return;
      applyTextHighlights(
        textContainerEl,
        query,
        partId,
        props.searchHighlightBudget,
        `part-view:${partId}`,
      );
      if (hasHiddenMatch) setExpandedLongText(true);
    });
  });

  const toolData = () => {
    if (p().type !== "tool") return null;
    return p() as any;
  };

  let toolSummaryRuns = 0;
  let lastToolSummaryAt = 0;
  const toolSummary = createMemo(() => {
    if (p().type !== "tool") return null;
    const startedAt = perfNow();
    const summary = summarizeStep(p());
    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    toolSummaryRuns += 1;
    const now = Date.now();
    const sinceLastMs = lastToolSummaryAt > 0 ? now - lastToolSummaryAt : null;
    lastToolSummaryAt = now;

    if (
      developerMode() &&
      (elapsedMs >= 4 || (toolSummaryRuns >= 6 && (sinceLastMs ?? 0) < 300))
    ) {
      const record = p() as { id?: string; messageID?: string };
      recordPerfLog(true, "session.render", "tool-summary", {
        partID: record.id ?? null,
        messageID: record.messageID ?? null,
        runs: toolSummaryRuns,
        sinceLastMs,
        ms: elapsedMs,
      });
    }

    return summary;
  });
  const toolState = () => toolData()?.state ?? {};
  const toolName = () => (toolData()?.tool ? String(toolData()?.tool) : "tool");
  const toolTitle = () => {
    const title = toolSummary()?.title;
    if (title) return title;
    return toolState()?.title ? String(toolState().title) : toolName();
  };
  const toolStatus = () =>
    toolState()?.status ? String(toolState().status) : "unknown";
  const toolSubtitle = () => {
    const detail = toolSummary()?.detail;
    if (detail) return detail;
    if (toolState()?.subtitle || toolState()?.detail || toolState()?.summary) {
      return String(
        toolState().subtitle ?? toolState().detail ?? toolState().summary,
      );
    }
    return "";
  };

  const extractDiff = () => {
    const state = toolState();
    const candidates = [state?.diff, state?.patch, state?.output];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      if (
        candidate.includes("@@") ||
        candidate.includes("+++ ") ||
        candidate.includes("--- ")
      ) {
        return candidate;
      }
    }
    return null;
  };

  const diffText = createMemo(() =>
    p().type === "tool" ? extractDiff() : null,
  );
  const normalizeToolText = (value: unknown) => {
    if (typeof value !== "string") return "";
    return value.replace(/(?:\r?\n\s*)+$/, "");
  };
  const diffTextNormalized = createMemo(() => normalizeToolText(diffText()));
  const diffLines = createMemo(() =>
    diffTextNormalized() ? diffTextNormalized().split("\n") : [],
  );
  const diffLineClass = (line: string) => {
    if (line.startsWith("+")) return "text-dls-diff-added bg-dls-diff-added-bg/40";
    if (line.startsWith("-")) return "text-dls-diff-removed bg-dls-diff-removed-bg/40";
    if (line.startsWith("@@")) return "text-dls-diff-hunk bg-dls-diff-hunk-bg/30";
    return "text-dls-text";
  };

  // Strip internal fields from run_protected_file_pipeline results that the end
  // user does not need: `message` (model-only orchestration directives, e.g.
  // "proceed to Step 3") and the `operation_id` / `operation_session_id` restore
  // handles. The user-facing fields (success, masked_file_path, final_answer,
  // resolved_by) are kept. Other tools are returned unchanged.
  const stripPipelineMessage = (rawOutput: string): string => {
    if (toolName().toLowerCase() !== "run_protected_file_pipeline")
      return rawOutput;
    try {
      const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        const internalFields = [
          "message",
          "operation_id",
          "operation_session_id",
        ];
        const hadInternal = internalFields.some((field) => field in parsed);
        if (hadInternal) {
          for (const field of internalFields) delete parsed[field];
          return JSON.stringify(parsed, null, 2);
        }
      }
    } catch {
      // Not JSON (or unparseable) — leave the output untouched.
    }
    return rawOutput;
  };

  const toolOutput = () =>
    stripPipelineMessage(normalizeToolText(toolState()?.output));
  const hasReadXmlOutput = createMemo(() => {
    if (toolName().toLowerCase() !== "read") return false;
    const output = toolOutput().trimStart();
    return (
      output.startsWith("<path>") ||
      output.startsWith("<type>") ||
      output.startsWith("<content>")
    );
  });

  // Hide confirm_file_protection only when it reports PROTECTION_DISABLED.
  // That result means protection was skipped automatically, so no user dialog
  // appeared and showing a tool card would add noise. Real user decisions,
  // such as APPROVED or ACTION_DENIED, still render normally.
  const isProtectionBypassHidden = createMemo(
    () =>
      toolName().toLowerCase() === "confirm_file_protection" &&
      toolOutput().includes("PROTECTION_DISABLED"),
  );

  // confirm_file_protection reports PROTECTION_DISABLED for two different
  // reasons that must not share the same banner copy:
  //  - data-protection mode is "none": the file may still leave the device
  //    (e.g. to a cloud model) without redaction.
  //  - the session is pinned to the local model: the file never leaves the
  //    device at all, so claiming it "was sent to the cloud" would be false.
  const protectionBypassMessage = createMemo(() => {
    if (/stays on the device/i.test(toolOutput())) {
      return "File Protection is off — this session is running locally, so the file stayed on your device and was not sent to the cloud.";
    }
    return "File Protection is off — this file was processed without data redaction.";
  });

  const toolError = () => {
    const error = toolState()?.error;
    return typeof error === "string" ? error : null;
  };

  const toolInput = () => toolState()?.input;

  const diagnostics = () => {
    const items = toolState()?.diagnostics;
    return Array.isArray(items) ? items : [];
  };

  const formatDiagnosticLocation = (diagnostic: any) => {
    const raw = diagnostic?.file ?? diagnostic?.path ?? diagnostic?.uri ?? "";
    const file = typeof raw === "string" ? raw.replace(/^file:\/\//, "") : "";
    const line = diagnostic?.line ?? diagnostic?.range?.start?.line;
    const character =
      diagnostic?.character ?? diagnostic?.range?.start?.character;
    const location =
      typeof line === "number"
        ? `${line + 1}${typeof character === "number" ? `:${character + 1}` : ""}`
        : "";
    return `${file}${file && location ? ":" : ""}${location}`.trim();
  };

  const formatDiagnosticLabel = (diagnostic: any) => {
    const severity = diagnostic?.severity ?? diagnostic?.level;
    if (typeof severity === "string") return severity;
    if (severity === 1) return "error";
    if (severity === 2) return "warning";
    if (severity === 3) return "info";
    if (severity === 4) return "hint";
    return "diagnostic";
  };

  const isLargeOutput = createMemo(() => toolOutput().length > 800);

  const [expandedOutput, setExpandedOutput] = createSignal(false);
  const outputPreview = createMemo(() => {
    const output = toolOutput();
    if (!output) return "";
    if (isLargeOutput() && !expandedOutput()) {
      return `${output.slice(0, 800)}\n\n… (truncated)`;
    }
    return output;
  });

  const toolImages = () => {
    const state = toolState();
    const candidates = Array.isArray(state?.images) ? state.images : [];
    return candidates
      .map((item: any) => {
        if (typeof item === "string") return { src: item, alt: "" };
        const src = item?.url ?? item?.src ?? item?.data;
        if (!src) return null;
        if (
          item?.data &&
          item?.mediaType &&
          !String(item.data).startsWith("data:")
        ) {
          return {
            src: `data:${item.mediaType};base64,${item.data}`,
            alt: item?.alt ?? "",
          };
        }
        return { src, alt: item?.alt ?? "" };
      })
      .filter(Boolean);
  };

  const inlineImage = () => {
    if (p().type !== "file") return null;
    const record = p() as any;
    const mime = typeof record?.mime === "string" ? record.mime : "";
    if (!mime.startsWith("image/")) return null;
    const src = record?.url ?? record?.src ?? record?.data ?? record?.source;
    if (!src) return null;
    if (
      record?.data &&
      record?.mediaType &&
      !String(record.data).startsWith("data:")
    ) {
      return `data:${record.mediaType};base64,${record.data}`;
    }
    return src as string;
  };

  return (
    <Switch>
      <Match when={p().type === "text"}>
        <Show
          when={collapsedLongText()}
          fallback={
            <Show
              when={renderMarkdown()}
              fallback={
                <div
                  ref={(el) => {
                    textContainerEl = el;
                  }}
                  class={`whitespace-pre-wrap break-words ${textClass()}`.trim()}
                >
                  {renderTextWithLinks()}
                </div>
              }
            >
              {/* null = parse error → plain text; "" = empty/pending → nothing; string = rendered HTML */}
              <Show when={renderedMarkdown() === null}>
                <div
                  ref={(el) => {
                    textContainerEl = el;
                  }}
                  class={`whitespace-pre-wrap break-words ${textClass()}`.trim()}
                >
                  {renderTextWithLinks()}
                </div>
              </Show>
              <Show
                when={
                  typeof renderedMarkdown() === "string" && renderedMarkdown()
                }
              >
                <div
                  ref={(el) => {
                    textContainerEl = el;
                  }}
                  class={`markdown-content max-w-none overflow-x-auto ${textClass()}
                    [&_strong]:font-semibold
                    [&_em]:italic
                    [&_h1]:text-display [&_h1]:font-bold [&_h1]:my-4
                    [&_h2]:text-heading [&_h2]:font-bold [&_h2]:my-3
                    [&_h3]:text-title [&_h3]:leading-title [&_h3]:font-bold [&_h3]:my-2
                    [&_p]:my-3 [&_p]:leading-relaxed
                    [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3
                    [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3
                    [&_li]:my-1
                    [&_blockquote]:border-l-4 [&_blockquote]:border-dls-border [&_blockquote]:pl-4 [&_blockquote]:my-4 [&_blockquote]:italic
                    [&_table]:w-full [&_table]:border-collapse [&_table]:my-4
                    [&_th]:border [&_th]:border-dls-border [&_th]:p-2 [&_th]:bg-dls-hover
                    [&_td]:border [&_td]:border-dls-border [&_td]:p-2
                  `.trim()}
                  innerHTML={renderedMarkdown()!}
                  onClick={openMarkdownLink}
                />
              </Show>
            </Show>
          }
        >
          <div class="rounded-inset border border-dls-border/70 bg-dls-panel-bg p-4 space-y-3">
            <Show
              when={
                typeof collapsedPreviewMarkdown() === "string" &&
                collapsedPreviewMarkdown()
              }
              fallback={
                <div
                  ref={(el) => {
                    textContainerEl = el;
                  }}
                  class={`whitespace-pre-wrap break-words text-body-lg leading-relaxed max-h-[22rem] overflow-hidden ${textClass()}`.trim()}
                >
                  {collapsedPreviewText()}
                </div>
              }
            >
              <div
                ref={(el) => {
                  textContainerEl = el;
                }}
                class={`markdown-content max-w-full max-h-[22rem] overflow-x-auto overflow-y-hidden ${textClass()}
                  [&_strong]:font-semibold
                  [&_em]:italic
                  [&_h1]:text-display [&_h1]:my-4
                  [&_h2]:text-heading [&_h2]:my-3
                  [&_h3]:text-title [&_h3]:leading-title [&_h3]:my-2
                  [&_p]:type-markdown-body [&_p]:my-3
                  [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3
                  [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3
                  [&_li]:my-1
                  [&_blockquote]:border-l-4 [&_blockquote]:border-dls-border [&_blockquote]:pl-4 [&_blockquote]:my-4 [&_blockquote]:italic
                  [&_table]:w-full [&_table]:border-collapse [&_table]:my-4
                  [&_th]:border [&_th]:border-dls-border [&_th]:p-2 [&_th]:bg-dls-hover
                  [&_td]:border [&_td]:border-dls-border [&_td]:p-2
                `.trim()}
                innerHTML={collapsedPreviewMarkdown()!}
                onClick={openMarkdownLink}
              />
            </Show>
            <button
              type="button"
              class="rounded-control border border-dls-border/80 bg-dls-surface-solid px-3 py-1.5 text-caption font-medium text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
              onClick={() => {
                const id = textPartStableId();
                if (id) {
                  expandedLargeTextPartIds.add(id);
                }
                setExpandedLongText(true);
              }}
            >
              Show full message ({rawText().length.toLocaleString()} chars)
            </button>
          </div>
        </Show>
        {/* Hidden while streaming: the growing text keeps shifting the button away from the cursor. */}
        <Show
          when={
            shouldCollapseLongText() &&
            !collapsedLongText() &&
            !props.isStreaming
          }
        >
          <button
            type="button"
            class="mt-2 rounded-control border border-dls-border/80 bg-dls-surface-solid px-3 py-1.5 text-caption font-medium text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
            onClick={() => {
              const id = textPartStableId();
              if (id) {
                expandedLargeTextPartIds.delete(id);
              }
              setExpandedLongText(false);
              props.onCollapseLargeText?.();
            }}
          >
            Collapse message
          </button>
        </Show>
      </Match>

      <Match when={p().type === "file"}>
        <Show when={fileCardInfo(p())}>
          {(info) => (
            <div
              ref={(el) => {
                textContainerEl = el;
              }}
              class={`flex items-center gap-3 rounded-inset border px-3 py-2 ${
                tone() === "dark"
                  ? "border-dls-border bg-dls-panel-input-bg"
                  : "border-dls-border/70 bg-dls-surface-raised/40"
              }`.trim()}
            >
              <div
                class={`h-9 w-9 rounded-control flex items-center justify-center ${
                  tone() === "dark"
                    ? "bg-dls-neutral-overlay/10 text-dls-text"
                    : "bg-dls-code-inline-bg/70 text-dls-secondary"
                }`.trim()}
              >
                <File size={16} />
              </div>
              <div class="min-w-0 flex-1">
                <div
                  class={`search-highlight-block text-body-lg font-medium truncate ${textClass()}`.trim()}
                >
                  {info().title}
                </div>
                <Show when={info().detail}>
                  <div
                    class={`search-highlight-block text-label truncate ${subtleTextClass()}`.trim()}
                  >
                    {info().detail}
                  </div>
                </Show>
              </div>
              <Show when={info().mime}>
                <div
                  class={`search-highlight-block text-tiny uppercase tracking-wide px-2 py-0.5 rounded-pill max-w-[160px] truncate ${
                    tone() === "dark"
                      ? "bg-dls-neutral-overlay/10 text-dls-text/80"
                      : "bg-dls-surface-solid/70 text-dls-muted"
                  }`.trim()}
                >
                  {info().mime}
                </div>
              </Show>
            </div>
          )}
        </Show>
      </Match>

      <Match when={p().type === "reasoning"}>
        <Show
          when={
            showThinking() &&
            developerMode() &&
            "text" in p() &&
            typeof (p() as { text: string }).text === "string" &&
            (p() as { text: string }).text.trim()
          }
        >
          <details class={`rounded-control ${panelBgClass()} p-2`.trim()}>
            <summary
              class={`cursor-pointer text-caption ${subtleTextClass()}`.trim()}
            >
              Thinking
            </summary>
            <pre
              class={`mt-2 whitespace-pre-wrap break-words text-caption text-dls-text`.trim()}
            >
              {clampText(String((p() as { text: string }).text), 2000)}
            </pre>
          </details>
        </Show>
      </Match>

      <Match when={p().type === "tool"}>
        <Show when={isProtectionBypassHidden()}>
          <div class="flex items-center gap-2 rounded-control border border-dls-warning-border bg-dls-warning-bg px-3 py-2 text-caption text-dls-warning-text w-fit">
            {protectionBypassMessage()}
          </div>
        </Show>
        <Show when={toolOnly() && !isProtectionBypassHidden()}>
          <div class="grid gap-3">
            <div class="flex items-start justify-between gap-3">
              <div class="space-y-1">
                <div class={`text-caption font-medium text-dls-text`.trim()}>
                  {toolTitle()}
                </div>
                <div class={`text-label ${subtleTextClass()}`.trim()}>
                  {toolName()}
                </div>
              </div>
              <div
                class={`rounded-pill px-2 py-0.5 text-label font-medium ${
                  toolStatus() === "completed"
                    ? "bg-dls-success-bg text-dls-success-text"
                    : toolStatus() === "running"
                      ? "bg-dls-info-bg-subtle text-dls-info-text"
                      : toolStatus() === "error"
                        ? "bg-dls-danger-bg text-dls-danger-text"
                        : "bg-dls-surface-raised/10 text-dls-text"
                }`}
              >
                {toolStatus()}
              </div>
            </div>

            <Show when={toolSubtitle()}>
              <div class={`text-caption ${subtleTextClass()}`.trim()}>
                {toolSubtitle()}
              </div>
            </Show>

            <Show when={diagnostics().length > 0}>
              <div class={`rounded-control border ${panelBgClass()} p-2`.trim()}>
                <div
                  class={`text-label font-medium ${subtleTextClass()}`.trim()}
                >
                  Diagnostics
                </div>
                <div class="mt-2 grid gap-2">
                  <For each={diagnostics()}>
                    {(diag: any) => (
                      <div class="flex items-start justify-between gap-4 text-caption">
                        <div>
                          <div class="font-medium text-dls-text">
                            {String(diag?.message ?? "")}
                          </div>
                          <Show when={diag?.source || diag?.code}>
                            <div class="text-label text-dls-secondary">
                              {[diag?.source, diag?.code]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </Show>
                        </div>
                        <div class="text-label text-dls-secondary text-right">
                          <div>{formatDiagnosticLabel(diag)}</div>
                          <Show when={formatDiagnosticLocation(diag)}>
                            <div>{formatDiagnosticLocation(diag)}</div>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={diffText()}>
              <div class={`rounded-control border ${panelBgClass()} p-2`.trim()}>
                <div
                  class={`text-label font-medium ${subtleTextClass()}`.trim()}
                >
                  Diff
                </div>
                <div class="mt-2 grid gap-1 rounded-control overflow-hidden">
                  <For each={diffLines()}>
                    {(line) => (
                      <div
                        class={`font-mono text-label leading-relaxed px-2 py-0.5 whitespace-pre-wrap break-words ${diffLineClass(
                          line,
                        )}`.trim()}
                      >
                        {line || " "}
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={toolImages().length > 0}>
              <div class="grid gap-2">
                <For each={toolImages()}>
                  {(image: any) => (
                    <img
                      src={image.src}
                      alt={image.alt || ""}
                      loading="lazy"
                      decoding="async"
                      class="max-w-full h-auto rounded-control border border-dls-border/50"
                    />
                  )}
                </For>
              </div>
            </Show>

            <Show when={toolError()}>
              <div class="rounded-control bg-dls-danger-bg p-2 text-caption text-dls-danger-text">
                {toolError()}
              </div>
            </Show>

            <Show
              when={
                showToolOutput() &&
                toolOutput() &&
                toolOutput() !== diffTextNormalized() &&
                !hasReadXmlOutput()
              }
            >
              <pre
                class={`whitespace-pre-wrap break-words rounded-control ${panelBgClass()} p-2 text-caption text-dls-text`.trim()}
              >
                {outputPreview()}
              </pre>
            </Show>

            <Show when={showToolOutput() && hasReadXmlOutput()}>
              <details class={`rounded-control ${panelBgClass()} p-2`.trim()}>
                <summary
                  class={`cursor-pointer text-caption ${subtleTextClass()}`.trim()}
                >
                  Raw read output
                </summary>
                <pre
                  class={`mt-2 whitespace-pre-wrap break-words text-caption text-dls-text`.trim()}
                >
                  {outputPreview()}
                </pre>
              </details>
            </Show>

            <Show when={showToolOutput() && isLargeOutput()}>
              <button
                class={`text-label ${subtleTextClass()} hover:text-dls-text transition-colors`}
                onClick={() => setExpandedOutput((current) => !current)}
              >
                {expandedOutput() ? "Show less" : "Show more"}
              </button>
            </Show>

            <Show when={showToolOutput() && toolInput() != null}>
              <details class={`rounded-control ${panelBgClass()} p-2`.trim()}>
                <summary
                  class={`cursor-pointer text-caption ${subtleTextClass()}`.trim()}
                >
                  Input
                </summary>
                <pre
                  class={`mt-2 whitespace-pre-wrap break-words text-caption text-dls-text`.trim()}
                >
                  {safeStringify(toolInput())}
                </pre>
              </details>
            </Show>
          </div>
        </Show>
      </Match>

      <Match when={inlineImage()}>
        <img
          src={inlineImage()!}
          alt=""
          loading="lazy"
          decoding="async"
          class="max-w-full h-auto rounded-inset border border-dls-border/50"
        />
      </Match>

      <Match when={p().type === "step-start" || p().type === "step-finish"}>
        <div class={`text-caption ${subtleTextClass()}`.trim()}>
          {p().type === "step-start" ? "Step started" : "Step finished"}
          <Show when={"reason" in p() && (p() as any).reason}>
            <span
              class={tone() === "dark" ? "text-dls-text/80" : "text-dls-secondary"}
            >
              {" "}
              · {String((p() as any).reason)}
            </span>
          </Show>
        </div>
      </Match>

      <Match when={true}>
        <Show when={developerMode()}>
          <pre
            class={`whitespace-pre-wrap break-words text-caption text-dls-text`.trim()}
          >
            {safeStringify(p())}
          </pre>
        </Show>
      </Match>
    </Switch>
  );
}
