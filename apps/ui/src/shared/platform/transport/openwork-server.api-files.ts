import type { ScheduledJob } from "~/shared/platform/tauri";
import { OpenworkServerError, requestBinary, requestJson, requestMultipartRaw } from "./openwork-server.transport";
import type { OpenworkFileCatalogEntry, OpenworkFileOpsBatchResult, OpenworkFileReadBatchResult, OpenworkFileSession, OpenworkFileSessionEvent, OpenworkFileWriteBatchResult, OpenworkInboxList, OpenworkInboxUploadResult, OpenworkWorkspaceFileContent, OpenworkWorkspaceFileWriteResult } from "./openwork-server.types";
import type { OpenworkClientContext } from "./openwork-server.client-context";

export function createFilesApi(ctx: OpenworkClientContext) {
  const { baseUrl, token, hostToken, timeouts } = ctx;
  return {
    listScheduledJobs: (workspaceId: string) =>
      requestJson<{ items: ScheduledJob[]; supported?: boolean }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/scheduler/jobs`, { token, hostToken }),
    deleteScheduledJob: (workspaceId: string, name: string) =>
      requestJson<{ job: ScheduledJob }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/scheduler/jobs/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    uploadInbox: async (workspaceId: string, file: File, options?: { path?: string }) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      if (!file) throw new Error("file is required");
      const uploadPath = options?.path?.trim() ?? "";
      const form = new FormData();
      form.append("file", file);
      if (uploadPath) {
        form.append("path", uploadPath);
      }

      const result = await requestMultipartRaw(baseUrl, `/workspace/${encodeURIComponent(id)}/inbox`, {
        token,
        hostToken,
        method: "POST",
        body: form,
        timeoutMs: timeouts.binary,
      });

      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // ignore
        }
        throw new OpenworkServerError(result.status, "request_failed", message || "Upload failed");
      }

      const body = result.text.trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as Partial<OpenworkInboxUploadResult>;
          if (typeof parsed.path === "string" && parsed.path.trim()) {
            return {
              ok: parsed.ok ?? true,
              path: parsed.path.trim(),
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : file.size,
            } satisfies OpenworkInboxUploadResult;
          }
        } catch {
          // ignore invalid JSON and fall back
        }
      }

      return {
        ok: true,
        path: uploadPath || file.name,
        bytes: file.size,
      } satisfies OpenworkInboxUploadResult;
    },
    getGmailCredentialsStatus: (workspaceId: string) =>
      requestJson<{ hasCredentials: boolean; hasToken: boolean; fileSize: number | null; updatedAt: number | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/gmail/credentials/status`,
        { token, hostToken },
      ),
    uploadGmailCredentials: async (workspaceId: string, file: File) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      if (!file) throw new Error("file is required");
      const form = new FormData();
      form.append("file", file);
      const result = await requestMultipartRaw(baseUrl, `/workspace/${encodeURIComponent(id)}/gmail/credentials`, {
        token,
        hostToken,
        method: "POST",
        body: form,
        timeoutMs: timeouts.binary,
      });
      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // ignore
        }
        throw new OpenworkServerError(result.status, "request_failed", message || "Gmail credentials upload failed");
      }
      const body = result.text.trim();
      if (body) {
        try {
          return JSON.parse(body) as { ok: boolean; bytes: number };
        } catch {
          // ignore
        }
      }
      return { ok: true, bytes: file.size };
    },
    startGmailAuth: (workspaceId: string) => 
      requestJson<{ authURL: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/gmail/auth/start`,
        { token, hostToken, method: "POST" },
      ),
    deleteGmailCredentials: (workspaceId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/gmail/credentials`,
        { token, hostToken, method: "DELETE" },
      ),
    listInbox: (workspaceId: string) =>
      requestJson<OpenworkInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/inbox`, {
        token,
        hostToken,
      }),
    listProjects: (workspaceId: string) =>
      requestJson<OpenworkInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/projects`, {
        token,
        hostToken,
        timeoutMs: 60_000,
      }),
    deleteProjectItem: (workspaceId: string, itemId: string) =>
      requestJson<{ ok: boolean; path: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/workspace/${encodeURIComponent(itemId)}`,
        { token, hostToken, method: "DELETE" },
      ),
    // These return whole-file bytes as base64, so they belong to the same class
    // as the other binary reads and use the same 60s budget. They previously
    // fell back to the 10s default, which surfaced large-but-healthy files as
    // spurious timeouts.
    readInboxContent: (workspaceId: string, itemId: string) =>
      requestJson<{ ok: boolean; path: string; contentBase64: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(itemId)}/content`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),
    readProjectContent: (workspaceId: string, itemId: string) =>
      requestJson<{ ok: boolean; path: string; contentBase64: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/workspace/${encodeURIComponent(itemId)}/content`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),
    // Render an office document (docx/xlsx/pptx) to PDF via headless
    // LibreOffice on the backend; returns the PDF as base64 for the existing
    // frontend PDF viewer. Conversion is ephemeral (temp dir, deleted after).
    readInboxPreviewPdf: (workspaceId: string, itemId: string) =>
      requestJson<{ ok: boolean; path: string; contentBase64: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(itemId)}/preview-pdf`,
        { token, hostToken, timeoutMs: timeouts.officePreview },
      ),
    readProjectPreviewPdf: (workspaceId: string, itemId: string) =>
      requestJson<{ ok: boolean; path: string; contentBase64: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/workspace/${encodeURIComponent(itemId)}/preview-pdf`,
        { token, hostToken, timeoutMs: timeouts.officePreview },
      ),
    downloadInboxItem: (workspaceId: string, inboxId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),
    deleteInboxItem: (workspaceId: string, inboxId: string) =>
      requestJson<{ ok: boolean; path: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, method: "DELETE" },
      ),
    createFileSession: (workspaceId: string, options?: { ttlSeconds?: number; write?: boolean }) =>
      requestJson<{ session: OpenworkFileSession }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`, {
        token,
        hostToken,
        method: "POST",
        body: {
          ...(typeof options?.ttlSeconds === "number" ? { ttlSeconds: options.ttlSeconds } : {}),
          ...(typeof options?.write === "boolean" ? { write: options.write } : {}),
        },
      }),
    renewFileSession: (sessionId: string, options?: { ttlSeconds?: number }) =>
      requestJson<{ session: OpenworkFileSession }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/renew`, {
        token,
        hostToken,
        method: "POST",
        body: {
          ...(typeof options?.ttlSeconds === "number" ? { ttlSeconds: options.ttlSeconds } : {}),
        },
      }),
    closeFileSession: (sessionId: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    getFileCatalogSnapshot: (
        sessionId: string,
        options?: { prefix?: string; after?: string; includeDirs?: boolean; limit?: number },
      ) => {
        const params = new URLSearchParams();
        const queryOptions = options ?? {};

        if (queryOptions.prefix?.trim()) {
          params.set("prefix", queryOptions.prefix.trim());
        }
        if (queryOptions.after?.trim()) {
          params.set("after", queryOptions.after.trim());
        }
        if (typeof queryOptions.includeDirs === "boolean") {
          params.set("includeDirs", queryOptions.includeDirs ? "true" : "false");
        }
        if (typeof queryOptions.limit === "number") {
          params.set("limit", String(queryOptions.limit));
        }
      const query = params.toString();
      return requestJson<{
        sessionId: string;
        workspaceId: string;
        generatedAt: number;
        cursor: number;
        total: number;
        truncated: boolean;
        nextAfter?: string;
        items: OpenworkFileCatalogEntry[];
      }>(
        baseUrl,
        `/files/sessions/${encodeURIComponent(sessionId)}/catalog/snapshot${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },
    listFileSessionEvents: (sessionId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${encodeURIComponent(String(options.since))}` : "";
      return requestJson<{ items: OpenworkFileSessionEvent[]; cursor: number }>(
        baseUrl,
        `/files/sessions/${encodeURIComponent(sessionId)}/catalog/events${query}`,
        { token, hostToken },
      );
    },
    readFileBatch: (sessionId: string, paths: string[]) =>
      requestJson<OpenworkFileReadBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/read-batch`, {
        token,
        hostToken,
        method: "POST",
        body: { paths },
      }),
    writeFileBatch: (
      sessionId: string,
      writes: Array<{ path: string; contentBase64: string; ifMatchRevision?: string; force?: boolean }>,
    ) =>
      requestJson<OpenworkFileWriteBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/write-batch`, {
        token,
        hostToken,
        method: "POST",
        body: { writes },
      }),
    runFileBatchOps: (
      sessionId: string,
      operations: Array<
        | { type: "mkdir"; path: string }
        | { type: "delete"; path: string; recursive?: boolean }
        | { type: "rename"; from: string; to: string }
      >,
    ) =>
      requestJson<OpenworkFileOpsBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        token,
        hostToken,
        method: "POST",
        body: { operations },
      }),
    readWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<OpenworkWorkspaceFileContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),
    writeWorkspaceFile: (
      workspaceId: string,
      payload: { path: string; content: string; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<OpenworkWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),
    deleteWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<{ ok: boolean; path: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    listAgentFiles: (workspaceId: string) =>
      requestJson<{ items: Array<{ name: string; description?: string }> }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/agents`,
        { token, hostToken },
      ),
  };
}
