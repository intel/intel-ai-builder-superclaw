import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { CapabilityGate } from "~/shared/platform/capability/capability-gate";
import PerfWeightSlider, { perfWeightSupported, resetPerfWeightCache } from "./perf-weight-slider";

const hoisted = vi.hoisted(() => ({
  forceCloudRouting: (() => false) as () => boolean,
  serverPerfWeight: 0.7,
  getResponses: [] as Array<Promise<{ perf_weight: number; supported: boolean }>>,
  completedGets: 0,
  requests: [] as Array<{ path: string; method: string; body: unknown }>,
}));

vi.mock("../lib/openwork-server", () => ({
  readOpenworkServerSettings: () => ({
    hubUrl: "http://127.0.0.1:1234",
    hubToken: "hub-token",
  }),
}));

// The slider saves through `../lib/servicehub` and reads through the ModelRouter
// adapter, which uses the shared transport. Both re-export one function, so
// mocking the shared module covers both paths.
vi.mock("~/shared/platform/transport/servicehub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/shared/platform/transport/servicehub")>()),
  requestServiceHubJson: async (
    _baseUrl: string,
    path: string,
    _token: string,
    opts?: { method?: string; body?: unknown },
  ) => {
    hoisted.requests.push({
      path,
      method: opts?.method ?? "GET",
      body: opts?.body,
    });
    if ((opts?.method ?? "GET") === "GET") {
      const response = hoisted.getResponses.shift();
      if (response) {
        const data = await response;
        hoisted.completedGets += 1;
        return data;
      }
      hoisted.completedGets += 1;
      return { perf_weight: hoisted.serverPerfWeight, supported: true };
    }
    return undefined;
  },
}));

vi.mock("~/shared/platform/capability/capability-gate", () => ({
  useCapabilityGate: () =>
    ({
      forceCloudRouting: () => hoisted.forceCloudRouting(),
    }) as unknown as CapabilityGate,
}));

const gets = () => hoisted.requests.filter((r) => r.method === "GET");
const puts = () => hoisted.requests.filter((r) => r.method === "PUT");
const readout = () => screen.queryByText(/^[01]\.\d{2}$/)?.textContent ?? null;

beforeEach(() => {
  hoisted.requests = [];
  hoisted.forceCloudRouting = () => false;
  hoisted.serverPerfWeight = 0.7;
  hoisted.getResponses = [];
  hoisted.completedGets = 0;
  resetPerfWeightCache();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("PerfWeightSlider force-cloud gate", () => {
  test("handles a round trip through the 0.8b Lite bundle without writing", async () => {
    const [forceCloud, setForceCloud] = createSignal(false);
    hoisted.forceCloudRouting = forceCloud;

    render(() => <PerfWeightSlider />);
    await waitFor(() => expect(readout()).toBe("0.70"));

    vi.useFakeTimers();
    setForceCloud(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(readout()).toBeNull();
    expect(puts()).toEqual([]);

    // Switching to edge commits a new primary bundle: the switch's migration
    // boundary already reset the persisted balance to 0.7, then the refreshed
    // capability profile releases the gate.
    vi.useRealTimers();
    hoisted.serverPerfWeight = 0.7;
    setForceCloud(false);

    await waitFor(() => expect(readout()).toBe("0.70"));
    expect(gets().length).toBe(2);
    expect(puts()).toEqual([]);
  });

  test("ignores an older read that completes after the post-switch read", async () => {
    let resolveInitial!: (value: { perf_weight: number; supported: boolean }) => void;
    let resolveRelease!: (value: { perf_weight: number; supported: boolean }) => void;
    hoisted.getResponses = [
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
      new Promise((resolve) => {
        resolveRelease = resolve;
      }),
    ];
    const [forceCloud, setForceCloud] = createSignal(true);
    hoisted.forceCloudRouting = forceCloud;

    render(() => <PerfWeightSlider />);
    await waitFor(() => expect(gets().length).toBe(1));
    setForceCloud(false);
    await waitFor(() => expect(gets().length).toBe(2));

    resolveRelease({ perf_weight: 0.7, supported: true });
    await waitFor(() => expect(readout()).toBe("0.70"));
    resolveInitial({ perf_weight: 1, supported: true });
    await waitFor(() => expect(hoisted.completedGets).toBe(2));

    expect(readout()).toBe("0.70");
  });

  test("an older read that lands late does not change what the search sees", async () => {
    let resolveInitial!: (value: { perf_weight: number; supported: boolean }) => void;
    let resolveRelease!: (value: { perf_weight: number; supported: boolean }) => void;
    hoisted.getResponses = [
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
      new Promise((resolve) => {
        resolveRelease = resolve;
      }),
    ];
    const [forceCloud, setForceCloud] = createSignal(true);
    hoisted.forceCloudRouting = forceCloud;

    render(() => <PerfWeightSlider />);
    await waitFor(() => expect(gets().length).toBe(1));
    setForceCloud(false);
    await waitFor(() => expect(gets().length).toBe(2));

    resolveRelease({ perf_weight: 0.7, supported: true });
    await waitFor(() => expect(readout()).toBe("0.70"));
    resolveInitial({ perf_weight: 1, supported: false });
    await waitFor(() => expect(hoisted.completedGets).toBe(2));

    expect(readout()).toBe("0.70");
    expect(perfWeightSupported()).toBe(true);
  });

  test("keeps the slider hidden when the post-switch read fails", async () => {
    const [forceCloud, setForceCloud] = createSignal(true);
    hoisted.forceCloudRouting = forceCloud;
    hoisted.serverPerfWeight = 1;

    render(() => <PerfWeightSlider />);
    await waitFor(() => expect(gets().length).toBe(1));
    hoisted.getResponses = [Promise.reject(new Error("unavailable"))];
    setForceCloud(false);

    await waitFor(() => expect(gets().length).toBe(2));
    expect(readout()).toBeNull();
    // The Settings search reads this, so it must not offer the hidden section.
    expect(perfWeightSupported()).toBe(false);
  });
});

describe("PerfWeightSlider after a tab switch", () => {
  test("a remount draws the last balance at once, before its read returns", async () => {
    const first = render(() => <PerfWeightSlider />);
    await waitFor(() => expect(readout()).toBe("0.70"));
    first.unmount();

    // The next read hangs, so only the cached value can be on screen.
    hoisted.getResponses = [new Promise(() => undefined)];
    render(() => <PerfWeightSlider />);
    expect(readout()).toBe("0.70");
  });

  test("unmounting before the 400ms debounce fires still sends the change, not discards it", async () => {
    const screen1 = render(() => <PerfWeightSlider />);
    await waitFor(() => expect(readout()).toBe("0.70"));

    const slider = screen1.getByRole("slider") as HTMLInputElement;
    fireEvent.input(slider, { target: { value: "0.4" } });
    fireEvent.change(slider, { target: { value: "0.4" } });

    // Leaving Settings (a tab switch, or "go to chat") unmounts the component
    // well inside the 400ms debounce window.
    screen1.unmount();

    await waitFor(() => expect(puts()).toEqual([{ path: "/llm-router/v1/perf-weight", method: "PUT", body: { perf_weight: 0.4 } }]));
  });
});
