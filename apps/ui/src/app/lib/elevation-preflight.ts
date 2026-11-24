/**
 * Startup elevation gate. The verdict is decided in Rust `setup()` before ServiceHub would start (#3176);
 * this only reads it. Fails open: an unknown verdict never blocks a healthy app.
 */
import { isTauriRuntime } from "../utils";

export async function fetchElevationBlocked(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<boolean>("get_elevation_blocked")) === true;
  } catch (error) {
    console.error("[elevation-preflight] failed to read verdict", error);
    return false;
  }
}
