import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";

import { HostMcpApiError } from "~/shared/platform/transport/host-mcp-api";
import type { ServiceHubSettings } from "~/shared/platform/transport/servicehub";
import { useHostMcpEarlyWake, type HostMcpWakeClient } from "./host-mcp-early-wake";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
});

const HUB: ServiceHubSettings = { baseUrl: "http://127.0.0.1:18800", token: "hub-token" };

function mount(options: { listed?: boolean; catalogFailures?: number; settings?: ServiceHubSettings | null; enabled?: boolean } = {}) {
  const calls: string[] = [];
  let catalogFailures = options.catalogFailures ?? 0;
  const client: HostMcpWakeClient = {
    hasService: async () => {
      calls.push("catalog");
      if (catalogFailures > 0) {
        catalogFailures -= 1;
        throw new HostMcpApiError("unreachable", null);
      }
      return options.listed ?? true;
    },
    listServers: async (wake) => {
      calls.push(wake?.cold ? "wake" : "list");
      return [];
    },
  };
  const [settings, setSettings] = createSignal<ServiceHubSettings | null>(options.settings === undefined ? HUB : options.settings);
  const [enabled, setEnabled] = createSignal(options.enabled ?? true);
  const woken = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return useHostMcpEarlyWake({ settings, enabled, createClient: () => client });
  });
  return { calls, woken, setSettings, setEnabled };
}

describe("waking the host MCP gateway early", () => {
  test("wakes it once ServiceHub is ready and the Profile allows it, with no runtime in sight", async () => {
    const { calls, woken } = mount();
    await vi.waitFor(() => expect(woken()).toBe(true));

    expect(calls).toEqual(["catalog", "wake"]);
  });

  test("waits for ServiceHub's settings and the Profile flag, then wakes once", async () => {
    const { calls, woken, setSettings, setEnabled } = mount({ settings: null, enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([]);

    setSettings(HUB);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([]);

    setEnabled(true);
    await vi.waitFor(() => expect(woken()).toBe(true));
    setSettings({ ...HUB, token: "rotated" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toEqual(["catalog", "wake"]);
  });

  test("does not wake a gateway this build does not register", async () => {
    const { calls, woken } = mount({ listed: false });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toEqual(["catalog"]);
    expect(woken()).toBe(false);
  });

  test("asks the catalog again while ServiceHub cannot answer it yet", async () => {
    vi.useFakeTimers();
    const { calls, woken } = mount({ catalogFailures: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["catalog"]);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(calls).toEqual(["catalog", "catalog", "wake"]);
    expect(woken()).toBe(true);
  });

  test("is mounted outside the startup resolver, which waits for the runtime", () => {
    const entry = readFileSync(join(__dirname, "..", "..", "app", "entry.tsx"), "utf8");
    const bridge = entry.slice(entry.indexOf("function CapabilityProfileBridge"), entry.indexOf("export default function AppEntry"));

    expect(bridge.indexOf("<HostMcpEarlyWake")).toBeGreaterThan(-1);
    expect(bridge.indexOf("<HostMcpEarlyWake")).toBeLessThan(bridge.indexOf("<CapabilityStartupResolver"));
  });
});
