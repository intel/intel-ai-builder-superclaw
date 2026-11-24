/**
 * G1 — unmounted Host client provider.
 *
 * Owns nothing today: this module is a leaf that is not wired into
 * `entry.tsx`/`app.tsx` in this Push. It will become the single owner of the
 * ServiceHub boot listeners (`servicehub-ready`/`servicehub-progress`/
 * `servicehub-error`) and the Hub URL/token authority in Push 8.
 *
 * The state machine is split from the Solid component on purpose: the
 * `HostClientController` below is plain TypeScript so its listener-ordering
 * and cleanup-race rules can be unit tested with a fake `HostBridge`, without
 * rendering anything.
 *
 * Forbidden dependencies (enforced by review, not by the type system): no
 * `@opencode-ai/sdk`, no OpenWork client, no `ServerContext`, no
 * workspace/session store, no `openwork-server.ts`, no localStorage. The Hub
 * token only ever lives in the in-memory state below.
 */
import {
  createContext,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentComponent,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";

import { getServiceHubBootSnapshot, type ServiceHubBootSnapshot, type ServiceHubReadyPayload } from "../lib/tauri";
import type { ServiceHubSettings } from "../lib/servicehub";
import { setUiBootId } from "../lib/log";
import { bridgeStartupClock } from "../lib/startup-timing";

export type Unlisten = () => void;

export type HostProgressPayload = {
  stage: string;
  message: string;
  pct: number | null;
  error?: string | null;
};

/** Testable seam: production uses `createDefaultHostBridge()`, tests inject a fake. */
export type HostBridge = {
  listenReady(handler: (payload: ServiceHubReadyPayload) => void): Promise<Unlisten>;
  listenProgress(handler: (payload: HostProgressPayload) => void): Promise<Unlisten>;
  listenError(handler: (message: string) => void): Promise<Unlisten>;
  getSnapshot(): Promise<ServiceHubBootSnapshot>;
};

export type HostClientState =
  | { status: "loading"; stage: string | null; message: string | null; pct: number | null }
  | { status: "ready"; client: ServiceHubSettings; stage: "ready"; message: string | null; pct: 1 }
  | { status: "error"; error: string; stage: string | null; message: string | null; pct: number | null };

const initialLoadingState = (): HostClientState => ({ status: "loading", stage: null, message: null, pct: null });

const SERVICEHUB_READY_EVENT = "superclaw://servicehub-ready";
const SERVICEHUB_PROGRESS_EVENT = "superclaw://servicehub-progress";
const SERVICEHUB_ERROR_EVENT = "superclaw://servicehub-error";

/** Production bridge: the real Tauri boot events + snapshot command. */
export function createDefaultHostBridge(): HostBridge {
  return {
    listenReady: (handler) =>
      listen<ServiceHubReadyPayload>(SERVICEHUB_READY_EVENT, (event) => handler(event.payload)),
    listenProgress: (handler) =>
      listen<HostProgressPayload>(SERVICEHUB_PROGRESS_EVENT, (event) => handler(event.payload)),
    listenError: (handler) => listen<string>(SERVICEHUB_ERROR_EVENT, (event) => handler(event.payload)),
    getSnapshot: () => getServiceHubBootSnapshot(),
  };
}

export type HostClientController = {
  getState(): HostClientState;
  getSettings(): ServiceHubSettings | null;
  subscribe(listener: (state: HostClientState) => void): Unlisten;
  dispose(): void;
};

/**
 * Pure, Solid-free state machine. Registers all three boot listeners first,
 * then reads the boot snapshot exactly once to recover any ready/progress
 * event that fired before the listeners attached (the REUSE race). Snapshot
 * and event paths always funnel through the same `applyReady`/`applyProgress`
 * /`applyError` functions so there is only one state-transition rule to
 * reason about.
 */
export function createHostClientController(bridge: HostBridge): HostClientController {
  let state: HostClientState = initialLoadingState();
  let settings: ServiceHubSettings | null = null;
  let disposed = false;
  const unlistens: Unlisten[] = [];
  const listeners = new Set<(state: HostClientState) => void>();

  const notify = () => {
    for (const listener of listeners) listener(state);
  };

  const setState = (next: HostClientState) => {
    state = next;
    notify();
  };

  const applyReady = (payload: ServiceHubReadyPayload) => {
    if (disposed) return;
    const next: ServiceHubSettings = { baseUrl: payload.hubUrl, token: payload.hubToken };
    settings = next;
    setState({ status: "ready", client: next, stage: "ready", message: null, pct: 1 });
  };

  const applyProgress = (payload: HostProgressPayload) => {
    if (disposed) return;
    setState({ status: "loading", stage: payload.stage, message: payload.message, pct: payload.pct });
  };

  const applyError = (message: string) => {
    if (disposed) return;
    settings = null;
    setState({ status: "error", error: message, stage: null, message: null, pct: null });
  };

  const applySnapshot = (snapshot: ServiceHubBootSnapshot) => {
    // Deliberately duplicates app.tsx's adoption, which is too late: app.tsx only
    // mounts after the reveal, leaving every pre-reveal line stamped `boot_id=-`.
    // Both setters are first-write-wins, so the later call no-ops.
    setUiBootId(snapshot.bootId);
    bridgeStartupClock(snapshot.totalElapsedMs);
    if (snapshot.ready && snapshot.readyPayload) {
      applyReady(snapshot.readyPayload);
      return;
    }
    if (snapshot.error) {
      applyError(snapshot.error);
      return;
    }
    if (snapshot.stage) {
      applyProgress({
        stage: snapshot.stage,
        message: snapshot.message ?? "",
        pct: snapshot.pct,
        error: snapshot.error,
      });
    }
  };

  // Registers `unlisten` immediately if we're already disposed instead of
  // leaking a live Tauri listener — the resolve-after-cleanup race.
  const track = (unlisten: Unlisten) => {
    if (disposed) {
      unlisten();
      return;
    }
    unlistens.push(unlisten);
  };

  const setup = async () => {
    track(await bridge.listenReady(applyReady));
    track(await bridge.listenProgress(applyProgress));
    track(await bridge.listenError(applyError));
    if (disposed) return;

    try {
      const snapshot = await bridge.getSnapshot();
      if (disposed) return;
      applySnapshot(snapshot);
    } catch {
      // Snapshot recovery is best-effort; the boot listeners remain the
      // source of truth and will still fire for an in-progress boot.
    }
  };

  void setup();

  return {
    getState: () => state,
    getSettings: () => settings,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      for (const unlisten of unlistens) unlisten();
      unlistens.length = 0;
      listeners.clear();
    },
  };
}

export type HostClientContextValue = {
  state: Accessor<HostClientState>;
  settings: Accessor<ServiceHubSettings | null>;
};

const HostClientContext = createContext<HostClientContextValue>();

/**
 * Not mounted anywhere yet (Push 8 wires this into the root tree). Kept
 * side-effect-free at module scope; all lifecycle work happens inside the
 * component via `createHostClientController`.
 */
export const HostClientProvider: ParentComponent<{ bridge?: HostBridge }> = (props) => {
  const controller = createHostClientController(props.bridge ?? createDefaultHostBridge());
  const [state, setState] = createSignal<HostClientState>(controller.getState());
  const [settings, setSettings] = createSignal<ServiceHubSettings | null>(controller.getSettings());

  const unsubscribe = controller.subscribe((next) => {
    setState(next);
    setSettings(controller.getSettings());
  });

  onCleanup(() => {
    unsubscribe();
    controller.dispose();
  });

  return <HostClientContext.Provider value={{ state, settings }}>{props.children}</HostClientContext.Provider>;
};

export function useHostClient(): HostClientContextValue {
  const ctx = useContext(HostClientContext);
  if (!ctx) throw new Error("useHostClient must be used within HostClientProvider");
  return ctx;
}
