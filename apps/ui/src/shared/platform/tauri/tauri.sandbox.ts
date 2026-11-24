import { invoke } from "@tauri-apps/api/core";
import type { EngineDoctorResult, EngineInfo, OpenworkServerInfo } from "./tauri.engine";

export async function openworkServerInfo(): Promise<OpenworkServerInfo> {
  return invoke<OpenworkServerInfo>("openwork_server_info");
}

export async function openworkServerRestart(): Promise<OpenworkServerInfo> {
  return invoke<OpenworkServerInfo>("openwork_server_restart");
}

export async function engineInfo(): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_info");
}

export async function engineDoctor(options?: {
  preferSidecar?: boolean;
  opencodeBinPath?: string | null;
}): Promise<EngineDoctorResult> {
  return invoke<EngineDoctorResult>("engine_doctor", {
    preferSidecar: options?.preferSidecar ?? false,
    opencodeBinPath: options?.opencodeBinPath ?? null,
  });
}
