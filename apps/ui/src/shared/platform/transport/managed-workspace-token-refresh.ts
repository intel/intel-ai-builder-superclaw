import { DEFAULT_OPENWORK_SERVER_PORT } from "./openwork-server";
import {
  fetchOwtToken,
  type OwtTokenResult,
  type ServiceHubSettings,
} from "./servicehub";

export async function refreshManagedWorkspaceToken(
  settings: ServiceHubSettings,
  syncToken: (
    token: string,
    openworkUrl: string,
    trace: {
      requestId: string;
      attempt: number;
      tokenCreatedAt: string;
      tokenScope: string;
      tokenRevision: string | null;
    },
  ) => Promise<void>,
  requestId: string,
): Promise<OwtTokenResult> {
  const result = await fetchOwtToken(settings.baseUrl, settings.token);
  if (!result.ok) return result;

  await syncToken(
    result.token,
    `http://127.0.0.1:${DEFAULT_OPENWORK_SERVER_PORT}`,
    {
      requestId,
      attempt: 1,
      tokenCreatedAt: result.createdAt,
      tokenScope: result.scope,
      tokenRevision: result.revision,
    },
  );
  return result;
}
