/**
 * The custom PII category selection used when `piiLevel === "custom"`.
 *
 * The selection is persisted to localStorage so it survives a reload, which
 * means it can outlive the server-side category list it was chosen from. Every
 * path that loads or stores the selection therefore re-sanitizes it against the
 * allowlist the server currently reports, and a category the server no longer
 * offers is dropped rather than masked blindly.
 */
import { createEffect, createSignal, on } from "solid-js";
import type { Accessor } from "solid-js";

import type { OpenworkServerClient, PiiCategories } from "./lib/openwork-server";

const PII_CUSTOM_CATS_KEY = "openwork.pii-custom-categories.v1";

/**
 * Trims, de-duplicates and (when an allowlist is supplied) filters a stored or
 * user-supplied category list. An empty allowlist means "not known yet", so the
 * list passes through rather than being emptied.
 */
export const sanitizeCustomPiiCategories = (
  cats: unknown,
  allowlist: readonly string[] = [],
): string[] => {
  if (!Array.isArray(cats)) return [];
  const allowed = new Set<string>(allowlist);
  const enforceAllowlist = allowed.size > 0;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cat of cats) {
    if (typeof cat !== "string") continue;
    const normalized = cat.trim();
    if (
      !normalized ||
      (enforceAllowlist && !allowed.has(normalized)) ||
      seen.has(normalized)
    )
      continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

/** Reads the persisted selection. The allowlist is not known this early, so the
 * stored values are only normalized, not filtered. */
export const readStoredCustomPiiCategories = (): string[] => {
  try {
    const raw =
      typeof window !== "undefined"
        ? window.localStorage.getItem(PII_CUSTOM_CATS_KEY)
        : null;
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return sanitizeCustomPiiCategories(parsed);
  } catch {
    return [];
  }
};

const persistCustomPiiCategories = (cats: readonly string[]) => {
  try {
    window.localStorage.setItem(PII_CUSTOM_CATS_KEY, JSON.stringify(cats));
  } catch {
    /* ignore */
  }
};

type PiiCategoriesDeps = {
  openworkServerClient: Accessor<OpenworkServerClient | null>;
  openworkServerWorkspaceId: Accessor<string | null>;
};

export const createPiiCategories = (deps: PiiCategoriesDeps) => {
  const { openworkServerClient, openworkServerWorkspaceId } = deps;

  const [piiCategories, setPiiCategories] = createSignal<PiiCategories | null>(
    null,
  );
  const [customPiiCategories, setCustomPiiCategoriesSignal] = createSignal<
    string[]
  >(readStoredCustomPiiCategories());

  const setCustomPiiCategories = (cats: string[]) => {
    const sanitized = sanitizeCustomPiiCategories(
      cats,
      piiCategories()?.all_categories ?? [],
    );
    setCustomPiiCategoriesSignal(sanitized);
    persistCustomPiiCategories(sanitized);
  };

  createEffect(
    on(
      () => [openworkServerClient(), openworkServerWorkspaceId()] as const,
      ([client, workspaceId]) => {
        if (!client || workspaceId == null || !workspaceId.trim()) {
          setPiiCategories(null);
          return;
        }
        void client
          .getPiiCategories(workspaceId.trim())
          .then((categories) => {
            setPiiCategories(categories);
            // The stored selection predates this list; re-check it.
            const sanitized = sanitizeCustomPiiCategories(
              customPiiCategories(),
              categories.all_categories,
            );
            setCustomPiiCategoriesSignal(sanitized);
            persistCustomPiiCategories(sanitized);
          })
          .catch(() => undefined);
      },
    ),
  );

  return { customPiiCategories, setCustomPiiCategories };
};
