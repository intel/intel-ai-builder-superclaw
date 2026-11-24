const PATH_START =
  /file:\/\/|(?<=^|[\s"'(])(?:[a-zA-Z]:[\\/]|\/(?:Users|home|var|etc|opt|tmp|private|Volumes|Applications)\/)/g;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}>]+$/;

export type PastedPath = {
  /** Offsets of the path, and any quotes around it, in the pasted text; end exclusive. */
  start: number;
  end: number;
  /** Local filesystem path (a `file://` URL decoded). */
  path: string;
};

const toLocalPath = (text: string) => {
  if (!text.startsWith("file://")) return text;
  const rest = text
    .slice("file://".length)
    .replace(/^localhost(?=\/)/i, "")
    .replace(/^\/(?=[a-zA-Z]:)/, "");
  let path = rest;
  try {
    path = decodeURIComponent(rest);
  } catch {
    // Malformed escapes: keep the text as pasted.
  }
  // Any other authority names a remote host: `file://server/share` is `\\server\share`.
  return !path || path.startsWith("/") || /^[a-zA-Z]:/.test(path)
    ? path
    : `\\\\${path.replace(/\//g, "\\")}`;
};

/** Forward slashes, with `.` and `..` resolved so `root/../x` does not count as inside. */
const normalize = (path: string) => {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    // Repeated separators are one, so `root\\..` leaves the root; a leading one keeps POSIX's `/`.
    if (segment === "." || (segment === "" && segments.length)) continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.length > 1) segments.pop();
  }
  return segments.join("/");
};

// A path may contain spaces, so only a quoted path or a paste that is nothing
// but the path can run past whitespace; anything else ends at the first space.
function pathEnd(text: string, start: number): number {
  const lineEnd = text.indexOf("\n", start);
  const stop = lineEnd === -1 ? text.length : lineEnd;
  const quote = text[start - 1];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, start);
    if (close !== -1 && close < stop) return close;
  }
  const rest = text.slice(start + 1, stop);
  if (!text.slice(0, start).trim() && !text.slice(stop).trim() && !rest.match(PATH_START)) {
    return start + text.slice(start, stop).trimEnd().length;
  }
  const space = text.slice(start, stop).search(/\s/);
  const end = space === -1 ? stop : start + space;
  return end - (text.slice(start, end).match(TRAILING_PUNCTUATION)?.[0].length ?? 0);
}

/**
 * Absolute local paths in pasted text that the agent cannot open: anything
 * outside `workspaceRoot` (a host path such as `C:\Users\...`). Paths inside
 * the workspace are reachable, so they are not returned.
 */
export function findOutsidePaths(text: string, workspaceRoot?: string): PastedPath[] {
  const root = normalize(workspaceRoot?.trim() ?? "").replace(/\/+$/, "");
  const fold = /^[a-zA-Z]:/.test(root) ? (s: string) => s.toLowerCase() : (s: string) => s;
  const foldedRoot = fold(root);
  const found: PastedPath[] = [];
  for (const match of text.matchAll(PATH_START)) {
    const start = match.index;
    if (found.length && start < found[found.length - 1].end) continue;
    const end = pathEnd(text, start);
    const path = toLocalPath(text.slice(start, end));
    const folded = fold(normalize(path));
    const inside =
      foldedRoot !== "" &&
      folded.startsWith(foldedRoot) &&
      /^$|^\//.test(folded.charAt(foldedRoot.length));
    // Quotes go with the chip, so adding the path does not leave them behind.
    const quote = text[start - 1];
    const quoted = (quote === '"' || quote === "'") && text[end] === quote;
    if (!inside) found.push(quoted ? { start: start - 1, end: end + 1, path } : { start, end, path });
  }
  return found;
}
