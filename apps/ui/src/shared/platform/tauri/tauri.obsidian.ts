import { invoke } from "@tauri-apps/api/core";

export async function obsidianIsAvailable(): Promise<boolean> {
  return invoke<boolean>("obsidian_is_available");
}

export async function validateObsidianVault(vaultName: string): Promise<string> {
  const safeVaultName = vaultName.trim();
  if (!safeVaultName) {
    throw new Error("vaultName is required");
  }
  return invoke<string>("validate_obsidian_vault", { vaultName: safeVaultName });
}

export async function openInObsidian(filePath: string): Promise<void> {
  const safePath = filePath.trim();
  if (!safePath) {
    throw new Error("filePath is required");
  }
  return invoke<void>("open_in_obsidian", { filePath: safePath });
}

export async function openInFileExplorer(
  path: string,
  options?: { reveal?: boolean },
): Promise<void> {
  const safePath = path.trim();
  if (!safePath) {
    throw new Error("path is required");
  }
  return invoke<void>("open_in_file_explorer", {
    path: safePath,
    reveal: options?.reveal ?? false,
  });
}

export async function writeObsidianMirrorFile(
  workspaceId: string,
  filePath: string,
  content: string,
): Promise<string> {
  const safeWorkspaceId = workspaceId.trim();
  const safePath = filePath.trim();
  if (!safeWorkspaceId) {
    throw new Error("workspaceId is required");
  }
  if (!safePath) {
    throw new Error("filePath is required");
  }
  return invoke<string>("write_obsidian_mirror_file", {
    workspaceId: safeWorkspaceId,
    filePath: safePath,
    content,
  });
}

export type ObsidianMirrorFileContent = {
  exists: boolean;
  path: string;
  content: string | null;
  updatedAtMs: number | null;
};

export async function readObsidianMirrorFile(
  workspaceId: string,
  filePath: string,
): Promise<ObsidianMirrorFileContent> {
  const safeWorkspaceId = workspaceId.trim();
  const safePath = filePath.trim();
  if (!safeWorkspaceId) {
    throw new Error("workspaceId is required");
  }
  if (!safePath) {
    throw new Error("filePath is required");
  }
  return invoke<ObsidianMirrorFileContent>("read_obsidian_mirror_file", {
    workspaceId: safeWorkspaceId,
    filePath: safePath,
  });
}

export type ReadWorkspaceFileResult = {
  ok: boolean;
  content: string | null;
  error: string | null;
};

export async function readWorkspaceFile(
  filePath: string,
  workspaceRoot: string,
): Promise<ReadWorkspaceFileResult> {
  const safePath = filePath.trim();
  const safeRoot = workspaceRoot.trim();
  if (!safePath) {
    throw new Error("filePath is required");
  }
  if (!safeRoot) {
    throw new Error("workspaceRoot is required");
  }
  return invoke<ReadWorkspaceFileResult>("read_workspace_file", {
    filePath: safePath,
    workspaceRoot: safeRoot,
  });
}

export async function readWorkspaceFileBase64(
  filePath: string,
  workspaceRoot: string,
): Promise<ReadWorkspaceFileResult> {
  const safePath = filePath.trim();
  const safeRoot = workspaceRoot.trim();
  if (!safePath) throw new Error("filePath is required");
  if (!safeRoot) throw new Error("workspaceRoot is required");
  return invoke<ReadWorkspaceFileResult>("read_workspace_file_base64", {
    filePath: safePath,
    workspaceRoot: safeRoot,
  });
}

/**
 * Check whether a file exists within a workspace root.
 * Cheaper than readWorkspaceFile — only canonicalizes + checks existence,
 * never reads file content.
 */
export async function workspaceFileExists(
  filePath: string,
  workspaceRoot: string,
): Promise<boolean> {
  const safePath = filePath.trim();
  const safeRoot = workspaceRoot.trim();
  if (!safePath || !safeRoot) return false;
  return invoke<boolean>("workspace_file_exists", {
    filePath: safePath,
    workspaceRoot: safeRoot,
  });
}

/** Size in bytes of a file within a workspace root; null when it is missing or outside. Reads metadata only. */
export async function workspaceFileSize(
  filePath: string,
  workspaceRoot: string,
): Promise<number | null> {
  const safePath = filePath.trim();
  const safeRoot = workspaceRoot.trim();
  if (!safePath || !safeRoot) return null;
  return invoke<number | null>("workspace_file_size", {
    filePath: safePath,
    workspaceRoot: safeRoot,
  });
}
