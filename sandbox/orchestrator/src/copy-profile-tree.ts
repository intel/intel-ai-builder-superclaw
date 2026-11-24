import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileConcurrency, forEachBounded } from "./bounded-parallel.js";

/** Windows CopyFile preserves READONLY attributes, but generated files must be flushable. */
export function copyWritableProfileFile(source: string, destination: string, mode = 0): void {
  copyFileSync(source, destination, mode);
  if (process.platform === "win32") chmodSync(destination, 0o600);
}

/** The per-file copy `copyPhysicalProfileTree` uses: refuses an existing target, then clears READONLY. */
export async function copyNewWritableProfileFile(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  if (process.platform === "win32") await chmod(destination, 0o600);
}

/** What a whole-tree pass moved or inspected, so its duration can be read per file and per byte. */
export interface ProfileTreeCounts {
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

/** Copy a physical packaged tree into a fresh destination, without inspecting ancestors.
 * Callers provide provisioned non-reparse roots; this is not a handle-level TOCTOU boundary.
 * Unlike Bun 1.3.12 cpSync, readdir opens source directories read-only on Windows.
 * The whole source is walked, and every directory created, before any file is copied; files
 * are then copied `fileConcurrency()` at a time, and a failure surfaces only after every copy
 * in flight has settled, so a caller removing the destination never races a write into it.
 */
export async function copyPhysicalProfileTree(
  source: string,
  destination: string,
  options: {
    readonly copyFile?: (source: string, destination: string) => Promise<void>;
    readonly parallelism?: number;
  } = {},
): Promise<ProfileTreeCounts> {
  const normalize = (path: string): string => process.platform === "win32"
    ? resolve(path).toLowerCase() : resolve(path);
  const contains = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  };
  const from = normalize(source);
  const to = normalize(destination);
  if (contains(from, to) || contains(to, from)) {
    throw new Error("Profile copy roots must not overlap");
  }
  const files: Array<readonly [string, string]> = [];
  let directories = 0;
  let bytes = 0;
  const walk = (src: string, dst: string): void => {
    const stat = lstatSync(src);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Profile copy source must be a physical directory");
    }
    // No recursive mkdir: the caller prepares the parent. Existing targets,
    // including junctions, are refused instead of followed or merged.
    mkdirSync(dst);
    directories += 1;
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const child = join(src, entry.name);
      const target = join(dst, entry.name);
      const childStat = lstatSync(child);
      if (childStat.isSymbolicLink()) throw new Error("Profile copy rejects symbolic links");
      if (childStat.isDirectory()) walk(child, target);
      else if (childStat.isFile()) {
        files.push([child, target]);
        bytes += childStat.size;
      } else throw new Error("Profile copy rejects special entries");
    }
  };
  walk(source, destination);
  const copy = options.copyFile ?? copyNewWritableProfileFile;
  await forEachBounded(files, fileConcurrency(options.parallelism), ([from, to]) => copy(from, to));
  return { files: files.length, directories, bytes };
}
