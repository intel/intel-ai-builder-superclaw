import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ProductProfileDescriptorSchema,
  ProductProfileIdSchema,
  type ProductProfileDescriptor,
  type ProductProfileId,
} from "@different-ai/openwork-contracts/capability";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { copyPhysicalProfileTree, copyWritableProfileFile, type ProfileTreeCounts } from "./copy-profile-tree.js";
import { publicationAsyncStep, publicationDiagnostic, publicationStep } from "./publication-diagnostics.js";

const REQUIRED_PROFILE_FILES = ["profile.json", "opencode.jsonc", "package.json"] as const;
const RUNTIME_SETTINGS_FILE = "superclaw-runtime-config.json";
const HDR_PROGRESS_DIR = "hybrid-dr-progress";
const FILE_REFERENCE = /\{file:\.\/([^}]+)\}/g;
const ROOT_NODE_MODULES_TARGET = "/opt/opencode-deps/node_modules";
const OPENCODE_GITIGNORE = ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n");
const DEPLOYMENT_SYMLINKS = new Map([
  ["node_modules", ROOT_NODE_MODULES_TARGET],
  ["tools/package.json", "../package.json"],
]);
/**
 * A scaffold entry generations used to carry and no longer create.
 *
 * `tools/node_modules` duplicated the whole dependency tree so that tools beside it could
 * import `@opencode-ai/plugin`. They resolve it from the root tree instead - the only bare
 * import any Profile tool has, covered by `test/profile-tool-resolution.test.ts` - so
 * Windows no longer copies 3,791 files twice and no longer flushes them twice.
 *
 * Accepted where it already exists so a generation published by an older build still
 * validates. Deliberately absent from the source-comparison allowances, so such a
 * generation compares as stale once and is republished without it.
 */
const LEGACY_DEPLOYMENT_SYMLINKS = new Map([["tools/node_modules", "../node_modules"]]);
const MANAGED_DEPLOYMENT_FILES = new Set([
  ".gitignore",
  "package-lock.json",
  "tools/opencode_router_send.ts",
  "tools/opencode_router_status.ts",
]);
const WINDOWS_RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_RENAME_RETRY_ATTEMPTS = 20;
const WINDOWS_RENAME_RETRY_DELAY_MS = 100;

export interface ProfileDeploymentLayout {
  readonly configRoot: string;
  readonly live: string;
  readonly next: string;
  readonly backup: string;
  readonly marker: string;
}

export type PublicationCrashPoint = "live_to_backup" | "next_to_live";

export function profileDeploymentLayout(configRoot: string, marker: string): ProfileDeploymentLayout {
  return {
    configRoot,
    live: join(configRoot, "opencode"),
    next: join(configRoot, "opencode.next"),
    backup: join(configRoot, "opencode.backup"),
    marker,
  };
}

function parseJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsoncFile(path: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(readFileSync(path, "utf8"), errors, { allowTrailingComma: false });
  if (errors.length > 0) throw new Error(`opencode.jsonc is not valid JSONC at offset ${errors[0]?.offset ?? 0}`);
  return value;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
}

export function renamePublicationDirectory(
  source: string,
  destination: string,
  options: {
    readonly rename?: (source: string, destination: string) => void;
    readonly sleep?: (milliseconds: number) => void;
    readonly windows?: boolean;
    readonly diagnosticStage?: string;
  } = {},
): void {
  const rename = options.rename ?? renameSync;
  const sleep = options.sleep ?? ((milliseconds: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  });
  const windows = options.windows ?? process.platform === "win32";
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (!windows || !WINDOWS_RENAME_RETRY_CODES.has(String(code))
        || attempt >= WINDOWS_RENAME_RETRY_ATTEMPTS
        || !pathExists(source) || pathExists(destination)) {
        throw error;
      }
      publicationDiagnostic(options.diagnosticStage ?? "rename", "retry", {
        retry_index: attempt,
        delay_ms: WINDOWS_RENAME_RETRY_DELAY_MS,
        code: String(code),
      });
      sleep(WINDOWS_RENAME_RETRY_DELAY_MS);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateTree(
  root: string,
  hydrated: boolean,
  skipDependencies: boolean,
): ProfileTreeCounts & { readonly skipped_dependencies: boolean } {
  let files = 0;
  let directories = 0;
  let bytes = 0;
  let skipped = false;
  const visit = (dir: string): void => {
    directories += 1;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (entry.name === RUNTIME_SETTINGS_FILE || entry.name === HDR_PROGRESS_DIR) {
        throw new Error(`Profile contains Runtime-owned artifact: ${rel}`);
      }
      if (skipDependencies && rel === "node_modules" && stat.isDirectory()) {
        skipped = true;
        continue;
      }
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        continue;
      }
      else if (stat.isSymbolicLink() && hydrated
        && (DEPLOYMENT_SYMLINKS.get(rel) ?? LEGACY_DEPLOYMENT_SYMLINKS.get(rel)) === readlinkSync(path)) continue;
      else throw new Error(`Profile contains unsupported entry: ${rel}`);
    }
  };
  visit(root);
  return { files, directories, bytes, skipped_dependencies: skipped };
}

function validateLocalReferences(root: string, config: unknown): void {
  const inspect = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(FILE_REFERENCE)) {
        const reference = match[1];
        if (!reference) continue;
        const target = resolve(root, reference);
        if (!isWithin(resolve(root), target)) throw new Error(`Profile file reference escapes its root: ${reference}`);
        if (!lstatSync(target).isFile()) throw new Error(`Profile file dependency is not a regular file: ${reference}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) inspect(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) inspect(item);
    }
  };
  try {
    inspect(config);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Profile ")) throw error;
    throw new Error(`Profile file dependency is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateDirectory(
  root: string,
  expectedProfile: ProductProfileId | undefined,
  hydrated: boolean,
  skipDependencies = false,
): ProductProfileDescriptor {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Profile root must be a real directory");
  // One publication walks this tree several times over. Report each pass on its own so the
  // repeats are countable instead of folded into whichever stage happened to call them.
  const walkStarted = performance.now();
  const counts = validateTree(root, hydrated, skipDependencies);
  publicationDiagnostic("validate_tree", "observed", {
    elapsed_ms: Math.round(performance.now() - walkStarted),
    hydrated,
    ...counts,
  });
  for (const name of REQUIRED_PROFILE_FILES) {
    const stat = lstatSync(join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Profile requires regular file: ${name}`);
  }
  const descriptor = ProductProfileDescriptorSchema.parse(parseJsonFile(join(root, "profile.json"), "profile.json"));
  if (expectedProfile !== undefined && descriptor.profile !== expectedProfile) {
    throw new Error(`Profile identity mismatch: expected ${expectedProfile}, found ${descriptor.profile}`);
  }
  const config = parseJsoncFile(join(root, "opencode.jsonc"));
  const packageJson = parseJsonFile(join(root, "package.json"), "package.json");
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new Error("package.json must contain an object");
  }
  const dependencies = (packageJson as Record<string, unknown>).dependencies;
  if (dependencies !== undefined && (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)
    || Object.values(dependencies).some((version) => typeof version !== "string" || version.length === 0))) {
    throw new Error("package.json dependencies must be a string map");
  }
  validateLocalReferences(root, config);
  if (hydrated) {
    const lockPath = join(root, "package-lock.json");
    if (!existsSync(lockPath)) throw new Error("Deployment requires regular file: package-lock.json");
    const lock = lstatSync(lockPath);
    if (!lock.isFile() || lock.isSymbolicLink()) throw new Error("Deployment requires regular file: package-lock.json");
    for (const [rel, target] of DEPLOYMENT_SYMLINKS) {
      const path = join(root, rel);
      const stat = lstatSync(path);
      const windowsFallback = process.platform === "win32"
        && (rel.endsWith("node_modules") ? stat.isDirectory() : stat.isFile());
      if (!windowsFallback && (!stat.isSymbolicLink() || readlinkSync(path) !== target)) {
        throw new Error(`Deployment scaffold mismatch: ${rel}`);
      }
    }
  }
  return descriptor;
}

function packageDependencies(path: string): Record<string, string> {
  const parsed = parseJsonFile(path, "package.json");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("package.json must contain an object");
  const dependencies = (parsed as Record<string, unknown>).dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)
    || Object.values(dependencies).some((version) => typeof version !== "string" || version.length === 0)) {
    throw new Error("package.json dependencies must be a string map");
  }
  return dependencies as Record<string, string>;
}

export function validateProfileDirectory(root: string, expectedProfile?: ProductProfileId): ProductProfileDescriptor {
  return validateDirectory(root, expectedProfile, false);
}

/**
 * Validate a generation tree, or all of it except a dependency tree this process just copied.
 *
 * `skipDependencies` stops the walk at a physical root `node_modules` instead of descending
 * into it. On Linux that entry is a symlink into the image-owned `/opt/opencode-deps`, which
 * the walk never follows, so the option changes nothing there.
 *
 * What is lost: inside that tree the walk no longer refuses a link, a special file, or a
 * Runtime-owned artifact name. `copyPhysicalProfileTree` refuses the first two while it
 * creates the tree. Nothing replaces the name check, which is inert there for both names:
 * readers resolve `superclaw-runtime-config.json` only at the config root, and
 * `hybrid-dr-progress` only under `SC_RUNTIME_CONFIG_DIR/openwork/` or
 * `HYBRID_DR_PROGRESS_ROOT`. The root entry itself must still be a real directory. Each pass
 * reports `skipped_dependencies` on its `validate_tree` diagnostic.
 *
 * Only a caller that copied the tree in this process, before any role with a grant on it can
 * reach it, may pass it: the single-use Runtime generation's fresh preparation, its publication,
 * and the checks before its receipt. On Windows that generation lives under
 * `config_root/bootstrap`, which only the bootstrap tier writes and the file_tool tier reads, and
 * Sandbox Manager starts every file_tool role after the receipt. The Connector starts during
 * publication, but the network_connector tier has no grant on `config_root/bootstrap`.
 * Topology recovery, source matching, the daemon path and every re-read of a live tree keep the
 * full walk, because a tree that has been live may have been changed by a tier holding rights on
 * it. Skipped entries are not stat'ed at all, which is the saving: 3,791 files per pass.
 */
export function validateProfileDeployment(
  root: string,
  expectedProfile?: ProductProfileId,
  options: { readonly skipDependencies?: boolean } = {},
): ProductProfileDescriptor {
  return validateDirectory(root, expectedProfile, true, options.skipDependencies);
}

function sourceEntriesMatch(source: string, live: string, rel = "", read = { files: 0, bytes: 0 }): boolean {
  const sourceEntries = readdirSync(source, { withFileTypes: true });
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  for (const entry of sourceEntries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const sourcePath = join(source, entry.name);
    const livePath = join(live, entry.name);
    if (!pathExists(livePath)) return false;
    const sourceStat = lstatSync(sourcePath);
    const liveStat = lstatSync(livePath);
    if (sourceStat.isDirectory()) {
      if (!liveStat.isDirectory() || liveStat.isSymbolicLink()
        || !sourceEntriesMatch(sourcePath, livePath, childRel, read)) {
        return false;
      }
    } else if (!sourceStat.isFile() || !liveStat.isFile()) {
      return false;
    } else {
      // Both copies are read whole, so charge both to the comparison's byte total.
      read.files += 1;
      read.bytes += sourceStat.size + liveStat.size;
      if (!readFileSync(sourcePath).equals(readFileSync(livePath))) return false;
    }
  }
  for (const entry of readdirSync(live, { withFileTypes: true })) {
    if (sourceNames.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (DEPLOYMENT_SYMLINKS.has(childRel) || MANAGED_DEPLOYMENT_FILES.has(childRel)) continue;
    return false;
  }
  return true;
}

export function profileDeploymentMatchesSource(input: {
  readonly source: string;
  readonly live: string;
  readonly targetProfile: ProductProfileId;
}): boolean {
  try {
    validateProfileDirectory(input.source, input.targetProfile);
    validateProfileDeployment(input.live, input.targetProfile);
    const read = { files: 0, bytes: 0 };
    const started = performance.now();
    // Counts stop at the first mismatch, because the comparison itself does.
    const matched = sourceEntriesMatch(input.source, input.live, "", read);
    publicationDiagnostic("compare_source", "observed", {
      elapsed_ms: Math.round(performance.now() - started), matched, ...read,
    });
    return matched;
  } catch {
    return false;
  }
}

export async function prepareProfileNext(input: {
  readonly source: string;
  readonly runtimeScaffoldRoot: string;
  readonly layout: ProfileDeploymentLayout;
  readonly targetProfile: ProductProfileId;
  /** Single-use generations only; see `validateProfileDeployment`. */
  readonly skipDependencies?: boolean;
}): Promise<ProductProfileDescriptor> {
  // Bun's native Windows copy has no ancestor/self-copy guard. Our inputs are
  // provisioned, non-reparse roots; reject lexical overlap before removing next.
  const comparable = (path: string): string => {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  const destination = comparable(input.layout.configRoot);
  for (const sourceRoot of [input.source, input.runtimeScaffoldRoot]) {
    const source = comparable(sourceRoot);
    if (isWithin(source, destination) || isWithin(destination, source)) {
      throw new Error("Profile inputs and generation directory must not overlap");
    }
  }
  validateProfileDirectory(input.source, input.targetProfile);
  for (const reserved of ["node_modules", "tools/node_modules", "tools/package.json"]) {
    if (pathExists(join(input.source, reserved))) {
      throw new Error(`Product Profile occupies Runtime scaffold path: ${reserved}`);
    }
  }
  const scaffoldNodeModules = join(input.runtimeScaffoldRoot, "node_modules");
  const scaffoldLock = join(input.runtimeScaffoldRoot, "package-lock.json");
  const scaffoldPackage = join(input.runtimeScaffoldRoot, "package.json");
  validateScaffoldEntry(scaffoldNodeModules, "node_modules", "directory");
  validateScaffoldEntry(scaffoldLock, "package-lock.json", "file");
  validateScaffoldEntry(scaffoldPackage, "package.json", "file");
  const profileDependencies = Object.entries(packageDependencies(join(input.source, "package.json"))).sort();
  const scaffoldDependencies = Object.entries(packageDependencies(scaffoldPackage)).sort();
  if (JSON.stringify(profileDependencies) !== JSON.stringify(scaffoldDependencies)) {
    throw new Error("Product Profile dependencies do not match the Runtime scaffold");
  }

  rmSync(input.layout.next, { recursive: true, force: true });
  mkdirSync(input.layout.configRoot, { recursive: true });
  try {
    if (process.platform === "win32") {
      await publicationAsyncStep("copy_profile", () => copyPhysicalProfileTree(input.source, input.layout.next), { metrics: (counts) => counts });
    } else {
      publicationStep("copy_profile", () => cpSync(input.source, input.layout.next, { recursive: true, dereference: false, verbatimSymlinks: true }));
    }
    publicationStep("copy_lock", () => copyWritableProfileFile(scaffoldLock, join(input.layout.next, "package-lock.json")));
    // OpenCode 1.18.25 creates this during config loading. Publish it before the
    // generation becomes read-only so runtime startup never needs a write grant.
    writeFileSync(join(input.layout.next, ".gitignore"), OPENCODE_GITIGNORE, { mode: 0o600 });
    mkdirSync(join(input.layout.next, "tools"), { recursive: true });
    // One dependency tree, at the generation root. Tools resolve `@opencode-ai/plugin` from
    // here by the ordinary parent-directory walk, which is why `tools/node_modules` is no
    // longer published: on Windows that second physical tree was 3,791 files copied and then
    // flushed for nothing.
    if (process.platform === "win32") {
      await publicationAsyncStep("copy_dependencies", () => copyPhysicalProfileTree(scaffoldNodeModules, join(input.layout.next, "node_modules")), { metrics: (counts) => counts });
      copyWritableProfileFile(join(input.source, "package.json"), join(input.layout.next, "tools", "package.json"));
    } else {
      symlinkSync(ROOT_NODE_MODULES_TARGET, join(input.layout.next, "node_modules"), "dir");
      symlinkSync("../package.json", join(input.layout.next, "tools", "package.json"), "file");
    }
    return validateProfileDeployment(input.layout.next, input.targetProfile, { skipDependencies: input.skipDependencies });
  } catch (error) {
    // Only unpublished next belongs to this attempt; live and backup are untouched.
    rmSync(input.layout.next, { recursive: true, force: true });
    throw error;
  }
}

function validateScaffoldEntry(path: string, name: string, expected: "directory" | "file"): void {
  if (!existsSync(path)) throw new Error(`Runtime scaffold ${name} is missing`);
  const matches = expected === "directory" ? lstatSync(path).isDirectory() : lstatSync(path).isFile();
  if (!matches) throw new Error(`Runtime scaffold ${name} must be a ${expected === "file" ? "regular file" : "directory"}`);
}

function fsyncPath(path: string): void {
  const isFile = lstatSync(path).isFile();
  const fd = openSync(path, isFile ? "r+" : "r");
  try {
    try {
      fsyncSync(fd);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (process.platform !== "win32" || isFile || (code !== "EPERM" && code !== "EINVAL")) throw error;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * How many files are flushed at once.
 *
 * This pass is dominated by the first open of each freshly written file, not by fsync and
 * not by bytes: a measured publication flushed 7,631 files totalling 106 MiB in 107.9 s
 * (14.1 ms/file), while re-flushing the same files immediately afterwards cost 3.6 s
 * (0.47 ms/file). Concurrency is what removes that latency. Measured on the same tree, 8
 * was the floor - 8.4 s against 40.2 s serial, with 32 and above slightly worse as the
 * queue stops helping and starts competing. Kept modest deliberately.
 *
 * Every file in the flushed set is still fsynced; the one exception is the dependency tree
 * of a single-use generation, which `fsyncProfileTree` skips on request.
 */
const FLUSH_CONCURRENCY = 8;

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Run `operation` over `items` with at most `FLUSH_CONCURRENCY` outstanding at once. */
async function inBoundedParallel<T>(
  items: readonly T[],
  operation: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(FLUSH_CONCURRENCY, items.length) },
    async () => {
      for (let index = next++; index < items.length; index = next++) {
        await operation(items[index]!);
      }
    },
  ));
}

/**
 * Flush a generation tree, or all of it except the dependency tree.
 *
 * `skipDependencies` leaves the generation root's `node_modules` unflushed. This is a
 * deliberate exception to #2574, which kept fsync rather than trade durability for speed.
 *
 * What is lost: after an OS crash or power loss, an orphaned generation's `node_modules`
 * files may be zero-length. Nothing ever reads that generation again, because the instance
 * id it lives under is minted per launch and the next launch mints another. A process
 * crash loses nothing, since written data is already in the page cache. The Runtime reads
 * the tree through the page cache either way.
 *
 * Only the single-use Runtime generation may pass it. A persistent directory, such as the
 * daemon's config directory, and topology recovery keep the full flush.
 * Skipped files are not opened at all, which is the saving: see `FLUSH_CONCURRENCY`.
 */
export async function fsyncProfileTree(
  root: string,
  options: { readonly skipDependencies?: boolean } = {},
): Promise<ProfileTreeCounts> {
  const files: string[] = [];
  const directories: string[] = [];
  let bytes = 0;
  const dependencyRoot = options.skipDependencies ? join(root, "node_modules") : undefined;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (path === dependencyRoot) continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        files.push(path);
        bytes += stat.size;
      }
      else if (!stat.isSymbolicLink()) throw new Error(`Profile contains special file: ${relative(root, path)}`);
    }
    directories.push(dir);
  };
  visit(root);
  // Files are flushed concurrently because their order carries no meaning; the only
  // requirement is that every one of them is durable before the caller renames the tree,
  // which awaiting the whole set here provides. A file that fails to flush still rejects,
  // so a partial flush cannot be mistaken for a published generation.
  await inBoundedParallel(files, fsyncFile);
  // Directories stay serial and in the existing deepest-first order. They cost
  // milliseconds, so there is nothing to win here and a durability ordering to keep.
  for (const dir of directories) fsyncPath(dir);
  return { files: files.length, directories: directories.length, bytes };
}

export function readTargetMarker(markerPath: string): ProductProfileId | null {
  if (!pathExists(markerPath)) return null;
  const markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("target marker must be a regular file");
  const parsed = parseJsonFile(markerPath, "target marker");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("target marker must be an object");
  const marker = parsed as Record<string, unknown>;
  if (Object.keys(marker).sort().join(",") !== "schema_version,target_profile" || marker.schema_version !== 1) {
    throw new Error("target marker has an invalid shape");
  }
  return ProductProfileIdSchema.parse(marker.target_profile);
}

export function writeTargetMarker(markerPath: string, targetProfile: ProductProfileId): void {
  mkdirSync(dirname(markerPath), { recursive: true });
  const temporary = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, JSON.stringify({ schema_version: 1, target_profile: targetProfile }));
    fsyncPath(temporary);
    renameSync(temporary, markerPath);
    fsyncPath(dirname(markerPath));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function validateIfPresent(path: string, expectedProfile?: ProductProfileId): ProductProfileDescriptor | null {
  return pathExists(path) ? validateProfileDeployment(path, expectedProfile) : null;
}

export async function publishPreparedProfile(input: {
  readonly layout: ProfileDeploymentLayout;
  readonly targetProfile: ProductProfileId;
  readonly injectCrashAfter?: PublicationCrashPoint;
  /**
   * Single-use generations only, and only for a `next` this process just prepared; see
   * `fsyncProfileTree` and `validateProfileDeployment` for what it gives up.
   */
  readonly skipDependencies?: boolean;
}): Promise<void> {
  const { layout, targetProfile } = input;
  validateProfileDeployment(layout.next, targetProfile, { skipDependencies: input.skipDependencies });
  validateIfPresent(layout.live);
  if (pathExists(layout.backup)) throw new Error("Cannot publish while backup exists");
  await publicationAsyncStep(
    "flush_next",
    () => fsyncProfileTree(layout.next, { skipDependencies: input.skipDependencies }),
    { metrics: (counts) => counts },
  );
  const markerTarget = readTargetMarker(layout.marker);
  if (markerTarget !== null && markerTarget !== targetProfile) throw new Error("Target marker conflicts with bootstrap target");
  if (markerTarget === null) writeTargetMarker(layout.marker, targetProfile);
  if (pathExists(layout.live)) {
    publicationStep("rename_live_backup", () => renamePublicationDirectory(layout.live, layout.backup, { diagnosticStage: "rename_live_backup" }), { paths: { source: layout.live, destination: layout.backup } });
    fsyncPath(layout.configRoot);
    if (input.injectCrashAfter === "live_to_backup") throw new Error("injected crash after live_to_backup");
  }
  publicationStep("rename_next_live", () => renamePublicationDirectory(layout.next, layout.live, { diagnosticStage: "rename_next_live" }), { paths: { source: layout.next, destination: layout.live } });
  fsyncPath(layout.configRoot);
  if (input.injectCrashAfter === "next_to_live") throw new Error("injected crash after next_to_live");
}

export type TopologyRecoveryResult = "clean-first-boot" | "stable" | "published" | "awaiting-proof";

export async function recoverProfileTopology(input: {
  readonly layout: ProfileDeploymentLayout;
  readonly bootstrapTarget: ProductProfileId;
}): Promise<TopologyRecoveryResult> {
  const { layout, bootstrapTarget } = input;
  const markerTarget = readTargetMarker(layout.marker);
  const hasLive = pathExists(layout.live);
  const hasNext = pathExists(layout.next);
  const hasBackup = pathExists(layout.backup);

  if (markerTarget === null) {
    if (!hasLive && !hasNext && !hasBackup) return "clean-first-boot";
    if (hasLive && !hasBackup) {
      validateProfileDeployment(layout.live, bootstrapTarget);
      if (hasNext) rmSync(layout.next, { recursive: true, force: true });
      return "stable";
    }
    throw new Error("Profile topology is indeterminate without a target marker");
  }
  if (markerTarget !== bootstrapTarget) throw new Error("Target marker conflicts with bootstrap target");

  validateIfPresent(layout.live, hasNext ? undefined : markerTarget);
  validateIfPresent(layout.next, markerTarget);
  validateIfPresent(layout.backup);

  if (hasLive && hasNext && !hasBackup) {
    await publishPreparedProfile({ layout, targetProfile: markerTarget });
    return "published";
  }
  if (!hasLive && hasNext && !hasBackup) {
    await fsyncProfileTree(layout.next);
    publicationStep("recover_next_live", () => renameSync(layout.next, layout.live), { paths: { source: layout.next, destination: layout.live } });
    fsyncPath(layout.configRoot);
    return "published";
  }
  if (!hasLive && hasNext && hasBackup) {
    publicationStep("recover_backup_live", () => renameSync(layout.backup, layout.live), { paths: { source: layout.backup, destination: layout.live } });
    fsyncPath(layout.configRoot);
    await publishPreparedProfile({ layout, targetProfile: markerTarget });
    return "published";
  }
  if (hasLive && !hasNext) return "awaiting-proof";
  throw new Error("Profile topology is indeterminate with a target marker");
}

export function readLiveProfileDescriptor(live: string): ProductProfileDescriptor | null {
  if (!pathExists(live) || !pathExists(join(live, "profile.json"))) return null;
  return validateProfileDeployment(live);
}

export function beginProfileTransition(layout: ProfileDeploymentLayout, targetProfile: ProductProfileId): void {
  const markerTarget = readTargetMarker(layout.marker);
  if (markerTarget !== null && markerTarget !== targetProfile) throw new Error("Target marker conflicts with desired target");
  if (markerTarget === null) writeTargetMarker(layout.marker, targetProfile);
}

export async function reconcileProfileInPlace(input: {
  readonly source: string;
  readonly layout: ProfileDeploymentLayout;
  readonly targetProfile: ProductProfileId;
  readonly runtimeScaffoldRoot?: string;
  /**
   * Single-use generations only; see `fsyncProfileTree` and `validateProfileDeployment`.
   * Topology recovery always flushes and walks fully.
   */
  readonly skipDependencies?: boolean;
}): Promise<{
  readonly descriptor: ProductProfileDescriptor;
  /** Whether this call copied `live` itself, rather than publishing a recovered topology. */
  readonly copied: boolean;
}> {
  if (readTargetMarker(input.layout.marker) !== input.targetProfile) {
    throw new Error("Profile transition marker is not committed for the desired target");
  }
  if (pathExists(input.layout.live) && !pathExists(join(input.layout.live, "profile.json"))) {
    publicationStep("remove_empty_live", () => rmSync(input.layout.live, { recursive: true, force: true }));
    fsyncPath(input.layout.configRoot);
  }
  const recovering = pathExists(input.layout.next) || pathExists(input.layout.backup);
  if (recovering) {
    await recoverProfileTopology({ layout: input.layout, bootstrapTarget: input.targetProfile });
  } else {
    await prepareProfileNext({
      source: input.source,
      runtimeScaffoldRoot: input.runtimeScaffoldRoot ?? "/opt/opencode-deps",
      layout: input.layout,
      targetProfile: input.targetProfile,
      skipDependencies: input.skipDependencies,
    });
    await publishPreparedProfile({
      layout: input.layout,
      targetProfile: input.targetProfile,
      skipDependencies: input.skipDependencies,
    });
  }
  const descriptor = validateProfileDeployment(input.layout.live, input.targetProfile, {
    skipDependencies: !recovering && input.skipDependencies,
  });
  return { descriptor, copied: !recovering };
}

export function completeProfileTransition(layout: ProfileDeploymentLayout, targetProfile: ProductProfileId): void {
  if (readTargetMarker(layout.marker) !== targetProfile) throw new Error("Profile transition marker does not match target");
  validateProfileDeployment(layout.live, targetProfile);
  rmSync(layout.backup, { recursive: true, force: true });
  fsyncPath(layout.configRoot);
  rmSync(layout.marker, { force: true });
  fsyncPath(dirname(layout.marker));
}

export async function beginAndReconcileProfileDeployment(input: {
  readonly sourceRoot: string;
  readonly configRoot: string;
  readonly marker: string;
  readonly targetProfile: string | undefined;
  readonly runtimeScaffoldRoot: string;
}): Promise<{
  readonly layout: ProfileDeploymentLayout;
  readonly targetProfile: ProductProfileId;
  readonly descriptor: ProductProfileDescriptor;
}> {
  const targetProfile = ProductProfileIdSchema.parse(input.targetProfile?.trim() || "lite");
  const layout = profileDeploymentLayout(input.configRoot, input.marker);
  const source = join(input.sourceRoot, targetProfile);
  const descriptor = validateProfileDirectory(source, targetProfile);
  const inheritedTarget = readTargetMarker(layout.marker);
  beginProfileTransition(layout, targetProfile);
  if (inheritedTarget !== null || !profileDeploymentMatchesSource({
    source,
    live: layout.live,
    targetProfile,
  })) {
    await reconcileProfileInPlace({
      source,
      layout,
      targetProfile,
      runtimeScaffoldRoot: input.runtimeScaffoldRoot,
    });
  }
  return { layout, targetProfile, descriptor };
}
