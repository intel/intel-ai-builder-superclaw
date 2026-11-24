import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PRODUCT_PROFILE_IDS = ["lite", "standard", "pro"];
const IGNORED_DIRECTORY_NAMES = new Set([".venv", "__pycache__"]);

function isIgnoredEntry(entry) {
  return (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name))
    || (entry.isFile() && (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")));
}

function updateRecordHeader(hash, type, relativePath) {
  hash.update(type);
  hash.update("\0");
  hash.update(relativePath, "utf8");
  hash.update("\0");
}

function updateFileLength(hash, length) {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(length));
  hash.update(encoded);
}

export function computeProductProfileDigest(profileRoot) {
  const rootStat = lstatSync(profileRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Product Profile root must be a regular directory: ${profileRoot}`);
  }

  const hash = createHash("sha256");
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      if (isIgnoredEntry(entry)) continue;
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Product Profile digest rejects symlink: ${relativePath}`);
      if (stat.isDirectory()) {
        updateRecordHeader(hash, "directory", relativePath);
        visit(path, relativePath);
      } else if (stat.isFile()) {
        const content = readFileSync(path);
        updateRecordHeader(hash, "file", relativePath);
        updateFileLength(hash, content.length);
        hash.update(content);
      } else {
        throw new Error(`Product Profile digest supports only directories and regular files: ${relativePath}`);
      }
    }
  };
  visit(profileRoot, "");
  return hash.digest("hex");
}

export function computeProductProfileDigests(profilesRoot) {
  return Object.fromEntries(
    PRODUCT_PROFILE_IDS.map((profile) => [
      profile,
      computeProductProfileDigest(join(profilesRoot, profile)),
    ]),
  );
}

export function compareProductProfileRoots(sourceRoot, packagedRoot) {
  const sourceRootDigest = computeProductProfileDigest(sourceRoot);
  const packagedRootDigest = computeProductProfileDigest(packagedRoot);
  const source = computeProductProfileDigests(sourceRoot);
  const packaged = computeProductProfileDigests(packagedRoot);
  for (const profile of PRODUCT_PROFILE_IDS) {
    if (source[profile] !== packaged[profile]) {
      throw new Error(
        `Product Profile parity check failed for ${profile}: source=${source[profile]} packaged=${packaged[profile]}`,
      );
    }
  }
  if (sourceRootDigest !== packagedRootDigest) {
    throw new Error(
      `Product Profile root parity check failed: source=${sourceRootDigest} packaged=${packagedRootDigest}`,
    );
  }
  return source;
}
