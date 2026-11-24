import { join } from "@tauri-apps/api/path";

import {
  openInFileExplorer,
  openInObsidian,
  workspaceFileExists,
} from "../lib/tauri";
import { isTauriRuntime, isWindowsPlatform } from "../utils";
import type { LocalFileActionResult } from "./session.local-files";

/**
 * Reactive inputs arrive as thunks so the controller reads them in its
 * caller's tracking scope instead of capturing a value at setup time.
 */
type FileActionsDeps = {
  workspaceType: () => string | undefined;
  obsidianAvailable: () => boolean;
  isSandboxWorkspace: () => boolean;
  setToastMessage: (message: string) => void;
  /** Host-side workspace root, or `""` when it cannot be resolved. */
  resolveHostRoot: () => Promise<string>;
  runLocalFileAction: (
    file: string,
    mode: "open" | "reveal" | "obsidian",
    action: (candidate: string) => Promise<void>,
  ) => Promise<LocalFileActionResult>;
  mirrorRemoteArtifactForObsidian: (file: string) => Promise<string>;
};

type FileActionsController = {
  revealArtifact: (file: string) => Promise<void>;
  openWorkspaceItemInExplorer: (
    path: string,
    kind: "file" | "dir",
  ) => Promise<void>;
  openArtifactInObsidian: (file: string) => Promise<void>;
};

/**
 * Opens files the agent produced in the host OS — File Explorer or Obsidian.
 *
 * Every entry point is desktop-only and reports its own failure through a
 * toast, so callers can invoke them directly from a click handler. For a
 * remote worker an Obsidian open falls back to mirroring the file locally
 * first, since the container path is not reachable from the host.
 */
export function createFileActions(
  deps: FileActionsDeps,
): FileActionsController {
  const revealArtifact = async (file: string) => {
    if (!isTauriRuntime()) {
      deps.setToastMessage("Reveal is available in the desktop app.");
      return;
    }
    try {
      const result = await deps.runLocalFileAction(
        file,
        "reveal",
        async (candidate) => {
          await openResolvedPathInExplorer(candidate, "file");
        },
      );
      if (!result.ok && result.reason === "missing-root") {
        deps.setToastMessage("Pick a worker to reveal files.");
        return;
      }
      if (!result.ok) {
        deps.setToastMessage(result.reason);
        return;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to reveal file";
      deps.setToastMessage(message);
    }
  };

  const openResolvedPathInExplorer = async (
    absPath: string,
    kind: "file" | "dir",
  ) => {
    if (!isTauriRuntime()) {
      deps.setToastMessage("Reveal is available in the desktop app.");
      return;
    }

    const { openPath, revealItemInDir } = await import(
      "@tauri-apps/plugin-opener"
    );

    if (kind === "dir") {
      if (isWindowsPlatform()) {
        await openInFileExplorer(absPath);
        return;
      }
      await openPath(absPath);
      return;
    }

    await revealItemInDir(absPath);
  };

  const resolveWorkspaceProjectPath = async (
    path: string,
    hostRoot: string,
  ): Promise<string | null> => {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (
      !normalized ||
      /^[a-zA-Z]:/.test(normalized) ||
      /^\//.test(normalized) ||
      /(^|\/)\.\.(?:\/|$)/.test(normalized)
    ) {
      return null;
    }

    return await join(hostRoot, ...normalized.split("/").filter(Boolean));
  };

  const openWorkspaceItemInExplorer = async (
    path: string,
    kind: "file" | "dir",
  ) => {
    const hostRoot = await deps.resolveHostRoot();
    if (!hostRoot) {
      deps.setToastMessage("Pick a worker to reveal files.");
      return;
    }

    const absPath = await resolveWorkspaceProjectPath(path, hostRoot);
    if (!absPath) {
      deps.setToastMessage("Cannot open, invalid path.");
      return;
    }

    try {
      const exists = await workspaceFileExists(absPath, hostRoot);
      if (!exists) {
        deps.setToastMessage("File or folder not found on disk.");
        return;
      }

      await openResolvedPathInExplorer(absPath, kind);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to open!";
      deps.setToastMessage(message);
    }
  };

  const openArtifactInObsidian = async (file: string) => {
    if (!/\.(md|mdx|markdown)$/i.test(file)) return;
    if (!deps.obsidianAvailable()) {
      deps.setToastMessage("Obsidian is not available on this system.");
      return;
    }
    if (!isTauriRuntime()) {
      deps.setToastMessage(
        "Open in Obsidian is available in the desktop app.",
      );
      return;
    }

    const isRemoteWorkspace = deps.workspaceType() === "remote";
    const preferLocalOpen = !isRemoteWorkspace || deps.isSandboxWorkspace();

    try {
      if (preferLocalOpen) {
        const localResult = await deps.runLocalFileAction(
          file,
          "obsidian",
          async (candidate) => {
            await openInObsidian(candidate);
          },
        );
        if (localResult.ok) {
          return;
        }
        if (localResult.reason === "missing-root" && !isRemoteWorkspace) {
          deps.setToastMessage("Pick a worker to open files.");
          return;
        }
        if (!isRemoteWorkspace) {
          deps.setToastMessage(localResult.reason);
          return;
        }
      }

      const mirrored = await deps.mirrorRemoteArtifactForObsidian(file);
      await openInObsidian(mirrored);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to open file in Obsidian";
      deps.setToastMessage(message);
    }
  };

  return {
    revealArtifact,
    openWorkspaceItemInExplorer,
    openArtifactInObsidian,
  };
}
