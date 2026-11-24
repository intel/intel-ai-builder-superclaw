import {
  DEFAULT_MODEL,
  HIDE_TITLEBAR_PREF_KEY,
  MODEL_PREF_KEY,
  THINKING_PREF_KEY,
  VARIANT_PREF_KEY,
} from "../constants";
import { LEGACY_DEFAULT_MODEL } from "../lib/workspace-model-config";
import type { EngineRuntime, ModelRef } from "../types";
import { modelEquals, parseModelRef } from "~/shared/util/model-ref";
import { normalizeModelVariant } from "./model-variant";

type ReadableStorage = Pick<Storage, "getItem">;

/**
 * Preferences recovered from storage. `null` means "nothing usable was stored"
 * and the caller should leave its signal at the default, so every field is
 * nullable except the model, which always resolves to something.
 */
export type StoredPreferences = {
  baseUrl: string | null;
  clientDirectory: string | null;
  engineCustomBinPath: string | null;
  engineSource: "path" | "sidecar" | "custom" | null;
  engineRuntime: EngineRuntime | null;
  defaultModel: ModelRef;
  /** A recognised model was migrated, so the key is stale and wants rewriting. */
  defaultModelNeedsRewrite: boolean;
  showThinking: boolean | null;
  hideTitlebar: boolean | null;
  modelVariant: string | null;
  updateAutoCheck: boolean | null;
  updateLastCheckedAt: number | null;
};

/** A JSON-encoded boolean; anything else stored under the key is discarded. */
function readBoolean(raw: string | null): boolean | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `custom` is only honoured alongside a path to run, otherwise it would select
 * an engine binary that does not exist; those installs fall back to the
 * platform default.
 */
function readEngineSource(
  raw: string | null,
  customBinPath: string | null,
  isTauri: boolean,
): "path" | "sidecar" | "custom" | null {
  if (raw !== "path" && raw !== "sidecar" && raw !== "custom") return null;
  if (raw === "custom" && !(customBinPath ?? "").trim()) {
    return isTauri ? "sidecar" : "path";
  }
  return raw;
}

/**
 * Retires two older defaults: the model this app used to ship with, and any
 * `local-llm` pick from before local models were routed by bundle. Both become
 * the current default, and the caller rewrites the key so the migration sticks.
 *
 * A value that does not parse also falls back, but is not flagged: only a
 * recognised model is worth migrating in place.
 */
function readDefaultModel(raw: string | null): {
  value: ModelRef;
  needsRewrite: boolean;
} {
  const parsed = parseModelRef(raw);
  if (!parsed) return { value: DEFAULT_MODEL, needsRewrite: false };
  const superseded =
    modelEquals(parsed, LEGACY_DEFAULT_MODEL) ||
    parsed.providerID === "local-llm";
  return {
    value: superseded ? DEFAULT_MODEL : parsed,
    needsRewrite: superseded,
  };
}

/**
 * Reads every preference `App()` hydrates at startup and validates it, so the
 * caller is left with a plain "apply these" list and no parsing of its own.
 *
 * Pure apart from the reads: the two keys that need clearing and the model
 * rewrite are the caller's to perform.
 *
 * In Tauri the stored `baseUrl` is deliberately ignored — OpenCode takes a
 * random port on every launch, so a cached URL is always stale. Web builds
 * connect to a fixed server and still need it.
 */
export function readStoredPreferences(
  storage: ReadableStorage,
  options: { isTauri: boolean },
): StoredPreferences {
  const read = (key: string) => storage.getItem(key);

  const engineCustomBinPath = read("openwork.engineCustomBinPath");
  const engineRuntime = read("openwork.engineRuntime");
  const updateAutoCheck = read("openwork.updateAutoCheck");
  const updateLastCheckedAt = Number(read("openwork.updateLastCheckedAt"));
  const defaultModel = readDefaultModel(read(MODEL_PREF_KEY));

  return {
    baseUrl: options.isTauri ? null : read("openwork.baseUrl") || null,
    clientDirectory: read("openwork.clientDirectory") || null,
    engineCustomBinPath: engineCustomBinPath || null,
    engineSource: readEngineSource(
      read("openwork.engineSource"),
      engineCustomBinPath,
      options.isTauri,
    ),
    engineRuntime:
      engineRuntime === "direct" || engineRuntime === "openwork-orchestrator"
        ? engineRuntime
        : null,
    defaultModel: defaultModel.value,
    defaultModelNeedsRewrite: defaultModel.needsRewrite,
    showThinking: readBoolean(read(THINKING_PREF_KEY)),
    hideTitlebar: readBoolean(read(HIDE_TITLEBAR_PREF_KEY)),
    modelVariant: normalizeModelVariant(read(VARIANT_PREF_KEY)),
    updateAutoCheck:
      updateAutoCheck === "1" ? true : updateAutoCheck === "0" ? false : null,
    updateLastCheckedAt:
      Number.isFinite(updateLastCheckedAt) && updateLastCheckedAt > 0
        ? updateLastCheckedAt
        : null,
  };
}
