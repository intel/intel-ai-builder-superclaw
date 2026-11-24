export function chunkText(input: string, limit: number): string[] {
  if (input.length <= limit) return [input];
  const chunks: string[] = [];
  let current = "";

  for (const line of input.split(/\n/)) {
    if ((current + line).length + 1 > limit) {
      if (current) chunks.push(current.trimEnd());
      current = "";
    }
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit) {
        const slice = line.slice(i, i + limit);
        if (slice.length) chunks.push(slice);
      }
      continue;
    }
    current += current ? `\n${line}` : line;
  }

  if (current.trim().length) chunks.push(current.trimEnd());
  return chunks.length ? chunks : [input];
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function formatInputSummary(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (!entries.length) return "";
  // Prefer a single human-friendly field over dumping the whole input object
  // (dumping would leak large fields like a sub-agent `prompt`).
  const SUMMARY_KEYS = ["description", "command", "filePath", "path", "pattern", "query", "url", "title", "name"];
  for (const key of SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // Fallback: compact key=value for short scalar fields, skipping verbose ones.
  const SKIP_KEYS = new Set(["prompt"]);
  const parts = entries
    .filter(([key, value]) => !SKIP_KEYS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.join(", ");
}

/**
 * Strip a leading `[<model-id>] ` prefix that LRM injects into responses,
 * so it doesn't leak to Slack/Telegram. Shape check preserves legitimate
 * bracket prose (`[Note] …`, `[1] …`). Mirrors `apps/ui`.
 */
export function stripModelPrefix(text: string): string {
  return text.replace(/^\s*\[([^\]\s\n]{2,80})\]\s/, (match, token) => {
    const hasLetter = /[a-zA-Z]/.test(token);
    const hasDistinctive = /[-_.:\/0-9]/.test(token);
    return hasLetter && hasDistinctive ? "" : match;
  });
}

/**
 * Resolve the concrete model id from a leading `[<model-id>]` prefix (injected
 * when a router alias like `llmrouter/auto` is used), or `null` if absent.
 * Looser match than `stripModelPrefix` (`[^\]\n]+`), then rejects tokens with
 * whitespace or >80 chars — this drops litellm's `[System: … sanitised …]`
 * placeholder while keeping ids like `deepseek/deepseek-chat`. Mirrors
 * `resolveAutoModelID` in `apps/ui` (local port, no shared import).
 */
export function resolveModelPrefix(rawText: string): string | null {
  if (!rawText) return null;
  const match = rawText.match(/^\s*\[([^\]\n]+)\]/);
  if (!match || !match[1]) return null;
  const token = match[1].trim();
  if (!token) return null;
  if (/\s/.test(token)) return null;
  if (token.length > 80) return null;
  return token;
}
