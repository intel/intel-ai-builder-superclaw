import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { base64ToUtf8, utf8ToBase64 } from "~/shared/util/base64-bytes";
import { OpenworkServerError } from "../lib/openwork-server";
import type {
  OpenworkFileSession,
  OpenworkServerClient,
} from "../lib/openwork-server";
import { readObsidianMirrorFile, writeObsidianMirrorFile } from "../lib/tauri";
import { isTauriRuntime } from "../utils";
import {
  createConflictPath,
  toRemoteArtifactCandidates,
} from "./session.artifact-paths";

const SYNC_TICK_INTERVAL_MS = 2500;
const FILE_SESSION_TTL_SECONDS = 15 * 60;
/** Renew rather than reuse a session this close to expiring. */
const FILE_SESSION_RENEW_LEAD_MS = 45_000;
/** Repeated sync failures collapse into one toast per window. */
const SYNC_ERROR_TOAST_INTERVAL_MS = 6_000;

type RemoteMirrorTrackedFile = {
  path: string;
  localPath: string;
  remoteRevision: string;
  localFingerprint: string;
  syncingLocal: boolean;
};

type RemoteFileSyncSession = OpenworkFileSession & { cursor: number };

/**
 * Reactive inputs arrive as thunks so the controller reads them in its
 * caller's tracking scope instead of capturing a value at setup time.
 */
type ObsidianMirrorDeps = {
  serverClient: () => OpenworkServerClient | null;
  serverWorkspaceId: () => string | null;
  workspaceDisplayId: () => string | undefined;
  workspaceType: () => string | undefined;
  activeWorkspaceRoot: () => string;
  setToastMessage: (message: string) => void;
};

type ObsidianMirrorController = {
  /**
   * Id of the live file session, or `""`. Callers key retries on it so a
   * recreated session re-drives reads that failed against the previous one.
   */
  fileSessionId: () => string;
  /** Mirrors a worker-relative file into the local vault; returns its path. */
  mirrorRemoteArtifactForObsidian: (file: string) => Promise<string>;
  readCandidatesViaSession: (
    candidates: string[],
  ) => Promise<{ contentBase64: string } | null>;
};

/** FNV-1a over the file text; only ever compared, never persisted. */
const textFingerprint = (value: string) => {
  let hash = 2166136261;
  for (let idx = 0; idx < value.length; idx += 1) {
    hash ^= value.charCodeAt(idx);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${hash >>> 0}`;
};

/**
 * Two-way mirror between a remote worker's files and a local Obsidian vault.
 *
 * Owns the OpenWork file session, the set of tracked files, and the polling
 * loop that reconciles both directions: remote writes are pulled down, local
 * edits are pushed back, and a rejected push is preserved as a conflict copy
 * rather than dropped.
 */
export function createObsidianMirror(
  deps: ObsidianMirrorDeps,
): ObsidianMirrorController {
  const trackedFiles = new Map<string, RemoteMirrorTrackedFile>();
  const [syncSession, setSyncSession] =
    createSignal<RemoteFileSyncSession | null>(null);
  const workspaceKey = createMemo(
    () =>
      deps.serverWorkspaceId()?.trim() ||
      deps.workspaceDisplayId()?.trim() ||
      "remote-worker",
  );
  let syncTimer: number | undefined;
  let syncInFlight = false;
  let lastErrorAt = 0;

  const stopSyncLoop = () => {
    if (syncTimer !== undefined) {
      window.clearInterval(syncTimer);
      syncTimer = undefined;
    }
  };

  const closeSession = async (session: RemoteFileSyncSession | null) => {
    const client = deps.serverClient();
    if (!client || !session) return;
    try {
      await client.closeFileSession(session.id);
    } catch {
      // best effort
    }
  };

  const reset = async () => {
    stopSyncLoop();
    syncInFlight = false;
    trackedFiles.clear();
    const existing = syncSession();
    setSyncSession(null);
    await closeSession(existing);
  };

  const ensureSession = async (): Promise<RemoteFileSyncSession> => {
    const client = deps.serverClient();
    const workspaceId = deps.serverWorkspaceId()?.trim() ?? "";
    if (!client || !workspaceId) {
      throw new Error("Connect to SuperClaw server to sync remote files.");
    }

    const existing = syncSession();
    if (existing && existing.workspaceId === workspaceId) {
      if (Date.now() + FILE_SESSION_RENEW_LEAD_MS < existing.expiresAt) {
        return existing;
      }

      try {
        const renewed = await client.renewFileSession(existing.id, {
          ttlSeconds: FILE_SESSION_TTL_SECONDS,
        });
        const next: RemoteFileSyncSession = {
          ...renewed.session,
          cursor: existing.cursor,
        };
        setSyncSession(next);
        return next;
      } catch (error) {
        if (
          !(error instanceof OpenworkServerError) ||
          error.code !== "file_session_not_found"
        ) {
          throw error;
        }
      }
    }

    if (existing) {
      await closeSession(existing);
      setSyncSession(null);
    }

    const created = await client.createFileSession(workspaceId, {
      ttlSeconds: FILE_SESSION_TTL_SECONDS,
      write: true,
    });
    const next: RemoteFileSyncSession = {
      ...created.session,
      cursor: 0,
    };
    setSyncSession(next);
    return next;
  };

  /**
   * Write remote content into the vault and record the revision plus a
   * fingerprint of what actually landed on disk, so the next tick can tell a
   * local edit from the write we just made. Returns the on-disk path.
   *
   * `syncingLocal` has to be supplied rather than carried over: this replaces
   * the map entry, while an in-flight push holds the previous object and clears
   * the flag on that one. Inheriting `true` here would strand the new entry as
   * permanently syncing, and it would be skipped in both directions forever.
   */
  const materializeMirrorFile = async (
    path: string,
    item: { contentBase64: string; revision: string },
    syncingLocal: boolean,
  ) => {
    const content = base64ToUtf8(item.contentBase64);
    const localPath = await writeObsidianMirrorFile(
      workspaceKey(),
      path,
      content,
    );
    const local = await readObsidianMirrorFile(workspaceKey(), path);
    trackedFiles.set(path, {
      path,
      localPath,
      remoteRevision: item.revision,
      localFingerprint: textFingerprint(local.content ?? content),
      syncingLocal,
    });
    return localPath;
  };

  const refreshTrackedFile = async (
    session: RemoteFileSyncSession,
    path: string,
  ) => {
    const client = deps.serverClient();
    if (!client) throw new Error("SuperClaw server client unavailable");

    const result = await client.readFileBatch(session.id, [path]);
    const item = result.items[0];
    if (!item?.ok) {
      if (item?.code === "file_not_found") {
        trackedFiles.delete(path);
        return;
      }
      throw new Error(item?.message ?? `Unable to read ${path}`);
    }

    // Never the tracked entry's current value: the conflict path calls this
    // from inside a push, so carrying `true` over would strand the replacement
    // entry as permanently syncing. The push's `finally` only clears the object
    // it captured, which this call has already replaced.
    await materializeMirrorFile(path, item, false);
  };

  const runSyncTick = async () => {
    if (syncInFlight) return;
    if (trackedFiles.size === 0) {
      stopSyncLoop();
      return;
    }

    const client = deps.serverClient();
    if (!client) {
      stopSyncLoop();
      return;
    }

    syncInFlight = true;
    try {
      let session = await ensureSession();

      const events = await client.listFileSessionEvents(session.id, {
        since: session.cursor,
      });
      if (events.cursor !== session.cursor) {
        session = { ...session, cursor: events.cursor };
        setSyncSession(session);
      }

      const refreshPaths = new Set<string>();
      for (const event of events.items) {
        if (event.type === "write" && trackedFiles.has(event.path)) {
          const tracked = trackedFiles.get(event.path);
          if (!tracked?.syncingLocal) {
            refreshPaths.add(event.path);
          }
          continue;
        }

        if (event.type === "rename") {
          const tracked = trackedFiles.get(event.path);
          if (!tracked) continue;
          trackedFiles.delete(event.path);
          if (event.toPath?.trim()) {
            const nextPath = event.toPath.trim();
            trackedFiles.set(nextPath, {
              ...tracked,
              path: nextPath,
            });
            refreshPaths.add(nextPath);
          }
          continue;
        }

        if (event.type === "delete") {
          trackedFiles.delete(event.path);
        }
      }

      for (const path of refreshPaths) {
        await refreshTrackedFile(session, path);
      }

      for (const [path, tracked] of trackedFiles) {
        if (tracked.syncingLocal) continue;

        const local = await readObsidianMirrorFile(workspaceKey(), path);
        if (!local.exists || local.content === null) continue;
        const nextFingerprint = textFingerprint(local.content);
        if (nextFingerprint === tracked.localFingerprint) continue;

        tracked.syncingLocal = true;
        try {
          const write = await client.writeFileBatch(session.id, [
            {
              path,
              contentBase64: utf8ToBase64(local.content),
              ifMatchRevision: tracked.remoteRevision,
            },
          ]);
          const item = write.items[0];
          if (item?.ok) {
            tracked.remoteRevision = item.revision;
            tracked.localFingerprint = nextFingerprint;
            continue;
          }

          if (!item?.ok && item?.code === "conflict") {
            const conflictPath = createConflictPath(path);
            await writeObsidianMirrorFile(
              workspaceKey(),
              conflictPath,
              local.content,
            );
            await refreshTrackedFile(session, path);
            deps.setToastMessage(
              `Conflict syncing ${path}. Saved local changes to ${conflictPath}.`,
            );
            continue;
          }

          throw new Error(item?.message ?? `Unable to sync ${path}`);
        } finally {
          tracked.syncingLocal = false;
        }
      }
    } catch (error) {
      if (Date.now() - lastErrorAt > SYNC_ERROR_TOAST_INTERVAL_MS) {
        lastErrorAt = Date.now();
        const message =
          error instanceof Error ? error.message : "Remote file sync failed";
        deps.setToastMessage(message);
      }
    } finally {
      syncInFlight = false;
    }
  };

  const ensureSyncLoop = () => {
    if (!isTauriRuntime()) return;
    if (trackedFiles.size === 0) return;
    if (syncTimer !== undefined) return;
    syncTimer = window.setInterval(() => {
      void runSyncTick();
    }, SYNC_TICK_INTERVAL_MS);
    void runSyncTick();
  };

  const mirrorRemoteArtifactForObsidian = async (file: string) => {
    const session = await ensureSession();
    const client = deps.serverClient();
    if (!client) {
      throw new Error("Connect to SuperClaw server to sync remote files.");
    }

    const candidates = toRemoteArtifactCandidates(
      file,
      deps.activeWorkspaceRoot(),
    );
    if (candidates.length === 0) {
      throw new Error("Only worker-relative files can be opened in Obsidian.");
    }

    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        const result = await client.readFileBatch(session.id, [candidate]);
        const item = result.items[0];
        if (!item?.ok) {
          if (item?.code === "file_not_found") continue;
          throw new Error(item?.message ?? `Unable to read ${candidate}`);
        }

        const localPath = await materializeMirrorFile(candidate, item, false);
        ensureSyncLoop();
        return localPath;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("Unable to open file in Obsidian");
  };

  /**
   * Try each candidate path against the server's read-batch API.
   * If the file session turns out to be stale (expired between our
   * `ensureSession` call and the actual read), the session is recreated and
   * the **same** candidate is retried before moving on.
   *
   * @returns The first successful read, or `null`.
   */
  const readCandidatesViaSession = async (
    candidates: string[],
  ): Promise<{ contentBase64: string } | null> => {
    const client = deps.serverClient();
    if (!client) return null;
    // Always validate/renew — a cached session object may have expired on the
    // server while the client still holds a stale reference.
    let session = await ensureSession();
    let retried = false;

    for (let idx = 0; idx < candidates.length; idx++) {
      const candidate = candidates[idx];
      try {
        const result = await client.readFileBatch(session.id, [candidate]);
        const item = result.items[0];
        if (item?.ok) {
          return { contentBase64: item.contentBase64 as string };
        }
      } catch (error) {
        // Session expired between ensure and read — recreate once, then
        // retry the *same* candidate so we don't silently skip it.
        if (
          !retried &&
          error instanceof OpenworkServerError &&
          error.code === "file_session_not_found"
        ) {
          retried = true;
          setSyncSession(null);
          try {
            session = await ensureSession();
          } catch {
            return null;
          }
          idx--; // retry current candidate with the fresh session
          continue;
        }
        // Per-file error (e.g. file_not_found) — try next candidate.
      }
    }
    return null;
  };

  createEffect(
    on(
      () =>
        [
          isTauriRuntime(),
          deps.workspaceType(),
          deps.serverWorkspaceId()?.trim() ?? "",
          Boolean(deps.serverClient()),
        ] as const,
      ([desktopRuntime, workspaceType, workspaceId, hasClient], previous) => {
        const previousWorkspaceId = previous?.[2] ?? "";
        const hasRemoteContext =
          desktopRuntime &&
          workspaceType === "remote" &&
          workspaceId.length > 0 &&
          hasClient;
        if (!hasRemoteContext) {
          if (
            syncSession() ||
            trackedFiles.size > 0 ||
            syncTimer !== undefined
          ) {
            void reset();
          }
          return;
        }

        if (previousWorkspaceId && previousWorkspaceId !== workspaceId) {
          void reset();
        }
      },
    ),
  );

  onCleanup(() => {
    void reset();
  });

  return {
    fileSessionId: () => syncSession()?.id ?? "",
    mirrorRemoteArtifactForObsidian,
    readCandidatesViaSession,
  };
}
