/**
 * Bind address for a listener the supervisor starts: the flag, then the environment, then loopback.
 *
 * Loopback is the default because every caller of these listeners is on the same machine, and a
 * launcher that omits the flag must not expose the listener on every interface. A blank value counts
 * as unset: uvicorn and Node both read an empty host as "all interfaces".
 */
export const DEFAULT_BIND_HOST = "127.0.0.1";

export function resolveBindHost(flag: string | undefined, env: string | undefined): string {
  return flag?.trim() || env?.trim() || DEFAULT_BIND_HOST;
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/** Address a local client dials to reach a listener bound to `bindHost`. */
export function connectableHost(bindHost: string): string {
  return isWildcardHost(bindHost) ? DEFAULT_BIND_HOST : bindHost;
}

/**
 * Host to put in the URLs the supervisor advertises, or undefined to let it pick a LAN address.
 *
 * A LAN address is only reachable when the listener binds every interface; for any other bind it
 * would point clients (the local channel router included) at an address nothing listens on.
 */
export function advertisedConnectHost(connectHost: string | undefined, bindHost: string): string | undefined {
  if (connectHost?.trim()) return connectHost;
  return isWildcardHost(bindHost) ? undefined : bindHost;
}
