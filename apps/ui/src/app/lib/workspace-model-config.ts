import { parse } from "jsonc-parser";

import { formatModelRef, modelEquals, parseModelRef } from "../utils";
import { DEFAULT_MODEL } from "../constants";
import type { ModelRef } from "../types";

// Legacy opencode default model, migrated to DEFAULT_MODEL on read.
export const LEGACY_DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  modelID: "big-pickle",
};

/** Reads the workspace default model out of raw opencode.jsonc content. */
export function parseDefaultModelFromConfig(
  content: string | null,
): ModelRef | null {
  if (!content) return null;
  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    const rawModel = typeof parsed?.model === "string" ? parsed.model : null;
    const model = parseModelRef(rawModel);
    if (!model) return null;
    return modelEquals(model, LEGACY_DEFAULT_MODEL) ? DEFAULT_MODEL : model;
  } catch {
    return null;
  }
}

/** Rewrites the `model` key in opencode.jsonc content, preserving everything else. */
export function formatConfigWithDefaultModel(
  content: string | null,
  model: ModelRef,
): string {
  let config: Record<string, unknown> = {};
  if (content?.trim()) {
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = { ...parsed };
      }
    } catch {
      config = {};
    }
  }

  if (!config["$schema"]) {
    config["$schema"] = "https://opencode.ai/config.json";
  }

  config.model = formatModelRef(model);
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Returns opencode.jsonc content with the `model` key stripped, for change-detection diffing. */
export function getConfigSnapshot(content: string | null): string {
  if (!content?.trim()) return "";
  try {
    const parsed = parse(content) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const copy = { ...parsed };
      delete copy.model;
      return JSON.stringify(copy);
    }
    return content;
  } catch {
    return content;
  }
}
