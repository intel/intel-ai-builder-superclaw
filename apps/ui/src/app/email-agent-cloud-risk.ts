import type { ModelRef } from "./types";

export function requiresEmailAgentCloudRiskConfirmation(
  agent: string | null,
  model: ModelRef,
): boolean {
  return (
    agent === "email-agent" &&
    model.providerID === "llmrouter" &&
    model.modelID === "cloud-model"
  );
}