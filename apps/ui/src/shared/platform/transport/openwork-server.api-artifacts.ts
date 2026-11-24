/**
 * Workspace artifact listing and download.
 */
import { requestBinary, requestJson } from "./openwork-server.transport";
import type { OpenworkArtifactList } from "./openwork-server.types";
import type { OpenworkClientContext } from "./openwork-server.client-context";

export function createArtifactsApi(ctx: OpenworkClientContext) {
  const { baseUrl, token, hostToken, timeouts } = ctx;
  return {
    listArtifacts: (workspaceId: string) =>
      requestJson<OpenworkArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),
    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),
  };
}
