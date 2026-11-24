import type { OpenworkServerClient } from "../lib/openwork-server";
import type { WorkspaceInfo } from "../lib/tauri";
import { isTauriRuntime, isWindowsPlatform } from "../utils";

export type UploadedInboxFile = { name: string; path: string };

/**
 * Reactive values arrive as thunks so the controller reads them when a user
 * action runs rather than when it is created. The panel/selection setters are
 * passed in because the session page owns that UI state.
 */
type InboxUploadDeps = {
  serverClient: () => OpenworkServerClient | null | undefined;
  serverWorkspaceId: () => string | null | undefined;
  workspaces: () => WorkspaceInfo[];
  rightSidebarExpanded: () => boolean;
  setRightSidebarExpanded: (open: boolean) => void;
  /** Bumped to make the workspace files panel re-read the inbox. */
  bumpInboxVersion: () => void;
  setSelectedFiles: (update: (previous: string[]) => string[]) => void;
  notify: (message: string) => void;
};

type InboxUploadController = {
  upload: (
    files: File[],
    options?: { notify?: boolean },
  ) => Promise<UploadedInboxFile[]>;
  revealWorkspaceInFinder: (workspaceId: string) => Promise<void>;
};

/**
 * For a folder upload (several files sharing one top-level directory) select
 * just that folder, so a large tree does not flood the context window with
 * individual paths.
 */
function selectionKeyForUpload(
  uploaded: UploadedInboxFile[],
): string | null {
  const topDirs = new Set(
    uploaded.map((file) => file.path.split("/")[0]).filter(Boolean),
  );
  if (topDirs.size === 1 && uploaded.length > 1) {
    return `projects/${[...topDirs][0]}/`;
  }
  const single = uploaded.length === 1 ? uploaded[0] : undefined;
  if (single) return `projects/${single.path}`;
  // Several files across different directories: do not auto-select.
  return null;
}

export function createInboxUpload(
  deps: InboxUploadDeps,
): InboxUploadController {
  const upload = async (
    files: File[],
    options?: { notify?: boolean },
  ): Promise<UploadedInboxFile[]> => {
    const shouldNotify = options?.notify ?? true;
    const client = deps.serverClient();
    const workspaceId = deps.serverWorkspaceId()?.trim() ?? "";
    if (!client || !workspaceId) {
      if (shouldNotify) {
        deps.notify("Connect to the SuperClaw server to upload files.");
      }
      return [];
    }
    if (!files.length) return [];

    const label =
      files.length === 1 ? (files[0]?.name ?? "file") : `${files.length} files`;
    if (shouldNotify) deps.notify(`Uploading ${label}...`);

    try {
      const uploaded: UploadedInboxFile[] = [];
      for (const file of files) {
        const relativePath = file.webkitRelativePath?.trim();
        const result = await client.uploadInbox(
          workspaceId,
          file,
          relativePath ? { path: relativePath } : undefined,
        );
        const path = result.path?.trim() || file.name;
        uploaded.push({ name: file.name || path, path });
      }
      if (shouldNotify) {
        const summary = uploaded
          .map((file) => file.name)
          .filter(Boolean)
          .join(", ");
        deps.notify(
          summary ? `Added to workspace: ${summary}` : "Added to workspace.",
        );
      }

      if (uploaded.length > 0) {
        // Show the uploaded files in FileUploadPanel.
        if (!deps.rightSidebarExpanded()) deps.setRightSidebarExpanded(true);
        deps.bumpInboxVersion();
        const key = selectionKeyForUpload(uploaded);
        if (key) {
          deps.setSelectedFiles((previous) =>
            previous.includes(key) ? previous : [...previous, key],
          );
        }
      }

      return uploaded;
    } catch (error) {
      if (shouldNotify) {
        deps.notify(
          error instanceof Error ? error.message : "Upload failed",
        );
      }
      return [];
    }
  };

  const revealWorkspaceInFinder = async (workspaceId: string) => {
    const workspace =
      deps.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "local") return;
    const target = workspace.path?.trim() ?? "";
    if (!target) {
      deps.notify("Workspace path is unavailable.");
      return;
    }
    if (!isTauriRuntime()) {
      deps.notify("Reveal is available in the desktop app.");
      return;
    }
    try {
      const { openPath, revealItemInDir } = await import(
        "@tauri-apps/plugin-opener"
      );
      if (isWindowsPlatform()) {
        await openPath(target);
      } else {
        await revealItemInDir(target);
      }
    } catch (error) {
      deps.notify(
        error instanceof Error ? error.message : "Unable to reveal workspace",
      );
    }
  };

  return { upload, revealWorkspaceInFinder };
}
