import { requestServiceHubJson } from "./servicehub";

export type PrivacyModelsState =
  | "ready"
  | "downloading"
  | "verifying"
  | "activating"
  | "failed"
  | "disabled"
  | "pending"
  | "unsupported";

export type PrivacyModelsHealth = {
  models_state: PrivacyModelsState;
  models_done_bytes: number;
  models_total_bytes: number;
  models_error: string | null;
  models_present: boolean;
};

export function getPrivacyModelsHealth(
  baseUrl: string,
  token: string,
): Promise<PrivacyModelsHealth> {
  return requestServiceHubJson<unknown>(
    baseUrl,
    "/data-protection/v1/models/status",
    token,
    { timeoutMs: 30_000 },
  ).then(parsePrivacyModelsHealth);
}

export function preparePrivacyModels(baseUrl: string, token: string): Promise<unknown> {
  return requestServiceHubJson<unknown>(
    baseUrl,
    "/data-protection/v1/models/prepare",
    token,
    { method: "POST", timeoutMs: 10_000 },
  );
}

function parsePrivacyModelsHealth(value: unknown): PrivacyModelsHealth {
  if (typeof value !== "object" || value === null) {
    throw new Error("Privacy model status response is invalid.");
  }
  const status = value as Record<string, unknown>;
  const states: readonly string[] = [
    "ready",
    "downloading",
    "verifying",
    "activating",
    "failed",
    "disabled",
    "pending",
    "unsupported",
  ];
  if (
    typeof status.models_state !== "string" ||
    !states.includes(status.models_state) ||
    typeof status.models_done_bytes !== "number" ||
    !Number.isFinite(status.models_done_bytes) ||
    typeof status.models_total_bytes !== "number" ||
    !Number.isFinite(status.models_total_bytes) ||
    !(status.models_error === null || typeof status.models_error === "string") ||
    typeof status.models_present !== "boolean"
  ) {
    throw new Error("Privacy model status response is invalid.");
  }
  return status as PrivacyModelsHealth;
}