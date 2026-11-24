import { createEffect, createSignal, on, type Accessor } from "solid-js";

import type {
  OpenworkRuntimeSettings,
  OpenworkRuntimeSettingsPatch,
} from "~/shared/platform/transport/openwork-server";

export type OpenworkRuntimeSettingsClient = {
  getRuntimeSettings: (workspaceId: string) => Promise<OpenworkRuntimeSettings>;
  patchRuntimeSettings: (
    workspaceId: string,
    patch: OpenworkRuntimeSettingsPatch,
  ) => Promise<OpenworkRuntimeSettings>;
};

export type UseOpenworkRuntimeSettingsDeps = {
  openworkServerStatus: Accessor<string>;
  openworkServerClient: Accessor<OpenworkRuntimeSettingsClient | null>;
  openworkServerWorkspaceId: Accessor<string | null>;
  safeStringify: (value: unknown) => string;
};

export function useOpenworkRuntimeSettings(deps: UseOpenworkRuntimeSettingsDeps) {
  const [runtimeSettings, setRuntimeSettings] =
    createSignal<OpenworkRuntimeSettings | null>(null);
  const [runtimeSettingsStatus, setRuntimeSettingsStatus] = createSignal<
    "idle" | "loading" | "saving" | "error"
  >("idle");
  const [runtimeSettingsError, setRuntimeSettingsError] = createSignal<
    string | null
  >(null);

  const refreshRuntimeSettings = async () => {
    const owClient = deps.openworkServerClient();
    const workspaceId = deps.openworkServerWorkspaceId();
    const normalizedWorkspaceId = workspaceId?.trim() ?? "";
    if (!owClient || !normalizedWorkspaceId) {
      setRuntimeSettings(null);
      setRuntimeSettingsStatus("idle");
      return;
    }
    setRuntimeSettingsStatus("loading");
    setRuntimeSettingsError(null);
    try {
      setRuntimeSettings(
        await owClient.getRuntimeSettings(normalizedWorkspaceId),
      );
      setRuntimeSettingsStatus("idle");
    } catch (error) {
      setRuntimeSettingsStatus("error");
      setRuntimeSettingsError(
        error instanceof Error ? error.message : deps.safeStringify(error),
      );
    }
  };

  const saveRuntimeSettings = async (patch: OpenworkRuntimeSettingsPatch) => {
    const owClient = deps.openworkServerClient();
    const workspaceId = deps.openworkServerWorkspaceId();
    const normalizedWorkspaceId = workspaceId?.trim() ?? "";
    if (!owClient || !normalizedWorkspaceId) {
      throw new Error("OpenWork server is not connected.");
    }
    setRuntimeSettingsStatus("saving");
    setRuntimeSettingsError(null);
    try {
      const next = await owClient.patchRuntimeSettings(
        normalizedWorkspaceId,
        patch,
      );
      setRuntimeSettings(next);
      setRuntimeSettingsStatus("idle");
    } catch (error) {
      setRuntimeSettingsStatus("error");
      const message =
        error instanceof Error ? error.message : deps.safeStringify(error);
      setRuntimeSettingsError(message);
      throw error;
    }
  };

  createEffect(
    on(
      () =>
        [
          deps.openworkServerStatus(),
          deps.openworkServerClient(),
          deps.openworkServerWorkspaceId(),
        ] as const,
      ([status, owClient, workspaceId]) => {
        if (status !== "connected" || !owClient || !workspaceId?.trim()) {
          setRuntimeSettings(null);
          setRuntimeSettingsStatus("idle");
          setRuntimeSettingsError(null);
          return;
        }
        void refreshRuntimeSettings();
      },
    ),
  );

  return {
    runtimeSettings,
    runtimeSettingsStatus,
    runtimeSettingsError,
    refreshRuntimeSettings,
    saveRuntimeSettings,
  };
}
