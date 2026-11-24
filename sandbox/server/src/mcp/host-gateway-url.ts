import { HOST_MCP_PORT, HOST_MCP_PROXY_PREFIX } from "@different-ai/openwork-contracts/host-mcp-api";

const PORT = String(HOST_MCP_PORT);
const PREFIX = HOST_MCP_PROXY_PREFIX.toLowerCase();
const IPV4_MAPPED_LOOPBACK = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;
const DOTTED_IPV4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "[::]" || host === "[::ffff:0:0]" || IPV4_MAPPED_LOOPBACK.test(host)) return true;
  return host === "0.0.0.0" || DOTTED_IPV4.exec(host)?.[1] === "127";
}

function decodedPath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
  const collapsed = decoded.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return new URL(collapsed, "http://host.invalid").pathname.toLowerCase();
}

/**
 * Whether `url` reaches the host MCP gateway, in any spelling a client resolves to it: a loopback
 * host by any name or address form, the gateway's port, and a path under its prefix once decoded.
 * Broader than `isHostMcpRuntimeUrl`, which accepts only the one spelling the gateway hands out:
 * this decides what is gated and badged, so a spelling the contract helper misses must not escape.
 */
export function isHostGatewayUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.port !== PORT || !isLoopbackHost(parsed.hostname)) return false;
  const path = decodedPath(parsed.pathname);
  return path === PREFIX || path.startsWith(`${PREFIX}/`);
}
