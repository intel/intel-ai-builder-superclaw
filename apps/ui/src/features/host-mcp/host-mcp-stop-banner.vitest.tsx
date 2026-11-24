import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostMcpServer, HostMcpStatus } from "@different-ai/openwork-contracts/host-mcp-api";

import { t } from "../../i18n";
import type { HostBarCall } from "./host-mcp";
import HostMcpStopBanner from "./host-mcp-stop-banner";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const status = (overrides: Partial<HostMcpStatus> = {}): HostMcpStatus => ({
  server_count: 1,
  running_count: 0,
  browser_configured: false,
  browser_active: false,
  session_locked: false,
  paused: false,
  active_calls: [],
  ...overrides,
});

const server = (name: string, state: HostMcpServer["state"] = "running"): HostMcpServer => ({
  name, command: ["uvx", name], environment_keys: [], approval_mode: "prompt",
  allow_when_locked: false, state, always_grants: [],
});

function renderBanner(
  initial: HostMcpStatus | null,
  servers: HostMcpServer[] | null = null,
  calls: { list?: HostBarCall[]; now?: () => number } = {},
) {
  const [current, setCurrent] = createSignal<HostMcpStatus | null>(initial);
  const [activeCalls, setActiveCalls] = createSignal<HostBarCall[]>(calls.list ?? []);
  const cancels: string[] = [];
  let stops = 0;
  let resumes = 0;
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(
    () => (
      <HostMcpStopBanner
        now={calls.now}
        host={{
          status: current,
          stopping: () => false,
          stopError: () => null,
          stopAll: async () => {
            stops += 1;
          },
          resuming: () => false,
          resumeError: () => null,
          resume: async () => {
            resumes += 1;
          },
          activeCalls,
          cancelling: () => new Set<string>(),
          cancelError: () => null,
          cancelCall: async (callId) => {
            cancels.push(callId);
          },
          approvals: { notices: () => [], dismissNotice: () => undefined, servers: () => servers },
        }}
      />
    ),
    root,
  );
  const get = (id: string) => root.querySelector<HTMLElement>(`[data-testid=${id}]`);
  const all = (id: string) => Array.from(root.querySelectorAll<HTMLElement>(`[data-testid=${id}]`));
  return { get, all, setCurrent, setActiveCalls, cancels, stops: () => stops, resumes: () => resumes };
}

const barCall = (overrides: Partial<HostBarCall> = {}): HostBarCall => ({
  call_id: "call-1",
  server: "windows-mcp",
  tool: "Click-Tool",
  state: "running",
  resume_in_ms: null,
  computer_use: false,
  resumeAt: null,
  ...overrides,
});

describe("HostMcpStopBanner: calls operating this computer", () => {
  const texts = (all: (id: string) => HTMLElement[]) => all("host-mcp-call-text").map((row) => row.textContent);

  test("a running call says what runs, and asks to keep off the mouse and keyboard only for computer use", () => {
    const { all } = renderBanner(status({ running_count: 1 }), null, {
      list: [barCall(), barCall({ call_id: "call-2", tool: "Type-Tool", computer_use: true })],
    });

    expect(texts(all)).toEqual([
      "SuperClaw is running windows-mcp · Click-Tool on your computer.",
      "SuperClaw is running windows-mcp · Type-Tool on your computer. Please don't use the mouse or keyboard until it finishes.",
    ]);
    expect(all("host-mcp-call").every((row) => row.className.includes("bg-dls-infobar-attention-bg"))).toBe(true);
  });

  test("a call waiting for the user says why and counts down to when it continues", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.parse("2026-11-04T21:00:00Z");
      vi.setSystemTime(start);
      const { all } = renderBanner(status({ running_count: 1 }), null, {
        list: [barCall({ state: "waiting_for_user", resume_in_ms: 5_000, resumeAt: start + 5_000, computer_use: true })],
      });

      expect(texts(all)).toEqual([
        "You used the mouse or keyboard, so SuperClaw paused windows-mcp · Click-Tool. It continues 5 s after you stop.",
      ]);
      expect(all("host-mcp-call")[0]?.getAttribute("data-state")).toBe("waiting_for_user");

      await vi.advanceTimersByTimeAsync(2_000);
      expect(texts(all)[0]).toContain("It continues 3 s after you stop.");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(texts(all)[0]).toContain("It continues 0 s after you stop.");
    } finally {
      vi.useRealTimers();
    }
  });

  test("each call has its own Cancel, alongside Stop all", () => {
    const { all, get, cancels } = renderBanner(status({ running_count: 1 }), null, {
      list: [barCall(), barCall({ call_id: "call-2" })],
    });

    all("host-mcp-call-cancel-btn")[1]?.click();

    expect(all("host-mcp-call-cancel-btn").map((button) => button.textContent)).toEqual(["Cancel", "Cancel"]);
    expect(cancels).toEqual(["call-2"]);
    expect(get("host-mcp-stop-all-btn")).not.toBeNull();
  });

  test("the gateway's server and tool names are shown as text", () => {
    const { all } = renderBanner(status({ running_count: 1 }), null, {
      list: [barCall({ tool: "<b>$&</b>{n}" })],
    });

    expect(texts(all)).toEqual(["SuperClaw is running windows-mcp · <b>$&</b>{n} on your computer."]);
    expect(all("host-mcp-call")[0]?.querySelector("b")).toBeNull();
  });

  test("is worded in both languages", () => {
    for (const key of [
      "mcp.host.call.running", "mcp.host.call.computer_use", "mcp.host.call.waiting", "mcp.host.call.cancel",
      "mcp.host.notify.title", "mcp.host.notify.body",
    ]) {
      expect(t(key, "en"), key).not.toBe(key);
      expect(t(key, "zh"), key).not.toBe(t(key, "en"));
    }
  });
});

/** Every class on the element and its ancestors up to the bar. */
function classesUpToBar(element: HTMLElement | null): string[] {
  const classes: string[] = [];
  for (let node = element; node; node = node.parentElement) {
    classes.push(...node.classList);
    if (node.dataset.testid === "host-mcp-infobar") break;
  }
  return classes;
}

describe("HostMcpStopBanner: a bar in the page flow", () => {
  test("is in normal flow, full width and opaque: nothing fixed, absolute, layered or see-through", () => {
    for (const [initial, id] of [
      [status({ running_count: 1 }), "host-mcp-stop-banner"],
      [status({ paused: true }), "host-mcp-paused-banner"],
    ] as const) {
      const { get } = renderBanner(initial);
      const classes = classesUpToBar(get(id));

      expect(classes).toContain("w-full");
      for (const forbidden of ["fixed", "absolute", "sticky", "pointer-events-none"]) {
        expect(classes, forbidden).not.toContain(forbidden);
      }
      expect(classes.filter((name) => /^z-|^opacity-|^backdrop-|^bg-transparent$|\/\d+$/.test(name))).toEqual([]);
      expect(classes.some((name) => name.startsWith("bg-dls-infobar-"))).toBe(true);
      expect(classes).toContain("border-b");
      dispose?.();
      document.body.innerHTML = "";
    }
  });

  test("is hidden while the gateway is not known to run, and while nothing runs on it", () => {
    const { get, setCurrent } = renderBanner(null);
    expect(get("host-mcp-stop-banner")).toBeNull();

    setCurrent(status({ server_count: 3 }));
    expect(get("host-mcp-stop-banner")).toBeNull();
    expect(get("host-mcp-paused-banner")).toBeNull();
  });
});

describe("HostMcpStopBanner: what it says", () => {
  const text = (get: (id: string) => HTMLElement | null) => get("host-mcp-stop-banner-text")?.textContent;

  test("one running server is named", () => {
    const { get } = renderBanner(status({ running_count: 1 }), [server("windows-mcp"), server("other", "stopped")]);

    expect(text(get)).toBe("windows-mcp is running on this computer, outside the sandbox.");
  });

  test("one running server whose name is not known is counted", () => {
    for (const servers of [null, [], [server("a"), server("b")]]) {
      const { get } = renderBanner(status({ running_count: 1 }), servers);
      expect(text(get)).toBe("1 MCP server is running on this computer, outside the sandbox.");
      dispose?.();
      document.body.innerHTML = "";
    }
  });

  test("several running servers are counted, even when their names are known", () => {
    const { get } = renderBanner(status({ running_count: 3 }), [server("a"), server("b"), server("c")]);

    expect(text(get)).toBe("3 MCP servers are running on this computer, outside the sandbox.");
  });

  test("the browser alone, and the browser with servers", () => {
    const alone = renderBanner(status({ browser_configured: true, browser_active: true }));
    expect(text(alone.get)).toBe("The SuperClaw browser is open on this computer.");
    dispose?.();
    document.body.innerHTML = "";

    const both = renderBanner(status({ running_count: 2, browser_configured: true, browser_active: true }));
    expect(text(both.get)).toBe(
      "2 MCP servers are running on this computer, outside the sandbox. · SuperClaw browser open",
    );
  });

  test("a server name is shown as text, never as markup or a replacement pattern", () => {
    const { get } = renderBanner(status({ running_count: 1 }), [server("$&-mcp")]);

    expect(text(get)).toBe("$&-mcp is running on this computer, outside the sandbox.");
  });

  test("Stop all asks to stop everything, and the bar goes when nothing runs", () => {
    const { get, setCurrent, stops } = renderBanner(status({ running_count: 1 }));
    expect(get("host-mcp-stop-all-btn")?.textContent).toBe("Stop all");

    get("host-mcp-stop-all-btn")?.click();
    expect(stops()).toBe(1);

    setCurrent(status({ running_count: 0 }));
    expect(get("host-mcp-stop-banner")).toBeNull();
  });

  test("after Stop all, a paused gateway says so and offers Resume, not Stop all", () => {
    const { get, resumes, stops } = renderBanner(status({ paused: true }));

    expect(get("host-mcp-paused-banner-text")?.textContent).toBe(
      "Paused: the agent can't use MCP servers running outside the sandbox until you resume.",
    );
    expect(get("host-mcp-stop-all-btn")).toBeNull();
    expect(get("host-mcp-resume-btn")?.textContent).toBe("Resume");
    get("host-mcp-resume-btn")?.click();

    expect(resumes()).toBe(1);
    expect(stops()).toBe(0);
  });

  test("the paused bar goes once the gateway is no longer paused", () => {
    const { get, setCurrent } = renderBanner(status({ paused: true }));

    setCurrent(status({ paused: false }));

    expect(get("host-mcp-paused-banner")).toBeNull();
  });

  test("is worded in both languages, as specified", () => {
    for (const [key, zh] of [
      ["mcp.host.banner.server_named", "{name} 正在这台电脑上运行（沙箱外）。"],
      ["mcp.host.banner.servers_many", "{count} 个 MCP server 正在这台电脑上运行（沙箱外）。"],
      ["mcp.host.banner.browser_suffix", " · SuperClaw 浏览器已打开"],
      ["mcp.host.banner.browser_only", "SuperClaw 浏览器已在这台电脑上打开。"],
      ["mcp.host.banner.paused", "已暂停：在你恢复之前，agent 无法使用沙箱外运行的 MCP server。"],
      ["mcp.host.banner.stop_all", "全部停止"],
      ["mcp.host.banner.resume", "恢复"],
    ] as const) {
      expect(t(key, "zh"), key).toBe(zh);
      expect(t(key, "en"), key).not.toBe(key);
    }
  });
});
