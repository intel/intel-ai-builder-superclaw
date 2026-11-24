import { createEffect, createSignal, on, onCleanup } from "solid-js";
import type { Setter } from "solid-js";
import { homeDir, join } from "@tauri-apps/api/path";

import { applySessionDeletions } from "~/shared/platform/artifact-deletion-store";
import { normalizeLocalFilePath } from "../lib/local-file-path";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import { readWorkspaceFileBase64, workspaceFileExists, workspaceFileSize } from "../lib/tauri";
import { imageMime } from "./session.file-preview.images";
import type { ArtifactItem, WorkspaceDisplay } from "../types";
import { isTauriRuntime } from "../utils";
import { isAbsolutePath } from "./session.artifact-paths";

/** Debounce for existence re-checks once the first pass has completed. */
const EXISTENCE_CHECK_DEBOUNCE_MS = 500;

export type LocalFileActionResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Reactive inputs arrive as thunks so the controller reads them in its
 * caller's tracking scope instead of capturing a value at setup time.
 */
type LocalFilesDeps = {
  workspaceDisplay: () => WorkspaceDisplay;
  activeWorkspaceRoot: () => string;
  selectedSessionId: () => string | null;
  artifacts: () => ArtifactItem[];
  developerMode: () => boolean;
  /** Artifact paths derived from chat messages, before existence filtering. */
  touchedFiles: () => string[];
};

type LocalFilesController = {
  /** `touchedFiles` filtered down to paths that actually exist on disk. */
  verifiedFiles: () => string[];
  setVerifiedFiles: Setter<string[]>;
  /** Host-side root directory for file-existence checks; `""` when unknown. */
  resolveHostRoot: () => Promise<string>;
  resolveHostFilePath: (containerPath: string) => Promise<string | null>;
  runLocalFileAction: (
    file: string,
    mode: "open" | "reveal" | "obsidian",
    action: (candidate: string) => Promise<void>,
  ) => Promise<LocalFileActionResult>;
  /** Byte size of a chat-referenced file, cached per path; null when it cannot be read. */
  fileSize: (file: string) => Promise<number | null>;
  /** A data URL for a chat-referenced image up to THUMBNAIL_MAX_BYTES, cached per path. */
  imageThumbnail: (file: string) => Promise<string | null>;
};

/** A chip thumbnail is 36px; a larger image is not read just to draw it. */
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
/** Each entry holds a whole base64 image and the session view never unmounts, so the cache is bounded. */
const THUMBNAIL_CACHE_LIMIT = 24;

/**
 * Resolves chat-referenced file paths to real host-side locations and verifies
 * they still exist.
 *
 * Remote workspaces report container paths (`/workspace/...`) that Tauri cannot
 * reach, so paths are mapped back to the host bind-mount before any filesystem
 * call. Every resolution is fail-open: when the host root cannot be determined
 * the files are shown rather than hidden.
 */
export function createLocalFiles(deps: LocalFilesDeps): LocalFilesController {
  // After touchedFiles() produces the list of artifact paths derived from
  // chat messages, verify which files actually exist on the filesystem.
  // This handles manual deletions and failed writes.
  //
  // For local workspaces:  activeWorkspaceRoot is the host path (C:\...)
  // For remote/sandbox:    activeWorkspaceRoot and ws.path are both the
  //   container path (/workspace) which Tauri cannot reach.  The host-side
  //   bind-mount is %USERPROFILE%\SuperClawProjects (convention from
  //   backend-manager), so we derive it via homeDir().
  //
  // Strategy: keep previous verifiedFiles during async FS check (no
  // optimistic show - avoids ghost-file flash for deleted files).
  // Check completes in ~30-60 ms, then setVerifiedFiles(existingOnly).
  // For non-Tauri environments (no FS access), show all files directly.
  const [verifiedFiles, setVerifiedFiles] = createSignal<string[]>([]);
  let existenceCheckTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the first verification pass has completed for the current file list. */
  let verifiedOnce = false;

  /** Resolve the host-side root directory for file-existence checks. */
  const resolveHostRoot = async (): Promise<string> => {
    const ws = deps.workspaceDisplay();
    if (ws.workspaceType === "remote") {
      // Prefer ws.directory — it may already contain the host-side path
      const wsDir = (ws.directory ?? "").trim();
      if (wsDir && /^[A-Za-z]:/.test(wsDir)) return wsDir;
      const wsPath = (ws.path ?? "").trim();
      // If ws.path is already a valid Windows host path, use it directly
      if (/^[A-Za-z]:/.test(wsPath)) return wsPath;
      // Detect the local sandbox via two signals - external remote
      // workspaces (e.g. opencode/OpenWork on a remote server) don't have
      // a host-side path Tauri can verify, so return "" for fail-open.
      //
      // Signal 1: containerPath presence (sandbox-side mount, e.g. /workspace)
      const hasContainerPath = Boolean((ws.containerPath ?? "").trim());
      // Signal 2: Connection URL points to localhost (a locally served sandbox)
      const connUrl =
        `${ws.baseUrl ?? ""} ${ws.openworkHostUrl ?? ""}`.toLowerCase();
      const isLocalhost =
        connUrl.includes("localhost") || connUrl.includes("127.0.0.1");
      if (!hasContainerPath && !isLocalhost) return "";
      // Container path (e.g. /workspace) — derive host path from convention:
      // backend-manager bind-mounts %USERPROFILE%\SuperClawProjects at /workspace
      try {
        const home = await homeDir();
        return await join(home, "SuperClawProjects");
      } catch {
        return "";
      }
    }
    return deps.activeWorkspaceRoot().trim();
  };

  /**
   * Map a container-side file path (e.g. /workspace/src/foo.ts) to the
   * corresponding host-side path (e.g. C:\Users\…\SuperClawProjects\src\foo.ts).
   * Returns null when no mapping is applicable (local workspace or unknown root).
   * Passed to PartView so inline file links open in Windows File Explorer.
   */
  const resolveHostFilePath = async (
    containerPath: string,
  ): Promise<string | null> => {
    if (deps.workspaceDisplay().workspaceType !== "remote") return null;
    const hostRoot = await resolveHostRoot();
    if (!hostRoot) return null;
    const wsRoot = deps.activeWorkspaceRoot().trim().replace(/\/+$/, "");
    if (!wsRoot) return null;
    const normalized = containerPath.replace(/\\/g, "/");
    if (!normalized.startsWith(wsRoot + "/") && normalized !== wsRoot)
      return null;
    const relative = normalized.slice(wsRoot.length).replace(/^\/+/, "");
    if (!relative) return hostRoot;

    // When the relative portion is a bare filename (no directory separators),
    // the file may actually live in a subdirectory (e.g. "code/file.csv"
    // instead of just "file.csv").  Search verifiedFiles for a basename match
    // so the link opens the correct host-side location.
    if (!relative.includes("/")) {
      const lowerBase = relative.toLowerCase();
      const match = verifiedFiles().find((vf) => {
        const slash = vf.lastIndexOf("/");
        const base = slash >= 0 ? vf.slice(slash + 1) : vf;
        return base.toLowerCase() === lowerBase;
      });
      if (match) {
        try {
          return await join(hostRoot, ...match.split("/"));
        } catch {
          // fall through to default resolution
        }
      }
    }

    try {
      return await join(hostRoot, ...relative.split("/"));
    } catch {
      return null;
    }
  };

  const runExistenceCheck = async (files: string[]) => {
    const forSessionId = deps.selectedSessionId();
    const currentRoot = await resolveHostRoot();
    if (!currentRoot) {
      // Can't resolve root — show all (fail-open)
      setVerifiedFiles(files);
      return;
    }
    try {
      const checks = await Promise.all(
        files.map(async (file) => {
          try {
            // Tauri's path.join concatenates, so an absolute file would be appended to the root.
            const absPath = isAbsolutePath(file) ? file : await join(currentRoot, file);
            const exists = await workspaceFileExists(absPath, currentRoot);
            return { file, exists };
          } catch {
            return { file, exists: true };
          }
        }),
      );
      const existing = checks.filter((c) => c.exists).map((c) => c.file);
      // Only update if the source list and session haven't changed
      if (
        deps.touchedFiles() === files &&
        deps.selectedSessionId() === forSessionId
      ) {
        // Filter out files the user UI-deleted in this session (persisted
        // in localStorage so it survives app restart).  Also clears stale
        // deletion records when the agent re-created the file.
        const filtered = forSessionId
          ? applySessionDeletions(forSessionId, existing, deps.artifacts())
          : existing;
        setVerifiedFiles(filtered);
      }
    } catch {
      // On any batch failure, show all (fail-open)
      setVerifiedFiles(files);
    }
  };

  const resolveLocalFileCandidates = async (file: string) => {
    const trimmed = normalizeLocalFilePath(file).trim();
    if (!trimmed) return [];
    if (isAbsolutePath(trimmed)) {
      const normalizedAbsolute = trimmed.replace(/\\/g, "/");
      if (/^\/+workspace(?:\/|$)/i.test(normalizedAbsolute)) {
        const hostRoot = await resolveHostRoot();
        if (!hostRoot) return [trimmed];
        const relative = normalizedAbsolute
          .replace(/^\/+workspace\/?/i, "")
          .replace(/^\/+/, "");
        if (!relative) return [hostRoot];
        try {
          return [await join(hostRoot, ...relative.split("/").filter(Boolean))];
        } catch {
          return [trimmed];
        }
      }
      return [trimmed];
    }

    let root = deps.activeWorkspaceRoot().trim();
    if (!root || /^\/workspace(?:\/|$)/i.test(root)) {
      const hostRoot = await resolveHostRoot();
      if (hostRoot) root = hostRoot;
    }
    if (!root) return [];

    const normalized = trimmed
      .replace(/[\\/]+/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    const candidates: string[] = [];
    const seen = new Set<string>();

    const pushCandidate = (value: string) => {
      const key = value
        .trim()
        .replace(/[\\/]+/g, "/")
        .toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      candidates.push(value);
    };

    pushCandidate(await join(root, normalized));

    const workspaceRelative = normalized
      .replace(/^\/+workspace\//i, "")
      .replace(/^workspace\//i, "");
    if (workspaceRelative && workspaceRelative !== normalized) {
      pushCandidate(await join(root, workspaceRelative));
    }

    if (normalized.startsWith(".opencode/openwork/outbox/")) {
      return candidates;
    }

    if (normalized.startsWith("openwork/outbox/")) {
      const suffix = normalized.slice("openwork/outbox/".length);
      if (suffix) {
        pushCandidate(
          await join(root, ".opencode", "openwork", "outbox", suffix),
        );
      }
      return candidates;
    }

    if (normalized.startsWith("outbox/")) {
      const suffix = normalized.slice("outbox/".length);
      if (suffix) {
        pushCandidate(
          await join(root, ".opencode", "openwork", "outbox", suffix),
        );
      }
      return candidates;
    }

    if (!normalized.startsWith(".opencode/")) {
      pushCandidate(
        await join(root, ".opencode", "openwork", "outbox", normalized),
      );
    }

    return candidates;
  };

  const runLocalFileAction = async (
    file: string,
    mode: "open" | "reveal" | "obsidian",
    action: (candidate: string) => Promise<void>,
  ): Promise<LocalFileActionResult> => {
    const candidates = await resolveLocalFileCandidates(file);
    if (!candidates.length) {
      return { ok: false as const, reason: "missing-root" as const };
    }

    const developerMode = deps.developerMode();
    let lastError: unknown = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const startedAt = perfNow();
      const attempt = {
        mode,
        input: file,
        target: candidate,
        candidateIndex: index,
        candidateCount: candidates.length,
      };
      try {
        recordPerfLog(developerMode, "session.file-open", "attempt", attempt);
        await action(candidate);
        finishPerf(
          developerMode,
          "session.file-open",
          "success",
          startedAt,
          attempt,
        );
        return { ok: true as const, path: candidate };
      } catch (error) {
        lastError = error;
        const failure = {
          ...attempt,
          error: error instanceof Error ? error.message : String(error),
        };
        console.warn("[session.file-open] candidate failed", failure);
        finishPerf(
          developerMode,
          "session.file-open",
          "candidate-failed",
          startedAt,
          failure,
        );
      }
    }

    const suffix =
      candidates.length > 1
        ? ` (tried ${candidates.length} paths: workspace root and outbox fallbacks)`
        : "";
    return {
      ok: false as const,
      reason: `${lastError instanceof Error ? lastError.message : "File open failed"}${suffix}`,
    };
  };

  // Sizes are read once per path, so a chip shows the size it had when first rendered.
  const fileSizeCache = new Map<string, Promise<number | null>>();
  const thumbnailCache = new Map<string, Promise<string | null>>();
  /** The first candidate path that exists in the workspace, with its size. */
  const locateFile = async (file: string) => {
    const root = await resolveHostRoot();
    if (!root) return null;
    for (const candidate of await resolveLocalFileCandidates(file)) {
      try {
        const size = await workspaceFileSize(candidate, root);
        if (size !== null) return { root, candidate, size };
      } catch {
        // try the next candidate
      }
    }
    return null;
  };
  const readThumbnail = async (file: string): Promise<string | null> => {
    const found = await locateFile(file);
    if (!found || found.size > THUMBNAIL_MAX_BYTES) return null;
    const result = await readWorkspaceFileBase64(found.candidate, found.root);
    return result.ok && result.content
      ? `data:${imageMime(file, "image/png")};base64,${result.content}`
      : null;
  };
  const cached = <T,>(
    cache: Map<string, Promise<T | null>>,
    file: string,
    read: (file: string) => Promise<T | null>,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<T | null> => {
    if (!isTauriRuntime()) return Promise.resolve(null);
    // Remote workspaces can share a root such as `/workspace` yet map to different host folders.
    const key = `${deps.workspaceDisplay().id}\n${deps.activeWorkspaceRoot()}\n${file}`;
    const pending = cache.get(key) ?? read(file).catch(() => null);
    // Re-inserting keeps the map in least-recently-used order.
    cache.delete(key);
    cache.set(key, pending);
    const oldest = cache.keys().next().value;
    if (cache.size > limit && oldest !== undefined) cache.delete(oldest);
    return pending;
  };
  const fileSize = (file: string) =>
    cached(fileSizeCache, file, async (path) => (await locateFile(path))?.size ?? null);
  const imageThumbnail = (file: string) =>
    cached(thumbnailCache, file, readThumbnail, THUMBNAIL_CACHE_LIMIT);

  createEffect(
    on(
      [deps.touchedFiles, deps.selectedSessionId] as const,
      ([files, sessionId], prev) => {
        clearTimeout(existenceCheckTimer);
        const prevSessionId = prev?.[1];
        const sessionChanged = sessionId !== prevSessionId;

        // Reset verification state on session change so the new session
        // gets an immediate (non-debounced) existence check.
        if (sessionChanged) {
          verifiedOnce = false;
        }

        if (files.length === 0) {
          setVerifiedFiles([]);
          verifiedOnce = false;
          return;
        }

        // Non-Tauri (web preview): can't verify FS, show all immediately
        if (!isTauriRuntime()) {
          setVerifiedFiles(files);
          return;
        }

        // First load or session switch: verify immediately (no debounce).
        // Don't set verifiedFiles here — the panel keeps its previous state
        // (old session's files or []) during the brief async check (~30-60ms)
        // to avoid flashing deleted files.  The check will replace it once done.
        // Subsequent updates (live session): debounce 500ms to avoid thrash.
        if (!verifiedOnce) {
          verifiedOnce = true;
          runExistenceCheck(files);
          return;
        }

        existenceCheckTimer = setTimeout(
          () => runExistenceCheck(files),
          EXISTENCE_CHECK_DEBOUNCE_MS,
        );
      },
    ),
  );

  onCleanup(() => clearTimeout(existenceCheckTimer));

  return {
    verifiedFiles,
    setVerifiedFiles,
    resolveHostRoot,
    resolveHostFilePath,
    runLocalFileAction,
    fileSize,
    imageThumbnail,
  };
}
