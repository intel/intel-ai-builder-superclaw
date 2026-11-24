/**
 * When a Settings card is shown. Each card and the Settings search call the
 * same predicate, so search never offers a card that is not there (#3836).
 * Gmail's lives with Gmail, in `pages/settings.gmail-credentials.ts`.
 */
import type { CapabilityGate } from "~/shared/platform/capability/capability-gate";
import type { UpdaterEnvironment } from "./tauri";
import { isTauriRuntime } from "../utils";

type Gate = Pick<CapabilityGate, "isActive" | "hdrEnabled" | "forceCloudRouting">;

/** Telemetry and file cleanup act on the installed app, so the browser build has neither. */
export const desktopSettingVisible = (): boolean => isTauriRuntime();

/** Retired under capability gating; dark-safe, so shown until a Profile is active. */
export const backendLifecycleVisible = (capability: Gate): boolean =>
  isTauriRuntime() && !capability.isActive();

/** Hybrid Deep Research exists only when the Profile enables it; dark-safe. */
export const hdrPrivacyVisible = (capability: Gate): boolean =>
  !capability.isActive() || capability.hdrEnabled();

/** A Profile that forces cloud routing leaves nothing to balance. */
export const perfWeightVisible = (capability: Gate): boolean => !capability.forceCloudRouting();

export const updateBarVisible = (env: UpdaterEnvironment | null | undefined): boolean =>
  isTauriRuntime() && env?.supported !== false;
