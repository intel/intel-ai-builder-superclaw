import { requestBinaryJson, requestJson } from "./openwork-server.transport";
import type { OpenworkAgentToolSkillCatalog, OpenworkAuditEntry, OpenworkCommandItem, OpenworkHubRepo, OpenworkHubSkillItem, OpenworkPluginItem, OpenworkSkillContent, OpenworkSkillItem } from "./openwork-server.types";
import type { OpenworkClientContext } from "./openwork-server.client-context";

export function createCatalogApi(ctx: OpenworkClientContext) {
  const { baseUrl, token, hostToken } = ctx;
  return {
    listPlugins: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/plugins${query}`,
        { token, hostToken },
      );
    },
    addPlugin: (workspaceId: string, spec: string) =>
      requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/plugins`,
        { token, hostToken, method: "POST", body: { spec } },
      ),
    removePlugin: (workspaceId: string, name: string) =>
      requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listSkills: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: OpenworkSkillItem[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills${query}`,
        { token, hostToken },
      );
    },
    listAgentToolSkillCatalog: (workspaceId: string) =>
      requestJson<OpenworkAgentToolSkillCatalog>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/agent-tools-skills`,
        { token, hostToken },
      ),
    listHubSkills: (options?: { repo?: OpenworkHubRepo; fresh?: boolean }) => {
      const params = new URLSearchParams();
      const owner = options?.repo?.owner?.trim();
      const repo = options?.repo?.repo?.trim();
      const ref = options?.repo?.ref?.trim();
      if (owner) params.set("owner", owner);
      if (repo) params.set("repo", repo);
      if (ref) params.set("ref", ref);
      if (options?.fresh) params.set("fresh", "1");
      const query = params.size ? `?${params.toString()}` : "";
      return requestJson<{ items: OpenworkHubSkillItem[] }>(baseUrl, `/hub/skills${query}`, {
        token,
        hostToken,
      });
    },
    installHubSkill: (
      workspaceId: string,
      name: string,
      options?: { overwrite?: boolean; repo?: { owner?: string; repo?: string; ref?: string }; timeoutMs?: number },
    ) =>
      requestJson<{ ok: boolean; name: string; path: string; action: "added" | "updated"; written: number; skipped: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills/hub/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: options?.timeoutMs,
          body: {
            ...(options?.overwrite ? { overwrite: true } : {}),
            ...(options?.repo ? { repo: options.repo } : {}),
          },
        },
      ),
    getSkill: (workspaceId: string, name: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<OpenworkSkillContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}${query}`,
        { token, hostToken },
      );
    },
    upsertSkill: (workspaceId: string, payload: { name: string; content: string; description?: string }) =>
      requestJson<OpenworkSkillItem>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/skills`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    createSkillPackageImport: (
      workspaceId: string,
      payload: {
        name: string;
        files: Array<{ id: string; path: string; size: number }>;
        filtered: Array<{ path: string; reason: "unsupported_type" | "ignored_directory" }>;
      },
    ) => requestJson<{
      ok: true;
      importId: string;
      files: Array<{ id: string; path: string; size: number }>;
    }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/skill-imports`, {
      token,
      hostToken,
      method: "POST",
      body: payload,
    }),
    uploadSkillPackageChunk: (
      workspaceId: string,
      importId: string,
      fileId: string,
      offset: number,
      bytes: Uint8Array,
    ) => requestBinaryJson<{ ok: true; fileId: string; received: number; complete: boolean }>(
      baseUrl,
      `/workspace/${encodeURIComponent(workspaceId)}/skill-imports/${encodeURIComponent(importId)}/files/${encodeURIComponent(fileId)}`,
      bytes,
      {
        token,
        hostToken,
        method: "PUT",
        headers: { "X-Skill-File-Offset": String(offset) },
        timeoutMs: 60_000,
      },
    ),
    commitSkillPackageImport: (workspaceId: string, importId: string) => requestJson<{
      ok: true;
      status: "imported" | "imported_with_filtered_files";
      name: string;
      action: "added" | "updated";
      filesImported: number;
      bytesImported: number;
      filtered: Array<{ path: string; reason: "unsupported_type" | "ignored_directory" }>;
    }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/skill-imports/${encodeURIComponent(importId)}/commit`, {
      token,
      hostToken,
      method: "POST",
      body: {},
      timeoutMs: 60_000,
    }),
    abortSkillPackageImport: (workspaceId: string, importId: string) =>
      requestJson<{ ok: true }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skill-imports/${encodeURIComponent(importId)}`,
        { token, hostToken, method: "DELETE" },
      ),
    deleteSkill: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean; name: string; path: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listCommands: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: OpenworkCommandItem[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/commands?scope=${scope}`,
        { token, hostToken },
      ),
    listAudit: (workspaceId: string, limit = 50) =>
      requestJson<{ items: OpenworkAuditEntry[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/audit?limit=${limit}`,
        { token, hostToken },
      ),
    upsertCommand: (
      workspaceId: string,
      payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
    ) =>
      requestJson<{ items: OpenworkCommandItem[] }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/commands`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteCommand: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
  };
}
