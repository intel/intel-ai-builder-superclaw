import { requestJson } from "./openwork-server.transport";
import type { ConfigPatchRequest } from "@different-ai/openwork-contracts/config-patch";
import type { IntentClassificationResult, IntentSessionDisplayResult, OpenworkGithubDeviceFlow, OpenworkGithubStatus, OpenworkReloadEvent, OpenworkRuntimeSettings, OpenworkRuntimeSettingsPatch, OpenworkRuntimeSnapshot, OpenworkServerCapabilities, OpenworkServerDiagnostics, OpenworkWorkspaceExport, OpenworkWorkspaceInfo, OpenworkWorkspaceList } from "./openwork-server.types";
import type { OpenworkClientContext } from "./openwork-server.client-context";

export function createCoreApi(ctx: OpenworkClientContext) {
  const { baseUrl, token, hostToken, timeouts } = ctx;
  return {
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", { token, hostToken, timeoutMs: timeouts.health }),
    runtimeVersions: () =>
      requestJson<OpenworkRuntimeSnapshot>(baseUrl, "/runtime/versions", { token, hostToken, timeoutMs: timeouts.status }),
    status: () => requestJson<OpenworkServerDiagnostics>(baseUrl, "/status", { token, hostToken, timeoutMs: timeouts.status }),
    capabilities: () => requestJson<OpenworkServerCapabilities>(baseUrl, "/capabilities", { token, hostToken, timeoutMs: timeouts.capabilities }),
    listWorkspaces: () => requestJson<OpenworkWorkspaceList>(baseUrl, "/workspaces", { token, hostToken, timeoutMs: timeouts.listWorkspaces }),
    classifyIntent: (payload: { text: string; session_id: string }) =>
      requestJson<IntentClassificationResult>(baseUrl, "/intent/classify", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: 60_000,
      }),
    getIntentSessionDisplay: (sessionId: string) =>
      requestJson<IntentSessionDisplayResult>(
        baseUrl,
        `/intent/session/${encodeURIComponent(sessionId)}/display`,
        { token, hostToken, timeoutMs: 10_000 },
      ),
    activateWorkspace: (workspaceId: string) =>
      requestJson<{ activeId: string; workspace: OpenworkWorkspaceInfo }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      ),
    deleteWorkspace: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: OpenworkWorkspaceInfo[] }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace },
      ),
    deleteSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteSession },
      ),
    exportWorkspace: (workspaceId: string) =>
      requestJson<OpenworkWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      }),
    importWorkspace: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/import`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.workspaceImport,
      }),
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; openwork: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    getRuntimeSettings: (workspaceId: string) =>
      requestJson<OpenworkRuntimeSettings>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/runtime-settings`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    patchConfig: (workspaceId: string, payload: ConfigPatchRequest) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    patchRuntimeSettings: (workspaceId: string, payload: OpenworkRuntimeSettingsPatch) =>
      requestJson<OpenworkRuntimeSettings>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/runtime-settings`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    listReloadEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: OpenworkReloadEvent[]; cursor?: number; disabled?: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/events${query}`,
        { token, hostToken },
      );
    },
    reloadEngine: (workspaceId: string) =>
      requestJson<{ ok: boolean; reloadedAt?: number }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/engine/reload`, {
        token,
        hostToken,
        method: "POST",
      }),
    // githubAuth, not config: this reads through `gh auth status`, which makes
    // its own GitHub round trip, so it belongs with the other gh-backed calls
    // rather than with the local config reads. A 10s ceiling is under the
    // latency this can genuinely reach on a proxied network, and a read that
    // always times out leaves the card blank forever — it is polled, but
    // retrying cannot outrun a limit that is simply too low.
    getGithubStatus: (workspaceId: string) =>
      requestJson<OpenworkGithubStatus>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/github/status`, {
        token,
        hostToken,
        timeoutMs: timeouts.githubAuth,
      }),
    setGithubToken: (workspaceId: string, tokenValue: string) =>
      requestJson<OpenworkGithubStatus>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/github/token`, {
        token,
        hostToken,
        method: "POST",
        body: { token: tokenValue },
        timeoutMs: timeouts.githubAuth,
      }),
    startGithubDeviceLogin: (workspaceId: string) =>
      requestJson<{ deviceFlow: OpenworkGithubDeviceFlow }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/github/device`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.githubAuth },
      ),
    cancelGithubDeviceLogin: (workspaceId: string) =>
      requestJson<{ deviceFlow: OpenworkGithubDeviceFlow }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/github/device`,
        { token, hostToken, method: "DELETE" },
      ),
    // githubAuth for the same reason as getGithubStatus above, and more so: this
    // runs `gh auth logout` and then re-reads `gh auth status`, so it pays the
    // round trip twice. The cancel call above keeps the default because it only
    // drops in-memory flow state and never reaches GitHub.
    disconnectGithub: (workspaceId: string) =>
      requestJson<OpenworkGithubStatus>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/github/auth`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.githubAuth,
      }),
    // Pausing keeps the sign-in; the answer re-reads `gh auth status`, hence githubAuth.
    setGithubEnabled: (workspaceId: string, enabled: boolean) =>
      requestJson<OpenworkGithubStatus>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/github/enabled`, {
        token,
        hostToken,
        method: "PUT",
        body: { enabled },
        timeoutMs: timeouts.githubAuth,
      }),
  };
}
