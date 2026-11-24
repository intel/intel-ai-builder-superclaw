/**
 * sandbox-networking - classifies MCP server URLs by where the sandbox reaches
 * them. The native sandbox runs on the Windows host, so a loopback URL is a
 * server on this machine and is used exactly as the user typed it.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isLocalWindowsMcpUrl(url: string): boolean {
  const hostname = hostnameFromUrl(url);
  return hostname !== null && LOOPBACK_HOSTS.has(hostname);
}
