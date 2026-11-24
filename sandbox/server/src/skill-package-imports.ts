import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  isSupportedSkillPackageFile,
  SKILL_PACKAGE_IMPORT_LIMITS,
  type SkillPackageFilteredFile,
  type SkillPackageManifestFile,
} from "@different-ai/openwork-contracts/skill-package";

import { ApiError } from "./errors.js";
import { parseFrontmatter } from "./frontmatter.js";
import { ensureDir, exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";
import { projectSkillsDir } from "./workspace-files.js";

const IMPORT_TTL_MS = 60 * 60 * 1000;

type ImportFileState = SkillPackageManifestFile & {
  absolutePath: string;
  received: number;
};

type ImportTransaction = {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  actorTokenHash: string;
  name: string;
  stagingDir: string;
  files: Map<string, ImportFileState>;
  filtered: SkillPackageFilteredFile[];
  createdAt: number;
};

export type SkillPackageCreateInput = {
  workspaceId: string;
  workspaceRoot: string;
  actorTokenHash: string;
  name: string;
  files: SkillPackageManifestFile[];
  filtered: SkillPackageFilteredFile[];
};

function normalizePackagePath(input: string): string {
  const normalized = String(input ?? "").trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new ApiError(400, "invalid_skill_package_path", "Skill package paths must be relative");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new ApiError(400, "invalid_skill_package_path", "Skill package path traversal is not allowed");
  }
  return parts.join("/");
}

function safePackageChild(root: string, relativePath: string): string {
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, relativePath);
  if (!candidate.startsWith(rootResolved + sep)) {
    throw new ApiError(400, "invalid_skill_package_path", "Skill package path traversal is not allowed");
  }
  return candidate;
}

function validateManifest(files: SkillPackageManifestFile[]): SkillPackageManifestFile[] {
  if (!files.length) throw new ApiError(400, "empty_skill_package", "Skill package has no supported files");
  if (files.length > SKILL_PACKAGE_IMPORT_LIMITS.maxFiles) {
    throw new ApiError(413, "skill_package_too_many_files", "Skill package exceeds the file count limit");
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  let totalBytes = 0;
  const normalized = files.map((file) => {
    const id = String(file.id ?? "").trim();
    if (!id || ids.has(id)) throw new ApiError(400, "invalid_skill_package_manifest", "File ids must be unique");
    ids.add(id);

    const path = normalizePackagePath(file.path);
    const folded = path.toLowerCase();
    if (paths.has(path) || caseFoldedPaths.has(folded)) {
      throw new ApiError(400, "duplicate_skill_package_path", `Duplicate skill package path: ${path}`);
    }
    paths.add(path);
    caseFoldedPaths.add(folded);
    if (!isSupportedSkillPackageFile(path)) {
      throw new ApiError(400, "unsupported_skill_package_file", `Unsupported file in upload manifest: ${path}`);
    }

    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ApiError(400, "invalid_skill_package_manifest", `Invalid file size: ${path}`);
    }
    if (size > SKILL_PACKAGE_IMPORT_LIMITS.maxFileBytes) {
      throw new ApiError(413, "skill_package_file_too_large", `File exceeds 64 MiB: ${path}`);
    }
    totalBytes += size;
    return { id, path, size };
  });

  if (!paths.has("SKILL.md")) {
    throw new ApiError(400, "skill_package_missing_manifest", "SKILL.md must exist at the skill folder root");
  }
  if (totalBytes > SKILL_PACKAGE_IMPORT_LIMITS.maxTotalBytes) {
    throw new ApiError(413, "skill_package_too_large", "Skill package exceeds 256 MiB");
  }
  return normalized;
}

export class SkillPackageImportStore {
  private readonly imports = new Map<string, ImportTransaction>();
  private readonly committingNames = new Set<string>();

  async create(input: SkillPackageCreateInput): Promise<{
    importId: string;
    files: SkillPackageManifestFile[];
    filtered: SkillPackageFilteredFile[];
    limits: typeof SKILL_PACKAGE_IMPORT_LIMITS;
  }> {
    validateSkillName(input.name);
    const files = validateManifest(input.files);
    await this.sweepExpired();
    await this.sweepOrphanedStaging(input.workspaceRoot);

    const importId = randomUUID();
    const stagingDir = join(input.workspaceRoot, ".opencode", ".skill-imports", importId);
    await mkdir(stagingDir, { recursive: true });
    const states = new Map<string, ImportFileState>();
    for (const file of files) {
      const absolutePath = safePackageChild(stagingDir, file.path);
      states.set(file.id, { ...file, absolutePath, received: 0 });
      if (file.size === 0) {
        await ensureDir(dirname(absolutePath));
        await writeFile(absolutePath, new Uint8Array());
      }
    }
    this.imports.set(importId, {
      id: importId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      actorTokenHash: input.actorTokenHash,
      name: input.name,
      stagingDir,
      files: states,
      filtered: input.filtered,
      createdAt: Date.now(),
    });
    return { importId, files, filtered: input.filtered, limits: SKILL_PACKAGE_IMPORT_LIMITS };
  }

  async appendChunk(importId: string, workspaceId: string, fileId: string, offset: number, bytes: Uint8Array, actorTokenHash: string): Promise<{
    fileId: string;
    received: number;
    complete: boolean;
  }> {
    const transaction = this.requireOwned(importId, workspaceId, actorTokenHash);
    const file = transaction.files.get(fileId);
    if (!file) throw new ApiError(404, "skill_package_file_not_found", "Skill package file was not declared");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset !== file.received) {
      throw new ApiError(409, "skill_package_offset_mismatch", "Upload offset does not match received bytes", {
        expectedOffset: file.received,
      });
    }
    if (bytes.byteLength > SKILL_PACKAGE_IMPORT_LIMITS.chunkBytes) {
      throw new ApiError(413, "skill_package_chunk_too_large", "Upload chunk exceeds 4 MiB");
    }
    if (file.received + bytes.byteLength > file.size) {
      throw new ApiError(413, "skill_package_file_size_mismatch", "Upload exceeds declared file size");
    }
    await ensureDir(dirname(file.absolutePath));
    await appendFile(file.absolutePath, bytes);
    file.received += bytes.byteLength;
    return { fileId, received: file.received, complete: file.received === file.size };
  }

  async commit(importId: string, workspaceId: string, actorTokenHash: string): Promise<{
    name: string;
    action: "added" | "updated";
    filesImported: number;
    bytesImported: number;
    filtered: SkillPackageFilteredFile[];
    targetPath: string;
  }> {
    const transaction = this.requireOwned(importId, workspaceId, actorTokenHash);
    const lockKey = `${transaction.workspaceId}:${transaction.name}`;
    if (this.committingNames.has(lockKey)) {
      throw new ApiError(409, "skill_package_import_conflict", "Another import is committing this skill");
    }
    this.committingNames.add(lockKey);
    try {
      for (const file of transaction.files.values()) {
        if (file.received !== file.size) {
          throw new ApiError(409, "skill_package_incomplete", `File upload is incomplete: ${file.path}`);
        }
        const info = await stat(file.absolutePath);
        if (!info.isFile() || info.size !== file.size) {
          throw new ApiError(409, "skill_package_file_size_mismatch", `File size does not match manifest: ${file.path}`);
        }
      }

      const skillMarkdown = await readFile(safePackageChild(transaction.stagingDir, "SKILL.md"), "utf8");
      const { data } = parseFrontmatter(skillMarkdown);
      const frontmatterName = typeof data.name === "string" ? data.name : "";
      const description = typeof data.description === "string" ? data.description : undefined;
      if (frontmatterName !== transaction.name) {
        throw new ApiError(400, "invalid_skill_name", "Skill frontmatter name must match the folder name");
      }
      validateDescription(description);

      let bytesImported = 0;
      for (const file of transaction.files.values()) {
        bytesImported += file.size;
      }

      const skillsDir = projectSkillsDir(transaction.workspaceRoot);
      const targetPath = join(skillsDir, transaction.name);
      const backupPath = join(skillsDir, `.backup-${transaction.name}-${importId}`);
      await ensureDir(skillsDir);
      const existed = await exists(targetPath);
      if (existed) await rename(targetPath, backupPath);
      try {
        await rename(transaction.stagingDir, targetPath);
      } catch (error) {
        if (existed && (await exists(backupPath))) await rename(backupPath, targetPath);
        throw error;
      }
      if (existed) {
        await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
      }
      this.imports.delete(importId);
      return {
        name: transaction.name,
        action: existed ? "updated" : "added",
        filesImported: transaction.files.size,
        bytesImported,
        filtered: transaction.filtered,
        targetPath,
      };
    } finally {
      this.committingNames.delete(lockKey);
    }
  }

  async abort(importId: string, workspaceId: string, actorTokenHash: string): Promise<void> {
    const transaction = this.requireOwned(importId, workspaceId, actorTokenHash);
    this.imports.delete(importId);
    await rm(transaction.stagingDir, { recursive: true, force: true });
  }

  private requireOwned(importId: string, workspaceId: string, actorTokenHash: string): ImportTransaction {
    const transaction = this.imports.get(importId);
    if (!transaction) throw new ApiError(404, "skill_package_import_not_found", "Skill package import not found");
    if (transaction.workspaceId !== workspaceId) {
      throw new ApiError(404, "skill_package_import_not_found", "Skill package import not found");
    }
    if (transaction.actorTokenHash !== actorTokenHash) {
      throw new ApiError(403, "forbidden", "Skill package import does not belong to this token");
    }
    return transaction;
  }

  private async sweepExpired(): Promise<void> {
    const expired = [...this.imports.values()].filter((item) => Date.now() - item.createdAt > IMPORT_TTL_MS);
    for (const transaction of expired) {
      this.imports.delete(transaction.id);
      await rm(transaction.stagingDir, { recursive: true, force: true });
    }
  }

  private async sweepOrphanedStaging(workspaceRoot: string): Promise<void> {
    const root = join(workspaceRoot, ".opencode", ".skill-imports");
    const active = new Set([...this.imports.values()].map((item) => item.stagingDir));
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      if (active.has(path)) continue;
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > IMPORT_TTL_MS) {
        await rm(path, { recursive: true, force: true });
      }
    }
  }
}