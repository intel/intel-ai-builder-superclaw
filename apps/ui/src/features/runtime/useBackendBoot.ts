import { batch, createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { OwtTokenResult } from "~/shared/platform/transport/servicehub";
import { owtProvisionRefusalText } from "~/shared/platform/capability/activation-error-text";
import type { ServiceHubBootSnapshot, ServiceHubReadyPayload } from "~/shared/platform/tauri";
import type { UiLogOptions } from "~/shared/platform/log/log";
import type { BackendBootSnapshotLike, RecoverableBootSnapshot } from "~/shared/util/backend-boot-policy";
type RuntimeBootStage = string | null;

export type RuntimeBootState = {
  stage: Accessor<RuntimeBootStage>;
  message: Accessor<string | null>;
  pct: Accessor<number | null>;
  error: Accessor<string | null>;
  ready: Accessor<boolean>;
  serviceHubReadyWithoutDataPlane: Accessor<boolean>;
  serviceHubBootActive: Accessor<boolean>;
  setStage: (
    value: RuntimeBootStage | ((prev: RuntimeBootStage) => RuntimeBootStage),
  ) => void;
  setMessage: (value: string | null) => void;
  setPct: (value: number | null) => void;
  setError: (value: string | null) => void;
  setReady: (value: boolean) => void;
  setServiceHubReadyWithoutDataPlane: (value: boolean) => void;
  setServiceHubBootActive: (value: boolean) => void;
  reset: () => void;
  applyProgress: (input: {
    stage?: string | null;
    message?: string | null;
    pct?: number | null;
    error?: string | null;
    ready?: boolean;
  }) => void;
};

export type RuntimeBootLifecycleDeps = {
  runtimeBoot: RuntimeBootState;
  isTauriRuntime: () => boolean;
  readOpenworkServerSettings: () => {
    hubUrl?: string | null;
    hubToken?: string | null;
    [key: string]: unknown;
  };
  writeOpenworkServerSettings: (settings: Record<string, unknown>) => unknown;
  setOpenworkServerSettings: (settings: unknown) => void;
  setStartupPreference: (value: string | null) => void;
  refreshLlmRouterProviders: () => Promise<unknown>;
  uiLogInfo: (
    stage: string,
    message: string,
    payload?: Record<string, unknown>,
  ) => void;
  uiLogWarn: (
    stage: string,
    message: string,
    payload?: Record<string, unknown>,
    options?: UiLogOptions,
  ) => void;
  uiLogError: (
    stage: string,
    message: string,
    payload?: Record<string, unknown>,
  ) => void;
  uiLogDebug: (
    stage: string,
    message: string,
    payload?: Record<string, unknown>,
  ) => void;
  setUiBootId: (bootId: string) => void;
  getServiceHubBootSnapshot: () => Promise<ServiceHubBootSnapshot>;
  getRecoverableBootSnapshot: (
    snapshot: BackendBootSnapshotLike,
  ) => RecoverableBootSnapshot | null;
  fetchOwtToken: (
    hubUrl: string,
    hubToken: string,
  ) => Promise<OwtTokenResult>;
  refreshManagedWorkspaceToken: (
    settings: { baseUrl: string; token: string },
    syncToken: RuntimeBootLifecycleDeps["workspaceStore"]["onBackendTokenRefresh"],
    requestId: string,
  ) => Promise<OwtTokenResult>;
  server: {
    add: (url: string) => void;
  };
  workspaceStore: {
    onBackendTokenRefresh: (
      token: string,
      url: string,
      metadata?: {
        requestId: string;
        attempt: number;
        tokenCreatedAt: string;
        tokenScope: string;
        tokenRevision: string | null;
      },
    ) => Promise<void>;
  };
  listen: <T>(
    eventName: string,
    handler: (event: { payload: T }) => void,
  ) => Promise<() => void>;
  startupOwtToken: () => string | null;
  DEFAULT_OPENWORK_SERVER_PORT: number;
  OWT_EXPIRED_EVENT: string;
};

// This hook tracks backend boot progress and readiness without embedding the
// actual startup orchestration logic into the root app component.
export function useRuntimeBoot(
  options?: {
    initialStage?: RuntimeBootStage;
    isDesktop?: boolean;
  },
): RuntimeBootState {
  const initialStage =
    options?.initialStage ?? (options?.isDesktop ? "initializing" : null);
  const [stage, setStageSignal] = createSignal<RuntimeBootStage>(initialStage);
  const [message, setMessage] = createSignal<string | null>(null);
  const [pct, setPct] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [ready, setReady] = createSignal(false);
  const [serviceHubReadyWithoutDataPlane, setServiceHubReadyWithoutDataPlane] =
    createSignal(false);
  const [serviceHubBootActive, setServiceHubBootActive] = createSignal(false);

  const setStage = (
    value: RuntimeBootStage | ((prev: RuntimeBootStage) => RuntimeBootStage),
  ) => {
    if (typeof value === "function") {
      setStageSignal((prev) => value(prev));
      return;
    }
    setStageSignal(value);
  };

  const applyProgress = (input: {
    stage?: string | null;
    message?: string | null;
    pct?: number | null;
    error?: string | null;
    ready?: boolean;
  }) => {
    batch(() => {
      if (input.stage !== undefined) setStage(input.stage);
      if (input.message !== undefined) setMessage(input.message);
      if (input.pct !== undefined) setPct(input.pct);
      if (input.error !== undefined) setError(input.error);
      if (input.ready !== undefined) setReady(input.ready);
    });
  };

  const reset = () => {
    batch(() => {
      setStageSignal(initialStage);
      setMessage(null);
      setPct(null);
      setError(null);
      setReady(false);
      setServiceHubReadyWithoutDataPlane(false);
      setServiceHubBootActive(false);
    });
  };

  return {
    stage,
    message,
    pct,
    error,
    ready,
    serviceHubReadyWithoutDataPlane,
    serviceHubBootActive,
    setStage,
    setMessage,
    setPct,
    setError,
    setReady,
    setServiceHubReadyWithoutDataPlane,
    setServiceHubBootActive,
    applyProgress,
    reset,
  };
}

export type BackendBootOverlayDeps = {
  runtimeBoot: RuntimeBootState;
  isTauriRuntime: () => boolean;
  retryServiceHubBoot: () => Promise<unknown>;
  uiLogError: (
    stage: string,
    message: string,
    payload?: Record<string, unknown>,
  ) => void;
  getBackendRetryPolicy: (stage: string | null) => {
    action: string;
    label: string;
  };
};

export function useBackendBootOverlay(deps: BackendBootOverlayDeps) {
  const stage = deps.runtimeBoot.stage;
  const message = deps.runtimeBoot.message;
  const pct = deps.runtimeBoot.pct;
  const error = deps.runtimeBoot.error;
  const ready = deps.runtimeBoot.ready;

  const retryDisabled = () =>
    deps.getBackendRetryPolicy(stage()).action === "wait";

  const onRetry = () => {
    const currentStage = stage();
    const policy = deps.getBackendRetryPolicy(currentStage);
    if (policy.action === "wait") return;

    deps.runtimeBoot.setError(null);
    deps.runtimeBoot.setReady(false);
    deps.runtimeBoot.setStage("retrying");
    deps.runtimeBoot.setMessage("Retrying…");
    deps.runtimeBoot.setPct(null);

    const runRetry = async () => {
      deps.runtimeBoot.setServiceHubBootActive(true);
      await deps.retryServiceHubBoot();
      return true;
    };

    void runRetry().catch((retryError) => {
      const nextError =
        retryError instanceof Error ? retryError.message : String(retryError);
      deps.uiLogError("host.retry", "ServiceHub retry failed", {
        error: nextError,
      });
      deps.runtimeBoot.setError(nextError);
      deps.runtimeBoot.setStage("error");
    });
  };

  return {
    stage,
    message,
    pct,
    error,
    ready,
    retryDisabled,
    onRetry,
  };
}

export function useRuntimeBootLifecycle(deps: RuntimeBootLifecycleDeps) {
  const { runtimeBoot } = deps;

  createEffect(() => {
    if (!deps.isTauriRuntime()) return;

    const unlisteners: Array<() => void> = [];
    let readySeenViaEvent = false;

    const logBootTimeline = (
      timeline: Array<{ elapsedMs: number; status: string; stage: string; message?: string }> | undefined,
      totalElapsedMs: number | null | undefined,
    ) => {
      if (!timeline || timeline.length === 0) return;
      const failed = timeline.filter((entry) => entry.status === "fail");
      const lines = timeline.map(
        (entry) =>
          `[+${(entry.elapsedMs / 1000).toFixed(2)}s] ${entry.status.toUpperCase().padEnd(4)} ${entry.stage}` +
          (entry.status === "fail" ? ` <- ${entry.message ?? "unknown failure"}` : ""),
      );
      const summary = {
        totalSeconds:
          typeof totalElapsedMs === "number"
            ? Number((totalElapsedMs / 1000).toFixed(2))
            : undefined,
        stageCount: timeline.length,
        failedStages: failed.map((entry) => entry.stage),
        lines,
      };

      if (failed.length > 0) {
        deps.uiLogError(
          "boot.timeline",
          `ServiceHub boot FAILED at ${failed.map((entry) => entry.stage).join(", ")}`,
          summary,
        );
      } else {
        deps.uiLogInfo(
          "boot.timeline",
          `Host boot timeline (${timeline.length} stages` +
            (summary.totalSeconds !== undefined ? `, ${summary.totalSeconds}s` : "") +
            "); Runtime readiness is separate",
          summary,
        );
      }
    };

    const applyServiceHubReady = (payload: {
      hubUrl: string;
      hubToken: string;
      openworkUrl?: string | null;
      owtToken?: string | null;
    }) => {
      deps.uiLogInfo("ready", "ServiceHub is ready", {
        hubUrl: payload.hubUrl,
        hasDataPlane: Boolean(payload.openworkUrl?.trim() && payload.owtToken?.trim()),
      });

      runtimeBoot.setServiceHubBootActive(true);
      runtimeBoot.setStage("ready");
      runtimeBoot.setMessage("ServiceHub is ready");
      runtimeBoot.setPct(1);
      runtimeBoot.setError(null);

      const openworkUrl = payload.openworkUrl?.trim() ?? "";
      const owtToken = payload.owtToken?.trim() ?? "";
      if (!openworkUrl || !owtToken) {
        deps.uiLogInfo("ready", "armed OWT poll (ready payload carried no data plane)", {
          hubUrl: payload.hubUrl,
        });
        const settings = deps.writeOpenworkServerSettings({
          hubUrl: payload.hubUrl,
          hubToken: payload.hubToken,
        });
        deps.setOpenworkServerSettings(settings);
        runtimeBoot.setServiceHubReadyWithoutDataPlane(true);
        runtimeBoot.setReady(true);
        return;
      }

      deps.uiLogInfo("ready", "using baked data-plane token from ready payload", {
        hubUrl: payload.hubUrl,
        openworkUrl,
      });
      runtimeBoot.setServiceHubReadyWithoutDataPlane(false);
      runtimeBoot.setReady(false);

      const settings = deps.writeOpenworkServerSettings({
        hubUrl: payload.hubUrl,
        hubToken: payload.hubToken,
        urlOverride: openworkUrl,
        token: owtToken,
      });
      deps.setOpenworkServerSettings(settings);
      void deps.refreshLlmRouterProviders().catch(() => undefined);
      deps.setStartupPreference("server");

      try {
        window.localStorage.setItem("openwork.onboardingComplete", "1");
      } catch {
        // ignore
      }

      const opencodeUrl = openworkUrl.replace(/\/+$/, "") + "/opencode";
      deps.server.add(opencodeUrl);

      void deps.workspaceStore
        .onBackendTokenRefresh(owtToken, openworkUrl)
        .finally(() => {
          runtimeBoot.setReady(true);
        });
    };

    const setup = async () => {
      unlisteners.push(
        await deps.listen<{ hubUrl: string; hubToken: string; openworkUrl?: string | null; owtToken?: string | null; }>(
          "superclaw://servicehub-ready",
          (event) => {
            readySeenViaEvent = true;
            applyServiceHubReady(event.payload);
            void deps.getServiceHubBootSnapshot()
              .then((snap) => logBootTimeline(snap.timeline, snap.totalElapsedMs))
              .catch(() => undefined);
          },
        ),
      );

      unlisteners.push(
        await deps.listen<string>("superclaw://servicehub-error", (event) => {
          deps.uiLogError("host.failed", "ServiceHub startup failed", {
            error: event.payload,
          });
          runtimeBoot.setServiceHubBootActive(true);
          runtimeBoot.setError(event.payload);
          runtimeBoot.setStage((stage) => stage ?? "error");
          void deps.getServiceHubBootSnapshot()
            .then((snap) => logBootTimeline(snap.timeline, snap.totalElapsedMs))
            .catch(() => undefined);
        }),
      );

      unlisteners.push(
        await deps.listen<{ stage: string; message: string; pct: number | null; error: string | null }>(
          "superclaw://servicehub-progress",
          (event) => {
            const { stage, message, pct, error: errMsg } = event.payload;
            if (errMsg) {
              deps.uiLogError("host.progress", message, { stage, pct, error: errMsg });
            } else {
              deps.uiLogInfo("host.progress", message, { stage, pct });
            }

            runtimeBoot.applyProgress({
              stage,
              message,
              pct,
              error: errMsg ?? null,
              ready: false,
            });
            runtimeBoot.setServiceHubBootActive(true);
            runtimeBoot.setReady(false);
          },
        ),
      );

      try {
        const snap = await deps.getServiceHubBootSnapshot();
        deps.setUiBootId(snap.bootId ?? "");
        deps.uiLogInfo("boot.snapshot", "recovered ServiceHub boot snapshot", {
          ready: snap.ready,
          stage: snap.stage,
        });
        if (readySeenViaEvent) {
          deps.uiLogInfo(
            "boot.snapshot",
            "skip snapshot recovery: ready already handled via event",
            { ready: snap.ready, stage: snap.stage },
          );
          return;
        }
        logBootTimeline(snap.timeline, snap.totalElapsedMs);
        if (snap.ready && snap.readyPayload) {
          deps.uiLogInfo("ready", "Recovered an already-ready ServiceHub from boot snapshot");
          applyServiceHubReady(snap.readyPayload);
          return;
        }
        const recovered = deps.getRecoverableBootSnapshot({
          ready: snap.ready ?? false,
          stage: snap.stage ?? null,
          message: snap.message ?? null,
          pct: snap.pct ?? null,
          error: snap.error ?? null,
          readyPayload: (snap.readyPayload ?? null) as ServiceHubReadyPayload | null,
        });
        if (recovered) {
          deps.uiLogInfo("host.progress", "Recovered ServiceHub boot progress from snapshot", {
            stage: recovered.stage,
          });
          runtimeBoot.setReady(false);
          runtimeBoot.setServiceHubBootActive(true);
          runtimeBoot.setStage(recovered.stage ?? runtimeBoot.stage());
          runtimeBoot.setMessage(recovered.message ?? null);
          runtimeBoot.setPct(recovered.pct ?? null);
          runtimeBoot.setError(recovered.error ?? null);
        }
      } catch (error) {
        deps.uiLogWarn("boot.snapshot", "ServiceHub boot snapshot check failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void setup().catch((error) => {
      deps.uiLogError("boot.listeners", "Failed to set up ServiceHub event listeners", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    onCleanup(() => {
      for (const fn of unlisteners) fn();
    });
  });

  createEffect(() => {
    if (!runtimeBoot.serviceHubReadyWithoutDataPlane()) return;

    const settings = deps.readOpenworkServerSettings();
    const hubUrl = settings.hubUrl?.trim() ?? "";
    const hubToken = settings.hubToken?.trim() ?? "";
    if (!hubUrl || !hubToken) return;
    // Tracked on purpose: a new startup stash re-arms this poll, which is how a
    // Profile committed after reveal (a late Edge connect, #3531) reaches the
    // workspace even after the attempts below ran out.
    const startupStash = deps.startupOwtToken();

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const POLL_INTERVAL_MS = 5_000;
    const MAX_POLL_ATTEMPTS = 120;
    let attempts = 0;
    const pollStartedAt = Date.now();
    let lastLoggedCode: string | null = null;
    const requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `owt-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    deps.uiLogInfo("runtime.ready", "OWT poll armed; awaiting workspace token", {
      requestId,
      maxAttempts: MAX_POLL_ATTEMPTS,
      intervalMs: POLL_INTERVAL_MS,
      hasStartupStash: Boolean(startupStash),
    });

    const poll = async () => {
      if (cancelled) return;
      if (attempts >= MAX_POLL_ATTEMPTS) {
        deps.uiLogError("runtime.owt", "Workspace token polling exceeded its attempt limit", {
          attempts: MAX_POLL_ATTEMPTS,
          lastCode: lastLoggedCode,
        });
        return;
      }
      attempts++;

      const stashed = attempts === 1 ? startupStash : null;
      const result = stashed
        ? ({ ok: true, token: stashed, scope: "", createdAt: "", revision: null, code: "OK", status: "ok", message: "stashed token" } as const)
        : await deps.fetchOwtToken(hubUrl, hubToken);

      if (cancelled) return;

      if (result.ok) {
        const openworkUrl = `http://127.0.0.1:${deps.DEFAULT_OPENWORK_SERVER_PORT}`;
        deps.uiLogInfo("runtime.ready", "Workspace token acquired; connecting data plane", {
          requestId,
          openworkUrl,
          attempts,
          status: "succeeded",
          elapsedMs: Date.now() - pollStartedAt,
          tokenCreatedAt: result.createdAt,
          tokenScope: result.scope,
          tokenRevision: result.revision,
        });

        batch(() => {
          runtimeBoot.setServiceHubReadyWithoutDataPlane(false);
          runtimeBoot.setReady(false);
        });

        const nextSettings = deps.writeOpenworkServerSettings({
          hubUrl,
          hubToken,
          urlOverride: openworkUrl,
          token: result.token,
        });
        deps.setOpenworkServerSettings(nextSettings);
        deps.setStartupPreference("server");

        try {
          window.localStorage.setItem("openwork.onboardingComplete", "1");
        } catch {
          // ignore
        }

        const opencodeUrl = openworkUrl.replace(/\/+$/, "") + "/opencode";
        deps.server.add(opencodeUrl);

        void deps.workspaceStore
          .onBackendTokenRefresh(result.token ?? "", openworkUrl, {
            requestId,
            attempt: attempts,
            tokenCreatedAt: result.createdAt,
            tokenScope: result.scope,
            tokenRevision: result.revision,
          })
          .finally(() => {
            runtimeBoot.setReady(true);
          });
        return;
      }

      if (result.code !== lastLoggedCode) {
        deps.uiLogWarn(
          "runtime.owt",
          "Workspace token readiness changed",
          {
            requestId,
            attempt: attempts,
            previousCode: lastLoggedCode,
            code: result.code,
            status: result.status,
            message: result.message,
            retryable: result.retryable,
          },
          {
            aggregate: {
              key: `owt-readiness:${result.code}`,
              windowMs: 60_000,
            },
          },
        );
        lastLoggedCode = result.code ?? null;
      }

      if (result.retryable && !cancelled) {
        timerId = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } else {
        deps.uiLogError("runtime.owt", "Workspace token polling stopped on a terminal error", {
          code: result.code,
          status: result.status,
          message: result.message,
        });
        // The sandbox refused its provision: say why instead of leaving "Connecting".
        // The ready payload without a data plane already set `ready`, which hides the overlay, so
        // clear it too, or the refusal and its Retry stay invisible.
        const provisionRefusal = owtProvisionRefusalText(result);
        if (provisionRefusal) {
          batch(() => {
            runtimeBoot.setReady(false);
            runtimeBoot.setStage("error");
            runtimeBoot.setError(provisionRefusal);
          });
        }
      }
    };

    void poll();

    onCleanup(() => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!runtimeBoot.serviceHubBootActive()) return;

    let refreshing = false;
    const handler = () => {
      if (refreshing) return;

      const settings = deps.readOpenworkServerSettings();
      const hubUrl = settings.hubUrl?.trim() ?? "";
      const hubToken = settings.hubToken?.trim() ?? "";
      if (!hubUrl || !hubToken) return;

      refreshing = true;
      const requestId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `owt-refresh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      deps.uiLogDebug("runtime.owt", "Workspace token expired; refreshing", {
        requestId,
      });
      void (async () => {
        try {
          const result = await deps.refreshManagedWorkspaceToken(
            { baseUrl: hubUrl, token: hubToken },
            deps.workspaceStore.onBackendTokenRefresh,
            requestId,
          );
          if (!result.ok) {
            deps.uiLogWarn(
              "runtime.owt",
              "Workspace token refresh failed",
              {
                requestId,
                code: result.code,
                status: result.status,
                message: result.message,
              },
              {
                aggregate: {
                  key: `owt-refresh:${result.code}`,
                  windowMs: 60_000,
                },
              },
            );
            return;
          }
          deps.uiLogDebug("runtime.owt", "Workspace token refreshed successfully", {
            requestId,
            status: "succeeded",
            tokenCreatedAt: result.createdAt,
            tokenScope: result.scope,
            tokenRevision: result.revision,
          });
        } catch (error) {
          deps.uiLogWarn("runtime.owt", "Workspace token refresh could not reconnect", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          refreshing = false;
        }
      })();
    };

    window.addEventListener(deps.OWT_EXPIRED_EVENT, handler);
    onCleanup(() => window.removeEventListener(deps.OWT_EXPIRED_EVENT, handler));
  });
}
