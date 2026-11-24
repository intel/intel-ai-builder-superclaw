import type { Part } from "@opencode-ai/sdk/v2/client";
import type { SearchHighlightBudget } from "./part-view.highlight";

export type Props = {
  part: Part;
  developerMode?: boolean;
  showThinking?: boolean;
  tone?: "light" | "dark";
  workspaceRoot?: string;
  renderMarkdown?: boolean;
  markdownThrottleMs?: number;
  highlightQuery?: string;
  searchHighlightBudget?: SearchHighlightBudget;
  /** Resolve a container/workspace file path to a host-side path for opening. */
  resolveHostPath?: (containerPath: string) => Promise<string | null>;
  /**
   * Stable key for persisting large-text expansion state across remounts
   */
  expansionKey?: string;
  /** Whether this part's message is still streaming. */
  isStreaming?: boolean;
  /**
   * Whether this part belongs to a user message. Guard-error rewriting applies
   * only to model output; a user who pastes a log containing `BLOCKED:` must
   * still see their own text.
   */
  isUserMessage?: boolean;
  /** Collapsing removes content above the viewport, so the caller restores scroll position. */
  onCollapseLargeText?: () => void;
};

export type LinkType = "url" | "file";

export type TextSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string; type: LinkType };
