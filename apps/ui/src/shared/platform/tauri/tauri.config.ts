import { invoke } from "@tauri-apps/api/core";
import type { ExecResult } from "./tauri.skills";

export type OpencodeConfigFile = {
  path: string;
  exists: boolean;
  content: string | null;
};

export type UpdaterEnvironment = {
  supported: boolean;
  reason: string | null;
  executablePath: string | null;
  appBundlePath: string | null;
};

export async function updaterEnvironment(): Promise<UpdaterEnvironment> {
  return invoke<UpdaterEnvironment>("updater_environment");
}

export type AppUpdateManifest = {
  manifestUrl: string;
  channel: string;
  /** `owner/name` whose Releases the installer and homepage must belong to; null for a loopback test server. */
  releasesRepo: string | null;
  xml: string;
  /** The product version this build was stamped with; checks fail before fetching without one. */
  installedVersion: string;
};

/**
 * Fetch the XML upgrade manifest (raw) from the latest GitHub Release. Channel is chosen by
 * the SUPERCLAW_UPDATE_CHANNEL env var on the Rust side. Parsing happens in
 * `update-manifest.ts`.
 */
export async function checkAppUpdate(): Promise<AppUpdateManifest> {
  return invoke<AppUpdateManifest>("check_app_update");
}

/** Download the update's installer and verify its signature. Nothing is launched. */
export async function downloadAppUpdate(installUrl: string, version: string): Promise<void> {
  return invoke<void>("download_app_update", { installUrl, version });
}

/** Re-verify the downloaded installer and launch it; the app must exit once this resolves. */
export async function installAppUpdate(installParameters: string | null, version: string): Promise<void> {
  return invoke<void>("install_app_update", { installParameters, version });
}

export type AppUpdateProgressPayload = {
  phase: string;
  bytesDownloaded?: number;
  bytesTotal?: number;
  pct?: number | null;
};

export async function getAppUpdateProgress(): Promise<AppUpdateProgressPayload | null> {
  return invoke<AppUpdateProgressPayload | null>("get_app_update_progress");
}

/** The installed product version (e.g. 2.0.0.1117); null for a build that was not stamped with one. */
export async function getProductVersion(): Promise<string | null> {
  return invoke<string | null>("get_product_version");
}

export async function readOpencodeConfig(
  scope: "project" | "global",
  projectDir: string,
): Promise<OpencodeConfigFile> {
  return invoke<OpencodeConfigFile>("read_opencode_config", { scope, projectDir });
}

export async function writeOpencodeConfig(
  scope: "project" | "global",
  projectDir: string,
  content: string,
): Promise<ExecResult> {
  return invoke<ExecResult>("write_opencode_config", { scope, projectDir, content });
}

export type CacheResetResult = {
  removed: string[];
  missing: string[];
  errors: string[];
};

export async function resetOpencodeCache(): Promise<CacheResetResult> {
  return invoke<CacheResetResult>("reset_opencode_cache");
}
