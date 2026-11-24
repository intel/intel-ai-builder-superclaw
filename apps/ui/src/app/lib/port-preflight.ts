/**
 * Client for the startup port-conflict gate.
 *
 * The probe itself runs in Rust during Tauri `setup()`, before any managed
 * service is spawned — see `apps/desktop/src-tauri/src/port_preflight`. This
 * module only reads the cached verdict.
 */
import { isTauriRuntime } from "../utils";

/** One occupied port, mirroring the Rust `PortConflict` payload. */
export type PortConflict = {
  port: number;
  /** Stable service id (e.g. `llmrouter_manager`), used for the i18n lookup. */
  service: string;
  bindHost: string;
  /** Image name of the holding process, when it could be resolved. */
  ownerName: string | null;
  /** PID of the holding process, when it could be resolved. */
  ownerPid: number | null;
};

/** Mirrors the Rust `PortPreflightReport` payload. */
export type PortPreflightReport = {
  conflicts: PortConflict[];
  checkedPorts: number[];
};

/**
 * Read the cached port-preflight verdict.
 *
 * Returns `null` — meaning "do not block" — whenever the verdict is unknown:
 * outside the Tauri runtime (browser dev), when the probe never ran, or when the
 * command itself fails. Failing open is deliberate: this gate exists to give a
 * clear message for a specific, detectable condition, and must never be the
 * reason a healthy app refuses to start.
 */
export async function fetchPortPreflightReport(): Promise<PortPreflightReport | null> {
  if (!isTauriRuntime()) return null;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const report = await invoke<PortPreflightReport | null>("get_port_preflight_report");
    if (!report || !Array.isArray(report.conflicts)) return null;
    return report;
  } catch (error) {
    console.error("[port-preflight] failed to read report", error);
    return null;
  }
}

/** Quit the app. The port holder is external, so exiting is the only action. */
export async function exitApp(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-process");
    await mod.exit(0);
  } catch {
    window.close();
  }
}
