import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  RuntimeDeploymentSpecSchema,
  RuntimeGenerationPublishedSchema,
  RuntimeSupervisorReadySchema,
  RuntimeInstanceIdSchema,
  RuntimeLaunchAttemptIdSchema,
  type RuntimeDeploymentSpec,
  type RuntimeInstanceEvidence,
  type RuntimeSupervisorReady,
  Sha256Schema,
  type ProductProfileDescriptor,
  type ProductProfileId,
} from "@different-ai/openwork-contracts/capability";
import {
  beginProfileTransition,
  fsyncProfileTree,
  profileDeploymentMatchesSource,
  profileDeploymentLayout,
  readTargetMarker,
  reconcileProfileInPlace,
  validateProfileDirectory,
  validateProfileDeployment,
  type ProfileDeploymentLayout,
} from "./profile-deployment.js";
import { fileConcurrency } from "./bounded-parallel.js";
import { publicationAsyncStep, publicationContext, publicationDiagnostic, publicationStep } from "./publication-diagnostics.js";

type ApplyingEvidence = Extract<RuntimeInstanceEvidence, { readonly status: "applying" }>;
export type InternalRuntimeInstanceEvidence = ApplyingEvidence | RuntimeSupervisorReady;

export interface RuntimeGenerationLayout {
  readonly root: string;
  readonly opencode: string;
  readonly publicationMarker: string;
}

const IGNORED_PROFILE_DIRECTORY_NAMES = new Set([".venv", "__pycache__"]);

function isIgnoredProfileEntry(entry: { readonly name: string; isDirectory(): boolean; isFile(): boolean }): boolean {
  return (entry.isDirectory() && IGNORED_PROFILE_DIRECTORY_NAMES.has(entry.name))
    || (entry.isFile() && (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")));
}

function decodeBase64Json(encoded: string | undefined, environmentVariable: string): unknown {
  if (!encoded) throw new Error(`${environmentVariable} is required`);
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      throw new Error("invalid base64");
    }
    return JSON.parse(decoded.toString("utf8"));
  } catch (error) {
    throw new Error(`${environmentVariable} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseRuntimeDeploymentB64(encoded: string | undefined): RuntimeDeploymentSpec {
  return RuntimeDeploymentSpecSchema.parse(decodeBase64Json(encoded, "SUPERCLAW_RUNTIME_DEPLOYMENT_B64"));
}

export function parseRuntimeInstanceIdentity(input: {
  readonly desiredFingerprint: string | undefined;
  readonly instanceId: string | undefined;
  readonly launchAttemptId: string | undefined;
}): { readonly desiredFingerprint: string; readonly instanceId: string; readonly launchAttemptId: string } {
  return {
    desiredFingerprint: Sha256Schema.parse(input.desiredFingerprint),
    instanceId: RuntimeInstanceIdSchema.parse(input.instanceId),
    launchAttemptId: RuntimeLaunchAttemptIdSchema.parse(input.launchAttemptId),
  };
}

export function runtimeGenerationLayout(instanceId: string, runtimeRoot = "/run/superclaw/runtime"): RuntimeGenerationLayout {
  const safeInstanceId = RuntimeInstanceIdSchema.parse(instanceId);
  const root = join(runtimeRoot, safeInstanceId);
  return { root, opencode: join(root, "opencode"), publicationMarker: join(root, "profile-publication.json") };
}

interface ProfileDigestFile {
  readonly kind: "file";
  readonly relativePath: string;
  readonly path: string;
  /** The file object the walk saw: `dev` and `ino` exceed 2^53 on NTFS, hence bigint. */
  readonly identity: BigIntStats;
}

type ProfileDigestEntry = { readonly kind: "directory"; readonly relativePath: string } | ProfileDigestFile;

/** Every entry the digest covers, in digest order. */
function productProfileDigestEntries(root: string): ProfileDigestEntry[] {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Product Profile root must be a regular directory");
  const entries: ProfileDigestEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    const children = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of children) {
      if (isIgnoredProfileEntry(entry)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      requireDigestableEntry(stat, relativePath);
      if (stat.isDirectory()) {
        entries.push({ kind: "directory", relativePath });
        visit(path, relativePath);
      } else {
        entries.push({ kind: "file", relativePath, path, identity: stat });
      }
    }
  };
  visit(root, "");
  return entries;
}

function requireDigestableEntry(stat: BigIntStats, relativePath: string): void {
  if (stat.isSymbolicLink()) throw new Error(`Product Profile digest rejects symlink: ${relativePath}`);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Product Profile digest rejects special entry: ${relativePath}`);
}

/**
 * Refuse a file whose name was re-pointed after the walk.
 *
 * The walk only names files; each is read later. Right before the read the name is re-checked
 * exactly as the walk checked it, and the opened handle must be the very file object the walk
 * saw - same volume, file id and size - so a link, a junction on an ancestor, or a replacement
 * planted in between is refused rather than followed.
 */
function requireWalkedFile(file: ProfileDigestFile, current: BigIntStats, opened: BigIntStats): void {
  if (!current.isFile() || !opened.isFile() || opened.dev !== file.identity.dev
    || opened.ino !== file.identity.ino || opened.size !== file.identity.size) {
    throw new Error(`Product Profile digest entry changed after the walk: ${file.relativePath}`);
  }
}

function readWalkedFileSync(file: ProfileDigestFile): Buffer {
  const current = lstatSync(file.path, { bigint: true });
  requireDigestableEntry(current, file.relativePath);
  const fd = openSync(file.path, "r");
  try {
    requireWalkedFile(file, current, fstatSync(fd, { bigint: true }));
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function readWalkedFile(file: ProfileDigestFile): Promise<Buffer> {
  const current = lstatSync(file.path, { bigint: true });
  requireDigestableEntry(current, file.relativePath);
  const handle = await open(file.path, "r");
  try {
    requireWalkedFile(file, current, await handle.stat({ bigint: true }));
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Return `promise` for a caller that awaits it later, keeping a rejection that lands before
 * then from being reported as unhandled. The rejection still reaches that caller.
 */
function awaitedLater<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

function productProfileDigestHasher(started: number): {
  readonly add: (entry: ProfileDigestEntry, content?: Buffer) => void;
  readonly finish: () => string;
} {
  const digest = createHash("sha256");
  let files = 0;
  let bytes = 0;
  return {
    add: (entry, content) => {
      if (entry.kind === "directory") {
        digest.update("directory\0").update(entry.relativePath).update("\0");
        return;
      }
      if (content === undefined) throw new Error(`Product Profile digest has no content for: ${entry.relativePath}`);
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(content.length));
      digest.update("file\0").update(entry.relativePath).update("\0").update(size).update(content);
      files += 1;
      bytes += content.length;
    },
    finish: () => {
      // This reads every Profile file whole, so its duration is only readable against bytes.
      publicationDiagnostic("profile_digest_walk", "observed", {
        elapsed_ms: Math.round(performance.now() - started), files, bytes,
      });
      return digest.digest("hex");
    },
  };
}

export function computeProductProfileDigest(root: string): string {
  const hasher = productProfileDigestHasher(performance.now());
  for (const entry of productProfileDigestEntries(root)) {
    hasher.add(entry, entry.kind === "file" ? readWalkedFileSync(entry) : undefined);
  }
  return hasher.finish();
}

/**
 * `computeProductProfileDigest`, reading up to `fileConcurrency()` files ahead of the hash.
 *
 * Sandbox Manager rewrites the Profile source before every start, so publication is the first
 * reader of every file and pays on-access scanning for each one; that latency, not hashing, is
 * the cost (see `fileConcurrency`). Files are still hashed strictly in walk order, each buffer
 * is dropped once hashed, and no read starts more than the window ahead of the hash, so at most
 * that many files are held at once. On failure, reads already started settle before it throws.
 *
 * `beforeRead` runs just before each file's re-check; tests use it to re-point a name.
 */
export async function computeProductProfileDigestConcurrently(
  root: string,
  options: {
    readonly parallelism?: number;
    readonly beforeRead?: (relativePath: string) => Promise<void> | void;
  } = {},
): Promise<string> {
  const hasher = productProfileDigestHasher(performance.now());
  const entries = productProfileDigestEntries(root);
  const files = entries.flatMap((entry) => (entry.kind === "file" ? [entry] : []));
  const window = fileConcurrency(options.parallelism);
  const reads: Array<Promise<Buffer> | undefined> = [];
  let started = 0;
  const readAhead = (hashed: number): void => {
    for (; started < files.length && started < hashed + window; started += 1) {
      const file = files[started] as ProfileDigestFile;
      reads[started] = awaitedLater((async () => {
        await options.beforeRead?.(file.relativePath);
        return readWalkedFile(file);
      })());
    }
  };
  let hashed = 0;
  try {
    for (const entry of entries) {
      if (entry.kind === "directory") {
        hasher.add(entry);
        continue;
      }
      readAhead(hashed);
      const content = await reads[hashed];
      reads[hashed] = undefined;
      hashed += 1;
      hasher.add(entry, content);
    }
  } catch (error) {
    await Promise.allSettled(reads.filter((read): read is Promise<Buffer> => read !== undefined));
    throw error;
  }
  return hasher.finish();
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
  } finally { closeSync(fd); }
}

// On Windows a rename fails while another process holds the destination open without
// FILE_SHARE_DELETE (Sandbox Manager reading the evidence) or still holds the new file (a scanner).
// Both last milliseconds, so the rename is retried for about 1.5 s before the write fails (#3928).
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface AtomicWriteIo {
  readonly rename: (from: string, to: string) => void;
  readonly sleep: (ms: number) => void;
  readonly log: (line: string) => void;
}

const defaultAtomicWriteIo: AtomicWriteIo = {
  rename: renameSync,
  sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  log: (line) => { console.error(line); },
};

function renameWithRetry(from: string, to: string, io: AtomicWriteIo): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.rename(from, to);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      io.log(`[openwork-orchestrator] Atomic write rename retry file=${basename(to)} attempt=${attempt + 1} code=${code} delay_ms=${delayMs}`);
      io.sleep(delayMs);
    }
  }
}

export function writeJsonAtomic(path: string, value: unknown, io: AtomicWriteIo = defaultAtomicWriteIo): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fsyncPath(temporary);
    renameWithRetry(temporary, path, io);
    fsyncPath(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

export class RuntimeDeploymentState {
  private evidence: InternalRuntimeInstanceEvidence;

  constructor(
    deployment: RuntimeDeploymentSpec,
    identity: { readonly desiredFingerprint: string; readonly instanceId: string; readonly launchAttemptId: string },
    private readonly evidencePath: string,
  ) {
    this.evidence = {
      schema_version: 1,
      status: "applying",
      deployment_id: deployment.deployment_id,
      desired_fingerprint: identity.desiredFingerprint,
      runtime_instance_id: identity.instanceId,
      launch_attempt_id: identity.launchAttemptId,
      product_profile_id: deployment.product_profile_id,
      product_profile_digest: deployment.product_profile_digest,
      profile_revision: deployment.profile_revision,
    };
    this.publishEvidence();
  }

  currentEvidence(): InternalRuntimeInstanceEvidence { return this.evidence; }

  markReady(input: {
    readonly components: { readonly opencode: boolean; readonly openwork: boolean };
    readonly intentClassifierMode: "enabled" | "bypass";
    readonly hybridDrStatus: "healthy" | "absent";
  }): void {
    this.evidence = {
      ...this.evidence,
      status: "ready",
      runtime_ready: true,
      components: input.components,
      intent_classifier: { mode: input.intentClassifierMode },
      hybrid_dr: { status: input.hybridDrStatus },
    };
    this.publishEvidence();
  }

  private publishEvidence(): void {
    if (this.evidence.status === "ready") RuntimeSupervisorReadySchema.parse(this.evidence);
    writeJsonAtomic(this.evidencePath, this.evidence);
  }
}

export interface RuntimeDeploymentBootstrap {
  readonly state: RuntimeDeploymentState;
  readonly profileLayout: ProfileDeploymentLayout;
  readonly profileTarget: ProductProfileId;
  readonly profileDescriptor: ProductProfileDescriptor;
  readonly capabilityBarrierCompletedAt: number;
}

export async function bootstrapRuntimeDeployment(input: {
  readonly opencodeConfigDir: string;
  readonly productProfileSourceRoot: string;
  readonly runtimeScaffoldRoot: string;
  readonly runtimeConfigDir: string;
  readonly runtimeGenerationRoot?: string;
  readonly deploymentB64: string | undefined;
  readonly desiredFingerprint: string | undefined;
  readonly instanceId: string | undefined;
  readonly launchAttemptId: string | undefined;
  readonly prepareRuntime: () => Promise<void>;
  readonly finalizeConfig?: () => Promise<void>;
}): Promise<RuntimeDeploymentBootstrap> {
  const deployment = parseRuntimeDeploymentB64(input.deploymentB64);
  const identity = parseRuntimeInstanceIdentity(input);
  return publicationContext(identity.instanceId, identity.launchAttemptId, async () => {
    const generation = runtimeGenerationLayout(identity.instanceId, input.runtimeGenerationRoot);
    if (resolve(input.opencodeConfigDir) !== resolve(generation.opencode)) {
      throw new Error("OPENCODE_CONFIG_DIR must match the Runtime generation config directory");
    }
    const profileLayout = profileDeploymentLayout(dirname(input.opencodeConfigDir), generation.publicationMarker);
    const publishedPath = join(generation.root, "generation-published.json");
    // An interrupted retry must not leave a previous completion visible during preparation.
    publicationStep("clear_previous_receipt", () => rmSync(publishedPath, { force: true }));
    const profileTarget = deployment.product_profile_id;
    const inheritedTarget = publicationStep("read_transition", () => readTargetMarker(profileLayout.marker));
    publicationStep("begin_transition", () => beginProfileTransition(profileLayout, profileTarget));
    const capabilityBarrierCompletedAt = Date.now();
    await publicationAsyncStep("prepare_runtime", () => input.prepareRuntime());
    const source = join(input.productProfileSourceRoot, profileTarget);
    const profileDescriptor = publicationStep("validate_profile", () => validateProfileDirectory(source, profileTarget));
    await publicationAsyncStep("profile_digest", async () => {
      const packagedProfileDigest = await computeProductProfileDigestConcurrently(source);
      if (packagedProfileDigest !== deployment.product_profile_digest) {
        throw new Error(`Product Profile digest mismatch: expected ${deployment.product_profile_digest}, found ${packagedProfileDigest}`);
      }
    });
    // This generation is single-use (fresh instance id per launch), so both flushes below, and the
    // walks of a tree copied here, leave its dependency tree alone. See `fsyncProfileTree` and
    // `validateProfileDeployment` for what that gives up.
    const skipDependencies = true;
    const state = publicationStep("write_applying", () => new RuntimeDeploymentState(
      deployment,
      identity,
      join(input.runtimeConfigDir, "runtime-instance-evidence.json"),
    ));
    // The live check below may stop at the dependency tree only if this process copied it, which
    // only `reconcileProfileInPlace` can say: it does not copy when it has a topology to recover.
    let copiedHere = false;
    if (publicationStep("match_profile", () => inheritedTarget !== null || !profileDeploymentMatchesSource({
      source,
      live: profileLayout.live,
      targetProfile: profileTarget,
    }))) {
      const reconciled = await publicationAsyncStep("reconcile_profile", () => reconcileProfileInPlace({
        source,
        layout: profileLayout,
        targetProfile: profileTarget,
        runtimeScaffoldRoot: input.runtimeScaffoldRoot,
        skipDependencies,
      }));
      copiedHere = reconciled.copied;
    }
    await publicationAsyncStep("finalize_config", async () => input.finalizeConfig?.());
    publicationStep("validate_live", () => validateProfileDeployment(profileLayout.live, profileTarget, {
      skipDependencies: copiedHere && skipDependencies,
    }));
    await publicationAsyncStep(
      "flush_live",
      () => fsyncProfileTree(profileLayout.live, { skipDependencies }),
      { metrics: (counts) => counts },
    );
    publicationStep("publish_receipt", () => writeJsonAtomic(publishedPath, RuntimeGenerationPublishedSchema.parse({
      ...state.currentEvidence(),
      status: "published",
    })));
    return { state, profileLayout, profileTarget, profileDescriptor, capabilityBarrierCompletedAt };
  });
}
