// ── Per-session UI-deletion persistence (localStorage) ──────────────
// Tracks files the user deleted via UI within a specific session.
// Survives app restarts so that artifacts from other sessions that
// recreated the same filename don't leak back into this session.
//
// Storage key : `artifact-deletions:<sessionId>`
// Storage value: JSON  { [normalizedPath]: { deletedAt, artifactMessageId? } }

import type { ArtifactItem } from "~/shared/types/session";

const DELETION_KEY_PREFIX = "artifact-deletions:";

interface DeletionRecord {
  /** epoch-ms when the user UI-deleted this file */
  deletedAt: number;
  /** messageId of the artifact that produced this file at deletion time;
   *  used to detect same-session re-creation (a newer messageId ⇒ agent
   *  wrote the file again after the user deleted it). */
  artifactMessageId?: string;
}

function getSessionDeletions(sessionId: string): Record<string, DeletionRecord> {
  try {
    const raw = localStorage.getItem(DELETION_KEY_PREFIX + sessionId);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setSessionDeletions(sessionId: string, records: Record<string, DeletionRecord>): void {
  if (Object.keys(records).length === 0) {
    localStorage.removeItem(DELETION_KEY_PREFIX + sessionId);
  } else {
    localStorage.setItem(DELETION_KEY_PREFIX + sessionId, JSON.stringify(records));
  }
}

/** Remove all deletion records for a session (call on session delete). */
export function clearSessionDeletions(sessionId: string): void {
  localStorage.removeItem(DELETION_KEY_PREFIX + sessionId);
}

export function addSessionDeletions(sessionId: string, paths: string[], artifacts: ArtifactItem[]): void {
  const records = getSessionDeletions(sessionId);
  for (const p of paths) {
    const key = p.toLowerCase();
    // Find the artifact that matches this path so we can store its messageId
    const match = artifacts.find((a) => {
      const ap = (a.path ?? a.name ?? "").trim().replace(/[\\/]+/g, "/").toLowerCase();
      return ap === key || ap.endsWith("/" + key) || key.endsWith("/" + ap);
    });
    records[key] = {
      deletedAt: Date.now(),
      artifactMessageId: match?.messageId,
    };
  }
  setSessionDeletions(sessionId, records);
}

/** Filter out UI-deleted files, clearing stale deletion records when
 *  the agent re-created the file in the same session (new messageId). */
export function applySessionDeletions(
  sessionId: string,
  existing: string[],
  artifacts: ArtifactItem[],
): string[] {
  const records = getSessionDeletions(sessionId);
  if (Object.keys(records).length === 0) return existing;

  let changed = false;
  const deletedKeys = new Set(Object.keys(records));

  // Detect re-creation: if the artifact's messageId differs from the one
  // stored at deletion time, the agent wrote the file again → clear.
  for (const key of deletedKeys) {
    const rec = records[key];
    if (!rec?.artifactMessageId) continue;
    const artifact = artifacts.find((a) => {
      const ap = (a.path ?? a.name ?? "").trim().replace(/[\\/]+/g, "/").toLowerCase();
      return ap === key || ap.endsWith("/" + key) || key.endsWith("/" + ap);
    });
    if (artifact?.messageId && artifact.messageId !== rec.artifactMessageId) {
      // File was re-created by a newer message in the same session
      delete records[key];
      deletedKeys.delete(key);
      changed = true;
    }
  }
  if (changed) setSessionDeletions(sessionId, records);

  if (deletedKeys.size === 0) return existing;
  return existing.filter((f) => !deletedKeys.has(f.toLowerCase()));
}
