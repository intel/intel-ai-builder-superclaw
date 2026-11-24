import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  EgressApprovalCallerSchema,
  SANDBOX_MANAGER_HOST_API_ERRORS,
  type EgressPendingApproval,
} from "@different-ai/openwork-contracts/sandbox-manager-host-api";
import { ServiceHubHttpError } from "~/shared/platform/transport/servicehub";

import { t } from "../../i18n";
import { useEgressApprovals, type EgressApprovals } from "../../features/egress-approvals";
import type { InstanceApiClient } from "~/shared/platform/transport/instance-api";
import EgressApprovalDialog from "./egress-approval-dialog";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const NOW = new Date("2026-10-06T21:00:00Z");
const ARM_MS = 700;

const approval = (overrides: Partial<EgressPendingApproval> = {}): EgressPendingApproval => ({
  approval_id: "appr-1",
  audience: "connector",
  action: "connector.fetch_result",
  caller: "agent",
  target: "https://example.com/report",
  requested_at: "2026-10-06T20:59:50Z",
  expires_at: "2026-10-06T21:01:00Z",
  ...overrides,
});

type Overrides = {
  approvals?: EgressPendingApproval[];
  decidingId?: string | null;
  decisionError?: { approvalId: string; message: string } | null;
  notice?: string | null;
  decide?: EgressApprovals["decide"];
  chatName?: EgressApprovals["chatName"];
};

function renderDialog(overrides: Overrides = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const decided: Array<[string, string]> = [];
  const dismissed = { notice: 0 };
  const [approvals, setApprovals] = createSignal<EgressPendingApproval[]>(
    overrides.approvals ?? [approval()],
  );
  const egress: EgressApprovals = {
    approvals,
    decidingId: () => overrides.decidingId ?? null,
    decisionError: () => overrides.decisionError ?? null,
    notice: () => overrides.notice ?? null,
    dismissNotice: () => (dismissed.notice += 1),
    decide:
      overrides.decide ??
      (async (id, decision) => {
        decided.push([id, decision]);
      }),
    chatName: overrides.chatName ?? (() => null),
  };
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <EgressApprovalDialog egress={egress} />, host);
  const get = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid=${id}]`);
  const advance = (ms: number) => vi.advanceTimersByTime(ms);
  /** Past the short delay after which Allow answers a click. */
  const arm = () => advance(ARM_MS);
  return { host, get, decided, dismissed, setApprovals, advance, arm };
}

const key = (target: Element | null, name: string, init: KeyboardEventInit = {}) =>
  target?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }));

describe("EgressApprovalDialog: what it shows", () => {
  test("shows nothing while no approval is waiting", () => {
    const { get } = renderDialog({ approvals: [] });

    expect(get("egress-approval-dialog")).toBeNull();
  });

  test("shows nothing for an approval that has already expired", () => {
    const { get } = renderDialog({ approvals: [approval({ expires_at: "2026-10-06T20:59:59Z" })] });

    expect(get("egress-approval-dialog")).toBeNull();
  });

  test("shows the whole target, who asked, what it is and how long is left", () => {
    const { host, get } = renderDialog();

    expect(get("egress-approval-target")?.textContent).toBe("https://example.com/report");
    const text = host.textContent ?? "";
    expect(text).toContain(t("egress_approval.action.connector.fetch_result"));
    expect(text).toContain(t("egress_approval.caller.agent"));
    expect(text).toContain(t("egress_approval.seconds").replace("{seconds}", "60"));
    expect(text).toContain("appr-1");
  });

  test("names every caller the contract has, in both languages", () => {
    for (const caller of EgressApprovalCallerSchema.options) {
      const key = `egress_approval.caller.${caller}`;
      expect(t(key, "en"), key).not.toBe(key);
      // zh falls back to en, so a missing zh line would read the same as the English one.
      expect(t(key, "zh"), key).not.toBe(t(key, "en"));
    }
  });

  test("shows a target as text, never as markup", () => {
    const target = '<img src=x onerror="alert(1)"> https://example.com';
    const { get } = renderDialog({ approvals: [approval({ target })] });

    expect(get("egress-approval-target")?.textContent).toBe(target);
    expect(get("egress-approval-target")?.querySelector("img")).toBeNull();
  });

  test("labels a shortened target with a label of its own, and only then", () => {
    const shortened = renderDialog({ approvals: [approval({ target: "https://example.com/aaaa…" })] });
    expect(shortened.get("egress-approval-shortened")?.textContent).toBe(t("egress_approval.shortened"));
    dispose?.();
    document.body.innerHTML = "";

    const whole = renderDialog();
    expect(whole.get("egress-approval-shortened")).toBeNull();
  });

  test("asks about the oldest first and says how many wait", () => {
    const { host, get } = renderDialog({
      approvals: [approval({ approval_id: "appr-1" }), approval({ approval_id: "appr-2", target: "https://other.example" })],
    });

    expect(get("egress-approval-target")?.textContent).toBe("https://example.com/report");
    expect(host.textContent).toContain(t("egress_approval.waiting").replace("{count}", "2"));
  });

  test("a failed decision shows its sentence on the approval it was for, and leaves it on screen", () => {
    const sentence = "That approval has already been decided or has expired.";
    const { host, get, arm } = renderDialog({ decisionError: { approvalId: "appr-1", message: sentence } });
    arm();

    expect(host.querySelector("[role=alert]")?.textContent).toBe(sentence);
    expect(get("egress-approval-dialog")).not.toBeNull();
    expect(get("egress-approval-allow-btn")?.disabled).toBe(false);
  });

  test("after a failed decision, Allow can be pressed again", () => {
    const { get, decided, arm } = renderDialog({
      decisionError: { approvalId: "appr-1", message: "The decision could not be delivered. Try again." },
    });
    arm();

    get("egress-approval-allow-btn")?.click();
    get("egress-approval-allow-btn")?.click();

    expect(decided).toEqual([
      ["appr-1", "approve"],
      ["appr-1", "approve"],
    ]);
  });

  test("a failure of an earlier approval is not shown on the next one", () => {
    const { host } = renderDialog({ decisionError: { approvalId: "appr-gone", message: "stale" } });

    expect(host.querySelector("[role=alert]")).toBeNull();
  });

  test("after a request ended on its own it says so, with a way to close", () => {
    const { host, get, dismissed } = renderDialog({ approvals: [], notice: "It ended." });

    expect(host.textContent).toContain("It ended.");
    get("egress-approval-notice-close-btn")?.click();
    expect(dismissed.notice).toBe(1);
  });
});

describe("EgressApprovalDialog: answering", () => {
  test("Allow waits a moment after an approval appears, Deny does not", () => {
    const { get, decided, advance } = renderDialog();

    expect(get("egress-approval-allow-btn")?.disabled).toBe(true);
    expect(get("egress-approval-deny-btn")?.disabled).toBe(false);
    get("egress-approval-allow-btn")?.click();
    advance(ARM_MS - 1);
    expect(get("egress-approval-allow-btn")?.disabled).toBe(true);
    advance(1);
    expect(get("egress-approval-allow-btn")?.disabled).toBe(false);
    get("egress-approval-allow-btn")?.click();

    expect(decided).toEqual([["appr-1", "approve"]]);
  });

  test("Allow and Deny hand the decision for that approval on", () => {
    const { get, decided, arm } = renderDialog();
    arm();

    get("egress-approval-allow-btn")?.click();
    get("egress-approval-deny-btn")?.click();

    expect(decided).toEqual([
      ["appr-1", "approve"],
      ["appr-1", "deny"],
    ]);
  });

  test("when the approval on screen changes, a click on Allow is ignored until it has been read", () => {
    const { get, decided, arm, advance, setApprovals } = renderDialog({
      approvals: [approval({ approval_id: "appr-1" })],
    });
    arm();

    setApprovals([approval({ approval_id: "appr-2", target: "https://other.example" })]);
    get("egress-approval-allow-btn")?.click();
    expect(decided).toEqual([]);
    expect(get("egress-approval-target")?.textContent).toBe("https://other.example");

    advance(ARM_MS);
    get("egress-approval-allow-btn")?.click();
    expect(decided).toEqual([["appr-2", "approve"]]);
  });

  test("a press that began on one approval does not answer the one that replaced it", () => {
    const { get, decided, arm, setApprovals } = renderDialog({
      approvals: [approval({ approval_id: "appr-1" })],
    });
    arm();

    get("egress-approval-deny-btn")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    setApprovals([approval({ approval_id: "appr-2" })]);
    get("egress-approval-deny-btn")?.click();

    expect(decided).toEqual([]);
  });

  test("a click on the approval that is still shown works, with or without a pointer press", () => {
    const { get, decided, arm } = renderDialog();
    arm();

    get("egress-approval-deny-btn")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    get("egress-approval-deny-btn")?.click();
    get("egress-approval-deny-btn")?.click();

    expect(decided).toEqual([
      ["appr-1", "deny"],
      ["appr-1", "deny"],
    ]);
  });

  test("while a decision is in flight both buttons are disabled", () => {
    const { get, arm } = renderDialog({ decidingId: "appr-1" });
    arm();

    expect(get("egress-approval-allow-btn")?.disabled).toBe(true);
    expect(get("egress-approval-deny-btn")?.disabled).toBe(true);
  });
});

describe("EgressApprovalDialog: keyboard", () => {
  test("focus starts on Deny, never on Allow", () => {
    const { get } = renderDialog();

    expect(document.activeElement).toBe(get("egress-approval-deny-btn"));
  });

  test("Escape denies the approval on screen and never approves", () => {
    const { get, decided, arm } = renderDialog();
    arm();

    key(get("egress-approval-dialog"), "Escape");

    expect(decided).toEqual([["appr-1", "deny"]]);
  });

  test("Escape does nothing while a decision is in flight", () => {
    const { get, decided, arm } = renderDialog({ decidingId: "appr-1" });
    arm();

    key(get("egress-approval-dialog"), "Escape");

    expect(decided).toEqual([]);
  });

  test("Tab stays inside the dialog and moves between Deny and Allow", () => {
    const { get, arm } = renderDialog();
    arm();
    const deny = get("egress-approval-deny-btn");
    const allow = get("egress-approval-allow-btn");

    deny?.focus();
    key(deny, "Tab");
    expect(document.activeElement).toBe(allow);
    key(allow, "Tab");
    expect(document.activeElement).toBe(deny);
    key(deny, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(allow);
  });

  test("a new list carrying the same approval keeps its buttons, and focus with them", () => {
    for (const grant_scopes of [undefined, ["once", "all_for_chat"] as const]) {
      const shown = () => approval(grant_scopes ? { grant_scopes: [...grant_scopes] } : {});
      const { get, arm, setApprovals } = renderDialog({ approvals: [shown()] });
      arm();
      const allow = get(grant_scopes ? "egress-approval-allow-all-btn" : "egress-approval-allow-btn");
      allow?.focus();

      setApprovals([shown()]);

      expect(get(grant_scopes ? "egress-approval-allow-all-btn" : "egress-approval-allow-btn")).toBe(allow);
      expect(document.activeElement).toBe(allow);
      dispose?.();
      document.body.innerHTML = "";
    }
  });
});

describe("EgressApprovalDialog: the scopes an approval offers", () => {
  const CHAT_REF = "sref_9a59ec8361e9787f";
  const scoped = (grant_scopes?: EgressPendingApproval["grant_scopes"]) =>
    approval({ ...(grant_scopes ? { grant_scopes, session_ref: CHAT_REF } : {}) });

  function renderScoped(
    scopes?: EgressPendingApproval["grant_scopes"],
    chatName: (sessionRef: string) => string | null = () => null,
  ) {
    const answers: Array<[string, string, string | undefined]> = [];
    const view = renderDialog({
      approvals: [scoped(scopes)],
      chatName,
      decide: async (id, decision, scope) => {
        answers.push([id, decision, scope]);
      },
    });
    return { ...view, answers };
  }

  test("a session the Connector knows is offered Deny, Allow once and Allow all sites for this session", () => {
    const { get } = renderScoped(["once", "all_for_chat"]);

    expect(get("egress-approval-allow-btn")).toBeNull();
    expect(get("egress-approval-deny-btn")?.textContent).toBe(t("egress_approval.deny"));
    expect(get("egress-approval-allow-once-btn")?.textContent).toBe(t("egress_approval.allow_once"));
    expect(get("egress-approval-allow-all-btn")?.textContent).toBe(t("egress_approval.allow_all_for_chat"));
    expect(get("egress-approval-chat-note")?.textContent).toBe(t("egress_approval.chat_scope_note"));
  });

  test("each Allow answers with its own scope once armed, and Deny with none", () => {
    for (const [button, scope] of [
      ["egress-approval-allow-once-btn", "once"],
      ["egress-approval-allow-all-btn", "all_for_chat"],
    ] as const) {
      const { get, answers, arm } = renderScoped(["once", "all_for_chat"]);
      get(button)?.click();
      expect(answers).toEqual([]);
      arm();
      get(button)?.click();
      expect(answers).toEqual([["appr-1", "approve", scope]]);
      dispose?.();
      document.body.innerHTML = "";
    }
    const { get, answers } = renderScoped(["once", "all_for_chat"]);
    get("egress-approval-deny-btn")?.click();
    expect(answers).toEqual([["appr-1", "deny", undefined]]);
  });

  test("a chat that could not be told is offered Allow once alone, and says why", () => {
    const { get } = renderScoped(["once"]);

    expect(get("egress-approval-deny-btn")).not.toBeNull();
    expect(get("egress-approval-allow-once-btn")).not.toBeNull();
    expect(get("egress-approval-allow-all-btn")).toBeNull();
    expect(get("egress-approval-allow-btn")).toBeNull();
    expect(get("egress-approval-chat-note")?.textContent).toBe(t("egress_approval.unknown_chat_note"));
  });

  test("an approval that lists no scopes keeps its two buttons, answers with no scope and shows no chat note", () => {
    const { get, answers, arm } = renderScoped();
    arm();

    expect(get("egress-approval-allow-once-btn")).toBeNull();
    expect(get("egress-approval-allow-all-btn")).toBeNull();
    expect(get("egress-approval-chat-note")).toBeNull();
    get("egress-approval-allow-btn")?.click();
    expect(answers).toEqual([["appr-1", "approve", undefined]]);
  });

  test("names the chat whose session_ref the approval carries", () => {
    const asked: string[] = [];
    const { get } = renderScoped(["once", "all_for_chat"], (sessionRef) => {
      asked.push(sessionRef);
      return sessionRef === CHAT_REF ? "Compare two laptops" : null;
    });

    expect(get("egress-approval-chat-name")?.textContent).toBe("Compare two laptops");
    expect(asked).toContain(CHAT_REF);
  });

  test("shows no chat row when no known chat matches, or the approval names none", () => {
    const unmatched = renderScoped(["once", "all_for_chat"], () => null);
    expect(unmatched.get("egress-approval-chat-name")).toBeNull();
    dispose?.();
    document.body.innerHTML = "";

    const unnamed = renderScoped(undefined, () => "Should not be shown");
    expect(unnamed.get("egress-approval-chat-name")).toBeNull();
  });

  test("an approval offered Allow once alone names no chat, even one that matches", () => {
    const { get } = renderScoped(["once"], () => "Compare two laptops");

    expect(get("egress-approval-chat-name")).toBeNull();
    expect(get("egress-approval-chat-note")?.textContent).toBe(t("egress_approval.unknown_chat_note"));
  });

  test("is worded in both languages", () => {
    for (const key of [
      "egress_approval.allow_once",
      "egress_approval.allow_all_for_chat",
      "egress_approval.chat_scope_note",
      "egress_approval.unknown_chat_note",
      "egress_approval.chat",
    ]) {
      expect(t(key, "en"), key).not.toBe(key);
      expect(t(key, "zh"), key).not.toBe(t(key, "en"));
    }
  });

  test("says session, as the rest of the app does", () => {
    expect(t("egress_approval.allow_all_for_chat", "en")).toBe("Allow all sites for this session");
    expect(t("egress_approval.allow_all_for_chat", "zh")).toBe("允许此会话中的所有网站");
    expect(t("egress_approval.chat", "en")).toBe("Session");
    expect(t("egress_approval.chat", "zh")).toBe("会话");
    expect(t("egress_approval.chat_scope_note", "en")).toBe(
      "\"This session\" stays allowed until you switch it off next to the message box. SuperClaw never opens addresses on your local network or this computer, whatever you choose.",
    );
    expect(t("egress_approval.chat_scope_note", "zh")).toBe(
      "“此会话”会一直保持允许，直到你在输入框旁将其关闭。无论你怎么选，SuperClaw 都不会打开本地网络或本机上的地址。",
    );
    expect(t("egress_approval.unknown_chat_note", "en")).not.toMatch(/\bchat\b/i);
    expect(t("egress_approval.unknown_chat_note", "zh")).toContain("会话");
    expect(t("egress_approval.unknown_chat_note", "zh")).not.toContain("对话");
  });
});

describe("EgressApprovalDialog with its adapter", () => {
  const SESSION_REF = "sref_9a59ec8361e9787f";
  type Client = Pick<InstanceApiClient, "listPendingApprovals" | "decideApproval">;

  /** The real `useEgressApprovals` over a host that lists `listed` once and then holds every later list. */
  function renderWithAdapter(
    listed: EgressPendingApproval[],
    {
      chats = [],
      refuse,
      refusals = [],
      holdDecision = false,
    }: {
      chats?: Array<{ id: string; title: string }>;
      refuse?: Error;
      /** One refusal per decision, in order; a decision past the end is granted (or gets `refuse`). */
      refusals?: Error[];
      holdDecision?: boolean;
    } = {},
  ) {
    const decided: Array<[string, string, string | undefined]> = [];
    /** With `holdDecision`, each decision answers when its entry is called. */
    const heldDecisions: Array<() => void> = [];
    /** Every list after the first, held until a test answers it. */
    const heldLists: Array<(approvals: EgressPendingApproval[]) => void> = [];
    let lists = 0;
    const client: Client = {
      listPendingApprovals: () => {
        lists += 1;
        if (lists === 1) return Promise.resolve({ available: true, approvals: listed });
        return new Promise((resolve) => heldLists.push((approvals) => resolve({ available: true, approvals })));
      },
      decideApproval: async (approval_id, decision, grant_scope) => {
        decided.push([approval_id, decision, grant_scope]);
        if (holdDecision) await new Promise<void>((resolve) => heldDecisions.push(resolve));
        const refusal = refusals.shift() ?? refuse;
        if (refusal) throw refusal;
        return { approval_id, decision: "approve", outcome: "granted", ...(grant_scope ? { grant_scope } : {}) };
      },
    };
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => {
      const egress = useEgressApprovals({ instanceApiClient: () => client, chats: () => chats });
      return <EgressApprovalDialog egress={egress} />;
    }, host);
    const get = (id: string) => host.querySelector<HTMLElement>(`[data-testid=${id}]`);
    return { host, get, decided, heldLists, heldDecisions };
  }

  const refusal = (code: "approval_delivery_failed" | "approval_not_pending") => {
    const { status, message } = SANDBOX_MANAGER_HOST_API_ERRORS[code];
    return new ServiceHubHttpError(message, status, code);
  };

  test("a decision the Sandbox Manager could not deliver keeps the prompt, and a retried list and answer settle it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const a = approval({ approval_id: "appr-a", target: "https://a.example/" });
    const { get, host, decided, heldLists } = renderWithAdapter([a], {
      refusals: [refusal("approval_delivery_failed")],
    });
    await vi.advanceTimersByTimeAsync(ARM_MS);

    get("egress-approval-allow-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(get("egress-approval-target")?.textContent).toBe("https://a.example/");
    expect(host.querySelector("[role=alert]")?.textContent).toBe(
      SANDBOX_MANAGER_HOST_API_ERRORS.approval_delivery_failed.message,
    );

    await vi.advanceTimersByTimeAsync(1_000 - ARM_MS);
    expect(heldLists).toHaveLength(1);
    heldLists[0]?.([a]);
    await vi.advanceTimersByTimeAsync(0);
    expect(get("egress-approval-target")?.textContent).toBe("https://a.example/");

    get("egress-approval-allow-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(decided).toEqual([
      ["appr-a", "approve", undefined],
      ["appr-a", "approve", undefined],
    ]);
    expect(get("egress-approval-dialog")).toBeNull();
    // The second answer landed: nothing to say about the first one.
    expect(get("egress-approval-notice")).toBeNull();
  });

  test("a decision on an approval that is no longer pending settles it, and a later list does not bring it back", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const a = approval({ approval_id: "appr-a", target: "https://a.example/" });
    const { get, heldLists } = renderWithAdapter([a], { refusals: [refusal("approval_not_pending")] });
    await vi.advanceTimersByTimeAsync(ARM_MS);

    get("egress-approval-allow-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(get("egress-approval-dialog")).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    heldLists[0]?.([a]);
    await vi.advanceTimersByTimeAsync(0);

    expect(get("egress-approval-dialog")).toBeNull();
  });

  test("a same-session request listed while Allow all sites is in flight stays; the prompts listed when it was chosen go", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const offered = (): Partial<EgressPendingApproval> => ({
      session_ref: SESSION_REF,
      grant_scopes: ["once", "all_for_chat"],
    });
    const a = approval({ approval_id: "appr-a", target: "https://a.example/", ...offered() });
    const b = approval({ approval_id: "appr-b", target: "https://b.example/", ...offered() });
    const n = approval({ approval_id: "appr-new", target: "https://new.example/", ...offered() });
    const { get, heldLists, heldDecisions } = renderWithAdapter([a, b], { holdDecision: true });
    await vi.advanceTimersByTimeAsync(ARM_MS);
    await vi.advanceTimersByTimeAsync(1_000 - ARM_MS);
    expect(heldLists).toHaveLength(1);

    get("egress-approval-allow-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    // A replaced Connector kept a new request of the session pending; it is listed before the answer lands.
    heldLists[0]?.([a, b, n]);
    await vi.advanceTimersByTimeAsync(0);
    expect(heldDecisions).toHaveLength(1);
    heldDecisions[0]?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(get("egress-approval-target")?.textContent).toBe("https://new.example/");
  });

  test("a list already in flight when Allow all sites is accepted cannot bring back the prompts it released", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const offered = (): Partial<EgressPendingApproval> => ({
      session_ref: SESSION_REF,
      grant_scopes: ["once", "all_for_chat"],
    });
    const a = approval({ approval_id: "appr-a", target: "https://a.example/", ...offered() });
    const b = approval({ approval_id: "appr-b", target: "https://b.example/", ...offered() });
    const c = approval({ approval_id: "appr-c", target: "https://c.example/" });
    const { get, heldLists } = renderWithAdapter([a, b, c]);
    await vi.advanceTimersByTimeAsync(ARM_MS);
    // The poller's next list goes out a second after the first, before the user answers.
    await vi.advanceTimersByTimeAsync(1_000 - ARM_MS);
    expect(heldLists).toHaveLength(1);

    get("egress-approval-allow-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(get("egress-approval-target")?.textContent).toBe("https://c.example/");

    heldLists[0]?.([a, b, c]);
    await vi.advanceTimersByTimeAsync(0);

    expect(get("egress-approval-target")?.textContent).toBe("https://c.example/");
  });

  test("a list started before Allow all sites is accepted is dropped, so a released prompt it first lists never shows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const offered = (): Partial<EgressPendingApproval> => ({
      session_ref: SESSION_REF,
      grant_scopes: ["once", "all_for_chat"],
    });
    const a = approval({ approval_id: "appr-a", target: "https://a.example/", ...offered() });
    const b = approval({ approval_id: "appr-b", target: "https://b.example/", ...offered() });
    const c = approval({ approval_id: "appr-c", target: "https://c.example/" });
    const d = approval({ approval_id: "appr-d", target: "https://d.example/" });
    const { get, heldLists } = renderWithAdapter([a, c]);
    await vi.advanceTimersByTimeAsync(ARM_MS);
    await vi.advanceTimersByTimeAsync(1_000 - ARM_MS);
    expect(heldLists).toHaveLength(1);

    get("egress-approval-allow-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    // B joined the session after the list in flight was asked for; the grant released it with A.
    heldLists[0]?.([b, c]);
    await vi.advanceTimersByTimeAsync(0);

    expect(get("egress-approval-target")?.textContent).toBe("https://c.example/");

    // The next list, asked for after the decision, is shown as it is.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(heldLists).toHaveLength(2);
    heldLists[1]?.([d]);
    await vi.advanceTimersByTimeAsync(0);

    expect(get("egress-approval-target")?.textContent).toBe("https://d.example/");
  });

  test("after Allow all sites for this session, the session's other prompts go, with no notice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const offered = (): Partial<EgressPendingApproval> => ({
      session_ref: SESSION_REF,
      grant_scopes: ["once", "all_for_chat"],
    });
    const { get, decided } = renderWithAdapter([
      approval({ approval_id: "appr-a", target: "https://a.example/", ...offered() }),
      approval({ approval_id: "appr-b", target: "https://b.example/", ...offered() }),
      approval({ approval_id: "appr-c", target: "https://c.example/" }),
    ]);
    await vi.advanceTimersByTimeAsync(ARM_MS);
    expect(get("egress-approval-target")?.textContent).toBe("https://a.example/");

    get("egress-approval-allow-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(decided).toEqual([["appr-a", "approve", "all_for_chat"]]);
    expect(get("egress-approval-target")?.textContent).toBe("https://c.example/");
    expect(get("egress-approval-notice")).toBeNull();
  });

  test("Allow all sites for an approval that had already ended releases nothing else", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const offered = (): Partial<EgressPendingApproval> => ({
      session_ref: SESSION_REF,
      grant_scopes: ["once", "all_for_chat"],
    });
    const { status, message } = SANDBOX_MANAGER_HOST_API_ERRORS.approval_not_pending;
    const { get } = renderWithAdapter(
      [
        approval({ approval_id: "appr-a", target: "https://a.example/", ...offered() }),
        approval({ approval_id: "appr-b", target: "https://b.example/", ...offered() }),
      ],
      { refuse: new ServiceHubHttpError(message, status, "approval_not_pending") },
    );
    await vi.advanceTimersByTimeAsync(ARM_MS);

    get("egress-approval-allow-all-btn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(get("egress-approval-target")?.textContent).toBe("https://b.example/");
  });

  test("a chat name that cannot be worked out leaves the names as they were, with no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("no digest"));
    try {
      const { get } = renderWithAdapter(
        // Real timers, so an expiry the clock will not reach.
        [approval({ session_ref: SESSION_REF, grant_scopes: ["once", "all_for_chat"], expires_at: "2999-01-01T00:00:00Z" })],
        { chats: [{ id: "ses_unhashable", title: "Plan a trip" }] },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(get("egress-approval-dialog")).not.toBeNull();
      expect(get("egress-approval-chat-name")).toBeNull();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      vi.restoreAllMocks();
    }
  });
});

describe("EgressApprovalDialog: an unlisted destination a command asked for (EG2-4b)", () => {
  const proxyApproval = (grant_scopes: EgressPendingApproval["grant_scopes"]) =>
    approval({
      audience: "egress_proxy",
      action: "proxy.connect_unlisted",
      caller: "shell",
      target: "example.com:443",
      grant_scopes,
      session_ref: "sref_9a59ec8361e9787f",
    });

  test("offers Allow all unlisted sites until restart, and says it covers every session", () => {
    const { host, get } = renderDialog({ approvals: [proxyApproval(["once", "all_for_chat"])] });

    expect(get("egress-approval-allow-btn")).toBeNull();
    expect(get("egress-approval-allow-once-btn")?.textContent).toBe(t("egress_approval.allow_once"));
    expect(get("egress-approval-allow-all-btn")?.textContent).toBe(t("egress_approval.proxy.allow_all_for_chat"));
    expect(get("egress-approval-chat-note")?.textContent).toBe(t("egress_approval.proxy.chat_scope_note"));
    const text = host.textContent ?? "";
    expect(text).toContain(t("egress_approval.action.proxy.connect_unlisted"));
    expect(text).toContain("example.com:443");
    expect(text).toContain(t("egress_approval.caller.shell"));
  });

  test("a command whose session could not be told is offered Allow once alone, and says why", () => {
    const { get } = renderDialog({ approvals: [proxyApproval(["once"])] });

    expect(get("egress-approval-allow-once-btn")).not.toBeNull();
    expect(get("egress-approval-allow-all-btn")).toBeNull();
    expect(get("egress-approval-chat-note")?.textContent).toBe(t("egress_approval.unknown_chat_note"));
  });

  test("is worded in both languages", () => {
    for (const key of [
      "egress_approval.action.proxy.connect_unlisted",
      "egress_approval.target.proxy.connect_unlisted",
      "egress_approval.proxy.allow_all_for_chat",
      "egress_approval.proxy.chat_scope_note",
    ]) {
      expect(t(key, "en"), key).not.toBe(key);
      expect(t(key, "zh"), key).not.toBe(t(key, "en"));
    }
  });
});