// The backend persists an edge server's base_url with a trailing "/vN"
// version segment appended (llmrouter_manager edge/config.py
// normalize_base_url) because the request dispatcher concatenates
// "{base_url}/chat/completions" directly and needs it there. That's an
// implementation detail of outbound requests, not something the user typed
// into the URL field — strip it back off so the field displays what was
// entered (mirrors normalize_base_url's `^v\d+$` version-segment check).
const VERSION_SEGMENT_RE = /^v\d+$/;

export function stripVersionSegment(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) return trimmed;
  const tail = trimmed.slice(lastSlash + 1);
  return VERSION_SEGMENT_RE.test(tail) ? trimmed.slice(0, lastSlash) : trimmed;
}

/** True when both URLs share scheme, host and port. Unparseable input is never a match. */
export function isSameOrigin(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA.trim()).origin === new URL(urlB.trim()).origin;
  } catch {
    return false;
  }
}
