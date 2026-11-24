import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

import { ProductProfileDescriptorSchema } from "../src/capability/product-profile.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILES_ROOT = resolve(HERE, "..", "..", "..", "sandbox", "agent_config", "profiles");
const PROFILE_IDS = ["lite", "standard", "pro"];
const REQUIRED_FILES = ["profile.json", "opencode.jsonc", "package.json"];
const REQUIRED_DIRECTORIES = ["plugins", "prompts", "skills", "tools"];
const FILE_REFERENCE = /\{file:([^{}]+)\}/g;

function fail(profile, message) {
  throw new Error(`Product Profile '${profile}': ${message}`);
}

function assertNoSymlinks(profile, root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (lstatSync(path).isSymbolicLink()) fail(profile, `symlink is not allowed: ${relative(root, path)}`);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
}

function assertInsideProfile(profile, root, referencedPath) {
  if (
    isAbsolute(referencedPath) ||
    referencedPath.includes("\\") ||
    referencedPath.includes("\0") ||
    /^[A-Za-z]:/.test(referencedPath)
  ) {
    fail(profile, `file reference must be a relative local path: ${referencedPath}`);
  }
  const candidate = resolve(root, referencedPath);
  const relativePath = relative(root, candidate);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    fail(profile, `file reference points outside the Profile: ${referencedPath}`);
  }
  if (!existsSync(candidate) || !lstatSync(candidate).isFile()) {
    fail(profile, `file reference does not name a regular file: ${referencedPath}`);
  }
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const realRelative = relative(realRoot, realCandidate);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    fail(profile, `file reference resolves outside the Profile: ${referencedPath}`);
  }
}

function validateFileReferences(profile, root, value) {
  if (typeof value === "string") {
    for (const match of value.matchAll(FILE_REFERENCE)) assertInsideProfile(profile, root, match[1]);
    if (value.replace(FILE_REFERENCE, "").includes("{file")) {
      fail(profile, `malformed file reference: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateFileReferences(profile, root, item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) validateFileReferences(profile, root, item);
  }
}

function assertFeatureConsistency(profile, descriptor, agents) {
  const checks = [
    [descriptor.feature_flags.email_agent, agents.has("email-agent"), "email_agent", "email-agent"],
    [
      descriptor.feature_flags.hybrid_deep_research_agent,
      agents.has("hybrid-deep-research"),
      "hybrid_deep_research_agent",
      "hybrid-deep-research",
    ],
    [
      descriptor.feature_flags.intent_classifier,
      descriptor.required_sidecars.includes("intent-classifier"),
      "intent_classifier",
      "intent-classifier",
    ],
    [
      descriptor.feature_flags.hybrid_deep_research_agent,
      descriptor.required_sidecars.includes("hdr-sidecar"),
      "hybrid_deep_research_agent",
      "hdr-sidecar",
    ],
  ];
  for (const [enabled, present, flag, resource] of checks) {
    if (enabled !== present) fail(profile, `${flag} must match ${resource} presence`);
  }
}

function assertTaskTargets(profile, config, agents) {
  for (const [agentId, definition] of Object.entries(config.agent)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
    const permission = definition.permission;
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) continue;
    const task = permission.task;
    if (!task || typeof task !== "object" || Array.isArray(task)) continue;
    for (const target of Object.keys(task)) {
      if (target !== "*" && !agents.has(target)) {
        fail(profile, `agent ${agentId} declares unknown task target: ${target}`);
      }
    }
  }
}

function validateProfile(profilesRoot, profile) {
  const root = join(profilesRoot, profile);
  assertNoSymlinks(profile, root);
  for (const name of REQUIRED_FILES) {
    const path = join(root, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) fail(profile, `missing required file: ${name}`);
  }
  for (const name of REQUIRED_DIRECTORIES) {
    const path = join(root, name);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) fail(profile, `missing required directory: ${name}`);
  }

  let descriptor;
  try {
    descriptor = ProductProfileDescriptorSchema.parse(JSON.parse(readFileSync(join(root, "profile.json"), "utf8")));
  } catch (error) {
    fail(profile, `invalid profile.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (descriptor.profile !== profile) fail(profile, "profile identity must match its directory");
  if (new Set(descriptor.required_sidecars).size !== descriptor.required_sidecars.length) {
    fail(profile, "required_sidecars must be unique");
  }

  const parseErrors = [];
  const config = parseJsonc(readFileSync(join(root, "opencode.jsonc"), "utf8"), parseErrors, {
    allowTrailingComma: true,
  });
  if (parseErrors.length > 0) {
    fail(profile, `invalid opencode.jsonc: ${printParseErrorCode(parseErrors[0].error)}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.agent || typeof config.agent !== "object" || Array.isArray(config.agent)) {
    fail(profile, "opencode.jsonc must define an agent object");
  }
  validateFileReferences(profile, root, config);
  const agents = new Set(Object.keys(config.agent));
  if (typeof config.default_agent !== "string" || !agents.has(config.default_agent)) {
    fail(profile, "opencode.jsonc default_agent must name an agent in this Profile");
  }
  assertTaskTargets(profile, config, agents);
  assertFeatureConsistency(profile, descriptor, agents);
}

// The runtime resolves one shared OpenCode dependency root and reuses it for whichever Profile the
// orchestrator selects, so the three package.json files must be byte-identical. The container image
// build used to enforce this with a `cmp` gate; nothing else does.
function assertSharedPackageManifest(profilesRoot) {
  const [reference, ...others] = PROFILE_IDS;
  const expected = readFileSync(join(profilesRoot, reference, "package.json"));
  for (const profile of others) {
    if (!expected.equals(readFileSync(join(profilesRoot, profile, "package.json")))) {
      throw new Error(
        `Product Profile '${profile}': package.json must be byte-identical to '${reference}' (all Profiles share one OpenCode dependency root)`,
      );
    }
  }
}

export function validateProductProfiles(profilesRoot = DEFAULT_PROFILES_ROOT) {
  const directories = readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(directories) !== JSON.stringify([...PROFILE_IDS].sort())) {
    throw new Error("Product Profiles root must contain exactly lite, standard, pro directories");
  }
  for (const profile of PROFILE_IDS) validateProfile(profilesRoot, profile);
  assertSharedPackageManifest(profilesRoot);
}

export function run() {
  validateProductProfiles();
  console.log("Product Profiles are valid: lite, standard, pro");
}
