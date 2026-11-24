import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  HostMcpActiveCall,
  HostMcpPendingApproval,
  HostMcpStatus,
} from "@different-ai/openwork-contracts/host-mcp-api";

import { HostMcpApiError, type HostMcpApiClient } from "~/shared/platform/transport/host-mcp-api";
import { HOST_MCP_POLL } from "./host-mcp";
import HostMcpApprovalDialog from "./host-mcp-approval-dialog";
import { HostMcpInfobar, HostMcpProvider } from "./host-mcp-stop-banner";
import { useHostMcp, type HostMcp } from "./useHostMcp";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
});

const status = (overrides: Partial<HostMcpStatus> = {}): HostMcpStatus => ({
  server_count: 1,
  running_count: 1,
  browser_configured: false,
  browser_active: false,
  session_locked: false,
  paused: false,
  active_calls: [],
  ...overrides,
});

const activeCall = (overrides: Partial<HostMcpActiveCall> = {}): HostMcpActiveCall => ({
  call_id: "call-1",
  server: "windows-mcp",
  tool: "Click-Tool",
  state: "running",
  resume_in_ms: null,
  computer_use: true,
  ...overrides,
});

/** A gateway whose status reads answer from `reads` in turn, the last one again and again. */
function mountCalls(
  reads: HostMcpStatus[],
  options: {
    cancelCall?: (callId: string) => Promise<void>;
    notify?: (title: string, body: string) => Promise<void>;
    hasFocus?: () => boolean;
  } = {},
) {
  vi.useFakeTimers();
  let statusReads = 0;
  const cancelled: string[] = [];
  const client = {
    hasService: async () => true,
    listServers: async () => [],
    listApprovals: () => new Promise(() => undefined),
    status: async () => {
      statusReads += 1;
      return reads.length > 1 ? (reads.shift() as HostMcpStatus) : (reads[0] as HostMcpStatus);
    },
    stopAll: async () => ({ stopped_servers: 0, browser_stopped: false }),
    cancelCall: options.cancelCall ?? (async (callId: string) => {
      cancelled.push(callId);
    }),
  } as unknown as HostMcpApiClient;
  const host = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return useHostMcp({
      client: () => client,
      enabled: () => true,
      notify: options.notify ?? (async () => undefined),
      hasFocus: options.hasFocus ?? (() => false),
    });
  });
  return { host, cancelled, statusReads: () => statusReads };
}

describe("useHostMcp: calls operating this computer", () => {
  test("status is read every second while a call runs or waits, and every three seconds otherwise", async () => {
    const running = status({ active_calls: [activeCall()] });
    const idle = status({ active_calls: [activeCall({ state: "awaiting_approval" })] });
    const { statusReads } = mountCalls([running, running, running, running, idle]);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusReads()).toBe(1);

    await vi.advanceTimersByTimeAsync(4 * HOST_MCP_POLL.activeCallIntervalMs);
    expect(statusReads()).toBe(5);

    await vi.advanceTimersByTimeAsync(2 * HOST_MCP_POLL.activeCallIntervalMs);
    expect(statusReads()).toBe(5);
    await vi.advanceTimersByTimeAsync(HOST_MCP_POLL.statusIntervalMs);
    expect(statusReads()).toBe(6);
  });

  test("the bar lists running and waiting calls, never one still awaiting approval", async () => {
    const { host } = mountCalls([status({
      active_calls: [
        activeCall({ call_id: "a", state: "awaiting_approval" }),
        activeCall({ call_id: "b" }),
        activeCall({ call_id: "c", state: "waiting_for_user", resume_in_ms: 4_000 }),
      ],
    })]);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.activeCalls().map((call) => call.call_id)).toEqual(["b", "c"]);
  });

  test("Cancel asks the gateway to cancel that call and drops it at once", async () => {
    const { host, cancelled } = mountCalls([status({ active_calls: [activeCall(), activeCall({ call_id: "call-2" })] })]);
    await vi.advanceTimersByTimeAsync(0);

    await host.cancelCall("call-1");

    expect(cancelled).toEqual(["call-1"]);
    expect(host.activeCalls().map((call) => call.call_id)).toEqual(["call-2"]);
    expect(host.cancelError()).toBeNull();
  });

  test("a call already finished (host_mcp_call_not_found) is dropped quietly; another failure keeps it and says so", async () => {
    const failures = [new HostMcpApiError("host_mcp_call_not_found", 404), new HostMcpApiError("unreachable", null)];
    const { host } = mountCalls([status({ active_calls: [activeCall(), activeCall({ call_id: "call-2" })] })], {
      cancelCall: async () => {
        const failure = failures.shift();
        if (failure) throw failure;
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    await host.cancelCall("call-1");
    expect(host.activeCalls().map((call) => call.call_id)).toEqual(["call-2"]);
    expect(host.cancelError()).toBeNull();

    await host.cancelCall("call-2");
    expect(host.activeCalls().map((call) => call.call_id)).toEqual(["call-2"]);
    expect(host.cancelError()).toEqual({ callId: "call-2", message: new HostMcpApiError("unreachable", null).message });
  });

  test("a call that waits for the user sends one notification, however long it waits", async () => {
    const sent: Array<[string, string]> = [];
    const waiting = status({ active_calls: [activeCall({ state: "waiting_for_user", resume_in_ms: 4_200 })] });
    mountCalls([waiting], {
      notify: async (title, body) => {
        sent.push([title, body]);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * HOST_MCP_POLL.activeCallIntervalMs);

    expect(sent).toEqual([[
      "SuperClaw is using your computer",
      "Please don't use the mouse or keyboard. It continues 5 s after you stop. Open SuperClaw to cancel.",
    ]]);
  });

  test("a second call gets its own notification; a call back to waiting does not get another", async () => {
    const sent: string[] = [];
    const waitingA = activeCall({ call_id: "a", state: "waiting_for_user", resume_in_ms: 3_000 });
    mountCalls([
      status({ active_calls: [waitingA] }),
      status({ active_calls: [activeCall({ call_id: "a" })] }),
      status({ active_calls: [waitingA, activeCall({ call_id: "b", state: "waiting_for_user", resume_in_ms: 3_000 })] }),
    ], {
      notify: async (title) => {
        sent.push(title);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3 * HOST_MCP_POLL.activeCallIntervalMs);

    expect(sent).toHaveLength(2);
  });

  test("no notification while SuperClaw has focus, and a failing one changes nothing", async () => {
    const waiting = status({ active_calls: [activeCall({ state: "waiting_for_user", resume_in_ms: 3_000 })] });
    const focused = mountCalls([waiting], {
      hasFocus: () => true,
      notify: async () => {
        throw new Error("should not be sent");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(focused.host.activeCalls()).toHaveLength(1);
    dispose?.();

    const failing = mountCalls([waiting], {
      notify: async () => {
        throw new Error("no notification service");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(failing.host.activeCalls()).toHaveLength(1);
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A gateway that starts, holds every approvals list, and answers status reads from `reads` in order. */
function mount(reads: Array<() => Promise<HostMcpStatus>>, stopAll: () => Promise<unknown>): HostMcp {
  const client = {
    hasService: async () => true,
    listServers: async () => [],
    listApprovals: () => new Promise(() => undefined),
    status: () => (reads.shift() ?? (() => new Promise<HostMcpStatus>(() => undefined)))(),
    stopAll,
  } as unknown as HostMcpApiClient;
  return createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return useHostMcp({ client: () => client, enabled: () => true });
  });
}

describe("useHostMcp: status after Stop all", () => {
  test("a status read that started before Stop all cannot bring the stopped work back", async () => {
    vi.useFakeTimers();
    const held = deferred<HostMcpStatus>();
    const host = mount(
      [async () => status({ running_count: 1 }), () => held.promise],
      async () => ({ stopped_servers: 1, browser_stopped: false }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(host.status()?.running_count).toBe(1);

    await vi.advanceTimersByTimeAsync(HOST_MCP_POLL.statusIntervalMs);
    await host.stopAll();
    expect(host.status()?.running_count).toBe(0);
    held.resolve(status({ running_count: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(host.status()?.running_count).toBe(0);
  });

  test("reads do not overlap: a read still in flight is not joined by another", async () => {
    vi.useFakeTimers();
    let started = 0;
    const held = deferred<HostMcpStatus>();
    mount(
      [async () => status(), () => { started += 1; return held.promise; }, async () => { started += 1; return status(); }],
      async () => ({ stopped_servers: 0, browser_stopped: false }),
    );
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(HOST_MCP_POLL.statusIntervalMs * 3);

    expect(started).toBe(1);
  });

  test("a Stop all error is cleared once nothing runs on the host", async () => {
    vi.useFakeTimers();
    const host = mount(
      [async () => status({ running_count: 1 }), async () => status({ running_count: 0 })],
      async () => {
        throw new HostMcpApiError("unreachable", null);
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    await host.stopAll();
    expect(host.stopError()).toBe(new HostMcpApiError("unreachable", null).message);

    await vi.advanceTimersByTimeAsync(HOST_MCP_POLL.statusIntervalMs);
    expect(host.status()?.running_count).toBe(0);
    expect(host.stopError()).toBeNull();
  });
});

describe("useHostMcp: Stop all while an approval asks, then Resume", () => {
  const approval: HostMcpPendingApproval = {
    kind: "tool_call",
    approval_id: "appr-1",
    requested_at: "2026-11-03T20:59:55Z",
    expires_at: "2026-11-03T21:00:30Z",
    grant_scopes: ["once", "until_restart"],
    server: "windows-mcp",
    tool: "Click-Tool",
    annotations: { read_only: null, destructive: null, open_world: null },
  };

  /** The app shell's three pieces over one gateway: the dialog, the banner and its notices. */
  function mountShell(
    reads: Array<() => Promise<HostMcpStatus>>,
    stop: () => Promise<{ stopped_servers: number; browser_stopped: boolean }> = async () => ({
      stopped_servers: 1,
      browser_stopped: false,
    }),
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T21:00:00Z"));
    const calls: string[] = [];
    const heldLists: Array<(approvals: HostMcpPendingApproval[]) => void> = [];
    let lists = 0;
    const client = {
      hasService: async () => true,
      listServers: async () => [{
        name: "windows-mcp", command: ["uvx", "windows-mcp"], environment_keys: [], approval_mode: "prompt",
        allow_when_locked: false, state: "running", always_grants: [],
      }],
      listApprovals: () => {
        lists += 1;
        return lists === 1 ? Promise.resolve([approval]) : new Promise((resolve) => heldLists.push(resolve));
      },
      status: () => {
        calls.push("status");
        return (reads.shift() ?? (() => new Promise<HostMcpStatus>(() => undefined)))();
      },
      stopAll: () => {
        calls.push("stop-all");
        return stop();
      },
      resume: async () => {
        calls.push("resume");
      },
    } as unknown as HostMcpApiClient;
    const root = document.createElement("div");
    document.body.append(root);
    // As the app mounts them: the provider around the pages, the bar under a page's title bar, and
    // the dialog with its own Stop all.
    const unmount = render(() => {
      const host = useHostMcp({ client: () => client, enabled: () => true });
      return (
        <HostMcpProvider value={host}>
          <div data-testid="page" class="flex flex-col">
            <header data-testid="title" />
            <HostMcpInfobar />
            <main data-testid="content" />
          </div>
          <HostMcpApprovalDialog approvals={host.approvals} stopAll={host.stopAll} />
        </HostMcpProvider>
      );
    }, root);
    dispose = () => {
      unmount();
      document.body.innerHTML = "";
    };
    const get = (id: string) => root.querySelector<HTMLElement>(`[data-testid=${id}]`);
    return { root, get, calls, heldLists };
  }

  test("the bar sits in the page between the title bar and the content, naming the running server", async () => {
    const { get } = mountShell([async () => status({ running_count: 1 })]);
    await vi.advanceTimersByTimeAsync(0);

    const page = Array.from(get("page")?.children ?? []).map((child) => child.getAttribute("data-testid"));
    expect(page).toEqual(["title", "host-mcp-infobar", "content"]);
    expect(get("host-mcp-stop-banner-text")?.textContent).toBe(
      "windows-mcp is running on this computer, outside the sandbox.",
    );
  });

  test("Stop all inside the dialog stops everything, closes the dialog at once and says nothing about it", async () => {
    const { get, calls, heldLists } = mountShell([async () => status({ running_count: 1 })]);
    await vi.advanceTimersByTimeAsync(0);
    const buttons = Array.from(get("host-mcp-approval-dialog")?.querySelectorAll("button") ?? []);
    expect(buttons.map((button) => button.getAttribute("data-testid"))[0]).toBe("host-mcp-approval-stop-all-btn");
    expect(document.activeElement).toBe(get("host-mcp-approval-dialog"));

    get("host-mcp-approval-stop-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toContain("stop-all");
    expect(get("host-mcp-approval-dialog")).toBeNull();
    expect(get("host-mcp-paused-banner")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(HOST_MCP_POLL.minIntervalMs);
    heldLists.shift()?.([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(get("host-mcp-approval-notice")).toBeNull();
  });

  test("the approvals the user's own Stop all ended get no expired or cancelled notice", async () => {
    const { get, heldLists } = mountShell([async () => status({ running_count: 1 })]);
    await vi.advanceTimersByTimeAsync(0);

    get("host-mcp-stop-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(HOST_MCP_POLL.minIntervalMs);
    heldLists.shift()?.([]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(get("host-mcp-approval-notice")).toBeNull();
  });

  test("while Stop all runs in the dialog, Deny and Allow are off and Escape does nothing", async () => {
    let finish: () => void = () => {};
    const { get, calls } = mountShell(
      [async () => status({ running_count: 1 })],
      () => new Promise((resolve) => {
        finish = () => resolve({ stopped_servers: 1, browser_stopped: false });
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    get("host-mcp-approval-stop-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    const dialog = get("host-mcp-approval-dialog");
    expect((get("host-mcp-approval-deny-btn") as HTMLButtonElement | null)?.disabled).toBe(true);
    expect((get("host-mcp-approval-allow-once-btn") as HTMLButtonElement | null)?.disabled).toBe(true);
    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    // This fake has no decision route: an answer sent would come back as an alert in the dialog.
    expect(dialog?.querySelector("[role=alert]")).toBeNull();
    expect(calls.filter((call) => call === "stop-all")).toHaveLength(1);
    expect(get("host-mcp-approval-dialog")).not.toBeNull();

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(get("host-mcp-approval-dialog")).toBeNull();
  });

  test("a Stop all that fails keeps the dialog, gives its buttons back and puts focus inside it", async () => {
    const { get } = mountShell(
      [async () => status({ running_count: 1 })],
      async () => {
        throw new HostMcpApiError("unreachable", null);
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);

    get("host-mcp-approval-stop-all-btn")?.focus();
    get("host-mcp-approval-stop-all-btn")?.click();
    (document.activeElement as HTMLElement | null)?.blur();
    await vi.advanceTimersByTimeAsync(0);

    expect(get("host-mcp-approval-dialog")).not.toBeNull();
    expect((get("host-mcp-approval-deny-btn") as HTMLButtonElement | null)?.disabled).toBe(false);
    expect(get("host-mcp-approval-dialog")?.contains(document.activeElement)).toBe(true);
  });

  test("an approvals list that empties while Stop all runs shows no cancelled notice", async () => {
    let finish: () => void = () => {};
    const { get, heldLists } = mountShell(
      [async () => status({ running_count: 1 })],
      () => new Promise((resolve) => {
        finish = () => resolve({ stopped_servers: 1, browser_stopped: false });
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    get("host-mcp-approval-stop-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    heldLists.shift()?.([]);
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(get("host-mcp-approval-notice")).toBeNull();
  });

  test("a Stop all before any status was read reads status at once", async () => {
    const { get, calls } = mountShell([
      () => new Promise<HostMcpStatus>(() => undefined),
      async () => status({ running_count: 0, paused: true }),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.filter((call) => call === "status")).toHaveLength(1);

    get("host-mcp-approval-stop-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.filter((call) => call === "status")).toHaveLength(2);
    expect(get("host-mcp-paused-banner")).not.toBeNull();
  });

  test("Resume asks the gateway, then reads status at once, and the paused banner goes", async () => {
    const { get, calls } = mountShell([
      async () => status({ running_count: 0, paused: true }),
      async () => status({ running_count: 0, paused: false }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(get("host-mcp-paused-banner")).not.toBeNull();
    calls.length = 0;

    get("host-mcp-resume-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["resume", "status"]);
    expect(get("host-mcp-paused-banner")).toBeNull();
  });

  test("while paused, status is still read at the normal cadence, so a restarted gateway clears it", async () => {
    const { get, calls } = mountShell([
      async () => status({ running_count: 0, paused: true }),
      async () => status({ running_count: 0, paused: false }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(get("host-mcp-paused-banner")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(HOST_MCP_POLL.statusIntervalMs);

    expect(calls.filter((call) => call === "status")).toHaveLength(2);
    expect(get("host-mcp-paused-banner")).toBeNull();
  });
});
