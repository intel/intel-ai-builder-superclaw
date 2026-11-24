import { invoke } from "@tauri-apps/api/core";

export async function pickDirectory(options?: {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
}): Promise<string | string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({
    title: options?.title,
    defaultPath: options?.defaultPath,
    directory: true,
    multiple: options?.multiple,
  });
}

export type LocalFolderScanEntry = {
  name: string;
  relativePath: string;
  size: number;
};

export type LocalFolderScan = {
  root: string;
  entries: LocalFolderScanEntry[];
  totalBytes: number;
  skippedDirs: string[];
  truncated: boolean;
};

/** Pre-flight half of the folder-import flow: metadata only (no contents),
 * junk dirs (node_modules, .git, …) skipped and reported. */
export async function scanLocalFolder(folderPath: string): Promise<LocalFolderScan> {
  return invoke<LocalFolderScan>("scan_local_folder", { folderPath });
}

/** Scan a folder for remote skill-package import. Build output directories are
 * retained because they may contain runtime resources required by a skill. */
export async function scanSkillFolder(folderPath: string): Promise<LocalFolderScan> {
  return invoke<LocalFolderScan>("scan_skill_folder", { folderPath });
}

/** Streaming half: one file's bytes per IPC call. Path must be under a root
 * approved by a prior scanLocalFolder call. */
export async function readLocalFileBytes(filePath: string): Promise<number[]> {
  return invoke<number[]>("read_local_file_bytes", { filePath });
}

/** Native file picker opened on `defaultPath`. The picked file (and only that
 * file) becomes readable with readLocalFileBytes. */
export async function pickLocalFile(defaultPath?: string): Promise<string | null> {
  return invoke<string | null>("pick_local_file", { defaultPath });
}

/** Read an image authorized by a recent native drop event. */
export async function readDroppedImage(filePath: string): Promise<number[]> {
  return invoke<number[]>("read_dropped_image", { filePath });
}

/** Read a non-image file authorized by a recent native drop event. */
export async function readDroppedFile(filePath: string): Promise<number[]> {
  return invoke<number[]>("read_dropped_file", { filePath });
}

/** Promote paths after the composer accepts a native drop. */
export async function authorizeComposerDroppedFiles(
  filePaths: string[],
): Promise<void> {
  return invoke<void>("authorize_composer_dropped_files", { filePaths });
}

export async function readLocalFileChunk(filePath: string, offset: number, length: number): Promise<number[]> {
  return invoke<number[]>("read_local_file_chunk", { filePath, offset, length });
}

export async function pickFile(options?: {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({
    title: options?.title,
    defaultPath: options?.defaultPath,
    directory: false,
    multiple: options?.multiple,
    filters: options?.filters,
  });
}

export async function saveFile(options?: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    title: options?.title,
    defaultPath: options?.defaultPath,
    filters: options?.filters,
  });
}
