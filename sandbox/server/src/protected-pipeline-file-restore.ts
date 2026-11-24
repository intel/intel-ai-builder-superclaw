import { rename, rm, writeFile } from "node:fs/promises";
import type { WorkspaceInfo } from "./types.js";

export type ProtectedPipelineOperationInfo = {
  operation_id: string;
  operation_session_id: string | null;
};

export class ProtectedFileContentTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly size: number,
  ) {
    super("Restored file exceeds size limit");
    this.name = "ProtectedFileContentTooLargeError";
  }
}

type Logger = {
  log: (
    level: "info" | "warn" | "error",
    message: string,
    attributes?: Record<string, unknown>,
  ) => void;
};

type Dependencies = {
  fetchOpencodeJson: (
    workspace: WorkspaceInfo,
    path: string,
    init: { method: string; body?: unknown },
  ) => Promise<unknown>;
  parseOperations: (state: Record<string, unknown>) => ProtectedPipelineOperationInfo[] | null;
  restoreText: (
    text: string,
    operations: ProtectedPipelineOperationInfo[],
    logger?: Logger,
    maxBytes?: number,
  ) => Promise<string>;
  shortId: () => string;
};

const PLACEHOLDER_RE = /<[A-Za-z_]+_\d+>/;
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".csv", ".json", ".html", ".htm"]);
const CACHE_TTL_MS = 60_000;
const MAX_SESSIONS = 25;

export function isRestorableProtectedFile(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return TEXT_EXTENSIONS.has(extension);
}

/**
 * Masked pipeline outputs must stay masked on disk: restoring one on read would rewrite the
 * file the cloud model analyses, and anything that reads it next would see the real values.
 */
export function isMaskedPipelineOutput(path: string): boolean {
  return /(^|\/)data_protection_workspace\/masked_datasets\//i.test(path.replace(/\\/g, "/"));
}

export function createProtectedFileTextRestorer(dependencies: Dependencies) {
  const cache = new Map<string, { fetchedAt: number; ops: ProtectedPipelineOperationInfo[] }>();

  async function collectOperations(
    workspace: WorkspaceInfo,
    logger?: Logger,
  ): Promise<ProtectedPipelineOperationInfo[]> {
    const cached = cache.get(workspace.id);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.ops;

    const operations: ProtectedPipelineOperationInfo[] = [];
    const seen = new Set<string>();
    try {
      const sessions = await dependencies.fetchOpencodeJson(workspace, "/session", { method: "GET" });
      const recentSessions = (Array.isArray(sessions) ? sessions : [])
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .sort((left, right) => sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left))
        .slice(0, MAX_SESSIONS);
      for (const session of recentSessions) {
        const sessionId = typeof session.id === "string" ? session.id : "";
        if (!sessionId) continue;
        let messages: unknown;
        try {
          messages = await dependencies.fetchOpencodeJson(
            workspace,
            `/session/${encodeURIComponent(sessionId)}/message`,
            { method: "GET" },
          );
        } catch {
          continue;
        }
        if (!Array.isArray(messages)) continue;
        for (const message of messages) {
          const parts = message && typeof message === "object" && Array.isArray((message as Record<string, unknown>).parts)
            ? (message as Record<string, unknown>).parts as unknown[]
            : [];
          for (const part of parts) {
            if (!part || typeof part !== "object") continue;
            const record = part as Record<string, unknown>;
            if (record.type !== "tool" || record.tool !== "run_protected_file_pipeline") continue;
            const state = record.state && typeof record.state === "object"
              ? record.state as Record<string, unknown>
              : {};
            for (const operation of dependencies.parseOperations(state) ?? []) {
              const key = `${operation.operation_id}:${operation.operation_session_id ?? ""}`;
              if (seen.has(key)) continue;
              seen.add(key);
              operations.push(operation);
            }
          }
        }
      }
    } catch (err) {
      logger?.log("warn", "failed to harvest workspace protected operations", { err: String(err) });
    }
    cache.set(workspace.id, { fetchedAt: Date.now(), ops: operations });
    return operations;
  }

  return async function restoreFileText(
    workspace: WorkspaceInfo,
    content: string,
    filePath?: string,
    logger?: Logger,
    maxBytes?: number,
  ): Promise<string> {
    if (filePath && isMaskedPipelineOutput(filePath)) return content;
    if (!PLACEHOLDER_RE.test(content)) return content;
    const operations = await collectOperations(workspace, logger);
    if (operations.length === 0) return content;
    const restored = await dependencies.restoreText(content, operations, logger, maxBytes);
    if (maxBytes !== undefined) {
      const size = Buffer.byteLength(restored, "utf8");
      if (size > maxBytes) throw new ProtectedFileContentTooLargeError(maxBytes, size);
    }
    if (filePath && restored !== content) {
      await persistRestoredText(filePath, restored, dependencies.shortId, logger);
    }
    return restored;
  };
}

function sessionUpdatedAtMs(session: Record<string, unknown>): number {
  const time = session.time && typeof session.time === "object"
    ? session.time as Record<string, unknown>
    : {};
  return typeof time.updated === "number" ? time.updated : typeof time.created === "number" ? time.created : 0;
}

async function persistRestoredText(
  filePath: string,
  content: string,
  shortId: () => string,
  logger?: Logger,
): Promise<void> {
  const temporaryPath = `${filePath}.restore-${shortId()}`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (err) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup; the original file remains available.
    }
    logger?.log("warn", "failed to persist restored protected file", { filePath, err: String(err) });
  }
}
