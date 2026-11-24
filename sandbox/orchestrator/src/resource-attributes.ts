/** OTEL_RESOURCE_ATTRIBUTES merging, shared by every child process we spawn. */

/**
 * Folds `additional` over an inherited OTEL_RESOURCE_ATTRIBUTES string, with the
 * caller's keys winning.
 *
 * Commas separate entries in the wire format, so any comma inside a value is
 * rewritten to a semicolon rather than escaped — an unescaped one would split a
 * single attribute into two malformed ones and take the rest of the string with
 * it. Entries without a `=` are dropped for the same reason.
 */
export function mergeResourceAttributes(
  additional: Record<string, string>,
  existing?: string,
): string {
  const entries = new Map<string, string>();
  if (existing) {
    for (const part of existing.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [key, ...rest] = trimmed.split("=");
      if (!key || rest.length === 0) continue;
      entries.set(key, rest.join("=").replace(/,/g, ";"));
    }
  }
  for (const [key, value] of Object.entries(additional)) {
    if (!key) continue;
    if (value === undefined || value === null) continue;
    entries.set(key, String(value).replace(/,/g, ";"));
  }
  return Array.from(entries.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}
