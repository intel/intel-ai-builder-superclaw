export function hostTokenHeaders(hostToken: string): Record<string, string> {
  return { "X-OpenWork-Host-Token": hostToken };
}

export async function verifyHostProxyAccess(url: string, hostToken: string): Promise<void> {
  // egress-surface: supervisor_openwork_api
  const response = await fetch(url, {
    headers: hostTokenHeaders(hostToken),
    signal: AbortSignal.timeout(3000),
  });
  if (response.status >= 500) {
    throw new Error(`opencodeRouter mount proxy (host auth) returned ${response.status}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("opencodeRouter mount proxy /config/groups rejected host auth");
  }
}
