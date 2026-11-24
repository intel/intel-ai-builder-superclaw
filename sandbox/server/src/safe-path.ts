import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { ApiError } from "./errors.js";

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function rethrowAsApiError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ELOOP") {
    throw new ApiError(400, "invalid_path", "Path contains a link cycle");
  }
  if (code === "EACCES" || code === "EPERM") {
    throw new ApiError(403, "path_access_denied", "Permission denied");
  }
  throw error;
}

/**
 * Real path of `path`, resolving every symlink and junction in it. Missing trailing
 * components are re-appended unresolved, so paths that will be created still resolve.
 * A component that exists but cannot be resolved (a dangling link) is refused: writing
 * through it would create its target, which may be outside the root.
 */
function realpathAllowingMissing(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch (error) {
      if (!isMissing(error)) rethrowAsApiError(error);
    }
    let entryExists = true;
    try {
      lstatSync(current);
    } catch (error) {
      if (!isMissing(error)) rethrowAsApiError(error);
      entryExists = false;
    }
    if (entryExists) {
      throw new ApiError(400, "invalid_path", "Path contains a link that cannot be resolved");
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...missing);
    missing.unshift(basename(current));
    current = parent;
  }
}

function isInside(path: string, root: string): boolean {
  // A filesystem root such as `C:\` or `/` already ends with a separator.
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolve `child` under `root` and refuse it unless it stays inside `root` both
 * lexically and on disk (after following symlinks and junctions). Links that stay
 * inside the root are allowed. The returned path is the unresolved candidate, so
 * deleting a final link removes the link rather than its target. The folder that
 * holds the candidate must also resolve inside the root, so a link stored outside
 * the root is never touched even if it points back in.
 *
 * Pass `trustedRoot` when `root` is derived from a trusted directory (for example
 * the outbox under a workspace): the real `root` must then also stay inside the real
 * `trustedRoot`, otherwise a link at `root` or one of its parents would make an
 * outside directory look like the root. Aliases to `trustedRoot` itself are fine.
 *
 * Point-in-time check: a component swapped for a link between this call and the
 * caller's filesystem operation is still followed. That check-to-use race is a
 * known residual (PEN-ML-048).
 */
export function resolveSafeChildPath(root: string, child: string, trustedRoot?: string): string {
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, child);
  if (candidate === rootResolved) {
    throw new ApiError(400, "invalid_path", "Path must point to a file");
  }
  if (!isInside(candidate, rootResolved)) {
    throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
  }
  const realRoot = realpathAllowingMissing(rootResolved);
  if (trustedRoot !== undefined) {
    const realTrusted = realpathAllowingMissing(resolve(trustedRoot));
    if (realRoot !== realTrusted && !isInside(realRoot, realTrusted)) {
      throw new ApiError(400, "invalid_path", "Path root resolves outside the trusted root");
    }
  }
  const realCandidate = realpathAllowingMissing(candidate);
  if (realCandidate === realRoot || !isInside(realCandidate, realRoot)) {
    throw new ApiError(400, "invalid_path", "Path resolves outside the allowed root");
  }
  // delete/rename/write act on the entry itself, so its folder must be inside the root even
  // when the entry is a link that points back in.
  const realParent = realpathAllowingMissing(dirname(candidate));
  if (realParent !== realRoot && !isInside(realParent, realRoot)) {
    throw new ApiError(400, "invalid_path", "Path parent resolves outside the allowed root");
  }
  return candidate;
}
