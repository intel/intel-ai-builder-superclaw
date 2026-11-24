/** Turns a file reference produced by an agent, an artifact list or the user
 * into the paths the remote worker will accept. Everything here is pure, so the
 * containment rules below are unit-testable in isolation. */

/** Matches a Windows drive path, a UNC share, a POSIX root or a `~/` home path. */
export const isAbsolutePath = (value: string) =>
  /^(?:[a-zA-Z]:[\\/]|\\\\|\/|~\/)/.test(value.trim());

export const selectedWorkspacePath = (relativePath: string, workspaceRoot: string): string => {
  const root = workspaceRoot.trim();
  if (/^[a-zA-Z]:[\\/]/.test(root)) {
    return `${root.replace(/[\\/]+$/, "").replace(/\//g, "\\")}\\${relativePath.replace(/\//g, "\\")}`;
  }
  return relativePath;
};

const MAX_TOUCHED_FILES = 48;

/**
 * The newest files the run touched, de-duplicated case-insensitively and capped
 * so a long run cannot grow this unboundedly. Artifacts win outright; the
 * working-file list is only consulted when there are no artifacts at all.
 *
 * Returns `previous` unchanged when the contents match, because callers feed
 * this into effects that would otherwise storm on every streamed token.
 */
export function collectTouchedFiles(
  artifacts: ReadonlyArray<{ path?: string; name?: string } | undefined>,
  workingFiles: ReadonlyArray<string | undefined>,
  previous: string[],
  workspaceRoot = "",
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const root = workspaceRoot.trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const rootPrefix = root ? `${root.toLowerCase()}/` : "";
  const add = (value: string) => {
    let normalized = String(value ?? "")
      .trim()
      .replace(/[\\/]+/g, "/");
    // Native agents write absolute paths; make them workspace-relative so they dedupe with relative writes.
    if (rootPrefix && normalized.toLowerCase().startsWith(rootPrefix)) {
      normalized = normalized.slice(rootPrefix.length);
    }
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };

  for (let idx = artifacts.length - 1; idx >= 0; idx -= 1) {
    const item = artifacts[idx];
    add(item?.path ?? item?.name ?? "");
    if (out.length >= MAX_TOUCHED_FILES) break;
  }

  if (out.length === 0) {
    for (let idx = workingFiles.length - 1; idx >= 0; idx -= 1) {
      add(workingFiles[idx] ?? "");
      if (out.length >= MAX_TOUCHED_FILES) break;
    }
  }

  if (previous.length === out.length && previous.every((f, i) => f === out[i])) {
    return previous;
  }
  return out;
}

/** Rewrites files under the workspace root as workspace-relative, the shape
 * `@` search returns, so a recent file and its search hit are one mention.
 * Files outside the workspace keep their absolute path. */
export function toWorkspaceMentionPaths(files: readonly string[], workspaceRoot: string): string[] {
  const root = workspaceRoot.trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const rootPrefix = root ? `${root.toLowerCase()}/` : "";
  if (!rootPrefix) return [...files];
  return files.map((file) => {
    const normalized = file.trim().replace(/[\\/]+/g, "/");
    return normalized.toLowerCase().startsWith(rootPrefix) ? normalized.slice(rootPrefix.length) : file;
  });
}

/** Resolves `file` to a path relative to the worker's workspace root.
 *
 * Returns `""` for anything that would escape the workspace: an absolute path,
 * a home path, a drive letter, or any `.`/`..` segment. Callers treat `""` as
 * "not a workspace file" and skip the remote round trip. */
export const toWorkerRelativeArtifactPath = (
  file: string,
  workspaceRoot: string,
) => {
  const normalized = file
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/[\\/]+/g, "/");
  if (!normalized) return "";

  const root = workspaceRoot
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  if (root) {
    const rootKey = root.toLowerCase();
    const fileKey = normalized.toLowerCase();
    if (fileKey === rootKey) return "";
    if (fileKey.startsWith(`${rootKey}/`)) {
      return normalized.slice(root.length + 1);
    }
  }

  let relative = normalized.replace(/^\.\/+/, "");

  // Diff-style `a/foo.md` and `b/foo.md` prefixes, as they appear in patches.
  if (/^[ab]\/.+\.(md|mdx|markdown)$/i.test(relative)) {
    relative = relative.slice(2);
  }

  if (/^workspace\//i.test(relative)) {
    relative = relative.replace(/^workspace\//i, "");
  }

  if (/^\/+workspace\//i.test(relative)) {
    relative = relative.replace(/^\/+workspace\//i, "");
  }

  if (!relative) return "";
  if (
    relative.startsWith("/") ||
    relative.startsWith("~") ||
    /^[a-zA-Z]:\//.test(relative)
  ) {
    return "";
  }
  if (relative.split("/").some((part) => part === "." || part === "..")) {
    return "";
  }
  return relative;
};

/** Agents write deliverables either in place or into the openwork outbox, so a
 * lookup tries both unless the path already points at the outbox. */
export const toRemoteArtifactCandidates = (
  file: string,
  workspaceRoot: string,
) => {
  const target = toWorkerRelativeArtifactPath(file, workspaceRoot);
  if (!target) return [] as string[];
  const outboxPath = `.opencode/openwork/outbox/${target}`.replace(/\/+/g, "/");
  if (
    target.startsWith(".opencode/openwork/outbox/") ||
    target.startsWith("./.opencode/openwork/outbox/") ||
    outboxPath === target
  ) {
    return [target];
  }
  return [target, outboxPath];
};

/** Read paths to try against the server, widest net first. The raw fallback
 * below skips the containment check above, so the server is the boundary: it
 * re-resolves every path against the file-session root. */
export const buildReadCandidates = (
  file: string,
  workspaceRoot: string,
): string[] => {
  const candidates = [...toRemoteArtifactCandidates(file, workspaceRoot)];
  // In sandboxed setups the file-session root may be the parent of
  // the workspace directory, so also try the 'workspace/' prefixed variant
  // (e.g. 'workspace/slides.html' in addition to 'slides.html').
  const first = candidates[0];
  if (first && !first.startsWith("workspace/")) {
    const withWorkspace = `workspace/${first}`;
    if (!candidates.includes(withWorkspace)) candidates.push(withWorkspace);
  }
  // Also try the raw relative path as-is (before any normalization).
  const rawRelative = file
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/^\.\//, "");
  if (
    rawRelative &&
    !candidates.some((c) => c.toLowerCase() === rawRelative.toLowerCase())
  ) {
    candidates.push(rawRelative);
  }
  return candidates;
};

/** Parks a conflicting local edit beside the original instead of overwriting
 * it, keeping the extension so the file still opens in the same editor. */
export const createConflictPath = (path: string) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const marker = `.openwork-conflict-${stamp}`;
  const dot = path.lastIndexOf(".");
  if (dot <= 0) {
    return `${path}${marker}`;
  }
  return `${path.slice(0, dot)}${marker}${path.slice(dot)}`;
};
