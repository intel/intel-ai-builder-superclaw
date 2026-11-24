import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostMcpPendingApproval } from "@different-ai/openwork-contracts/host-mcp-api";

import { HostMcpApiError } from "~/shared/platform/transport/host-mcp-api";
import { t } from "../../i18n";
import { HOST_APPROVAL_NOTICES, HOST_MCP_POLL, type HostMcpApprovalsClient } from "./host-mcp";
import HostMcpApprovalDialog, { ARM_DELAY_MS } from "./host-mcp-approval-dialog";
import HostMcpApprovalNotices from "./host-mcp-approval-notices";
import { useHostMcpApprovals } from "./useHostMcp";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const NOW = new Date("2026-11-03T21:00:00Z");

const toolCall = (id: string, overrides: Partial<Extract<HostMcpPendingApproval, { kind: "tool_call" }>> = {}): HostMcpPendingApproval => ({
  kind: "tool_call",
  approval_id: id,
  requested_at: "2026-11-03T20:59:55Z",
  expires_at: "2026-11-03T21:10:00Z",
  grant_scopes: ["once", "until_restart"],
  server: "windows-mcp",
  tool: "Click-Tool",
  annotations: { read_only: null, destructive: null, open_world: null },
  ...overrides,
});

const origin = (id: string): HostMcpPendingApproval => ({
  kind: "browser_origin",
  approval_id: id,
  requested_at: "2026-11-03T20:59:55Z",
  expires_at: "2026-11-03T21:10:00Z",
  grant_scopes: ["once", "until_restart"],
  origin: "https://example.com",
});

/** The real hook, dialog and notices over a gateway whose every list after the first waits for `answer`. */
function mount(first: HostMcpPendingApproval[], refusal?: Error) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const held: Array<(approvals: HostMcpPendingApproval[]) => void> = [];
  let lists = 0;
  const client: HostMcpApprovalsClient = {
    listApprovals: () => {
      lists += 1;
      if (lists === 1) return Promise.resolve(first);
      return new Promise((resolve) => held.push(resolve));
    },
    decideApproval: async (approval_id, decision) => {
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
    return (
      <>
        <HostMcpApprovalDialog approvals={approvals} />
        <HostMcpApprovalNotices approvals={approvals} />
      </>
    );
  }, root);
  const notices = () => Array.from(root.querySelectorAll<HTMLElement>("[data-testid=host-mcp-approval-notice]"));
  const texts = () => notices().map((notice) => notice.querySelector("[data-testid=host-mcp-approval-notice-text]")?.textContent);
  /** Lets the poller ask again, then answers that list. */
  const answer = async (approvals: HostMcpPendingApproval[]) => {
    await vi.advanceTimersByTimeAsync(HOST_MCP_POLL.minIntervalMs);
    held.shift()?.(approvals);
    await vi.advanceTimersByTimeAsync(0);
  };
  const get = (id: string) => root.querySelector<HTMLElement>(`[data-testid=${id}]`);
  return { root, notices, texts, answer, get };
}

const EXPIRED = "Approval for windows-mcp · Click-Tool expired, so it didn't run. Ask the agent to try again if you still want it.";
const CANCELLED = "The request for windows-mcp · Click-Tool was cancelled, so it didn't run.";

describe("host approval notices: an approval that ended unanswered", () => {
  test("one that left the list after its expiry says it expired and can be asked for again", async () => {
    const { texts, notices, answer } = mount([toolCall("a", { expires_at: "2026-11-03T21:00:00.500Z" })]);
    await vi.advanceTimersByTimeAsync(0);

    await answer([]);

    expect(texts()).toEqual([EXPIRED]);
    expect(notices()[0]?.getAttribute("data-ended")).toBe("expired");
  });

  test("one still listed past its expiry is told about once, when it leaves the dialog", async () => {
    const approval = toolCall("a", { expires_at: "2026-11-03T21:00:02Z" });
    const { texts, answer, get } = mount([approval]);
    await vi.advanceTimersByTimeAsync(0);
    expect(get("host-mcp-approval-dialog")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(get("host-mcp-approval-dialog")).toBeNull();
    expect(texts()).toEqual([EXPIRED]);

    await answer([]);
    expect(texts()).toEqual([EXPIRED]);
  });

  test("one that left the list well before its expiry was cancelled", async () => {
    const { texts, notices, answer } = mount([toolCall("a")]);
    await vi.advanceTimersByTimeAsync(0);

    await answer([]);

    expect(texts()).toEqual([CANCELLED]);
    expect(notices()[0]?.getAttribute("data-ended")).toBe("cancelled");
  });

  test("a browser origin names the origin", async () => {
    const { texts, answer } = mount([origin("o")]);
    await vi.advanceTimersByTimeAsync(0);

    await answer([]);

    expect(texts()).toEqual([
      t("mcp.host.notice.cancelled_origin").replace("{origin}", "https://example.com"),
    ]);
  });

  test("the gateway's words are shown as text, never as markup or replacement patterns", async () => {
    const { root, texts, answer } = mount([toolCall("a", { tool: "<b>$&</b>" })]);
    await vi.advanceTimersByTimeAsync(0);

    await answer([]);

    expect(texts()).toEqual(["The request for windows-mcp · <b>$&</b> was cancelled, so it didn't run."]);
    expect(root.querySelector("[data-testid=host-mcp-approval-notice] b")).toBeNull();
  });
});

describe("host approval notices: what the user answered", () => {
  test("an approval the user allowed or denied gets no notice", async () => {
    for (const button of ["host-mcp-approval-allow-once-btn", "host-mcp-approval-deny-btn"]) {
      const { notices, answer, get } = mount([toolCall("a")]);
      await vi.advanceTimersByTimeAsync(ARM_DELAY_MS);

      get(button)?.click();
      await vi.advanceTimersByTimeAsync(0);
      await answer([]);

      expect(notices()).toEqual([]);
      dispose?.();
      dispose = undefined;
      document.body.innerHTML = "";
    }
  });

  test("an approval dropped because it was no longer pending when the user clicked gets no notice", async () => {
    const { notices, answer, get } = mount([toolCall("a")], new HostMcpApiError("approval_not_pending", 409));
    await vi.advanceTimersByTimeAsync(ARM_DELAY_MS);

    get("host-mcp-approval-allow-once-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    await answer([]);

    expect(get("host-mcp-approval-dialog")).toBeNull();
    expect(notices()).toEqual([]);
  });
});

describe("host approval notices: going away", () => {
  test("Dismiss removes a notice, and the rest stay", async () => {
    const { notices, texts, answer } = mount([toolCall("a"), toolCall("b", { tool: "Type-Tool" })]);
    await vi.advanceTimersByTimeAsync(0);
    await answer([]);
    expect(notices()).toHaveLength(2);

    notices()[0]?.querySelector<HTMLButtonElement>("[data-testid=host-mcp-approval-notice-dismiss]")?.click();

    expect(texts()).toEqual([CANCELLED]);
  });

  test("each notice goes by itself after a minute", async () => {
    const { notices, answer } = mount([toolCall("a")]);
    await vi.advanceTimersByTimeAsync(0);
    await answer([]);
    expect(notices()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HOST_APPROVAL_NOTICES.dismissAfterMs - 1_000);
    expect(notices()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices()).toHaveLength(0);
  });

  test("only the latest few stay, newest first", async () => {
    const tools = ["One", "Two", "Three", "Four"];
    const { texts, answer } = mount(tools.map((tool) => toolCall(tool, { tool })));
    await vi.advanceTimersByTimeAsync(0);

    for (let left = tools.length - 1; left >= 0; left -= 1) {
      await answer(tools.slice(0, left).map((tool) => toolCall(tool, { tool })));
    }

    expect(texts()).toHaveLength(HOST_APPROVAL_NOTICES.keep);
    expect(texts()[0]).toContain("windows-mcp · One");
    expect(texts()[2]).toContain("windows-mcp · Three");
  });
});
