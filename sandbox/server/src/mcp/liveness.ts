/**
 * opencode never re-checks an MCP server after connecting, so a stopped local
 * server keeps reading as connected. Only loopback URLs are probed, so this adds
 * no outbound traffic.
 */

import type { McpServer } from "@different-ai/openwork-contracts/mcp";

const PROBE_TIMEOUT_MS = 5_000;
const MISSES_BEFORE_DISABLE = 2;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
const missesByUrl = new Map<string, number>();

function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Any HTTP answer, including 401/404/405, means something is listening. */
async function isReachable(url: string): Promise<boolean> {
  try {
    // egress-surface: openwork_local_mcp_liveness
    await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/**
 * After two missed probes in a row, `disable` disconnects the server and turns it off, answering
 * whether its config now says disabled, or null when the engine refused, which leaves it connected
 * for the next read to retry.
 */
export async function withLocalLiveness(
  server: McpServer,
  disable: (name: string) => Promise<{ persisted: boolean } | null>,
): Promise<McpServer> {
  const { config, status } = server;
  if (status?.status !== "connected" || config.type !== "remote" || !isLoopbackUrl(config.url)) return server;
  if (await isReachable(config.url)) {
    missesByUrl.delete(config.url);
    return server;
  }
  const misses = (missesByUrl.get(config.url) ?? 0) + 1;
  missesByUrl.set(config.url, misses);
  if (misses < MISSES_BEFORE_DISABLE) return server;
  const disabled = await disable(server.name);
  if (!disabled) return server;
  missesByUrl.delete(config.url);
  return { ...server, enabled: disabled.persisted ? false : server.enabled, status: { status: "disabled" } };
}
