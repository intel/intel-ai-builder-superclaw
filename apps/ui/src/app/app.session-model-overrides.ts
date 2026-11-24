/**
 * Reading and writing the per-session model overrides kept in localStorage,
 * keyed per workspace.
 *
 * All three are pure, which matters because the stored value is the one piece
 * of this state the app does not control: it survives upgrades, so the parser
 * has to cope with whatever another build wrote. It accepts both the
 * `"provider/model"` string form that `serializeSessionModelOverrides` below
 * emits and the `{ providerID, modelID }` object form, and discards anything
 * it cannot read rather than throwing —
 * a corrupt entry must not take the whole map down with it.
 */
import { SESSION_MODEL_PREF_KEY } from "~/shared/util/constants";
import { formatModelRef, parseModelRef } from "~/shared/util/model-ref";
import type { ModelRef } from "./types";

export const sessionModelOverridesKey = (workspaceId: string) =>
  `${SESSION_MODEL_PREF_KEY}.${workspaceId}`;

export const parseSessionModelOverrides = (
  raw: string | null,
): Record<string, ModelRef> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const next: Record<string, ModelRef> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const model = parseModelRef(value);
        if (model) next[sessionId] = model;
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (
        typeof record.providerID === "string" &&
        typeof record.modelID === "string"
      ) {
        next[sessionId] = {
          providerID: record.providerID,
          modelID: record.modelID,
        };
      }
    }
    return next;
  } catch {
    return {};
  }
};

/**
 * `null` for an empty map, which is the caller's signal to remove the key
 * rather than store `"{}"`.
 */
export const serializeSessionModelOverrides = (
  overrides: Record<string, ModelRef>,
): string | null => {
  const entries = Object.entries(overrides);
  if (!entries.length) return null;
  const payload: Record<string, string> = {};
  for (const [sessionId, model] of entries) {
    payload[sessionId] = formatModelRef(model);
  }
  return JSON.stringify(payload);
};
