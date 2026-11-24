/** Reasoning-effort variants a model can be run at, in menu order. */
export const MODEL_VARIANT_OPTIONS = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-High" },
];

/** Returns the canonical variant, or `null` if the input names no known one. */
export function normalizeModelVariant(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "balance" || trimmed === "balanced") return "none";
  const match = MODEL_VARIANT_OPTIONS.find(
    (option) => option.value === trimmed,
  );
  return match ? match.value : null;
}

/**
 * The `reasoning_effort` to send for a Codex model, or `undefined` to omit it.
 * Codex has no `xhigh`, so that maps down to `high`.
 */
export function resolveCodexReasoningEffort(
  modelID: string,
  variant: string | null,
): string | undefined {
  if (!modelID.trim().toLowerCase().includes("codex")) return undefined;
  const normalized = normalizeModelVariant(variant);
  if (!normalized || normalized === "none") return undefined;
  if (normalized === "xhigh") return "high";
  return normalized;
}

export function formatModelVariantLabel(value: string | null): string {
  const normalized = normalizeModelVariant(value) ?? "none";
  return (
    MODEL_VARIANT_OPTIONS.find((option) => option.value === normalized)
      ?.label ?? "None"
  );
}
