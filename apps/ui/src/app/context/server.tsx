import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type ParentProps } from "solid-js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { isWebDeployment } from "../lib/openwork-deployment";
import { readOpenworkServerSettings } from "../lib/openwork-server";
import { isTauriRuntime } from "../utils";

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function serverDisplayName(url: string) {
  if (!url) return "";
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

type ServerContextValue = {
  url: string;
  name: string;
  list: string[];
  healthy: () => boolean | undefined;
  token: () => string;
  setActive: (url: string) => void;
  add: (url: string) => void;
  remove: (url: string) => void;
};

const ServerContext = createContext<ServerContextValue | undefined>(undefined);

export function ServerProvider(props: ParentProps & { defaultUrl: string }) {
  const [list, setList] = createSignal<string[]>([]);
  const [active, setActiveRaw] = createSignal("");
  const [healthy, setHealthy] = createSignal<boolean | undefined>(undefined);
  const [ready, setReady] = createSignal(false);

  const readStoredList = () => {
    try {
      const raw = window.localStorage.getItem("openwork.server.list");
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  };

  const readStoredActive = () => {
    try {
      const stored = window.localStorage.getItem("openwork.server.active");
      return typeof stored === "string" ? stored : "";
    } catch {
      return "";
    }
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (ready()) return;

    const fallback = normalizeServerUrl(props.defaultUrl) ?? "";

    // In hosted web deployments served by OpenWork, OpenCode
    // traffic should go through the server proxy (usually same-origin `/opencode`).
    // Do not reuse any persisted localhost targets.
    const forceProxy =
      !isTauriRuntime() &&
      isWebDeployment() &&
      (import.meta.env.PROD ||
        (typeof import.meta.env?.VITE_OPENWORK_URL === "string" &&
          import.meta.env.VITE_OPENWORK_URL.trim().length > 0));
    if (forceProxy && fallback) {
      setList([fallback]);
      setActiveRaw(fallback);
      setReady(true);
      return;
    }

    const storedList = readStoredList();
    const storedActive = normalizeServerUrl(readStoredActive());

    // [Remote-first] When no fallback URL is provided (remote-first mode),
    // filter out stale loopback addresses from localStorage to prevent
    // auto-connecting to a local server that isn't running.
    // In Tauri mode, the backend IS local (native services on localhost), so
    // loopback URLs are legitimate and must NOT be filtered out.
    const isRemoteFirst = !fallback;
    const shouldFilterLoopback = isRemoteFirst && !isTauriRuntime();
    const isLoopback = (url: string) => {
      try {
        const h = new URL(url).hostname;
        return h === "127.0.0.1" || h === "localhost" || h === "::1";
      } catch {
        return false;
      }
    };
    const cleanList = shouldFilterLoopback ? storedList.filter((u) => !isLoopback(u)) : storedList;
    const cleanActive =
      shouldFilterLoopback && storedActive && isLoopback(storedActive) ? undefined : storedActive;

    const initialList = cleanList.length ? cleanList : fallback ? [fallback] : [];
    const initialActive = cleanActive || initialList[0] || fallback || "";

    setList(initialList);
    setActiveRaw(initialActive);
    setReady(true);
  });

  createEffect(() => {
    if (!ready()) return;
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem("openwork.server.list", JSON.stringify(list()));
      window.localStorage.setItem("openwork.server.active", active());
    } catch {
      // ignore
    }
  });

  const activeUrl = createMemo(() => active());

  const readOpenworkToken = () => {
    try {
      return readOpenworkServerSettings().token ?? "";
    } catch {
      return "";
    }
  };

  // Reactive mirror of the OpenWork token.  localStorage writes do not fire
  // 'storage' events in the same window, so writeOpenworkServerSettings emits
  // a custom 'openwork:token-changed' event that we listen to here.  This
  // signal is consumed by GlobalSDKProvider so the SDK client (and SSE event
  // subscriber) rebuilds with a fresh Authorization header when the backend
  // manager rotates the OWT token.
  const [token, setToken] = createSignal<string>(
    typeof window === "undefined" ? "" : readOpenworkToken(),
  );

  if (typeof window !== "undefined") {
    const onTokenChanged = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      const next = typeof detail === "string" ? detail.trim() : readOpenworkToken();
      setToken(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== "openwork.server.token") return;
      setToken(readOpenworkToken());
    };
    window.addEventListener("openwork:token-changed", onTokenChanged as EventListener);
    window.addEventListener("storage", onStorage);
    onCleanup(() => {
      window.removeEventListener("openwork:token-changed", onTokenChanged as EventListener);
      window.removeEventListener("storage", onStorage);
    });
  }

  const checkHealth = async (url: string) => {
    if (!url) return false;
    const token = readOpenworkToken();
    const headers = token && url.includes("/opencode") ? { Authorization: `Bearer ${token}` } : undefined;
    const client = createOpencodeClient({
      baseUrl: url,
      headers,
      signal: AbortSignal.timeout(3000),
      fetch: isTauriRuntime() ? tauriFetch : undefined,
    });
    return client.global
      .health()
      .then((result) => result.data?.healthy === true)
      .catch(() => false);
  };

  createEffect(() => {
    const url = activeUrl();
    if (!url) return;

    setHealthy(undefined);

    let activeRun = true;
    let busy = false;

    const run = () => {
      if (busy) return;
      busy = true;
      void checkHealth(url)
        .then((next) => {
          if (!activeRun) return;
          setHealthy(next);
        })
        .finally(() => {
          busy = false;
        });
    };

    run();
    const interval = window.setInterval(run, 10_000);

    onCleanup(() => {
      activeRun = false;
      window.clearInterval(interval);
    });
  });

  const setActive = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;
    setActiveRaw(next);
  };

  const add = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;

    setList((current) => {
      if (current.includes(next)) return current;
      return [...current, next];
    });
    setActiveRaw(next);
  };

  const remove = (input: string) => {
    const next = normalizeServerUrl(input);
    if (!next) return;

    setList((current) => current.filter((item) => item !== next));
    setActiveRaw((current) => {
      if (current !== next) return current;
      const remaining = list().filter((item) => item !== next);
      return remaining[0] ?? "";
    });
  };

  const value: ServerContextValue = {
    get url() {
      return activeUrl();
    },
    get name() {
      return serverDisplayName(activeUrl());
    },
    get list() {
      return list();
    },
    healthy,
    token,
    setActive,
    add,
    remove,
  };

  return <ServerContext.Provider value={value}>{props.children}</ServerContext.Provider>;
}

export function useServer() {
  const context = useContext(ServerContext);
  if (!context) {
    throw new Error("Server context is missing");
  }
  return context;
}
