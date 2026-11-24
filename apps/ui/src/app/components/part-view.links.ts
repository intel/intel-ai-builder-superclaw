import type { LinkType, TextSegment } from "./part-view.types";
import {
  parseComposerInboxUploadPath,
  parseLegacyComposerInboxUploadPath,
} from "./session/composer.attachments";

export const WEB_LINK_RE = /^(?:https?:\/\/|www\.)/i;

export const FILE_URI_RE = /^file:\/\//i;

export const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export const UNSAFE_SCHEMES = /^(?:javascript|data|vbscript|blob):/i;

export const MAILTO_RE = /^mailto:/i;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/][^\s"'`\)\]\}>]+$/;

export const POSIX_PATH_RE = /^\/(?!\/)[^\s"'`\)\]\}>][^\s"'`\)\]\}>]*$/;

export const TILDE_PATH_RE = /^~\/[^\s"'`\)\]\}>][^\s"'`\)\]\}>]*$/;

export const BARE_FILENAME_RE =
  /^(?!\.)(?!.*\.\.)(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)$/;

export const SAFE_PATH_CHAR_RE = /[^\s"'`\)\]\}>]/;

export const EXTENSIONLESS_WORKSPACE_BASENAMES = new Set([
  "readme",
  "license",
  "notice",
  "changelog",
  "makefile",
  "dockerfile",
]);

/** [Selected file: …] / [Selected folder: …] bracket spans — paths with spaces survive. */
export const SELECTED_SPAN_RE = /\[Selected (?:file|folder):\s*([^\]]+)\]/gi;

/** Quoted spans (double, single, backtick) that may contain paths with spaces. */
export const QUOTED_PATH_SPAN_RE = /"([^"]+)"|'([^']+)'|`([^`]+)`/g;

/** Path prefix used for span extraction (POSIX absolute, Windows drive, relative, tilde, file://). */
export const SPAN_PATH_PREFIX_RE =
  /^(?:file:\/\/|[A-Za-z]:[\\/]|\.\.?\/|~\/|\/(?!\/))/;

export const stripFileReferenceSuffix = (value: string) => {
  const withoutQueryOrFragment = value.replace(/[?#].*$/, "").trim();
  if (!withoutQueryOrFragment) return "";
  return withoutQueryOrFragment.replace(/:(\d+)(?::\d+)?$/, "");
};

/**
 * Check whether a detected file-type link is under the workspace root.
 * Absolute paths outside the root (e.g. /opt/…/python3) are NOT clickable.
 * Relative paths are always considered relevant (they resolve against root).
 * When no workspaceRoot is set, everything passes (fail-open).
 */
export const isWorkspaceFilePath = (href: string, workspaceRoot: string): boolean => {
  const root = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return true;

  const normalized = href.replace(/\\/g, "/");

  // Relative paths always resolve under the workspace root.
  if (
    !normalized.startsWith("/") &&
    !WINDOWS_PATH_RE.test(href) &&
    !FILE_URI_RE.test(href)
  ) {
    return true;
  }

  // Windows absolute paths / file:// URIs are already host-side — always relevant.
  if (WINDOWS_PATH_RE.test(href) || FILE_URI_RE.test(href)) return true;

  // Absolute POSIX path: must be under the workspace root.
  const stripped = stripFileReferenceSuffix(normalized);
  return stripped === root || stripped.startsWith(root + "/");
};

export const isWorkspaceRelativeFilePath = (value: string) => {
  const stripped = stripFileReferenceSuffix(value);
  if (!stripped) return false;

  const normalized = stripped.replace(/\\/g, "/");
  if (!normalized.includes("/")) return false;
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("//")
  ) {
    return false;
  }
  if (URI_SCHEME_RE.test(normalized)) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;

  const segments = normalized.split("/");
  if (!segments.length) return false;
  const lastSegment = segments[segments.length - 1] ?? "";
  const hasDottedSegment = segments.some((segment) => segment.includes("."));
  if (
    !hasDottedSegment &&
    !EXTENSIONLESS_WORKSPACE_BASENAMES.has(lastSegment.toLowerCase())
  ) {
    return false;
  }
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
};

export const isRelativeFilePath = (value: string) => {
  if (value === "." || value === "..") return false;

  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const hasNonTraversalSegment = segments.some(
    (segment) => segment && segment !== "." && segment !== "..",
  );

  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return hasNonTraversalSegment;
  }

  const [firstSegment, secondSegment] = normalized.split("/");
  if (!secondSegment || firstSegment.length <= 1) return false;
  if (secondSegment === "." || secondSegment === "..") return false;
  return firstSegment.startsWith(".") && SAFE_PATH_CHAR_RE.test(secondSegment);
};

/* Disabled: Bare filenames (e.g., TC-001-result.json) create too many false positives
   in chat context where filenames appear casually in text. Users can still link files
   explicitly via markdown: [filename](filename). Previous implementation would generate
   misleading markdown links with incorrect hrefs when AI mentioned filenames. */

export const isBareRelativeFilePath = (value: string) => {
  if (value.includes("/") || value.includes("\\") || value.includes(":"))
    return false;
  if (!BARE_FILENAME_RE.test(value)) return false;

  const extension = value.split(".").pop() ?? "";
  if (!/[A-Za-z]/.test(extension)) return false;

  const lowerValue = value.toLowerCase();
  if (lowerValue === "e.g" || lowerValue === "i.e") return false;

  const dotCount = (value.match(/\./g) ?? []).length;
  if (dotCount === 1 && !value.includes("_") && !value.includes("-")) {
    const [name, tld] = value.split(".");
    if (
      /^[A-Za-z]{2,24}$/.test(name ?? "") &&
      /^[A-Za-z]{2,10}$/.test(tld ?? "")
    ) {
      return false;
    }
  }

  const [firstLabel] = value.split(".");
  if (/^\d+$/.test(firstLabel ?? "")) return false;

  /* Disabled: Bare filenames (e.g., TC-001-result.json, result.json) create too many
     false positives in chat context where filenames appear casually in text.*/
  return false;
};

export const LEADING_PUNCTU = /[\"'`\(\[\{<]/;

export const TRAILING_PUNCTU = /[\"'`\)\]}>.,:;!?]/;

/** Strip leading/trailing punctuation from a token (mirrors parseLinkFromToken's logic). */
export const stripPunct = (token: string): string => {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_PUNCTU.test(token[start] ?? "")) start++;
  while (end > start && TRAILING_PUNCTU.test(token[end - 1] ?? "")) end--;
  return token.slice(start, end);
};

export const isLikelyWebLink = (value: string) => WEB_LINK_RE.test(value);

export const isLikelyFilePath = (value: string) => {
  // Reject values containing function-call or string-literal syntax —
  // e.g. os.makedirs('/workspace/code') is code, not a standalone path.
  if (/[('"`]/.test(value)) return false;

  if (FILE_URI_RE.test(value)) return true;
  if (WINDOWS_PATH_RE.test(value)) return true;
  if (POSIX_PATH_RE.test(value)) return true;
  if (TILDE_PATH_RE.test(value)) return true;
  if (isRelativeFilePath(value)) return true;
  if (isBareRelativeFilePath(value)) return true;
  if (isWorkspaceRelativeFilePath(value)) return true;

  return false;
};

/**
 * Normalize a schemeless href like "example.com" from a markdown anchor to an https:// URL. Returns null for fragments, relative paths or values that dont resemble a hostname.
 */
export const COMMON_FILE_EXTENSIONS = new Set([
  "py",
  "ts",
  "js",
  "jsx",
  "tsx",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "css",
  "scss",
  "md",
  "txt",
  "csv",
  "sql",
  "sh",
  "bash",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "rb",
  "php",
  "swift",
  "kt",
  "scala",
  "clj",
  "ex",
  "elm",
  "lua",
  "vim",
  "gradle",
  "maven",
  "npm",
  "pkg",
  "deb",
  "rpm",
  "exe",
  "msi",
  "dmg",
  "zip",
  "tar",
  "gz",
  "rar",
  "7z",
  "iso",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "jpg",
  "png",
  "gif",
  "svg",
  "mp3",
  "mp4",
  "avi",
  "mov",
  "mkv",
  "wav",
  "flac",
  "aac",
  "ogg",
]);

export const normalizeBareHref = (href: string): string | null => {
  if (!href || href.startsWith("#")) return null;
  if (URI_SCHEME_RE.test(href)) return null;
  if (href.startsWith("/") || href.startsWith(".") || href.startsWith("~"))
    return null;

  // Isolate the host portion (strip any path/query/fragment/port).
  const host = href.split(/[/?#:]/, 1)[0] ?? "";
  const labels = host.split(".");
  if (labels.length < 2) return null;

  // Require a real alphabetic TLD (>=2 letters) so numeric/punctuated tokens are not mistaken for hostnames.
  // This rejects invalid TLDs (percentages, decimals, or "e.g").
  const tld = labels[labels.length - 1] ?? "";
  if (COMMON_FILE_EXTENSIONS.has(tld.toLowerCase())) return null;
  if (!/^[A-Za-z]{2,}$/.test(tld)) return null;

  // Every label must be a syntactically valid DNS label.
  const labelOk = (label: string) =>
    /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label);
  if (!labels.every(labelOk)) return null;

  return `https://${href}`;
};

/**
 * Drop a trailing `]` that GFM autolinking pulled into the URL when a link was
 * written inside brackets, e.g. `[https://example.com/a]`. Only an unmatched
 * closer is removed, so `https://example.com/a[b]` is left intact.
 */
export const trimUnmatchedBracket = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "]") {
    const slice = value.slice(0, end);
    const opens = (slice.match(/\[/g) ?? []).length;
    const closes = (slice.match(/\]/g) ?? []).length;
    if (closes <= opens) break;
    end -= 1;
  }
  return value.slice(0, end);
};

const AUTOLINK_SCHEME_PREFIXES = ["http://", "https://", "mailto:"] as const;

/**
 * A GFM autolink labels itself with the URL exactly as typed, and marked prepends
 * whichever scheme it inferred (`www.x]` -> `http://www.x]`, `a@b.com` ->
 * `mailto:a@b.com`). Comparing against the *raw* href keeps this independent of the
 * rewriting `resolveUrlHref` does later.
 */
const isSelfLabelledAutolink = (rawHref: string, text: string): boolean =>
  rawHref === text ||
  AUTOLINK_SCHEME_PREFIXES.some((scheme) => rawHref === `${scheme}${text}`);

/**
 * Split an anchor label around a bracket that autolinking swallowed, keeping the
 * label and its target in sync. Only a self-labelled autolink is split. An explicit
 * `[text](url)` label is returned untouched even when it ends in an unmatched `]`
 * (writable as `[a\]](url)`), because there the bracket is the author's own text
 * rather than an autolink artefact.
 */
export const splitTrimmedBracketLabel = (
  rawHref: string,
  text: string,
): { label: string; trailing: string } => {
  if (!isSelfLabelledAutolink(rawHref, text)) return { label: text, trailing: "" };
  const label = trimUnmatchedBracket(text);
  return { label, trailing: text.slice(label.length) };
};

export const resolveUrlHref = (href: string): string | null => {
  const trimmed = trimUnmatchedBracket(href.trim());
  if (!trimmed || trimmed === "#") return null;
  if (UNSAFE_SCHEMES.test(trimmed)) return null;
  if (MAILTO_RE.test(trimmed)) return trimmed;
  if (EMAIL_RE.test(trimmed)) return `mailto:${trimmed}`;
  if (isLikelyWebLink(trimmed)) {
    return trimmed.toLowerCase().startsWith("www.")
      ? `https://${trimmed}`
      : trimmed;
  }
  return normalizeBareHref(trimmed);
};

export const classifyLinkTarget = (
  href: string,
): { href: string; type: LinkType } | null => {
  const trimmed = href.trim();
  if (!trimmed || trimmed === "#") return null;

  const resolvedUrl = resolveUrlHref(trimmed);
  if (resolvedUrl) {
    return { href: resolvedUrl, type: "url" };
  }

  if (isLikelyFilePath(trimmed)) {
    return { href: trimmed, type: "file" };
  }

  return null;
};

export const parseLinkFromToken = (
  token: string,
): { href: string; type: LinkType; value: string } | null => {
  let start = 0;
  let end = token.length;

  while (start < end && LEADING_PUNCTU.test(token[start] ?? "")) {
    start += 1;
  }

  while (end > start && TRAILING_PUNCTU.test(token[end - 1] ?? "")) {
    end -= 1;
  }

  const value = token.slice(start, end);
  if (!value) return null;

  const target = classifyLinkTarget(value);
  if (target) {
    return {
      value,
      type: target.type,
      href: target.href,
    };
  }

  return null;
};

/**
 * Relaxed file-path check for paths extracted from quoted or bracketed context.
 * Unlike isLikelyFilePath, this allows spaces within the path since the
 * quoting/bracketing already provides unambiguous token boundaries.
 */
export const isLikelyFilePathWithSpaces = (value: string): boolean => {
  if (!value || !SPAN_PATH_PREFIX_RE.test(value)) return false;
  if (FILE_URI_RE.test(value)) return true;
  // Require a file extension or a multi-segment path to reduce false positives.
  if (/\.[A-Za-z0-9]{1,10}$/.test(value)) return true;
  const secondSlash = value.indexOf("/", 1);
  return secondSlash > 0 && secondSlash < value.length - 1;
};

/** Extension check: ends with .ext (1-10 alphanumeric chars). */
export const FILE_EXT_TAIL_RE = /\.[A-Za-z0-9]{1,10}$/;

/**
 * Try to greedily extend a POSIX-absolute path token by consuming subsequent
 * whitespace-separated tokens, stopping when one ends with a file extension.
 * Handles unquoted paths with spaces, e.g. `/workspace/test file with space.txt`.
 *
 * Returns null if no valid extension-bearing extension is found within the
 * lookahead window, letting the caller fall back to the single-token path.
 */
export const tryExtendSpacedPath = (
  cleanedStart: string,
  rawTokens: RegExpExecArray[],
  startIdx: number,
): { combinedPath: string; endIdx: number; trailingSuffix: string } | null => {
  // Only extend POSIX absolute paths (/foo/bar) that don't already have an extension.
  if (!/^\/(?!\/)/.test(cleanedStart)) return null;
  // Must have at least 2 path segments (e.g. /workspace/test, not just /test).
  if (!/^\/[^\s/]+\//.test(cleanedStart)) return null;
  if (FILE_EXT_TAIL_RE.test(cleanedStart)) return null;

  const MAX_LOOKAHEAD = 8;
  for (
    let j = startIdx + 1;
    j < rawTokens.length && j <= startIdx + MAX_LOOKAHEAD;
    j++
  ) {
    const nextRaw = rawTokens[j]![0] ?? "";
    const nextCleaned = stripPunct(nextRaw);
    if (!nextCleaned) break;

    // Stop if the next token looks like a new path, URL, or structural element.
    if (WEB_LINK_RE.test(nextCleaned)) break;
    if (POSIX_PATH_RE.test(nextCleaned)) break;
    if (WINDOWS_PATH_RE.test(nextCleaned)) break;
    if (FILE_URI_RE.test(nextCleaned)) break;
    if (TILDE_PATH_RE.test(nextCleaned)) break;
    // Stop on tokens containing structural punctuation (likely not part of a filename).
    if (/[(){}[\]<>;,!?=+|&]/.test(nextRaw)) break;

    if (FILE_EXT_TAIL_RE.test(nextCleaned)) {
      // Found extension — combine all tokens from start through this one.
      const parts = [cleanedStart];
      for (let k = startIdx + 1; k < j; k++) {
        parts.push(rawTokens[k]![0] ?? "");
      }
      parts.push(nextCleaned);

      // Trailing suffix: punctuation after the extension in the raw last token.
      const suffixStart = nextRaw.indexOf(nextCleaned) + nextCleaned.length;
      const suffix =
        suffixStart < nextRaw.length ? nextRaw.slice(suffixStart) : "";

      return {
        combinedPath: parts.join(" "),
        endIdx: j,
        trailingSuffix: suffix,
      };
    }
  }
  return null;
};

/** Whitespace-based tokenization with link detection (original splitTextTokens logic). */
export const tokenizeByWhitespace = (text: string, tokens: TextSegment[]) => {
  const rawTokens = [...text.matchAll(/\S+/g)] as RegExpExecArray[];
  let position = 0;

  for (let i = 0; i < rawTokens.length; i++) {
    const match = rawTokens[i]!;
    const token = match[0] ?? "";
    const index = match.index ?? 0;

    if (index > position) {
      tokens.push({ kind: "text", value: text.slice(position, index) });
    }

    const link = parseLinkFromToken(token);
    if (link && link.type === "file") {
      // Greedy extension: when the detected path has no file extension, try to
      // consume subsequent tokens that complete a filename with spaces
      // (e.g. "/workspace/test" + "file" + "with" + "space.txt").
      const extended = tryExtendSpacedPath(link.value, rawTokens, i);
      if (extended) {
        const prefixLen = token.indexOf(link.value);
        if (prefixLen > 0) {
          tokens.push({ kind: "text", value: token.slice(0, prefixLen) });
        }
        tokens.push({
          kind: "link",
          value: extended.combinedPath,
          href: extended.combinedPath,
          type: "file",
        });
        if (extended.trailingSuffix) {
          tokens.push({ kind: "text", value: extended.trailingSuffix });
        }
        // Advance position past the last consumed token.
        const lastMatch = rawTokens[extended.endIdx]!;
        position = (lastMatch.index ?? 0) + (lastMatch[0] ?? "").length;
        i = extended.endIdx;
        continue;
      }
    }

    if (!link) {
      tokens.push({ kind: "text", value: token });
    } else {
      const start = token.indexOf(link.value);
      if (start > 0) {
        tokens.push({ kind: "text", value: token.slice(0, start) });
      }
      tokens.push({
        kind: "link",
        value: link.value,
        href: link.href,
        type: link.type,
      });
      const end = start + link.value.length;
      if (end < token.length) {
        tokens.push({ kind: "text", value: token.slice(end) });
      }
    }

    position = index + token.length;
  }

  if (position < text.length) {
    tokens.push({ kind: "text", value: text.slice(position) });
  }
};

export const splitTextTokens = (text: string): TextSegment[] => {
  const tokens: TextSegment[] = [];

  // Phase 1: Pre-extract quoted/bracketed spans that contain file paths with
  // spaces.  These must be identified before whitespace tokenization, otherwise
  // the path is split at every space and only the first fragment is linkified.
  type SpanHit = {
    start: number;
    end: number;
    prefix: string; // text before the path inside the span (e.g. "[Selected file: ")
    suffix: string; // text after the path inside the span (e.g. "]")
    linkValue: string; // display text for the link
    href: string; // path to open
  };
  const spans: SpanHit[] = [];

  // [Selected file: /workspace/path with spaces.txt]
  for (const m of text.matchAll(SELECTED_SPAN_RE)) {
    const inner = (m[1] ?? "").trim();
    if (inner && isLikelyFilePathWithSpaces(inner)) {
      const full = m[0];
      const innerIdx = full.indexOf(inner);
      spans.push({
        start: m.index!,
        end: m.index! + full.length,
        prefix: full.slice(0, innerIdx),
        suffix: full.slice(innerIdx + inner.length),
        linkValue: inner,
        href: inner,
      });
    }
  }

  // Quoted spans: "/path with spaces.txt", '/path', `/path`
  // Only intercept when the inner value contains spaces — non-spaced paths
  // work correctly with the existing whitespace tokenizer.
  for (const m of text.matchAll(QUOTED_PATH_SPAN_RE)) {
    const inner = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (inner && inner.includes(" ") && isLikelyFilePathWithSpaces(inner)) {
      const quote = m[0][0]!;
      spans.push({
        start: m.index!,
        end: m.index! + m[0].length,
        prefix: quote,
        suffix: quote,
        linkValue: inner,
        href: inner,
      });
    }
  }

  // Sort by position and drop overlaps.
  spans.sort((a, b) => a.start - b.start);
  const merged: SpanHit[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && s.start < prev.end) continue;
    merged.push(s);
  }

  // Phase 2: Walk the text, emitting pre-extracted span links at their
  // positions and whitespace-tokenizing the gaps between them.
  let position = 0;
  for (const span of merged) {
    if (span.start > position) {
      tokenizeByWhitespace(text.slice(position, span.start), tokens);
    }
    if (span.prefix) tokens.push({ kind: "text", value: span.prefix });
    tokens.push({
      kind: "link",
      value: span.linkValue,
      href: span.href,
      type: "file",
    });
    if (span.suffix) tokens.push({ kind: "text", value: span.suffix });
    position = span.end;
  }
  if (position < text.length) {
    tokenizeByWhitespace(text.slice(position), tokens);
  }

  return tokens;
};

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const displayFilePath = (path: string) =>
  parseComposerInboxUploadPath(path)?.filename ??
  parseLegacyComposerInboxUploadPath(path) ??
  path;

export const renderInlineTextWithLinks = (text: string, workspaceRoot?: string) => {
  const tokens = splitTextTokens(text);
  const wsRoot = workspaceRoot ?? "";
  return tokens
    .map((token) => {
      if (token.kind === "text") return escapeHtml(token.value);
      if (token.type === "file" && !isWorkspaceFilePath(token.href, wsRoot)) {
        return escapeHtml(token.value);
      }
      if (token.type === "file") {
        return `<a href="#" data-file-href="${escapeHtml(token.href)}" class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]">${escapeHtml(displayFilePath(token.value))}</a>`;
      }
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]">${escapeHtml(token.value)}</a>`;
    })
    .join("");
};
