import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir, exists } from "./utils.js";

export const SUPERCLAW_RUNTIME_SETTINGS_FILE = "superclaw-runtime-config.json";
const LEGACY_RUNTIME_SETTINGS_PATH = "/config/opencode/superclaw-runtime-config.json";
const LEGACY_TAVILY_MIGRATION_MARKER = ".legacy-tavily-key-migrated-v1";
const HOST_OWNED_TAVILY_API_KEY = "The Tavily API key is saved outside the sandbox in this version of SuperClaw.";

export type DeepResearchLocalFilePrivacy = "share_with_cloud" | "do_not_share_with_cloud";

export type SuperclawRuntimeSettings = {
  schemaVersion: 1;
  updatedAt: number | null;
  search: { tavilyApiKey: string };
  deepResearch: { localFilePrivacy: DeepResearchLocalFilePrivacy };
};

// This file sits in the file_tool tier's data directory, which the agent's shell can read. When the
// Connector is required the host keeps the Tavily key, so this file neither takes nor reports it.
function tavilyApiKeyIsHostOwned(): boolean {
  return process.env.SUPERCLAW_CONNECTOR_REQUIRED?.trim() === "1";
}

export function superclawRuntimeSettingsPath(): string {
  const configDir = process.env.SC_RUNTIME_CONFIG_DIR?.trim()
    || "/data/superclaw/runtime";
  return join(configDir, SUPERCLAW_RUNTIME_SETTINGS_FILE);
}

export function defaultSuperclawRuntimeSettings(): SuperclawRuntimeSettings {
  return {
    schemaVersion: 1,
    updatedAt: null,
    search: { tavilyApiKey: "" },
    deepResearch: { localFilePrivacy: "do_not_share_with_cloud" },
  };
}

export function normalizeDeepResearchLocalFilePrivacy(value: unknown): DeepResearchLocalFilePrivacy | null {
  return value === "share_with_cloud" || value === "do_not_share_with_cloud" ? value : null;
}

export function normalizeSuperclawRuntimeSettings(input: unknown): SuperclawRuntimeSettings {
  const defaults = defaultSuperclawRuntimeSettings();
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaults;
  const record = input as Record<string, unknown>;
  const search = record.search && typeof record.search === "object" && !Array.isArray(record.search)
    ? record.search as Record<string, unknown>
    : {};
  const deepResearch = record.deepResearch && typeof record.deepResearch === "object" && !Array.isArray(record.deepResearch)
    ? record.deepResearch as Record<string, unknown>
    : {};
  const localFilePrivacy = normalizeDeepResearchLocalFilePrivacy(deepResearch.localFilePrivacy)
    ?? defaults.deepResearch.localFilePrivacy;
  return {
    schemaVersion: 1,
    updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : null,
    search: {
      tavilyApiKey: typeof search.tavilyApiKey === "string" ? search.tavilyApiKey : "",
    },
    deepResearch: { localFilePrivacy },
  };
}

export async function readSuperclawRuntimeSettings(): Promise<SuperclawRuntimeSettings> {
  const path = superclawRuntimeSettingsPath();
  if (!(await exists(path))) return defaultSuperclawRuntimeSettings();
  try {
    return normalizeSuperclawRuntimeSettings(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return defaultSuperclawRuntimeSettings();
  }
}

export function serializeSuperclawRuntimeSettings(settings: SuperclawRuntimeSettings) {
  return {
    schemaVersion: settings.schemaVersion,
    updatedAt: settings.updatedAt,
    // An app of an earlier build reads search.tavilyApiKeySet without checking that it exists.
    // While the host owns the key this file never knows it, so it reports "not set"; the app
    // asks the host for the real answer.
    search: {
      tavilyApiKeySet: !tavilyApiKeyIsHostOwned() && settings.search.tavilyApiKey.trim().length > 0,
    },
    deepResearch: { localFilePrivacy: settings.deepResearch.localFilePrivacy },
  };
}

export async function writeSuperclawRuntimeSettings(settings: SuperclawRuntimeSettings): Promise<void> {
  await writeJsonAtomic(superclawRuntimeSettingsPath(), settings);
}

export async function migrateLegacyTavilyApiKey(
  legacyPath = LEGACY_RUNTIME_SETTINGS_PATH,
): Promise<boolean> {
  if (tavilyApiKeyIsHostOwned()) return false;
  const targetPath = superclawRuntimeSettingsPath();
  const markerPath = join(dirname(targetPath), LEGACY_TAVILY_MIGRATION_MARKER);
  if (await exists(markerPath)) return false;

  const current = await readSuperclawRuntimeSettings();
  let legacy = defaultSuperclawRuntimeSettings();
  try {
    legacy = normalizeSuperclawRuntimeSettings(JSON.parse(await readFile(legacyPath, "utf8")));
  } catch {
    // A fresh install or cleared user data has no legacy settings to migrate.
  }

  const tavilyApiKey = legacy.search.tavilyApiKey.trim();
  const migrated = !current.search.tavilyApiKey.trim() && Boolean(tavilyApiKey);
  if (migrated) {
    await writeJsonAtomic(targetPath, {
      ...current,
      updatedAt: Date.now(),
      search: { tavilyApiKey },
    });
  }
  await writeJsonAtomic(markerPath, { schemaVersion: 1 });
  return migrated;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
    await chmod(tmpPath, 0o600).catch(() => undefined);
    await rename(tmpPath, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

export async function patchSuperclawRuntimeSettings(
  patch: unknown,
  invalidPayload: (message: string) => Error,
): Promise<SuperclawRuntimeSettings> {
  const result = patchQueue.then(() => applyRuntimeSettingsPatch(patch, invalidPayload));
  patchQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

let patchQueue: Promise<unknown> = Promise.resolve();

async function applyRuntimeSettingsPatch(
  patch: unknown,
  invalidPayload: (message: string) => Error,
): Promise<SuperclawRuntimeSettings> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw invalidPayload("runtime settings patch must be an object");
  }
  const payload = patch as Record<string, unknown>;
  const hostOwnedKey = tavilyApiKeyIsHostOwned();
  if (hostOwnedKey && payload.search !== undefined) {
    throw invalidPayload(HOST_OWNED_TAVILY_API_KEY);
  }
  const current = await readSuperclawRuntimeSettings();
  const next: SuperclawRuntimeSettings = {
    ...current,
    search: { ...current.search },
    deepResearch: { ...current.deepResearch },
    updatedAt: Date.now(),
  };

  if (payload.search !== undefined) {
    if (!payload.search || typeof payload.search !== "object" || Array.isArray(payload.search)) {
      throw invalidPayload("search must be an object");
    }
    const search = payload.search as Record<string, unknown>;
    if (search.clearTavilyApiKey === true) {
      next.search.tavilyApiKey = "";
    } else if (typeof search.tavilyApiKey === "string" && search.tavilyApiKey.trim()) {
      next.search.tavilyApiKey = search.tavilyApiKey.trim();
    }
  }

  if (payload.deepResearch !== undefined) {
    if (!payload.deepResearch || typeof payload.deepResearch !== "object" || Array.isArray(payload.deepResearch)) {
      throw invalidPayload("deepResearch must be an object");
    }
    const localFilePrivacy = normalizeDeepResearchLocalFilePrivacy(
      (payload.deepResearch as Record<string, unknown>).localFilePrivacy,
    );
    if (!localFilePrivacy) {
      throw invalidPayload("deepResearch.localFilePrivacy is invalid");
    }
    next.deepResearch.localFilePrivacy = localFilePrivacy;
  }

  if (hostOwnedKey) next.search.tavilyApiKey = "";
  await writeSuperclawRuntimeSettings(next);
  return next;
}

export function deepResearchTierFromLocalFilePrivacy(value: DeepResearchLocalFilePrivacy): "0" | "2" {
  return value === "share_with_cloud" ? "0" : "2";
}
