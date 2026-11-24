import { ApiError } from "./errors.js";

type RuntimeControlInit = { method?: string; body?: unknown };

function getRuntimeControlConfig(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.OPENWORK_CONTROL_BASE_URL?.trim() ?? "";
  const token = process.env.OPENWORK_CONTROL_TOKEN?.trim() ?? "";
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export async function fetchRuntimeControl(path: string, init?: RuntimeControlInit): Promise<unknown> {
  const result = await fetchRuntimeControlResponse(path, init);
  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(result.status, "runtime_upgrade_failed", "Worker runtime control request failed", result.body);
  }
  return result.body;
}

export async function fetchRuntimeControlResponse(
  path: string,
  init?: RuntimeControlInit,
): Promise<{ status: number; body: unknown }> {
  const control = getRuntimeControlConfig();
  if (!control) {
    throw new ApiError(501, "runtime_upgrade_unavailable", "Worker runtime control is not configured on this host");
  }
  // egress-surface: openwork_supervisor_control
  const response = await fetch(`${control.baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${control.token}` },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}
