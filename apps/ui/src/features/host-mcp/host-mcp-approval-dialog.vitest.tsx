import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostMcpPendingApproval } from "@different-ai/openwork-contracts/host-mcp-api";

import { HostMcpApiError } from "~/shared/platform/transport/host-mcp-api";
import { t } from "../../i18n";
import HostMcpApprovalDialog, { ARM_DELAY_MS } from "./host-mcp-approval-dialog";
import { useHostMcpApprovals, type HostMcpApprovals } from "./useHostMcp";
import type { HostMcpApprovalsClient } from "./host-mcp";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const NOW = new Date("2026-11-03T21:00:00Z");

const toolCall = (overrides: Partial<Extract<HostMcpPendingApproval, { kind: "tool_call" }>> = {}): HostMcpPendingApproval => ({
  kind: "tool_call",
  approval_id: "appr-1",
  requested_at: "2026-11-03T20:59:55Z",
  expires_at: "2026-11-03T21:00:45Z",
  grant_scopes: ["once", "until_restart"],
  server: "windows-mcp",
  tool: "Click-Tool",
  annotations: { read_only: null, destructive: null, open_world: null },
  arguments_preview: '{"loc": [10, 20]}',
  ...overrides,
});

const READ_ONLY = { read_only: true, destructive: null, open_world: null };

const origin: HostMcpPendingApproval = {
  kind: "browser_origin",
  approval_id: "appr-o",
  requested_at: "2026-11-03T20:59:55Z",
  expires_at: "2026-11-03T21:00:45Z",
  grant_scopes: ["once", "until_restart"],
  origin: "https://example.com",
};

function renderDialog(listed: HostMcpPendingApproval[], overrides: Partial<HostMcpApprovals> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const decided: Array<[string, string, string | undefined]> = [];
  const [approvals, setApprovals] = createSignal<HostMcpPendingApproval[]>(listed);
  const host: HostMcpApprovals = {
    approvals,
    decidingId: () => null,
    decisionError: () => null,
    decide: async (id, decision, scope) => {
      decided.push([id, decision, scope]);
    },
    notices: () => [],
    dismissNotice: () => undefined,
    endedByStopAll: () => undefined,
    alwaysGranted: () => null,
    servers: () => null,
    refreshServers: () => undefined,
    ...overrides,
  };
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => <HostMcpApprovalDialog approvals={host} />, root);
  const get = (id: string) => root.querySelector<HTMLButtonElement>(`[data-testid=${id}]`);
  return { root, get, decided, setApprovals, arm: () => vi.advanceTimersByTime(ARM_DELAY_MS) };
}

function renderDialogWithAdvance(listed: HostMcpPendingApproval[]) {
  const view = renderDialog(listed);
  return { ...view, advance: (ms: number) => vi.advanceTimersByTime(ms) };
}

const buttonIds = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("button")).map((button) => button.getAttribute("data-testid"));

describe("HostMcpApprovalDialog: a tool call", () => {
  test("shows nothing while nothing waits", () => {
    const { get } = renderDialog([]);

    expect(get("host-mcp-approval-dialog")).toBeNull();
  });

  test("shows the server, the tool and its title, the arguments and the time left", () => {
    const { get } = renderDialog([toolCall({ title: "Click" })]);

    expect(get("host-mcp-approval-server")?.textContent).toBe("windows-mcp");
    expect(get("host-mcp-approval-tool")?.textContent).toBe("Click Click-Tool");
    expect(get("host-mcp-approval-arguments")?.textContent).toBe('{"loc": [10, 20]}');
    expect(get("host-mcp-approval-arguments")?.className).toContain("font-mono");
    expect(get("host-mcp-approval-countdown")?.textContent).toBe("Denied automatically in 45 s");
  });

  test("a ten-minute approval counts down in minutes and seconds, not hundreds of seconds", () => {
    const { get, advance } = renderDialogWithAdvance([toolCall({ expires_at: "2026-11-03T21:10:00Z" })]);
    expect(get("host-mcp-approval-countdown")?.textContent).toBe("Denied automatically in 10:00");

    advance(1_000);
    expect(get("host-mcp-approval-countdown")?.textContent).toBe("Denied automatically in 9:59");
  });

  test("leaves out a title that only repeats the tool name", () => {
    for (const title of ["Snapshot", " snapshot "]) {
      const { get } = renderDialog([toolCall({ tool: "Snapshot", title })]);
      expect(get("host-mcp-approval-tool")?.textContent).toBe("Snapshot");
      dispose?.();
      document.body.innerHTML = "";
    }
  });

  test("says whether the tool is read-only or may change things, from its annotations", () => {
    const write = renderDialog([toolCall()]);
    expect(write.get("host-mcp-approval-may-change")).not.toBeNull();
    expect(write.get("host-mcp-approval-read-only")).toBeNull();
    dispose?.();
    document.body.innerHTML = "";

    const read = renderDialog([toolCall({ annotations: READ_ONLY, grant_scopes: ["once", "until_restart", "always"] })]);
    expect(read.get("host-mcp-approval-read-only")).not.toBeNull();
    expect(read.get("host-mcp-approval-may-change")).toBeNull();
  });

  test("shows the gateway's text as text, never as markup", () => {
    const preview = '<img src=x onerror="alert(1)">';
    const { get } = renderDialog([toolCall({ arguments_preview: preview, tool: "<b>tool</b>" })]);

    expect(get("host-mcp-approval-arguments")?.textContent).toBe(preview);
    expect(get("host-mcp-approval-arguments")?.querySelector("img")).toBeNull();
    expect(get("host-mcp-approval-tool")?.querySelector("b")).toBeNull();
  });

  test("a tool that may change things is offered Deny, Allow once and Allow until restart", () => {
    const { root } = renderDialog([toolCall()]);

    expect(buttonIds(root)).toEqual([
      "host-mcp-approval-deny-btn",
      "host-mcp-approval-allow-once-btn",
      "host-mcp-approval-allow-until-restart-btn",
    ]);
  });

  test("a read-only tool is offered Always allow too", () => {
    const { root, get } = renderDialog([toolCall({ annotations: READ_ONLY, grant_scopes: ["once", "until_restart", "always"] })]);

    expect(buttonIds(root)).toContain("host-mcp-approval-always-allow-btn");
    expect(get("host-mcp-approval-always-allow-btn")?.textContent).toBe(t("mcp.host.approval.always_allow"));
  });

  test("each Allow answers with its own scope once armed, Deny with none, and Escape denies", () => {
    const { get, decided, arm } = renderDialog([toolCall({ annotations: READ_ONLY, grant_scopes: ["once", "until_restart", "always"] })]);

    get("host-mcp-approval-allow-once-btn")?.click();
    expect(decided).toEqual([]);
    arm();
    get("host-mcp-approval-allow-once-btn")?.click();
    get("host-mcp-approval-allow-until-restart-btn")?.click();
    get("host-mcp-approval-always-allow-btn")?.click();
    get("host-mcp-approval-deny-btn")?.click();
    get("host-mcp-approval-dialog")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(decided).toEqual([
      ["appr-1", "approve", "once"],
      ["appr-1", "approve", "until_restart"],
      ["appr-1", "approve", "always"],
      ["appr-1", "deny", undefined],
      ["appr-1", "deny", undefined],
    ]);
  });

});

describe("HostMcpApprovalDialog: focus", () => {
  const key = (target: Element | null, name: string, init: KeyboardEventInit = {}) =>
    target?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }));

  test("focus goes to the dialog itself, not to Deny, so Space or Enter answers nothing", () => {
    const { get, decided, arm } = renderDialog([toolCall()]);
    arm();

    expect(document.activeElement).toBe(get("host-mcp-approval-dialog"));
    expect(document.activeElement).not.toBe(get("host-mcp-approval-deny-btn"));
    key(document.activeElement, "Enter");
    key(document.activeElement, " ");
    expect(decided).toEqual([]);
  });

  test("Tab from the dialog reaches the first button, Shift+Tab the last", () => {
    const { get, arm } = renderDialog([toolCall()]);
    arm();

    key(get("host-mcp-approval-dialog"), "Tab");
    expect(document.activeElement).toBe(get("host-mcp-approval-deny-btn"));
    get("host-mcp-approval-dialog")?.focus();
    key(get("host-mcp-approval-dialog"), "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(get("host-mcp-approval-allow-until-restart-btn"));
  });

  test("focus returns to where it was when the last approval goes", () => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    const { get, setApprovals } = renderDialog([toolCall()]);
    expect(document.activeElement).toBe(get("host-mcp-approval-dialog"));

    setApprovals([]);

    expect(document.activeElement).toBe(before);
  });

  test("a failed decision puts focus back inside the dialog, so Escape still denies", () => {
    const [error, setError] = createSignal<{ approvalId: string; message: string } | null>(null);
    const [deciding, setDeciding] = createSignal<string | null>(null);
    const { get, decided } = renderDialog([toolCall()], { decisionError: error, decidingId: deciding });
    setDeciding("appr-1");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    setDeciding(null);
    setError({ approvalId: "appr-1", message: "The host service could not be reached." });

    expect(document.activeElement).toBe(get("host-mcp-approval-dialog"));
    key(document.activeElement, "Escape");
    expect(decided).toEqual([["appr-1", "deny", undefined]]);
  });

  test("a different approval shown while a decision was in flight gets focus inside the dialog", () => {
    const [deciding, setDeciding] = createSignal<string | null>(null);
    const { get, setApprovals } = renderDialog([toolCall()], { decidingId: deciding });
    setDeciding("appr-1");
    (document.activeElement as HTMLElement | null)?.blur();

    setApprovals([toolCall({ approval_id: "appr-2" })]);
    setDeciding(null);

    expect(get("host-mcp-approval-dialog")?.contains(document.activeElement)).toBe(true);
  });
});

describe("HostMcpApprovalDialog: a browser origin", () => {
  test("asks to open the origin, shown as text, with Allow once, Allow until restart and Deny", () => {
    const { root, get } = renderDialog([origin]);

    expect(get("host-mcp-approval-origin")?.textContent).toBe("https://example.com");
    expect(root.querySelector("h3")?.textContent).toBe(
      t("mcp.host.approval.browser_title").replace("{origin}", "https://example.com"),
    );
    expect(buttonIds(root)).toEqual([
      "host-mcp-approval-deny-btn",
      "host-mcp-approval-allow-once-btn",
      "host-mcp-approval-allow-until-restart-btn",
    ]);
  });
});

describe("HostMcpApprovalDialog with its adapter", () => {
  function renderWithAdapter(listed: HostMcpPendingApproval[], refusals: Error[]) {
    const decided: Array<[string, string, string | undefined]> = [];
    let lists = 0;
    const client: HostMcpApprovalsClient = {
      listApprovals: () => {
        lists += 1;
        return lists === 1 ? Promise.resolve(listed) : new Promise(() => undefined);
      },
      decideApproval: async (approval_id, decision, grant_scope) => {
        decided.push([approval_id, decision, grant_scope]);
        const refusal = refusals.shift();
        if (refusal) throw refusal;
        return decision === "approve"
          ? { approval_id, decision, outcome: "granted" as const }
          : { approval_id, decision, outcome: "denied" as const };
      },
    };
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => {
      const approvals = useHostMcpApprovals({ client: () => client });
      return <HostMcpApprovalDialog approvals={approvals} />;
    }, root);
    const get = (id: string) => root.querySelector<HTMLElement>(`[data-testid=${id}]`);
    return { root, get, decided };
  }

  test("an approval that is no longer pending is dropped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { get } = renderWithAdapter([toolCall()], [new HostMcpApiError("approval_not_pending", 409)]);
    await vi.advanceTimersByTimeAsync(ARM_DELAY_MS);

    get("host-mcp-approval-allow-once-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(get("host-mcp-approval-dialog")).toBeNull();
  });

  test("a scope the gateway did not offer shows its sentence and keeps the card", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const refusal = new HostMcpApiError("approval_scope_not_offered", 409);
    const { root, get } = renderWithAdapter([toolCall()], [refusal]);
    await vi.advanceTimersByTimeAsync(ARM_DELAY_MS);

    get("host-mcp-approval-allow-until-restart-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(get("host-mcp-approval-dialog")).not.toBeNull();
    expect(root.querySelector("[role=alert]")?.textContent).toBe(refusal.message);
  });

  test("a network failure keeps the card, and a retry settles it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { root, get, decided } = renderWithAdapter([toolCall()], [new HostMcpApiError("unreachable", null)]);
    await vi.advanceTimersByTimeAsync(ARM_DELAY_MS);

    get("host-mcp-approval-allow-once-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector("[role=alert]")?.textContent).toBe(new HostMcpApiError("unreachable", null).message);

    get("host-mcp-approval-allow-once-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(decided).toEqual([
      ["appr-1", "approve", "once"],
      ["appr-1", "approve", "once"],
    ]);
    expect(get("host-mcp-approval-dialog")).toBeNull();
  });
});

describe("HostMcpApprovalDialog: tools already allowed always on the server", () => {
  const grantsOf = (byServer: Record<string, string[]>) => (server: string) => byServer[server] ?? null;
  const line = (root: HTMLElement) => root.querySelector("[data-testid=host-mcp-approval-standing-grants]");

  test("says which tools are already always allowed, and that this one is different", () => {
    const { root } = renderDialog([toolCall({ tool: "Wait" })], {
      alwaysGranted: grantsOf({ "windows-mcp": ["Screenshot", "Snapshot"] }),
    });

    expect(line(root)?.textContent).toBe(
      "Already always allowed on windows-mcp: Screenshot, Snapshot. This is a different tool.",
    );
  });

  test("says nothing when the server has no standing grant, or none is known", () => {
    for (const alwaysGranted of [() => null, () => [], grantsOf({ other: ["Screenshot"] })]) {
      const { root } = renderDialog([toolCall({ tool: "Wait" })], { alwaysGranted });
      expect(line(root)).toBeNull();
      dispose?.();
      document.body.innerHTML = "";
    }
  });

  test("lists the first five and counts the rest", () => {
    const { root } = renderDialog([toolCall({ tool: "Wait" })], {
      alwaysGranted: grantsOf({ "windows-mcp": ["A", "B", "C", "D", "E", "F", "G"] }),
    });

    expect(line(root)?.textContent).toBe(
      "Already always allowed on windows-mcp: A, B, C, D, E and 2 more. This is a different tool.",
    );
  });

  test("shows the gateway's tool names as text, never as markup", () => {
    const { root } = renderDialog([toolCall({ tool: "Wait" })], {
      alwaysGranted: grantsOf({ "windows-mcp": ["<b>Shot</b>", "{count}"] }),
    });

    expect(line(root)?.textContent).toContain("<b>Shot</b>, {count}.");
    expect(line(root)?.querySelector("b")).toBeNull();
  });

  test("is worded in both languages", () => {
    for (const key of ["mcp.host.approval.always_granted", "mcp.host.approval.always_granted_more"]) {
      expect(t(key, "en"), key).not.toBe(key);
      expect(t(key, "zh"), key).not.toBe(t(key, "en"));
    }
  });
});

describe("HostMcpApprovalDialog: standing grants read through its adapter", () => {
  const registered = (name: string, always_grants: string[]) => ({
    name, command: ["uvx", "windows-mcp"], environment_keys: [], approval_mode: "prompt" as const,
    allow_when_locked: false, state: "running" as const, always_grants,
  });

  function mountWithServers(
    listServers: () => Promise<ReturnType<typeof registered>[]>,
    first: HostMcpPendingApproval[] = [toolCall({ tool: "Wait" })],
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const held: Array<(approvals: HostMcpPendingApproval[]) => void> = [];
    let lists = 0;
    let serverReads = 0;
    const client: HostMcpApprovalsClient = {
      listApprovals: () => {
        lists += 1;
        return lists === 1 ? Promise.resolve(first) : new Promise((resolve) => held.push(resolve));
      },
      decideApproval: async (approval_id, decision, grant_scope) =>
        decision === "approve"
          ? { approval_id, decision, outcome: "granted" as const, ...(grant_scope ? { grant_scope } : {}) }
          : { approval_id, decision, outcome: "denied" as const },
      listServers: () => {
        serverReads += 1;
        return listServers();
      },
    };
    const root = document.createElement("div");
    document.body.append(root);
    dispose = render(() => {
      const approvals = useHostMcpApprovals({ client: () => client });
      return <HostMcpApprovalDialog approvals={approvals} />;
    }, root);
    const answer = async (approvals: HostMcpPendingApproval[]) => {
      await vi.advanceTimersByTimeAsync(1_000);
      held.shift()?.(approvals);
      await vi.advanceTimersByTimeAsync(0);
    };
    const get = (id: string) => root.querySelector<HTMLElement>(`[data-testid=${id}]`);
    return { get, answer, serverReads: () => serverReads };
  }

  test("reads the server list when a tool approval appears and names its grants", async () => {
    const { get } = mountWithServers(async () => [registered("windows-mcp", ["Screenshot"])]);
    await vi.advanceTimersByTimeAsync(0);

    expect(get("host-mcp-approval-standing-grants")?.textContent).toBe(
      "Already always allowed on windows-mcp: Screenshot. This is a different tool.",
    );
  });

  test("a server list that cannot be read shows nothing, and the dialog still asks", async () => {
    const { get } = mountWithServers(async () => {
      throw new HostMcpApiError("service_unavailable", 503);
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(get("host-mcp-approval-dialog")).not.toBeNull();
    expect(get("host-mcp-approval-standing-grants")).toBeNull();
  });

  test("the next approvals use the list read a moment ago, and an Always allow reads it again", async () => {
    const snapshot = toolCall({
      approval_id: "appr-1",
      tool: "Snapshot",
      annotations: READ_ONLY,
      grant_scopes: ["once", "until_restart", "always"],
    });
    const wait = toolCall({ approval_id: "appr-2", tool: "Wait" });
    let grants: string[] = [];
    const { get, answer, serverReads } = mountWithServers(async () => [registered("windows-mcp", grants)], [snapshot]);
    await vi.advanceTimersByTimeAsync(0);
    expect(serverReads()).toBe(1);

    await answer([snapshot, wait]);
    expect(serverReads()).toBe(1);

    await vi.advanceTimersByTimeAsync(ARM_DELAY_MS);
    grants = ["Snapshot"];
    get("host-mcp-approval-always-allow-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    await answer([wait, toolCall({ approval_id: "appr-3", tool: "Type" })]);

    expect(serverReads()).toBe(2);
    expect(get("host-mcp-approval-tool")?.textContent).toBe("Wait");
    expect(get("host-mcp-approval-standing-grants")?.textContent).toBe(
      "Already always allowed on windows-mcp: Snapshot. This is a different tool.",
    );
  });

  test("an approval already queued behind an Always allow names the new grant at once, with no new list", async () => {
    const snapshot = toolCall({
      approval_id: "appr-1",
      tool: "Snapshot",
      annotations: READ_ONLY,
      grant_scopes: ["once", "until_restart", "always"],
    });
    const wait = toolCall({ approval_id: "appr-2", tool: "Wait" });
    let grants: string[] = [];
    const { get, serverReads } = mountWithServers(async () => [registered("windows-mcp", grants)], [snapshot, wait]);
    await vi.advanceTimersByTimeAsync(ARM_DELAY_MS);
    expect(serverReads()).toBe(1);

    grants = ["Snapshot"];
    get("host-mcp-approval-always-allow-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(serverReads()).toBe(2);
    expect(get("host-mcp-approval-tool")?.textContent).toBe("Wait");
    expect(get("host-mcp-approval-standing-grants")?.textContent).toBe(
      "Already always allowed on windows-mcp: Snapshot. This is a different tool.",
    );
  });
});

describe("HostMcpApprovalDialog: wording", () => {
  test("every line it shows is worded in both languages", () => {
    for (const key of [
      "mcp.host.approval.tool_title",
      "mcp.host.approval.tool_subtitle",
      "mcp.host.approval.browser_title",
      "mcp.host.approval.read_only",
      "mcp.host.approval.may_change",
      "mcp.host.approval.arguments",
      "mcp.host.approval.no_arguments",
      "mcp.host.approval.expires_in",
      "mcp.host.approval.allow_once",
      "mcp.host.approval.allow_until_restart",
      "mcp.host.approval.always_allow",
      "mcp.host.approval.deny",
      "mcp.host.banner.server_named",
      "mcp.host.banner.servers_one",
      "mcp.host.banner.servers_many",
      "mcp.host.banner.browser_suffix",
      "mcp.host.banner.browser_only",
      "mcp.host.banner.paused",
      "mcp.host.banner.stop_all",
      "mcp.host.run_on_computer",
      "mcp.host.run_on_computer_warning",
      "mcp.host.approval_prompt",
      "mcp.host.approval_auto",
      "mcp.host.use_browser",
      "mcp.host.browser_hint",
      "mcp.host.badge",
    ]) {
      expect(t(key, "en"), key).not.toBe(key);
      expect(t(key, "zh"), key).not.toBe(t(key, "en"));
    }
  });
});
