import { createEffect } from "solid-js";
import { createSignal } from "solid-js";
import { onCleanup } from "solid-js";

export const SEARCH_HIGHLIGHT_MARK_ATTR = "data-search-highlight";
export const MAX_SEARCH_OCCURRENCES = 10_000;
const SEARCH_BLOCK_SELECTOR =
  ".search-highlight-block, p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, td, th, dt, dd, figcaption";

export type SearchHighlightBudget = {
  reserve: (key: string, requested: number) => number;
  available: (key: string) => number;
  isTruncated: () => boolean;
  used: () => number;
  limit: () => number;
};

export const createSearchHighlightBudget = (
  limit = MAX_SEARCH_OCCURRENCES,
): SearchHighlightBudget => {
  const allocations = new Map<string, number>();
  let used = 0;
  let truncated = false;
  return {
    available: (key) => Math.max(0, limit - used + (allocations.get(key) ?? 0)),
    reserve: (key, requested) => {
      const previous = allocations.get(key) ?? 0;
      const available = Math.max(0, limit - used + previous);
      const granted = Math.min(requested, available);
      used += granted - previous;
      allocations.set(key, granted);
      if (granted < requested) truncated = true;
      return granted;
    },
    isTruncated: () => truncated,
    used: () => used,
    limit: () => limit,
  };
};

export const clearTextHighlights = (root: HTMLElement) => {
  const marks = root.querySelectorAll(
    `mark[${SEARCH_HIGHLIGHT_MARK_ATTR}="true"]`,
  );
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
  });
  root.normalize();
};

/**
 * Paints every visible occurrence of `query` as a plain `mark`. Which mark (if
 * any) is "active" is decided centrally, once, after all of these repaints
 * settle - see `message-list.search-nav.ts` - so this never needs to agree
 * with any separately-computed occurrence index. Returns whether any match
 * was painted, so a caller hiding this text behind a collapsed preview knows
 * to reveal it.
 */
export const applyTextHighlights = (
  root: HTMLElement,
  query: string,
  partId: string,
  budget?: SearchHighlightBudget,
  budgetKey = partId,
): boolean => {
  clearTextHighlights(root);
  const needle = query.trim().toLowerCase();
  if (!needle) return false;

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
    acceptNode(node) {
      if (node.nodeType === 1) {
        const element = node as Element;
        if (element.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
        if (element.matches("script, style")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      const value = node.nodeValue ?? "";
      if (!value) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style"))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
    },
  );

  type TextSegment = { node?: Text; value: string; start: number; end: number };
  const nodeGroups: Array<{ block: Element; segments: TextSegment[] }> = [];
  let current = walker.nextNode();
  while (current) {
    const isBreak = current.nodeType === 1;
    const node = isBreak ? undefined : (current as Text);
    const element = isBreak ? (current as Element) : node?.parentElement;
    const parent = isBreak ? element?.parentElement : element;
    const block = parent?.closest(SEARCH_BLOCK_SELECTOR) ?? root;
    let group = nodeGroups[nodeGroups.length - 1];
    if (!group || group.block !== block) {
      group = { block, segments: [] };
      nodeGroups.push(group);
    }
    group.segments.push({
      ...(node ? { node } : {}),
      value: node?.nodeValue ?? "\n",
      start: 0,
      end: 0,
    });
    current = walker.nextNode();
  }

  const maxStoredMatches = budget
    ? budget.available(budgetKey)
    : MAX_SEARCH_OCCURRENCES;
  let totalMatches = 0;
  let storedMatches = 0;
  let overflowed = false;
  const groups = nodeGroups.map(({ segments }) => {
    let textStream = "";
    segments.forEach((segment) => {
      const start = textStream.length;
      textStream += segment.value;
      segment.start = start;
      segment.end = textStream.length;
    });

    const lowerText = textStream.toLowerCase();
    const lowerToOriginalStart: number[] = [];
    const lowerToOriginalEnd: number[] = [];
    let originalIndex = 0;
    for (const character of textStream) {
      const loweredLength = character.toLowerCase().length;
      for (let index = 0; index < loweredLength; index += 1) {
        lowerToOriginalStart.push(originalIndex);
        lowerToOriginalEnd.push(originalIndex + character.length);
      }
      originalIndex += character.length;
    }

    const matches: Array<{ start: number; end: number }> = [];
    let searchIndex = 0;
    while (!overflowed && searchIndex < lowerText.length) {
      const matchStart = lowerText.indexOf(needle, searchIndex);
      if (matchStart === -1) break;
      const originalStart = lowerToOriginalStart[matchStart];
      const originalEnd = lowerToOriginalEnd[matchStart + needle.length - 1];
      if (originalStart === undefined || originalEnd === undefined) break;
      totalMatches += 1;
      if (storedMatches < maxStoredMatches) {
        matches.push({ start: originalStart, end: originalEnd });
        storedMatches += 1;
      } else {
        overflowed = true;
        break;
      }
      searchIndex = matchStart + needle.length;
    }
    return { segments, matches };
  });

  let remainingMatches = budget
    ? budget.reserve(budgetKey, totalMatches)
    : Math.min(totalMatches, MAX_SEARCH_OCCURRENCES);
  let foundMatch = false;

  for (const { segments, matches } of groups) {
    const allowedMatches = matches.slice(0, remainingMatches);
    remainingMatches -= allowedMatches.length;
    if (allowedMatches.length) foundMatch = true;

    segments.forEach(({ node, start, end }) => {
      if (!node) return;
      const text = node.nodeValue ?? "";
      const nodeMatches = allowedMatches
        .filter((match) => match.start < end && match.end > start)
        .map((match) => ({
          start: Math.max(match.start, start) - start,
          end: Math.min(match.end, end) - start,
        }));
      if (!nodeMatches.length) return;

      let cursor = 0;
      const fragment = document.createDocumentFragment();

      nodeMatches.forEach((match) => {
        if (match.start > cursor) {
          fragment.appendChild(
            document.createTextNode(text.slice(cursor, match.start)),
          );
        }
        const mark = document.createElement("mark");
        mark.setAttribute(SEARCH_HIGHLIGHT_MARK_ATTR, "true");
        mark.dataset.searchPartId = partId;
        mark.className = "search-highlight";
        mark.textContent = text.slice(match.start, match.end);
        fragment.appendChild(mark);
        cursor = match.end;
      });
      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }

      node.parentNode?.replaceChild(fragment, node);
    });
  }
  return foundMatch;
};


export function useThrottledValue<T>(
  value: () => T,
  delayMs: number | (() => number) = 80,
) {
  const initial = value();
  const [state, setState] = createSignal<T>(initial);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hasEmitted = false;
  let pendingValue = initial;
  let hasPendingValue = false;

  createEffect(() => {
    const next = value();
    const delay = typeof delayMs === "function" ? delayMs() : delayMs;
    // Always apply the first non-empty value synchronously so the initial
    // render never falls through to the raw-text fallback.
    if (!delay || !hasEmitted) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      hasEmitted = true;
      hasPendingValue = false;
      setState(() => next);
      return;
    }
    pendingValue = next;
    hasPendingValue = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!hasPendingValue) return;
      hasPendingValue = false;
      setState(() => pendingValue);
    }, delay);
  });

  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });

  return state;
}
