export type MaskingSummary = {
  entityCount: number;
  categories: Array<{ category: string; count: number }>;
};

export function extractMaskingSummary(value: unknown): MaskingSummary | null {
  if (!value || typeof value !== "object") return null;

  const record = value as {
    entity_count?: unknown;
    categories?: unknown;
  };
  const entityCount = record.entity_count;
  if (
    typeof entityCount !== "number" ||
    !Number.isSafeInteger(entityCount) ||
    entityCount <= 0 ||
    !Array.isArray(record.categories) ||
    record.categories.length === 0
  ) {
    return null;
  }

  const categories: Array<{ category: string; count: number }> = [];
  const seen = new Set<string>();
  for (const item of record.categories) {
    if (!item || typeof item !== "object") return null;
    const categoryRecord = item as { category?: unknown; count?: unknown };
    const category = categoryRecord.category;
    const count = categoryRecord.count;
    if (
      typeof category !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/.test(category) ||
      seen.has(category) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      return null;
    }
    seen.add(category);
    categories.push({ category, count });
  }

  const categoryTotal = categories.reduce((total, item) => total + item.count, 0);
  if (categoryTotal !== entityCount) return null;

  return { entityCount, categories };
}

export function formatMaskingCategory(category: string): string {
  return category
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}