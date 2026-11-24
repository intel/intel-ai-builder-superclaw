import { FILE_URI_RE, isBareRelativeFilePath, isRelativeFilePath, isWorkspaceRelativeFilePath, stripFileReferenceSuffix } from "./part-view.links";

export const normalizeRelativePath = (relativePath: string, workspaceRoot: string) => {
  const root = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!root) return null;

  const relative = relativePath.trim().replace(/\\/g, "/");
  if (!relative) return null;

  const isPosixRoot = root.startsWith("/");
  const rootValue = isPosixRoot ? root.slice(1) : root;
  const rootParts = rootValue.split("/").filter((value) => value.length > 0);
  const isWindowsDrive = /^[A-Za-z]:$/.test(rootParts[0] ?? "");
  const resolved: string[] = [...rootParts];
  const segments = relative.split("/");

  for (const segment of segments) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      if (!(isWindowsDrive && resolved.length === 1)) {
        resolved.pop();
      }
      continue;
    }

    resolved.push(segment);
  }

  const normalized = resolved.join("/");
  if (isPosixRoot) return `/${normalized || ""}` || "/";
  return normalized;
};

/**
 * `decodeURIComponent` throws `URIError` on malformed percent-encoding, which is
 * reachable from LLM-authored links. Fall back to the raw value so one bad link
 * cannot break file-link handling for the whole message.
 */
const safeDecodeUri = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const normalizeFilePath = (
  href: string,
  workspaceRoot: string,
): string | null => {
  const strippedHref = stripFileReferenceSuffix(href);
  if (!strippedHref) return null;

  if (FILE_URI_RE.test(strippedHref)) {
    try {
      const parsed = new URL(strippedHref);
      if (parsed.protocol !== "file:") return null;
      const raw = safeDecodeUri(parsed.pathname || "");
      if (!raw) return null;
      if (/^\/[A-Za-z]:\//.test(raw)) {
        return raw.slice(1);
      }
      if (
        parsed.hostname &&
        !parsed.pathname.startsWith(`/${parsed.hostname}`) &&
        !raw.startsWith("/")
      ) {
        return `/${parsed.hostname}${raw}`;
      }
      return raw;
    } catch {
      const raw = safeDecodeUri(strippedHref.replace(/^file:\/\//, ""));
      if (!raw) return null;
      return raw;
    }
  }

  const trimmed = strippedHref.trim();
  if (
    isRelativeFilePath(trimmed) ||
    isBareRelativeFilePath(trimmed) ||
    isWorkspaceRelativeFilePath(trimmed)
  ) {
    if (!workspaceRoot) return null;
    return normalizeRelativePath(trimmed, workspaceRoot);
  }

  // Strip only the :line:col suffix: `?` and `#` are URI syntax in the
  // file:// branch above, but legal filename characters in a plain path.
  return href.trim().replace(/:(\d+)(?::\d+)?$/, "");
};

export function clampText(text: string, max = 800) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (truncated)`;
}
