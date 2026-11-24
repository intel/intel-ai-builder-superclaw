/**
 * G1 — unmounted Profile fetch/retry provider.
 *
 * Fetches `GET /app/capability-profile` whenever Host settings become a
 * valid `{baseUrl, token}` pair, retries a 503 ("Profile not active yet")
 * indefinitely with a capped backoff, and otherwise classifies failures into
 * a single `transport_error` state. Not wired into the root tree in this
 * Push — Push 8 mounts it under `HostClientProvider`, fed by
 * `useHostClient().settings`.
 *
 * As with `host-client-provider.tsx`, the request/retry state machine is a
 * plain, Solid-free `AppCapabilityController` so its retry timing and
 * cancellation rules can be unit tested with an injected fetcher + retry
 * scheduler, without rendering anything or waiting on real timers.
 */
import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentComponent,
} from "solid-js";
import type {
  ActiveAppCapabilityProfile,
  RecoveryAppCapabilityProfile,
} from "@different-ai/openwork-contracts/capability";

import { ServiceHubHttpError, ServiceHubResponseError, requestServiceHubJson, type ServiceHubSettings } from "~/shared/platform/transport/servicehub";
import { AppCapabilityProfileParseError, parseAppCapabilityProfile } from "./app-capability-profile";

export type AppCapabilityTransportErrorKind = "http" | "network" | "contract";

export type AppCapabilityState =
  | { status: "loading" }
  | { status: "initializing" }
  | { status: "active"; profile: ActiveAppCapabilityProfile }
  | { status: "recovery"; profile: RecoveryAppCapabilityProfile }
  | {
      status: "transport_error";
      error: { kind: AppCapabilityTransportErrorKind; code?: string; message: string };
    };

type Cancel = () => void;

/** Testable seam for retry timing: production schedules a real timer. */
export type RetryScheduler = (callback: () => void, delayMs: number) => Cancel;

/** Testable seam for the network call: production hits ServiceHub over HTTP. */
export type AppCapabilityFetcher = (settings: ServiceHubSettings, signal: AbortSignal) => Promise<unknown>;

const CAPABILITY_PROFILE_PATH = "/app/capability-profile";

/** Production fetcher: GET the endpoint. Schema validation happens in the controller. */
export async function fetchAppCapabilityProfileJson(
  settings: ServiceHubSettings,
  signal: AbortSignal,
): Promise<unknown> {
  return requestServiceHubJson<unknown>(settings.baseUrl, CAPABILITY_PROFILE_PATH, settings.token, { signal });
}

const defaultScheduleRetry: RetryScheduler = (callback, delayMs) => {
  const id = setTimeout(callback, delayMs);
  return () => clearTimeout(id);
};

// No Retry-After: 500ms → 1s → 2s → 4s → 8s → 10s, then capped at 10s.
const NO_RETRY_AFTER_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
const MAX_RETRY_DELAY_MS = 10_000;

function computeRetryDelayMs(retryAfterMs: number | undefined, attempt: number): number {
  if (typeof retryAfterMs === "number") {
    return Math.min(Math.max(0, retryAfterMs), MAX_RETRY_DELAY_MS);
  }
  const index = Math.min(Math.max(attempt - 1, 0), NO_RETRY_AFTER_BACKOFF_MS.length - 1);
  return NO_RETRY_AFTER_BACKOFF_MS[index];
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function settingsEqual(a: ServiceHubSettings | null, b: ServiceHubSettings | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.baseUrl === b.baseUrl && a.token === b.token;
}

type TransportErrorState = Extract<AppCapabilityState, { status: "transport_error" }>;

type ClassifiedError =
  | { retryable503: true; profileInitializing: boolean; retryAfterMs?: number }
  | { retryable503: false; error: TransportErrorState };

function classifyError(err: unknown): ClassifiedError {
  if (err instanceof ServiceHubHttpError) {
    if (err.status === 503) {
      return {
        retryable503: true,
        profileInitializing: err.code === "capability_profile_initializing",
        retryAfterMs: err.retryAfterMs,
      };
    }
    return {
      retryable503: false,
      error: { status: "transport_error", error: { kind: "http", code: err.code, message: err.message } },
    };
  }
  if (err instanceof ServiceHubResponseError || err instanceof AppCapabilityProfileParseError) {
    return {
      retryable503: false,
      error: { status: "transport_error", error: { kind: "contract", message: err.message } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { retryable503: false, error: { status: "transport_error", error: { kind: "network", message } } };
}

export type AppCapabilityController = {
  getState(): AppCapabilityState;
  setSettings(settings: ServiceHubSettings | null): void;
  refresh(): Promise<void>;
  subscribe(listener: (state: AppCapabilityState) => void): Cancel;
  dispose(): void;
};

export type AppCapabilityControllerOptions = {
  fetcher?: AppCapabilityFetcher;
  scheduleRetry?: RetryScheduler;
};

/**
 * Pure, Solid-free fetch/retry state machine. `generation` is bumped on every
 * settings change and on dispose, so a stale in-flight request or a stale
 * scheduled retry can never clobber a newer Host's result.
 */
export function createAppCapabilityController(options: AppCapabilityControllerOptions = {}): AppCapabilityController {
  const fetcher = options.fetcher ?? fetchAppCapabilityProfileJson;
  const scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry;

  let state: AppCapabilityState = { status: "loading" };
  let currentSettings: ServiceHubSettings | null = null;
  let abortController: AbortController | null = null;
  let cancelRetry: Cancel | null = null;
  let attempt = 0;
  let generation = 0;
  const listeners = new Set<(state: AppCapabilityState) => void>();

  const notify = () => {
    for (const listener of listeners) listener(state);
  };

  const setState = (next: AppCapabilityState) => {
    state = next;
    notify();
  };

  const stopPending = () => {
    abortController?.abort();
    abortController = null;
    cancelRetry?.();
    cancelRetry = null;
  };

  const runFetch = async (settings: ServiceHubSettings, gen: number) => {
    const controller = new AbortController();
    abortController = controller;
    try {
      const raw = await fetcher(settings, controller.signal);
      if (gen !== generation) return; // a newer Host superseded this request
      const profile = parseAppCapabilityProfile(raw);
      attempt = 0;
      if (profile.lifecycle_state === "active") {
        setState({ status: "active", profile });
      } else {
        setState({ status: "recovery", profile });
      }
    } catch (err) {
      if (gen !== generation) return;
      if (isAbortError(err)) return; // caller-driven abort — never surfaces as an error

      const classified = classifyError(err);
      if (classified.retryable503) {
        attempt += 1;
        if (classified.profileInitializing) setState({ status: "initializing" });
        const delayMs = computeRetryDelayMs(classified.retryAfterMs, attempt);
        cancelRetry = scheduleRetry(() => {
          if (gen !== generation) return;
          void runFetch(settings, gen);
        }, delayMs);
        return; // stays "loading" while retrying
      }

      setState(classified.error);
    }
  };

  return {
    getState: () => state,
    setSettings(settings) {
      if (settingsEqual(settings, currentSettings)) return;
      stopPending();
      currentSettings = settings;
      attempt = 0;
      generation += 1;
      setState({ status: "loading" });
      if (settings) {
        void runFetch(settings, generation);
      }
    },
    async refresh() {
      if (!currentSettings) return;
      stopPending();
      attempt = 0;
      generation += 1;
      await runFetch(currentSettings, generation);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stopPending();
      generation += 1;
      listeners.clear();
    },
  };
}

export type AppCapabilityContextValue = {
  state: Accessor<AppCapabilityState>;
  activeProfile: Accessor<ActiveAppCapabilityProfile | null>;
  recovery: Accessor<RecoveryAppCapabilityProfile | null>;
  refresh: () => Promise<void>;
};

const AppCapabilityContext = createContext<AppCapabilityContextValue>();

export { AppCapabilityContext };

/**
 * Not mounted anywhere yet — Push 8 mounts this under `HostClientProvider`
 * and feeds it `useHostClient().settings`.
 */
export const AppCapabilityProfileProvider: ParentComponent<{
  settings: Accessor<ServiceHubSettings | null>;
  options?: AppCapabilityControllerOptions;
}> = (props) => {
  const controller = createAppCapabilityController(props.options);
  const [state, setState] = createSignal<AppCapabilityState>(controller.getState());

  const unsubscribe = controller.subscribe(setState);

  createEffect(() => {
    controller.setSettings(props.settings());
  });

  onCleanup(() => {
    unsubscribe();
    controller.dispose();
  });

  const activeProfile: Accessor<ActiveAppCapabilityProfile | null> = () => {
    const current = state();
    return current.status === "active" ? current.profile : null;
  };
  const recovery: Accessor<RecoveryAppCapabilityProfile | null> = () => {
    const current = state();
    return current.status === "recovery" ? current.profile : null;
  };

  return (
    <AppCapabilityContext.Provider value={{ state, activeProfile, recovery, refresh: () => controller.refresh() }}>
      {props.children}
    </AppCapabilityContext.Provider>
  );
};

export function useAppCapability(): AppCapabilityContextValue {
  const ctx = useContext(AppCapabilityContext);
  if (!ctx) throw new Error("useAppCapability must be used within AppCapabilityProfileProvider");
  return ctx;
}
