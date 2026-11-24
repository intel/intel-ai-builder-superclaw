import type { ComposerDraft } from "~/shared/types/composer";

const SPREADSHEET_EXTENSIONS = new Set(["csv", "xlsx"]);

const extensionOf = (nameOrPath: string): string => {
  const trimmed = nameOrPath.trim().replace(/\\/g, "/");
  if (!trimmed) return "";
  const tail = trimmed.substring(trimmed.lastIndexOf("/") + 1);
  const dot = tail.lastIndexOf(".");
  if (dot <= 0 || dot === tail.length - 1) return "";
  return tail.substring(dot + 1).toLowerCase();
};

const isSpreadsheet = (nameOrPath: string): boolean =>
  SPREADSHEET_EXTENSIONS.has(extensionOf(nameOrPath));

// Strip http(s) URLs first so a remote URL like `https://example.com/foo.pdf`
// cannot masquerade as a local path. file:// is preserved and handled below.
const HTTP_URL_PATTERN = /\bhttps?:\/\/\S+/gi;

// Path-shape prefix used by both the span extractors (which preserve spaces)
// and the whitespace-token fallback. A path must start with one of:
//   file:// URL, Windows drive, ./ or ../ relative, ~/ home, or POSIX absolute.
const PATH_PREFIX_PATTERN = /^(?:file:\/\/|[A-Za-z]:[\\/]|\.\.?\/|~\/|\/)/i;

// Anchored patterns applied to whitespace-separated tokens (after span extraction
// and http strip). Same prefixes as PATH_PREFIX_PATTERN, anchored at both ends
// against a non-whitespace token body so we reject prose that happens to start
// with `/`.
const ANCHORED_PATH_PATTERNS: RegExp[] = [
  /^file:\/\/\S+$/i,
  /^[A-Za-z]:[\\/]\S+$/,
  /^\.\.?\/\S+$/,
  /^~\/\S+$/,
  /^\/\S+$/,
];

// session.tsx injects `[Selected file: <abs-path>]` and `[Selected folder:
// <abs-path>]` text parts when the user picks a workspace entry. The path can
// contain spaces (e.g. `/workspace/Quarterly Sales.xlsx`), so we have to pull
// the whole bracket span out before whitespace tokenization — otherwise a
// spreadsheet with a space gets split into `/workspace/Quarterly` (no .xlsx
// suffix → looks extensionless → wrongly forces local-model).
const SELECTED_BRACKET_PATTERN = /\[Selected (?:file|folder):\s*([^\]]+)\]/gi;

// Quoted spans (single, double, backtick) preserve paths that contain spaces
// even outside the [Selected …] wrapper, e.g. `summarize "/tmp/notes file.txt"`.
const QUOTED_SPAN_PATTERN = /"([^"]+)"|'([^']+)'|`([^`]+)`/g;

const LEADING_PUNCT = /^[(\[{<"'`]+/;
const TRAILING_PUNCT = /[,;:!?)\]}>"'`]+$/;

const stripWrappingPunct = (token: string): string => {
  let out = token.replace(LEADING_PUNCT, "").replace(TRAILING_PUNCT, "");
  // Allow trimming a single trailing "." only when another "." remains, so
  // we don't erase the extension on a sentence-ending period.
  if (out.endsWith(".") && out.slice(0, -1).includes(".")) {
    out = out.slice(0, -1);
  }
  return out;
};

const extractPathTokens = (text: string): string[] => {
  if (!text) return [];
  let working = text.replace(HTTP_URL_PATTERN, " ");
  const found: string[] = [];

  // 1. Pull `[Selected file: …]` / `[Selected folder: …]` payloads first so
  //    paths containing spaces survive whitespace tokenization.
  working = working.replace(SELECTED_BRACKET_PATTERN, (_match, path: string) => {
    const candidate = path.trim();
    if (candidate && PATH_PREFIX_PATTERN.test(candidate)) found.push(candidate);
    return " ";
  });

  // 2. Pull quoted spans that look like anchored paths.
  working = working.replace(QUOTED_SPAN_PATTERN, (...args: unknown[]) => {
    const inner = ((args[1] ?? args[2] ?? args[3] ?? "") as string).trim();
    if (inner && PATH_PREFIX_PATTERN.test(inner)) found.push(inner);
    return " ";
  });

  // 3. Fall back to whitespace tokenization for the common case (anchored
  //    paths without spaces).
  for (const raw of working.split(/\s+/)) {
    const cleaned = stripWrappingPunct(raw);
    if (!cleaned) continue;
    if (ANCHORED_PATH_PATTERNS.some((p) => p.test(cleaned))) {
      found.push(cleaned);
    }
  }
  return found;
};

// Strip a leading `/<commandName>` token (and the whitespace after it) from a
// blob if present. Slash command drafts carry their invocation in draft.text
// and the first text part; the `/<cmd>` token would otherwise match the
// absolute-path pattern as an extensionless local file and force every
// command (e.g. /help) to local-model under an active PII level.
const stripCommandToken = (text: string, commandName: string): string => {
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const rest = text.slice(leading.length);
  const head = "/" + commandName;
  if (!rest.startsWith(head)) return text;
  const after = rest.slice(head.length);
  // Only strip if the command name is a complete token: end-of-string or
  // followed by whitespace. Otherwise `/help` would also strip `/helper`.
  if (after.length === 0 || /^\s/.test(after)) return after;
  return text;
};

export function hasNonSpreadsheetLocalFile(draft: ComposerDraft): boolean {
  for (const attachment of draft.attachments) {
    if (attachment.kind !== "file" && attachment.kind !== "image") continue;
    if (!isSpreadsheet(attachment.name)) return true;
  }
  for (const part of draft.parts) {
    if (part.type !== "file") continue;
    if (!isSpreadsheet(part.path)) return true;
  }
  // Free-text path mentions: scan both the canonical prompt body AND any
  // text parts. session.tsx:4514 injects `[Selected file: /workspace/...]`
  // as a text part (not into draft.text) when the user picks a binary
  // workspace file, so missing the parts scan would silently route those
  // mentions through the auto-router instead of bypassing to local-model.
  const textBlobs: string[] = [];
  if (draft.command) {
    // Slash command: prefer the parsed arguments string (which already excludes
    // the `/<cmd>` token) over the raw body. session.tsx may still append
    // separate `[Selected file: ...]` text parts; those don't start with the
    // command token so they survive stripCommandToken untouched.
    if (draft.command.arguments) textBlobs.push(draft.command.arguments);
    for (const part of draft.parts) {
      if (part.type === "text")
        textBlobs.push(stripCommandToken(part.text, draft.command.name));
      else if (part.type === "paste") textBlobs.push(part.text);
    }
  } else {
    const body = draft.resolvedText ?? draft.text;
    if (body) textBlobs.push(body);
    for (const part of draft.parts) {
      if (part.type === "text") textBlobs.push(part.text);
      else if (part.type === "paste") textBlobs.push(part.text);
    }
  }
  for (const blob of textBlobs) {
    if (!blob) continue;
    for (const token of extractPathTokens(blob)) {
      const ext = extensionOf(token);
      if (!SPREADSHEET_EXTENSIONS.has(ext)) return true;
    }
  }
  return false;
}
