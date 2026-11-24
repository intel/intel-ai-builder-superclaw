import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const hasFlag = (name) => process.argv.slice(2).includes(name);
const forceBuild = hasFlag("--force") || process.env.OPENWORK_SIDECAR_FORCE_BUILD === "1";
const sidecarOverride = process.env.OPENWORK_SIDECAR_DIR?.trim() || readArg("--outdir");
const sidecarDir = sidecarOverride ? resolve(sidecarOverride) : join(__dirname, "..", "src-tauri", "sidecars");
const repoRoot = resolve(__dirname, "..", "..", "..");
const packageJsonPath = resolve(__dirname, "..", "package.json");
const runtimePackageJsonPath = resolve(repoRoot, "sandbox", "orchestrator", "package.json");

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const desktopPkg = readJsonFile(packageJsonPath);
const runtimePkg = readJsonFile(runtimePackageJsonPath);

const opencodeVersion = (() => {
  if (process.env.OPENCODE_VERSION?.trim()) return process.env.OPENCODE_VERSION.trim();
  if (desktopPkg?.opencodeVersion) return String(desktopPkg.opencodeVersion).trim();
  if (runtimePkg?.opencodeVersion) return String(runtimePkg.opencodeVersion).trim();
  return null;
})();

const opencodePatchesDir = resolve(repoRoot, "patches", "opencode");
const opencodeLockPath = resolve(repoRoot, "patches", "upstream.lock.json");
const opencodeLock = readJsonFile(opencodeLockPath)?.opencode ?? null;

// The fingerprint is the git tree hash of the patched source (patched_tree in
// upstream.lock.json), not a commit SHA - it changes whenever the pinned
// upstream commit OR the patch content changes, and (unlike hashing just the
// patch file's bytes) it also catches a corrupted/mis-applied checkout, since
// it validates the *result* of applying the patch, not just the patch itself.
const runtimeRefSlug = opencodeLock?.patched_tree ? opencodeLock.patched_tree.slice(0, 12) : "default";
const runtimeCheckoutDir = resolve(repoRoot, ".cache", "opencode-src", runtimeRefSlug);
const runtimeOpencodeDir = resolve(runtimeCheckoutDir, "packages", "opencode");
const runtimeOpencodeDistDir = resolve(runtimeOpencodeDir, "dist");

const normalizeVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "latest") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
};
const opencodeRouterVersion = (() => {
  if (process.env.OPENCODE_ROUTER_VERSION?.trim()) return process.env.OPENCODE_ROUTER_VERSION.trim();
  if (desktopPkg?.opencodeRouterVersion) return String(desktopPkg.opencodeRouterVersion).trim();
  return null;
})();
const VALID_TARGET_TRIPLES = Object.assign(Object.create(null), {
  "aarch64-apple-darwin": "aarch64-apple-darwin",
  "x86_64-apple-darwin": "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu": "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu": "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc": "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc": "aarch64-pc-windows-msvc",
});

// Target triple for native platform binaries
const resolvedTargetTriple = (() => {
  const envTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (envTarget) {
    const safe = VALID_TARGET_TRIPLES[envTarget.trim()];
    if (safe) return safe;
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
})();

const bunTarget = (() => {
  switch (resolvedTargetTriple) {
    case "aarch64-apple-darwin":
      return "bun-darwin-arm64";
    case "x86_64-apple-darwin":
      return "bun-darwin-x64-baseline";
    case "aarch64-unknown-linux-gnu":
      return "bun-linux-arm64";
    case "x86_64-unknown-linux-gnu":
      return "bun-linux-x64-baseline";
    // Windows baseline artifacts intermittently fail to extract in CI
    // with Bun 1.3.6. Use the stable x64 target here for now.
    case "x86_64-pc-windows-msvc":
      return "bun-windows-x64";
    default:
      return null;
  }
})();

const opencodeBaseName = process.platform === "win32" ? "opencode.exe" : "opencode";
const opencodePath = join(sidecarDir, opencodeBaseName);
const opencodeTargetName = resolvedTargetTriple
  ? `opencode-${resolvedTargetTriple}${process.platform === "win32" ? ".exe" : ""}`
  : null;
const opencodeTargetPath = opencodeTargetName ? join(sidecarDir, opencodeTargetName) : null;

const opencodeCandidatePath = opencodeTargetPath ?? opencodePath;
const opencodeStampPath = opencodeCandidatePath ? `${opencodeCandidatePath}.head` : null;
let existingOpencodeVersion = null;

// openwork-server paths
const openworkServerBaseName = "openwork-server";
const openworkServerName = process.platform === "win32" ? `${openworkServerBaseName}.exe` : openworkServerBaseName;
const openworkServerPath = join(sidecarDir, openworkServerName);
const openworkServerBuildName = bunTarget
  ? `${openworkServerBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : openworkServerName;
const openworkServerBuildPath = join(sidecarDir, openworkServerBuildName);
const openworkServerTargetTriple = resolvedTargetTriple;
const openworkServerTargetName = openworkServerTargetTriple
  ? `${openworkServerBaseName}-${openworkServerTargetTriple}${openworkServerTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const openworkServerTargetPath = openworkServerTargetName ? join(sidecarDir, openworkServerTargetName) : null;

const openworkServerDir = resolve(__dirname, "..", "..", "..", "sandbox", "server");

const resolveBuildScript = (dir) => {
  const scriptPath = resolve(dir, "script", "build.ts");
  if (existsSync(scriptPath)) return scriptPath;
  const scriptsPath = resolve(dir, "scripts", "build.ts");
  if (existsSync(scriptsPath)) return scriptsPath;
  return scriptPath;
};

const buildContracts = () => {
  const contractsDir = resolve(__dirname, "..", "..", "..", "shared", "contracts");
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpmCommand, ["--dir", contractsDir, "run", "build"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

// The openwork-server and opencode-router sidecars import its built dist/.
const buildMcpPolicy = () => {
  const mcpPolicyDir = resolve(__dirname, "..", "..", "..", "shared", "mcp-policy");
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpmCommand, ["--dir", mcpPolicyDir, "run", "build"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

// opencode-router paths
const opencodeRouterBaseName = "opencode-router";
const opencodeRouterName = process.platform === "win32" ? `${opencodeRouterBaseName}.exe` : opencodeRouterBaseName;
const opencodeRouterPath = join(sidecarDir, opencodeRouterName);
const opencodeRouterBuildName = bunTarget
  ? `${opencodeRouterBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : opencodeRouterName;
const opencodeRouterBuildPath = join(sidecarDir, opencodeRouterBuildName);
const opencodeRouterTargetTriple = resolvedTargetTriple;
const opencodeRouterTargetName = opencodeRouterTargetTriple
  ? `${opencodeRouterBaseName}-${opencodeRouterTargetTriple}${opencodeRouterTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const opencodeRouterTargetPath = opencodeRouterTargetName ? join(sidecarDir, opencodeRouterTargetName) : null;
const opencodeRouterDir = resolve(__dirname, "..", "..", "..", "sandbox", "channels");

// orchestrator paths
const orchestratorBaseName = "openwork-orchestrator";
const orchestratorName =
  process.platform === "win32" ? `${orchestratorBaseName}.exe` : orchestratorBaseName;
const orchestratorPath = join(sidecarDir, orchestratorName);
const orchestratorBuildName = bunTarget
  ? `${orchestratorBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : orchestratorName;
const orchestratorBuildPath = join(sidecarDir, orchestratorBuildName);
const orchestratorTargetTriple = resolvedTargetTriple;
const orchestratorTargetName = orchestratorTargetTriple
  ? `${orchestratorBaseName}-${orchestratorTargetTriple}${orchestratorTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const orchestratorTargetPath = orchestratorTargetName ? join(sidecarDir, orchestratorTargetName) : null;
const orchestratorDir = resolve(__dirname, "..", "..", "..", "sandbox", "orchestrator");

// Pre-built ordered allowlist of every sidecar path this script may inspect.
const _allSidecarPaths = [
  openworkServerPath,
  openworkServerBuildPath,
  openworkServerTargetPath,
  opencodePath,
  opencodeTargetPath,
  opencodeCandidatePath,
  opencodeRouterPath,
  opencodeRouterBuildPath,
  opencodeRouterTargetPath,
  orchestratorPath,
  orchestratorBuildPath,
  orchestratorTargetPath,
].filter(Boolean);

/**
 * Return the pre-computed sidecar path constant that exactly equals `filePath`, or `null` if no match is found
 */
const confinedSidecarPath = (filePath) => {
  if (typeof filePath !== "string" || !filePath) return null;
  return _allSidecarPaths.find((p) => p === filePath) ?? null;
};

const readHeader = (filePath, length = 256) => {
  // Confine to sidecarDir before touching any OS file API.
  const safe = confinedSidecarPath(filePath);
  if (!safe) return "";
  const fd = openSync(safe, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const safe = confinedSidecarPath(filePath);
    if (!safe) return true;
    const stat = statSync(safe);
    if (!stat.isFile()) return true;
    if (stat.size < 1024) return true;
    const header = readHeader(safe);
    if (header.startsWith("#!")) return true;
    if (header.includes("Sidecar missing") || header.includes("Bun is required")) return true;
  } catch {
    return true;
  }
  return false;
};


const _authorizedScanRoots = new Set();

const readStamp = (filePath) => {
  try {
    return readFileSync(filePath, "utf8").trim() || null;
  } catch {
    return null;
  }
};

const runChecked = (command, args, options, failureMessage) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    console.error(failureMessage ?? `Command failed: ${command} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
};

const runCapture = (command, args, options) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout ?? "").trim() || null;
};

// git.exe is a real executable (never a .cmd/.bat PATH shim like bun/pnpm can
// be), so it never needs shell:true - and on Windows, shell:true routes the
// call through cmd.exe, which re-splits a quoted multi-word argument (e.g. a
// commit message) on spaces and strips `^` (its own escape character, as in
// `HEAD^{tree}`) before git ever sees the argument. Force shell:false here
// regardless of the generic helpers' Windows default.
const runGitChecked = (args, options, failureMessage) =>
  runChecked("git", args, { ...options, shell: false }, failureMessage);
const runGitCapture = (args, options) => runCapture("git", args, { ...options, shell: false });

// runGitCapture/runCapture return null for both "command succeeded with empty
// output" (a genuinely clean `git status --porcelain`) and "command failed" -
// a caller checking truthiness alone cannot tell them apart, so a failed
// status check (e.g. a concurrent process holding .git/index.lock) would be
// silently accepted as "clean". Return a non-empty sentinel on failure so it
// always reads as "not clean" instead.
const runGitStatusPorcelain = (dir) => {
  const result = spawnSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) return "unreadable (git status failed)";
  return String(result.stdout ?? "").trim();
};

/**
 * Safely remove a directory, handling Windows MAX_PATH limitations.
 * On Windows, uses PowerShell's Remove-Item which can handle very long paths.
 * Falls back to rmSync on non-Windows platforms.
 */
const safeRemoveDirectory = (dirPath) => {
  if (!existsSync(dirPath)) return;

  try {
    if (process.platform === "win32") {
      // Use PowerShell to handle Windows MAX_PATH issues
      const result = spawnSync("powershell", [
        "-Command",
        `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "${dirPath.replace(/"/g, '`"')}"`,
      ]);
      if (result.status !== 0) {
        console.warn(`Warning: PowerShell cleanup failed for ${dirPath}, trying rmSync`);
        rmSync(dirPath, { recursive: true, force: true });
      }
    } else {
      rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`Warning: Failed to clean directory ${dirPath}: ${err.message}`);
  }
};

// JS port of scripts/patches/opencode-verify-lock.ps1 - kept as a separate
// implementation (not a shared module) per this file's existing convention of
// mirroring the PowerShell side rather than sharing code with it. Needs no
// third_party/opencode init: reads the pin out of the git index, not a
// checkout.
const verifyOpencodeLock = () => {
  if (!opencodeLock) {
    console.error(`${opencodeLockPath} has no 'opencode' entry`);
    process.exit(1);
  }
  for (const field of ["url", "sha", "patched_tree", "patches"]) {
    if (!opencodeLock[field]) {
      console.error(`${opencodeLockPath} is missing required field '${field}'`);
      process.exit(1);
    }
  }
  // Format checks (not identity checks - this cannot prove the URL is really
  // the legitimate upstream, only that the lock is internally well-formed;
  // identity is established once, at PR-review time, by a human).
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(opencodeLock.url)) {
    console.error(`upstream.lock.json 'url' must be a public HTTPS GitHub URL: ${opencodeLock.url}`);
    process.exit(1);
  }
  if (!/^[0-9a-f]{40}$/.test(opencodeLock.sha)) {
    console.error(`upstream.lock.json 'sha' must be a 40-character lowercase commit SHA: ${opencodeLock.sha}`);
    process.exit(1);
  }
  if (!/^[0-9a-f]{40}$/.test(opencodeLock.patched_tree)) {
    console.error(`upstream.lock.json 'patched_tree' must be a 40-character lowercase tree SHA: ${opencodeLock.patched_tree}`);
    process.exit(1);
  }

  const gitmodulesPath = resolve(repoRoot, ".gitmodules");
  const submoduleUrl = runGitCapture([
    "config", "-f", gitmodulesPath, "--get", "submodule.third_party/opencode.url",
  ]);
  if (submoduleUrl !== opencodeLock.url) {
    console.error(`third_party/opencode submodule URL is ${submoduleUrl}; lock requires ${opencodeLock.url}`);
    process.exit(1);
  }

  const indexEntry = runGitCapture(["-C", repoRoot, "ls-files", "--stage", "--", "third_party/opencode"]);
  if (!indexEntry) {
    console.error(`no index entry for third_party/opencode`);
    process.exit(1);
  }
  const [meta, path] = indexEntry.split("\t");
  const [mode, sha] = meta.trim().split(/\s+/);
  if (path !== "third_party/opencode" || mode !== "160000" || sha !== opencodeLock.sha) {
    console.error(`index entry for third_party/opencode is '${indexEntry}'; expected a 160000 gitlink at ${opencodeLock.sha}`);
    process.exit(1);
  }

  const lockedPatchNames = new Set();
  for (const patch of opencodeLock.patches) {
    if (!patch.file || !patch.sha256) {
      console.error(`a patch entry in upstream.lock.json is missing 'file' or 'sha256'`);
      process.exit(1);
    }
    lockedPatchNames.add(patch.file);
    const patchPath = resolve(opencodePatchesDir, patch.file);
    if (!existsSync(patchPath)) {
      console.error(`patch file not found: ${patchPath}`);
      process.exit(1);
    }
    // A core.autocrlf LF->CRLF round-trip is a known way for a patch file's
    // bytes (and therefore its sha256 and the fingerprint it feeds) to change
    // silently; catch it directly rather than relying solely on .gitattributes.
    if (readFileSync(patchPath, "utf8").includes("\r\n")) {
      console.error(`${patch.file} contains CRLF line endings (expected LF - see .gitattributes)`);
      process.exit(1);
    }
    const actualHash = createHash("sha256").update(readFileSync(patchPath)).digest("hex");
    if (actualHash !== patch.sha256.toLowerCase()) {
      console.error(`${patch.file} sha256 is ${actualHash}; lock requires ${patch.sha256}`);
      process.exit(1);
    }
  }
  // A patch file present on disk but not registered in the lock would be
  // silently ignored by applyOpencodePatches - catch that instead of building
  // from a source nobody has verified against a recorded sha256.
  const unlockedPatches = readdirSync(opencodePatchesDir)
    .filter((name) => name.endsWith(".patch") && !lockedPatchNames.has(name));
  if (unlockedPatches.length > 0) {
    console.error(`patch file(s) not listed in upstream.lock.json: ${unlockedPatches.join(", ")}`);
    process.exit(1);
  }

  if (opencodeLock.upstream_version && runtimePkg?.opencodeVersion &&
      String(runtimePkg.opencodeVersion) !== opencodeLock.upstream_version) {
    console.error(
      `sandbox/orchestrator/package.json::opencodeVersion is ${runtimePkg.opencodeVersion}; ` +
      `lock's upstream_version is ${opencodeLock.upstream_version}`,
    );
    process.exit(1);
  }

  const submodulePath = resolve(repoRoot, "third_party", "opencode");
  if (existsSync(resolve(submodulePath, ".git"))) {
    const actualCommit = runGitCapture(["-C", submodulePath, "rev-parse", "--verify", "HEAD"]);
    if (actualCommit !== opencodeLock.sha) {
      console.error(`initialized third_party/opencode checkout is at ${actualCommit}; lock requires ${opencodeLock.sha}`);
      process.exit(1);
    }
  }

  // Covers sha + every patch's sha256 (in lock order) + patched_tree, so the
  // freshness gate (the prebuilt-binary fast path below, and
  // fetch-runtime-bin.ps1's equivalent) reacts to any of these three
  // drifting apart, not just to patched_tree in isolation. patched_tree is
  // only ever recomputed when applyOpencodePatches actually runs (it needs
  // the submodule checked out); if a maintainer updates sha or a patch's
  // sha256 but forgets to recompute patched_tree, comparing patched_tree
  // alone would never detect the lock's own fields have drifted apart - the
  // one check that could (applyOpencodePatches' tree comparison) would never
  // even run, because this fast path would have already decided nothing
  // changed.
  const fingerprintInput = [
    opencodeLock.sha,
    ...opencodeLock.patches.map((p) => p.sha256.toLowerCase()),
    opencodeLock.patched_tree,
  ].join("\n");
  const fingerprint = createHash("sha256").update(fingerprintInput, "utf8").digest("hex");

  return { ...opencodeLock, fingerprint };
};

// JS port of scripts/patches/opencode-apply-patches.ps1. Produces (or
// reuses) `destination` with the patch applied and committed, and verifies
// the result's tree hash against lock.patched_tree before returning.
const applyOpencodePatches = (lock, destination) => {
  const submodulePath = resolve(repoRoot, "third_party", "opencode");
  if (!existsSync(resolve(submodulePath, ".git"))) {
    console.log("Initializing third_party/opencode submodule...");
    runGitChecked(
      ["-C", repoRoot, "submodule", "update", "--init", "--", "third_party/opencode"],
      undefined,
      "git submodule update --init failed for third_party/opencode",
    );
  }
  const actualCommit = runGitCapture(["-C", submodulePath, "rev-parse", "--verify", "HEAD"]);
  if (actualCommit !== lock.sha) {
    console.error(`third_party/opencode is at ${actualCommit} after init; lock requires ${lock.sha}`);
    process.exit(1);
  }
  const submoduleStatus = runGitStatusPorcelain(submodulePath);
  if (submoduleStatus) {
    console.error(`third_party/opencode worktree must be clean before applying the patch:\n${submoduleStatus}`);
    process.exit(1);
  }

  const worktreeListRaw = runGitCapture(["-C", submodulePath, "worktree", "list", "--porcelain"]) ?? "";
  const registered = worktreeListRaw
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
  const isRegistered = registered.includes(destination);

  if (existsSync(destination) && isRegistered) {
    const existingTree = runGitCapture(["-C", destination, "rev-parse", "HEAD^{tree}"]);
    const existingStatus = runGitStatusPorcelain(destination);
    // Content match alone cannot distinguish "built from the pinned base
    // commit" from "happens to have identical file content via some other
    // history" - a cache hit must also prove the same ancestry a fresh apply
    // would.
    const existingParent = runGitCapture(["-C", destination, "rev-parse", "--verify", "HEAD~1"]);
    if (existingTree === lock.patched_tree && existingParent === lock.sha && !existingStatus) {
      console.log(`OpenCode patch already applied at ${destination} (tree ${existingTree}).`);
      return destination;
    }
    if (existingStatus) {
      console.error(`Destination has local changes or an unreadable status; refusing to remove it: ${destination}`);
      process.exit(1);
    }
    console.log(`Existing worktree at ${destination} does not match the lock (tree ${existingTree}, parent ${existingParent}) - recreating.`);
    runGitChecked(["-C", submodulePath, "worktree", "remove", destination], undefined, "git worktree remove failed");
  } else if (isRegistered) {
    runGitChecked(["-C", submodulePath, "worktree", "prune"], undefined, "git worktree prune failed");
  } else if (existsSync(destination)) {
    console.error(`destination exists but is not a registered worktree of third_party/opencode: ${destination}`);
    process.exit(1);
  }

  mkdirSync(dirname(destination), { recursive: true });
  runGitChecked(["-C", submodulePath, "worktree", "add", "--detach", destination, lock.sha], undefined, "git worktree add failed");

  const worktreeHead = runGitCapture(["-C", destination, "rev-parse", "HEAD"]);
  if (worktreeHead !== lock.sha) {
    console.error(`worktree HEAD is ${worktreeHead}, expected ${lock.sha}`);
    process.exit(1);
  }

  for (const patch of lock.patches) {
    const patchPath = resolve(opencodePatchesDir, patch.file);
    runGitChecked(["-C", destination, "apply", "--index", "--whitespace=nowarn", patchPath], undefined, `git apply failed for ${patch.file}`);
  }

  runGitChecked(
    [
      "-C", destination,
      "-c", "user.name=superclaw-opencode-patch",
      "-c", "user.email=noreply@invalid",
      "commit", "--quiet", "-m", "Apply SuperClaw OpenCode patch (patches/upstream.lock.json)",
    ],
    undefined,
    "git commit failed",
  );

  // Ancestry check, not just content: a tree hash match alone cannot
  // distinguish "built from the pinned base commit" from "happens to have
  // identical file content via some other history". Exactly one commit must
  // sit on top of lock.sha, and HEAD~1 must resolve to lock.sha exactly.
  const commitsSincePin = runGitCapture(["-C", destination, "rev-list", "--count", `${lock.sha}..HEAD`]);
  if (commitsSincePin !== "1") {
    console.error(`expected exactly 1 commit on top of ${lock.sha}, found ${commitsSincePin}`);
    process.exit(1);
  }
  const parentCommit = runGitCapture(["-C", destination, "rev-parse", "--verify", "HEAD~1"]);
  if (parentCommit !== lock.sha) {
    console.error(`patch commit's parent is ${parentCommit}; expected the pinned base ${lock.sha}`);
    process.exit(1);
  }

  const actualTree = runGitCapture(["-C", destination, "rev-parse", "HEAD^{tree}"]);
  if (actualTree !== lock.patched_tree) {
    console.error(`applied tree is ${actualTree}; lock requires patched_tree ${lock.patched_tree}`);
    process.exit(1);
  }
  const finalStatus = runGitStatusPorcelain(destination);
  if (finalStatus) {
    console.error(`applied worktree is not clean after commit:\n${finalStatus}`);
    process.exit(1);
  }

  return destination;
};

const shouldUseBaselineBuild = () =>
  resolvedTargetTriple === "x86_64-apple-darwin" ||
  resolvedTargetTriple === "x86_64-unknown-linux-gnu" ||
  resolvedTargetTriple === "x86_64-pc-windows-msvc";

const buildLocalOpencodeSidecar = (expectedVersion) => {
  if (!resolvedTargetTriple || !bunTarget) {
    console.error(`No local OpenCode build target configured for ${resolvedTargetTriple ?? "unknown target"}.`);
    process.exit(1);
  }

  const buildScriptPath = resolve(runtimeOpencodeDir, "script", "build.ts");
  if (!existsSync(buildScriptPath)) {
    console.error(`OpenCode build script not found at ${buildScriptPath}`);
    process.exit(1);
  }

  // Clean ALL node_modules directories in checkout (not just root) to avoid broken symlinks.
  // Nested workspace package node_modules (packages/*/node_modules) contain symlinks pointing
  // to the root node_modules. Cleaning only root leaves dangling symlinks causing EACCES.
  const cleanAllNodeModules = () => {
    if (process.platform === "win32") {
      // PowerShell: find and delete all node_modules directories recursively
      const result = spawnSync("powershell", [
        "-Command",
        [
          `$dirs = Get-ChildItem -Path '${runtimeCheckoutDir.replace(/'/g, "''")}' -Recurse -Directory -Filter 'node_modules' -ErrorAction SilentlyContinue`,
          `| Sort-Object { $_.FullName.Length } -Descending`,
          `; foreach ($d in $dirs) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $d.FullName }`,
        ].join(" "),
      ], { stdio: "inherit" });
      if (result.status !== 0) {
        console.warn("PowerShell cleanup had issues, continuing anyway");
      }
    } else {
      // Unix: use find to delete all node_modules directories
      spawnSync("find", [runtimeCheckoutDir, "-name", "node_modules", "-type", "d", "-prune", "-exec", "rm", "-rf", "{}", "+"], { stdio: "inherit" });
    }
  };

  console.log("Cleaning all node_modules directories (including nested workspace packages)...");
  cleanAllNodeModules();

  // Also clean bun cache to ensure fresh extraction
  const bunCachePath = resolve(runtimeCheckoutDir, ".bun");
  safeRemoveDirectory(bunCachePath);

  // Clean bun.lock to ensure fresh lockfile generation
  const bunLockPath = resolve(runtimeCheckoutDir, "bun.lock");
  if (existsSync(bunLockPath)) {
    try {
      unlinkSync(bunLockPath);
    } catch (err) {
      console.warn(`Warning: Failed to clean bun.lock: ${err.message}`);
    }
  }

  // Install dependencies with retry logic for transient failures
  // Don't skip scripts - they're needed for proper package setup
  const installDependencies = () => {
    const installArgs = ["install", "--no-save"];
    
    console.log("Installing dependencies (with install scripts enabled for proper package setup)...");
    const result = spawnSync("bun", installArgs, {
      cwd: runtimeCheckoutDir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    
    // Return success even if exit code != 0, because:
    // 1. Some packages like tree-sitter may fail on Windows, but aren't critical
    // 2. Core packages should still be installed
    // 3. We'll catch actual issues during the build step
    if (result.status === 0) {
      console.log("Install succeeded");
    } else {
      console.warn("Install had issues (exit code " + result.status + "), but continuing - core packages should still be in place");
    }
  };
  
  installDependencies();

  // bun may rewrite bun.lock during install despite --no-save. Restore the
  // tracked copy so the worktree's git status stays clean afterward - a
  // lingering "D bun.lock"/"M bun.lock" would otherwise make
  // ensureRuntimeCheckout's reuse check see this worktree as permanently
  // dirty and refuse to touch it on the next invocation.
  runGitChecked(["-C", runtimeCheckoutDir, "checkout", "--", "bun.lock"], undefined, "failed to restore bun.lock after install");

  rmSync(runtimeOpencodeDistDir, { recursive: true, force: true });

  const buildArgs = ["run", "script/build.ts", "--single", "--skip-install", "--target", bunTarget];
  if (shouldUseBaselineBuild()) {
    buildArgs.push("--baseline");
  }

  runChecked(
    "bun",
    buildArgs,
    {
      cwd: runtimeOpencodeDir,
      env: {
        ...process.env,
        ...(expectedVersion ? { OPENCODE_VERSION: expectedVersion } : {}),
      },
    },
    "local OpenCode build failed",
  );

  _authorizedScanRoots.add(runtimeOpencodeDistDir);
  try {
    return findOpencodeBinary(runtimeOpencodeDistDir);
  } finally {
    _authorizedScanRoots.delete(runtimeOpencodeDistDir);
  }
};

const readDirectory = (dir) => {
  const authorizedRoot = [..._authorizedScanRoots].find((r) => r === dir);
  if (!authorizedRoot) return [];

  const results = [];
  const stack = [authorizedRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      else if (entry.isFile()) results.push(next);
    }
  }
  return results;
};

const findOpencodeBinary = (dir) => {
  const candidates = readDirectory(dir);
  return (
    candidates.find((file) => file.endsWith(`/${opencodeBaseName}`) || file.endsWith(`\\${opencodeBaseName}`)) ??
    candidates.find((file) => file.endsWith("/opencode") || file.endsWith("\\opencode")) ??
    null
  );
};

const findOpenCodeRouterBinary = (dir) => {
  const candidates = readDirectory(dir);
  return (
    candidates.find((file) => file.endsWith(`/${opencodeRouterName}`) || file.endsWith(`\\${opencodeRouterName}`)) ??
    candidates.find((file) => file.endsWith("/opencode-router") || file.endsWith("\\opencodeRouter")) ??
    null
  );
};

const readBinaryVersion = (filePath) => {
  try {
    if (typeof filePath !== "string" || !filePath) return null;
    let matched;
    if (opencodePath && filePath === opencodePath) matched = opencodePath;
    else if (opencodeTargetPath && filePath === opencodeTargetPath) matched = opencodeTargetPath;
    else return null;
    if (!existsSync(matched)) return null;
    const result = spawnSync(matched, ["--version"], { encoding: "utf8", shell: false, timeout: 5000 });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    // ignore
  }
  return null;
};

const sha256File = (filePath) => {
  const safe = _allSidecarPaths.find((p) => p === filePath) ?? null;
  if (!safe) return null;
  const hash = createHash("sha256");
  hash.update(readFileSync(safe));
  return hash.digest("hex");
};

const parseChecksum = (content, assetName) => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, name] = trimmed.split(/\s+/);
    if (name === assetName) return hash.toLowerCase();
    if (trimmed.endsWith(` ${assetName}`)) {
      return trimmed.split(/\s+/)[0]?.toLowerCase() ?? null;
    }
  }
  return null;
};

let didBuildOpenworkServer = false;
const shouldBuildOpenworkServer =
  forceBuild || !existsSync(openworkServerBuildPath) || isStubBinary(openworkServerBuildPath);

if (shouldBuildOpenworkServer) {
  buildMcpPolicy();
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(openworkServerBuildPath)) {
    try {
      unlinkSync(openworkServerBuildPath);
    } catch {
      // ignore
    }
  }
  const openworkServerScript = resolveBuildScript(openworkServerDir);
  if (!existsSync(openworkServerScript)) {
    console.error(`OpenWork server build script not found at ${openworkServerScript}`);
    process.exit(1);
  }
  const openworkServerArgs = [openworkServerScript, "--outdir", sidecarDir, "--filename", "openwork-server"];
  if (bunTarget) {
    openworkServerArgs.push("--target", bunTarget);
  }
  const buildResult = spawnSync("bun", openworkServerArgs, {
    cwd: openworkServerDir,
    stdio: "inherit",
    shell: true,
  });

  if (buildResult.status !== 0) {
    process.exit(buildResult.status ?? 1);
  }

  didBuildOpenworkServer = true;
}

if (existsSync(openworkServerBuildPath)) {
  const shouldCopyCanonical = didBuildOpenworkServer || !existsSync(openworkServerPath) || isStubBinary(openworkServerPath);
  if (shouldCopyCanonical && openworkServerBuildPath !== openworkServerPath) {
    try {
      if (existsSync(openworkServerPath)) {
        unlinkSync(openworkServerPath);
      }
    } catch {
      // ignore
    }
    copyFileSync(openworkServerBuildPath, openworkServerPath);
  }

  if (openworkServerTargetPath) {
    const shouldCopyTarget =
      didBuildOpenworkServer || !existsSync(openworkServerTargetPath) || isStubBinary(openworkServerTargetPath);
    if (shouldCopyTarget && openworkServerBuildPath !== openworkServerTargetPath) {
      try {
        if (existsSync(openworkServerTargetPath)) {
          unlinkSync(openworkServerTargetPath);
        }
      } catch {
        // ignore
      }
      copyFileSync(openworkServerBuildPath, openworkServerTargetPath);
    }
  }
}

if (!existingOpencodeVersion && opencodeCandidatePath) {
  existingOpencodeVersion =
    existsSync(opencodeCandidatePath) && !isStubBinary(opencodeCandidatePath)
      ? readBinaryVersion(opencodeCandidatePath)
      : null;
}

const pinnedOpencodeVersion = normalizeVersion(opencodeVersion);
const normalizedOpencodeVersion = pinnedOpencodeVersion;

if (!normalizedOpencodeVersion) {
  console.error(
    "OpenCode version could not be resolved. Set OPENCODE_VERSION or apps/desktop/package.json::opencodeVersion."
  );
  process.exit(1);
}

const runtimeHeadSha = (() => {
  // Verify the lock unconditionally, before deciding whether a pre-committed
  // binary can be trusted - matching fetch-runtime-bin.ps1's own structure
  // (it calls opencode-verify-lock.ps1 first, then decides whether to reuse
  // or rebuild). A valid-looking .head stamp next to a corrupted patch, a
  // drifted gitlink, or a missing/malformed lock must not be accepted just
  // because the stamp field happens to match.
  const lock = verifyOpencodeLock();

  // Use the pre-committed runtime binary when one exists for this platform.
  const prebuiltName =
    process.platform === "win32" && process.arch === "x64"
      ? "superclaw-windows-x64.exe"
      : process.platform === "linux" && process.arch === "x64"
        ? "superclaw-linux-x64"
        : null;
  const prebuiltBin = prebuiltName
    ? resolve(repoRoot, "packaging", "docker", "superclaw-runtime-bin", prebuiltName)
    : null;
  if (prebuiltBin && existsSync(prebuiltBin)) {
    const prebuiltHead = `${prebuiltBin}.head`;
    // Reject LFS pointers and stubs before copying the runtime into sidecars.
    const isValidBinary = (() => {
      try {
        const st = statSync(prebuiltBin);
        if (!st.isFile() || st.size < 1024) return false;
        const fd = openSync(prebuiltBin, "r");
        try {
          const buf = Buffer.alloc(4);
          readSync(fd, buf, 0, 4, 0);
          return process.platform === "win32"
            ? buf[0] === 0x4d && buf[1] === 0x5a // MZ
            : buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46; // ELF
        } finally { closeSync(fd); }
      } catch { return false; }
    })();
    if (isValidBinary) {
      const headSha = existsSync(prebuiltHead) ? readStamp(prebuiltHead) : "prebuilt";
      if (headSha !== lock.fingerprint) {
        console.error(`Pre-committed runtime stamp ${headSha} does not match pinned fingerprint ${lock.fingerprint}.`);
        process.exit(1);
      }
      const needsCopy =
        !opencodeCandidatePath ||
        !existsSync(opencodeCandidatePath) ||
        isStubBinary(opencodeCandidatePath) ||
        !existingOpencodeVersion ||
        existingOpencodeVersion !== normalizedOpencodeVersion ||
        (opencodeStampPath ? readStamp(opencodeStampPath) : null) !== headSha;
      if (needsCopy) {
        mkdirSync(sidecarDir, { recursive: true });
        for (const target of [opencodeTargetPath, opencodePath].filter(Boolean)) {
          if (existsSync(target)) { try { unlinkSync(target); } catch { /* ignore */ } }
          copyFileSync(prebuiltBin, target);
          try { chmodSync(target, 0o755); } catch { /* ignore */ }
        }
        if (opencodeStampPath) writeFileSync(opencodeStampPath, `${headSha}\n`, "utf8");
        console.log(`OpenCode sidecar installed from pre-committed binary (${headSha}).`);
      } else {
        console.log(`OpenCode sidecar already present from pre-committed binary (${existingOpencodeVersion}).`);
      }
      return null; // signal: skip clone-based build below
    }
  }
  applyOpencodePatches(lock, runtimeCheckoutDir);
  return lock.fingerprint;
})();

const stampedRuntimeHead = opencodeStampPath ? readStamp(opencodeStampPath) : null;

const shouldBuildOpencode = runtimeHeadSha !== null && (
  !opencodeCandidatePath ||
  !existsSync(opencodeCandidatePath) ||
  isStubBinary(opencodeCandidatePath) ||
  !existingOpencodeVersion ||
  existingOpencodeVersion !== normalizedOpencodeVersion ||
  stampedRuntimeHead !== runtimeHeadSha);

if (!shouldBuildOpencode) {
  console.log(`OpenCode sidecar already present (${existingOpencodeVersion}, source ${runtimeHeadSha}).`);
}

if (shouldBuildOpencode) {
  mkdirSync(sidecarDir, { recursive: true });

  const builtBinary = buildLocalOpencodeSidecar(normalizedOpencodeVersion);
  if (!builtBinary || !existsSync(builtBinary)) {
    console.error("OpenCode binary not found after local build.");
    process.exit(1);
  }

  const opencodeTargets = [opencodeTargetPath, opencodePath].filter(Boolean);
  for (const target of opencodeTargets) {
    try {
      if (existsSync(target)) {
        unlinkSync(target);
      }
    } catch {
      // ignore
    }
    copyFileSync(builtBinary, target);
    try {
      chmodSync(target, 0o755);
    } catch {
      // ignore
    }
  }

  if (opencodeStampPath) {
    writeFileSync(opencodeStampPath, `${runtimeHeadSha}\n`, "utf8");
  }

  existingOpencodeVersion = readBinaryVersion(opencodeCandidatePath);

  console.log(`OpenCode sidecar rebuilt locally at ${normalizedOpencodeVersion} from ${runtimeHeadSha}.`);
}

const opencodeRouterPkgRaw = readFileSync(resolve(opencodeRouterDir, "package.json"), "utf8");
const opencodeRouterPkg = JSON.parse(opencodeRouterPkgRaw);
const opencodeRouterPkgVersion = String(opencodeRouterPkg.version ?? "").trim();
const normalizedOpenCodeRouterVersion =
  opencodeRouterVersion != null && opencodeRouterVersion.startsWith("v")
    ? opencodeRouterVersion.slice(1)
    : opencodeRouterVersion;
const expectedOpenCodeRouterVersion = normalizedOpenCodeRouterVersion || opencodeRouterPkgVersion;

if (!expectedOpenCodeRouterVersion) {
  console.error("OpenCodeRouter version missing. Set opencodeRouterVersion or ensure package.json has version.");
  process.exit(1);
}

if (normalizedOpenCodeRouterVersion && opencodeRouterPkgVersion && normalizedOpenCodeRouterVersion !== opencodeRouterPkgVersion) {
  console.error(`OpenCodeRouter version mismatch: desktop=${normalizedOpenCodeRouterVersion}, package=${opencodeRouterPkgVersion}`);
  process.exit(1);
}

let didBuildOpenCodeRouter = false;
const shouldBuildOpenCodeRouter = forceBuild || !existsSync(opencodeRouterBuildPath) || isStubBinary(opencodeRouterBuildPath);
if (shouldBuildOpenCodeRouter) {
  if (!shouldBuildOpenworkServer) buildMcpPolicy();
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(opencodeRouterBuildPath)) {
    try {
      unlinkSync(opencodeRouterBuildPath);
    } catch {
      // ignore
    }
  }
  const opencodeRouterScript = resolveBuildScript(opencodeRouterDir);
  if (!existsSync(opencodeRouterScript)) {
    console.error(`OpenCodeRouter build script not found at ${opencodeRouterScript}`);
    process.exit(1);
  }
  const opencodeRouterArgs = [opencodeRouterScript, "--outdir", sidecarDir, "--filename", "opencode-router"];
  if (bunTarget) {
    opencodeRouterArgs.push("--target", bunTarget);
  }
  const result = spawnSync("bun", opencodeRouterArgs, { cwd: opencodeRouterDir, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildOpenCodeRouter = true;
}

if (existsSync(opencodeRouterBuildPath)) {
  const shouldCopyCanonical = didBuildOpenCodeRouter || !existsSync(opencodeRouterPath) || isStubBinary(opencodeRouterPath);
  if (shouldCopyCanonical && opencodeRouterBuildPath !== opencodeRouterPath) {
    try {
      if (existsSync(opencodeRouterPath)) unlinkSync(opencodeRouterPath);
    } catch {
      // ignore
    }
    copyFileSync(opencodeRouterBuildPath, opencodeRouterPath);
  }

  if (opencodeRouterTargetPath) {
    const shouldCopyTarget = didBuildOpenCodeRouter || !existsSync(opencodeRouterTargetPath) || isStubBinary(opencodeRouterTargetPath);
    if (shouldCopyTarget && opencodeRouterBuildPath !== opencodeRouterTargetPath) {
      try {
        if (existsSync(opencodeRouterTargetPath)) unlinkSync(opencodeRouterTargetPath);
      } catch {
        // ignore
      }
      copyFileSync(opencodeRouterBuildPath, opencodeRouterTargetPath);
    }
  }
}

// Build orchestrator sidecar
let didBuildOrchestrator = false;
const shouldBuildOrchestrator =
  forceBuild || !existsSync(orchestratorBuildPath) || isStubBinary(orchestratorBuildPath);
if (shouldBuildOrchestrator) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(orchestratorBuildPath)) {
    try {
      unlinkSync(orchestratorBuildPath);
    } catch {
      // ignore
    }
  }
  const orchestratorBuildScript = resolveBuildScript(orchestratorDir);
  if (!existsSync(orchestratorBuildScript)) {
    console.error(`Orchestrator build script not found at ${orchestratorBuildScript}`);
    process.exit(1);
  }
  buildContracts();
  const orchestratorArgs = [
    orchestratorBuildScript,
    "--outdir",
    sidecarDir,
    "--filename",
    orchestratorBaseName,
  ];
  if (bunTarget) {
    orchestratorArgs.push("--target", bunTarget);
  }
  const result = spawnSync("bun", orchestratorArgs, {
    cwd: orchestratorDir,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      BUN_ENV: "production",
    },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildOrchestrator = true;
}

if (existsSync(orchestratorBuildPath)) {
  const shouldCopyCanonical =
    didBuildOrchestrator || !existsSync(orchestratorPath) || isStubBinary(orchestratorPath);
  if (shouldCopyCanonical && orchestratorBuildPath !== orchestratorPath) {
    try {
      if (existsSync(orchestratorPath)) unlinkSync(orchestratorPath);
    } catch {
      // ignore
    }
    copyFileSync(orchestratorBuildPath, orchestratorPath);
  }

  if (orchestratorTargetPath) {
    const shouldCopyTarget =
      didBuildOrchestrator ||
      !existsSync(orchestratorTargetPath) ||
      isStubBinary(orchestratorTargetPath);
    if (shouldCopyTarget && orchestratorBuildPath !== orchestratorTargetPath) {
      try {
        if (existsSync(orchestratorTargetPath)) unlinkSync(orchestratorTargetPath);
      } catch {
        // ignore
      }
      copyFileSync(orchestratorBuildPath, orchestratorTargetPath);
    }
  }
}

const openworkServerVersion = (() => {
  try {
    const raw = readFileSync(resolve(openworkServerDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const orchestratorVersion = (() => {
  try {
    const raw = readFileSync(resolve(orchestratorDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const versions = {
  opencode: {
    version: normalizedOpencodeVersion,
    sha256: opencodeCandidatePath && existsSync(opencodeCandidatePath) ? sha256File(opencodeCandidatePath) : null,
  },
  "openwork-server": {
    version: openworkServerVersion,
    sha256: existsSync(openworkServerPath) ? sha256File(openworkServerPath) : null,
  },
  opencodeRouter: {
    version: expectedOpenCodeRouterVersion,
    sha256: existsSync(opencodeRouterPath) ? sha256File(opencodeRouterPath) : null,
  },
  "openwork-orchestrator": {
    version: orchestratorVersion,
    sha256: existsSync(orchestratorPath) ? sha256File(orchestratorPath) : null,
  },
};

const missing = Object.entries(versions)
  .filter(([, info]) => !info.version || !info.sha256)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Sidecar version metadata incomplete for: ${missing.join(", ")}`);
  process.exit(1);
}

const versionsPath = join(sidecarDir, "versions.json");
try {
  mkdirSync(sidecarDir, { recursive: true });
  const content = JSON.stringify(versions, null, 2) + "\n";
  writeFileSync(versionsPath, content, "utf8");
  if (resolvedTargetTriple) {
    const targetSuffix = process.platform === "win32" ? ".exe" : "";
    const targetVersionsPath = join(sidecarDir, `versions.json-${resolvedTargetTriple}${targetSuffix}`);
    writeFileSync(targetVersionsPath, content, "utf8");
  }
} catch (error) {
  console.error(`Failed to write versions.json: ${error}`);
  process.exit(1);
}
