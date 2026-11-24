import type { LlmRouterProviderModel } from "./llmrouter-client";

/** Display label for the cloud model combobox; persisted selection remains `model.id`. */
export function cloudModelDisplayLabel(
  modelId: string,
  options: readonly LlmRouterProviderModel[],
): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  const match = options.find((model) => model.id === trimmed);
  if (match && match.name.trim()) return match.name;
  return trimmed;
}
