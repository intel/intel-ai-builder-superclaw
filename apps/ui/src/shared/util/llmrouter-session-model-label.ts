import { formatModelRouteLabel } from "./model-ref";

// Session-level labels show the route or model, not the internal provider.
export function formatLlmRouterSessionModelLabel(modelID: string): string {
  return formatModelRouteLabel(modelID) ?? modelID;
}

// Composer only presents LLMRouter routes, so it uses compact route labels.
export function formatComposerModelLabel(label: string): string {
  return formatModelRouteLabel(label) ?? label;
}
