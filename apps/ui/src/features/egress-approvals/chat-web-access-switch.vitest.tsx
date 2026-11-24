import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";

import { t } from "../../i18n";
import type { KnownChat } from "./chat-names";
import ChatWebAccessSwitch from "./chat-web-access-switch";
import { useChatWebAccess, type ChatGrantClient, type ChatWebAccess } from "./useChatWebAccess";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const CHATS: KnownChat[] = [
  { id: "ses_root", title: "Plan a trip" },
  { id: "ses_sub", parentID: "ses_root", title: "research" },
  { id: "ses_slack", title: "Slack/bot alice" },
  { id: "ses_telegram_sub", parentID: "ses_telegram" },
  { id: "ses_telegram", title: "Telegram/bot bob" },
];

/** The host API as the switch sees it, in memory. */
function fakeHost(options: { allowed?: string[]; failSet?: boolean; unavailable?: boolean } = {}) {
  const allowed = new Set(options.allowed ?? []);
  const calls = { get: [] as string[], set: [] as Array<[string, boolean]> };
  const host = {
    allowed,
    calls,
    failSet: options.failSet ?? false,
    client: {
      getChatGrant: async (root: string) => {
        calls.get.push(root);
        return options.unavailable ? { available: false as const } : { available: true as const, allowed: allowed.has(root) };
      },
      setChatGrant: async (root: string, allow: boolean) => {
        calls.set.push([root, allow]);
        if (host.failSet) throw new Error("The decision could not be delivered to the Connector. Try again.");
        if (allow) allowed.add(root);
        else allowed.delete(root);
        return { allowed: allow };
      },
    } satisfies ChatGrantClient,
  };
  return host;
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(options: { client: ChatGrantClient | null; selected: string | null; chats?: KnownChat[] }) {
  const [selected, setSelected] = createSignal<string | null>(options.selected);
  const [chats, setChats] = createSignal<KnownChat[]>(options.chats ?? CHATS);
  const [changed, setChanged] = createSignal(0);
  const [client, setClient] = createSignal<ChatGrantClient | null>(options.client);
  const hook: { access?: ChatWebAccess } = {};
  const root = document.createElement("div");
  document.body.append(root);
  dispose = render(() => {
    const access = useChatWebAccess({
      instanceApiClient: client,
      chats,
      selectedSessionId: selected,
      changed,
    });
    hook.access = access;
    return <ChatWebAccessSwitch access={access} />;
  }, root);
  const chip = () => root.querySelector<HTMLButtonElement>("[data-testid=chat-web-access-chip]");
  const menu = () => root.querySelector<HTMLElement>("[role=menu]");
  const item = (choice: Choice) => root.querySelector<HTMLButtonElement>(`[data-testid=chat-web-access-${choice}]`);
  const open = () => {
    if (!menu()) chip()?.click();
  };
  return {
    root,
    access: () => {
      if (!hook.access) throw new Error("the hook did not run");
      return hook.access;
    },
    setSelected,
    setChats,
    setChanged,
    setClient,
    chip,
    menu,
    item,
    open,
    pick: (choice: Choice) => {
      open();
      item(choice)?.click();
    },
    label: () => chip()?.textContent?.trim() ?? null,
    name: () => chip()?.getAttribute("aria-label") ?? null,
    shown: () => root.querySelector("[data-testid=chat-web-access]") !== null,
    /** The note inside the open menu, or else the closed chip's accessible description. */
    note: () => {
      const inMenu = root.querySelector("[data-testid=chat-web-access-note]");
      if (inMenu) return inMenu.textContent;
      const describedBy = chip()?.getAttribute("aria-describedby");
      return describedBy ? (document.getElementById(describedBy)?.textContent ?? null) : null;
    },
  };
}

type Choice = "ask" | "allowed";
const ASK = () => t("chat_web_access.ask");
const ALLOWED = () => t("chat_web_access.allowed");
const chipName = (choice: string) => t("chat_web_access.chip_label").replace("{choice}", choice);

function press(key: string): void {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("ChatWebAccessSwitch: a new chat", () => {
  test("reads Ask for approval and keeps a choice locally until the chat exists", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: null });
    await flush();

    expect(view.label()).toBe(ASK());
    view.pick("allowed");
    await flush();

    expect(view.label()).toBe(ALLOWED());
    expect(view.menu()).toBeNull();
    expect(host.calls).toEqual({ get: [], set: [] });
  });

  test("a pre-select is sent once, for the new root, and the next new chat asks again", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: null });
    view.pick("allowed");
    await flush();

    await view.access().applyPreselect("ses_new");

    expect(host.calls.set).toEqual([["ses_new", true]]);
    view.setChats([{ id: "ses_new", title: "New task" }, ...CHATS]);
    view.setSelected("ses_new");
    await flush();
    expect(view.label()).toBe(ALLOWED());
    expect(view.note()).toBeNull();
    view.setSelected(null);
    await flush();
    expect(view.label()).toBe(ASK());
  });

  test("while the pre-select is handed over, the chip holds the choice and is disabled until the new session is selected", async () => {
    const held: Array<() => void> = [];
    const allowed = new Set<string>();
    const client: ChatGrantClient = {
      getChatGrant: async (root) => ({ available: true, allowed: allowed.has(root) }),
      setChatGrant: (root, allow) =>
        new Promise((resolve) =>
          held.push(() => {
            if (allow) allowed.add(root);
            resolve({ allowed: allow });
          }),
        ),
    };
    const view = mount({ client, selected: null });
    view.pick("allowed");
    await flush();

    const handingOver = view.access().applyPreselect("ses_new");
    await flush();
    expect(view.label()).toBe(ALLOWED());
    expect(view.chip()?.disabled).toBe(true);

    held[0]?.();
    await handingOver;
    await flush();
    expect(view.label()).toBe(ALLOWED());
    expect(view.chip()?.disabled).toBe(true);

    view.setChats([{ id: "ses_new", title: "New task" }, ...CHATS]);
    view.setSelected("ses_new");
    await flush();
    expect(view.label()).toBe(ALLOWED());
    expect(view.chip()?.disabled).toBe(false);
  });

  test("a hand-over whose session never opens ends: the chip is enabled again and asks each time", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: null });
    view.pick("allowed");
    await flush();

    await view.access().applyPreselect("ses_orphan");
    expect(view.chip()?.disabled).toBe(true);
    view.access().endPreselect();
    await flush();

    expect(host.calls.set).toEqual([["ses_orphan", true]]);
    expect(view.chip()?.disabled).toBe(false);
    expect(view.label()).toBe(ASK());
  });

  test("ending a hand-over after its session opened changes nothing", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: null });
    view.pick("allowed");
    await flush();
    await view.access().applyPreselect("ses_new");
    view.setChats([{ id: "ses_new", title: "New task" }, ...CHATS]);
    view.setSelected("ses_new");
    await flush();

    view.access().endPreselect();
    await flush();

    expect(view.label()).toBe(ALLOWED());
    expect(view.chip()?.disabled).toBe(false);
  });

  test("ending with no hand-over keeps the new-chat choice", async () => {
    const view = mount({ client: fakeHost().client, selected: null });
    view.pick("allowed");
    await flush();

    view.access().endPreselect();
    await flush();

    expect(view.label()).toBe(ALLOWED());
  });

  test("without a pre-select nothing is sent for the new chat", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: null });

    await view.access().applyPreselect("ses_new");

    expect(host.calls.set).toEqual([]);
  });

  test("a pre-select that fails reads Ask for approval with a note, and does not throw", async () => {
    const host = fakeHost({ failSet: true });
    const view = mount({ client: host.client, selected: null });
    view.pick("allowed");
    await flush();

    await expect(view.access().applyPreselect("ses_new")).resolves.toBeUndefined();
    view.setChats([{ id: "ses_new", title: "New task" }, ...CHATS]);
    view.setSelected("ses_new");
    await flush();

    expect(view.label()).toBe(ASK());
    expect(view.note()).toBe(t("chat_web_access.allow_failed"));
  });
});

describe("ChatWebAccessSwitch: an existing chat", () => {
  test("reads the chat's state and writes the user's choice", async () => {
    const host = fakeHost({ allowed: ["ses_root"] });
    const view = mount({ client: host.client, selected: "ses_root" });
    await flush();

    expect(host.calls.get).toEqual(["ses_root"]);
    expect(view.label()).toBe(ALLOWED());
    view.pick("ask");
    await flush();

    expect(host.calls.set).toEqual([["ses_root", false]]);
    expect(view.label()).toBe(ASK());
  });

  test("a sub-agent session shows and switches its root chat", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: "ses_sub" });
    await flush();

    expect(host.calls.get).toEqual(["ses_root"]);
    view.pick("allowed");
    await flush();

    expect(host.calls.set).toEqual([["ses_root", true]]);
    expect(view.label()).toBe(ALLOWED());
  });

  test("switching off that fails still reads Allow for this session, with a note", async () => {
    const host = fakeHost({ allowed: ["ses_root"], failSet: true });
    const view = mount({ client: host.client, selected: "ses_root" });
    await flush();

    view.pick("ask");
    await flush();

    expect(view.label()).toBe(ALLOWED());
    expect(view.note()).toBe(t("chat_web_access.ask_failed"));
  });

  test("a switch the server took but whose answer was lost reads what the server says, with no note", async () => {
    const allowed = new Set<string>();
    const client: ChatGrantClient = {
      getChatGrant: async (root) => ({ available: true, allowed: allowed.has(root) }),
      setChatGrant: async (root, allow) => {
        if (allow) allowed.add(root);
        throw new Error("The host service could not be reached.");
      },
    };
    const view = mount({ client, selected: "ses_root" });
    await flush();

    view.pick("allowed");
    await flush();

    expect(view.label()).toBe(ALLOWED());
    expect(view.note()).toBeNull();
  });

  test("a switch that failed and that the server did not take reads Ask for approval, with the note", async () => {
    const client: ChatGrantClient = {
      getChatGrant: async () => ({ available: true, allowed: false }),
      setChatGrant: async () => {
        throw new Error("The host service could not be reached.");
      },
    };
    const view = mount({ client, selected: "ses_root" });
    await flush();

    view.pick("allowed");
    await flush();

    expect(view.label()).toBe(ASK());
    expect(view.note()).toBe(t("chat_web_access.allow_failed"));
  });

  test("a write from a replaced client that answers last does not overwrite the new client's", async () => {
    const heldWrite = (allowed: boolean) => {
      const answers: Array<() => void> = [];
      const client: ChatGrantClient = {
        getChatGrant: async () => ({ available: true, allowed }),
        setChatGrant: (_root, allow) =>
          new Promise((resolve) => answers.push(() => resolve({ allowed: allow }))),
      };
      return { client, answers };
    };
    const first = heldWrite(false);
    // Reads Allowed, so that Ask for approval is a change and is written.
    const second = heldWrite(true);
    const view = mount({ client: first.client, selected: "ses_root" });
    await flush();
    view.pick("allowed");
    await flush();

    view.setClient(second.client);
    await flush();
    view.pick("ask");
    await flush();
    expect(second.answers).toHaveLength(1);
    second.answers[0]?.();
    await flush();
    first.answers[0]?.();
    await flush();

    expect(view.label()).toBe(ASK());
  });

  test("a write from a replaced client that answers after the new client's read changes nothing", async () => {
    const answers: Array<() => void> = [];
    const first: ChatGrantClient = {
      getChatGrant: async () => ({ available: true, allowed: false }),
      setChatGrant: (_root, allow) => new Promise((resolve) => answers.push(() => resolve({ allowed: allow }))),
    };
    const second: ChatGrantClient = {
      getChatGrant: async () => ({ available: true, allowed: false }),
      setChatGrant: async (_root, allow) => ({ allowed: allow }),
    };
    const view = mount({ client: first, selected: "ses_root" });
    await flush();
    view.pick("allowed");
    await flush();

    view.setClient(second);
    await flush();
    expect(view.label()).toBe(ASK());
    answers[0]?.();
    await flush();

    expect(view.label()).toBe(ASK());
    expect(view.chip()?.disabled).toBe(false);
  });

  test("a read from a replaced client, for a chat no longer shown, neither hides the switch nor changes the state", async () => {
    const held = new Map<string, (answer: Awaited<ReturnType<ChatGrantClient["getChatGrant"]>>) => void>();
    const first: ChatGrantClient = {
      getChatGrant: (root) => new Promise((resolve) => held.set(root, resolve)),
      setChatGrant: async (_root, allow) => ({ allowed: allow }),
    };
    const second: ChatGrantClient = {
      getChatGrant: async () => ({ available: true, allowed: false }),
      setChatGrant: async (_root, allow) => ({ allowed: allow }),
    };
    const view = mount({ client: first, selected: "ses_root", chats: [...CHATS, { id: "ses_other", title: "Other" }] });
    await flush();
    view.setSelected("ses_other");
    await flush();
    view.setClient(second);
    await flush();
    expect(view.label()).toBe(ASK());

    held.get("ses_root")?.({ available: false });
    held.get("ses_other")?.({ available: true, allowed: true });
    await flush();

    expect(view.shown()).toBe(true);
    expect(view.label()).toBe(ASK());
    view.setSelected("ses_root");
    await flush();
    expect(view.shown()).toBe(true);
  });

  test("an older read that answers after a newer one does not overwrite it", async () => {
    const answers: Array<(allowed: boolean) => void> = [];
    const client: ChatGrantClient = {
      getChatGrant: () =>
        new Promise((resolve) => answers.push((allowed) => resolve({ available: true, allowed }))),
      setChatGrant: async (_root, allow) => ({ allowed: allow }),
    };
    const view = mount({ client, selected: "ses_root" });
    await flush();
    view.setChanged(1);
    await flush();
    expect(answers).toHaveLength(2);

    answers[1]?.(true);
    await flush();
    answers[0]?.(false);
    await flush();

    expect(view.label()).toBe(ALLOWED());
  });

  test("an older read that answers unavailable after a newer one does not hide the switch", async () => {
    const answers: Array<(answer: Awaited<ReturnType<ChatGrantClient["getChatGrant"]>>) => void> = [];
    const client: ChatGrantClient = {
      getChatGrant: () => new Promise((resolve) => answers.push(resolve)),
      setChatGrant: async (_root, allow) => ({ allowed: allow }),
    };
    const view = mount({ client, selected: "ses_root" });
    await flush();
    view.setChanged(1);
    await flush();
    expect(answers).toHaveLength(2);

    answers[1]?.({ available: true, allowed: true });
    await flush();
    answers[0]?.({ available: false });
    await flush();

    expect(view.shown()).toBe(true);
    expect(view.label()).toBe(ALLOWED());
  });

  test("a failure note goes once a read says the chat changed, and stays while it says the same", async () => {
    const host = fakeHost({ failSet: true });
    const view = mount({ client: host.client, selected: "ses_root" });
    await flush();
    view.pick("allowed");
    await flush();
    expect(view.note()).toBe(t("chat_web_access.allow_failed"));

    view.setChanged(1);
    await flush();
    expect(view.note()).toBe(t("chat_web_access.allow_failed"));

    host.allowed.add("ses_root");
    view.setChanged(2);
    await flush();

    expect(view.label()).toBe(ALLOWED());
    expect(view.note()).toBeNull();
  });

  test("a chat allowed in the dialog whose refresh then fails is not known, with a note, and Ask for approval is written", async () => {
    let readsFail = false;
    const allowed = new Set<string>();
    const set: Array<[string, boolean]> = [];
    const client: ChatGrantClient = {
      getChatGrant: async (root) => {
        if (readsFail) throw new Error("The host service could not be reached.");
        return { available: true, allowed: allowed.has(root) };
      },
      setChatGrant: async (root, allow) => {
        set.push([root, allow]);
        if (allow) allowed.add(root);
        else allowed.delete(root);
        return { allowed: allow };
      },
    };
    const view = mount({ client, selected: "ses_root" });
    await flush();
    expect(view.label()).toBe(ASK());

    allowed.add("ses_root");
    readsFail = true;
    view.setChanged(1);
    await flush();

    expect(view.label()).toBe(t("chat_web_access.chip_unknown"));
    expect(view.note()).toBe(t("chat_web_access.read_failed"));
    view.pick("ask");
    await flush();
    expect(set).toEqual([["ses_root", false]]);
  });

  test("an approval answered for the chat in the dialog is read back", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: "ses_root" });
    await flush();
    expect(view.label()).toBe(ASK());

    host.allowed.add("ses_root");
    view.setChanged(1);
    await flush();

    expect(host.calls.get).toEqual(["ses_root", "ses_root"]);
    expect(view.label()).toBe(ALLOWED());
  });

  test("an approval answered for the chat while a switch-off is on its way is read once the switch-off answers", async () => {
    const allowed = new Set(["ses_root"]);
    const gets: string[] = [];
    let answerSet: (() => void) | undefined;
    const client: ChatGrantClient = {
      getChatGrant: async (root) => {
        gets.push(root);
        return { available: true, allowed: allowed.has(root) };
      },
      setChatGrant: (root, allow) =>
        new Promise((resolve) => {
          if (!allow) allowed.delete(root);
          answerSet = () => resolve({ allowed: allow });
        }),
    };
    const view = mount({ client, selected: "ses_root" });
    await flush();
    expect(view.label()).toBe(ALLOWED());

    view.pick("ask");
    await flush();
    // The switch-off was taken; then the dialog allowed the chat again, before the switch-off's answer came back.
    allowed.add("ses_root");
    view.setChanged(1);
    await flush();
    expect(gets).toEqual(["ses_root"]);
    answerSet?.();
    await flush();

    expect(gets).toEqual(["ses_root", "ses_root"]);
    expect(view.label()).toBe(ALLOWED());
  });
});

describe("ChatWebAccessSwitch: a chat whose setting is not known", () => {
  const UNKNOWN = () => t("chat_web_access.chip_unknown");
  const checkedItems = (view: ReturnType<typeof mount>) => view.root.querySelectorAll("[role=menuitemradio][aria-checked=true]");

  test("while the first read is pending the chip is neutral, nothing is checked, and either choice is written", async () => {
    for (const [choice, allow] of [
      ["ask", false],
      ["allowed", true],
    ] as const) {
      const set: Array<[string, boolean]> = [];
      const client: ChatGrantClient = {
        getChatGrant: () => new Promise(() => undefined),
        setChatGrant: async (root, value) => {
          set.push([root, value]);
          return { allowed: value };
        },
      };
      const view = mount({ client, selected: "ses_root" });
      await flush();

      expect(view.label(), choice).toBe(UNKNOWN());
      expect(view.name(), choice).toBe(UNKNOWN());
      expect(view.note(), choice).toBeNull();
      view.open();
      expect(checkedItems(view), choice).toHaveLength(0);
      expect(view.menu()?.querySelector("svg.lucide-check"), choice).toBeNull();

      view.pick(choice);
      await flush();

      expect(set, choice).toEqual([["ses_root", allow]]);
      expect(view.label(), choice).toBe(allow ? ALLOWED() : ASK());
      dispose?.();
      dispose = undefined;
    }
  });

  test("a first read that failed shows a note, and either choice is written", async () => {
    for (const [choice, allow] of [
      ["ask", false],
      ["allowed", true],
    ] as const) {
      const set: Array<[string, boolean]> = [];
      const client: ChatGrantClient = {
        getChatGrant: async () => {
          throw new Error("The host service could not be reached.");
        },
        setChatGrant: async (root, value) => {
          set.push([root, value]);
          return { allowed: value };
        },
      };
      const view = mount({ client, selected: "ses_root" });
      await flush();

      expect(view.label(), choice).toBe(UNKNOWN());
      expect(view.note(), choice).toBe(t("chat_web_access.read_failed"));
      view.open();
      expect(view.note(), choice).toBe(t("chat_web_access.read_failed"));
      expect(checkedItems(view), choice).toHaveLength(0);

      view.pick(choice);
      await flush();

      expect(set, choice).toEqual([["ses_root", allow]]);
      expect(view.note(), choice).toBeNull();
      dispose?.();
      dispose = undefined;
    }
  });

  test("an allow whose answer and whose read-back are both lost is not known, says the setting could not be read, and Ask for approval is then written", async () => {
    let reads = 0;
    const set: Array<[string, boolean]> = [];
    const client: ChatGrantClient = {
      getChatGrant: async () => {
        reads += 1;
        if (reads > 1) throw new Error("The host service could not be reached.");
        return { available: true, allowed: false };
      },
      setChatGrant: async (root, value) => {
        set.push([root, value]);
        throw new Error("The host service could not be reached.");
      },
    };
    const view = mount({ client, selected: "ses_root" });
    await flush();

    view.pick("allowed");
    await flush();

    expect(view.menu()).not.toBeNull();
    expect(view.label()).toBe(UNKNOWN());
    expect(view.note()).toBe(t("chat_web_access.read_failed"));
    expect(checkedItems(view)).toHaveLength(0);

    view.pick("ask");
    await flush();

    expect(set).toEqual([
      ["ses_root", true],
      ["ses_root", false],
    ]);
  });
});

describe("ChatWebAccessSwitch: the chip and its menu", () => {
  test("the chip shows the chosen option, is named for what it controls, and opens a menu with both choices", async () => {
    const view = mount({ client: fakeHost().client, selected: "ses_root" });
    await flush();

    expect(view.label()).toBe("Ask for approval");
    expect(view.name()).toBe("Web pages: Ask for approval");
    expect(view.chip()?.getAttribute("aria-haspopup")).toBe("menu");
    expect(view.chip()?.getAttribute("aria-expanded")).toBe("false");
    expect(view.menu()).toBeNull();

    view.open();

    expect(view.chip()?.getAttribute("aria-expanded")).toBe("true");
    const menu = view.menu();
    // A title and the two choices, only "Allow" with a line under it: no footer, no hint under "Ask".
    expect(menu?.textContent).toBe(
      "How should web page access be approved?" + "Ask for approval" + "Allow for this session" + "Opens public web pages without asking",
    );
    expect(view.item("ask")?.getAttribute("role")).toBe("menuitemradio");
    expect(view.item("ask")?.getAttribute("aria-checked")).toBe("true");
    expect(view.item("allowed")?.getAttribute("role")).toBe("menuitemradio");
    expect(view.item("allowed")?.getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(view.item("ask"));
  });

  test("an allowed session's chip shows Allow for this session and its menu checks it", async () => {
    const view = mount({ client: fakeHost({ allowed: ["ses_root"] }).client, selected: "ses_root" });
    await flush();

    expect(view.label()).toBe("Allow for this session");
    expect(view.name()).toBe("Web pages: Allow for this session");
    view.open();
    expect(view.item("ask")?.getAttribute("aria-checked")).toBe("false");
    expect(view.item("allowed")?.getAttribute("aria-checked")).toBe("true");
  });

  test("picking the other choice writes it, closes the menu and returns focus to the chip", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: "ses_root" });
    await flush();

    view.pick("allowed");
    await flush();

    expect(host.calls.set).toEqual([["ses_root", true]]);
    expect(view.menu()).toBeNull();
    expect(document.activeElement).toBe(view.chip());
    expect(view.label()).toBe(ALLOWED());
    expect(view.name()).toBe(chipName(ALLOWED()));
  });

  test("on a chat, picking the choice the chip shows still writes it, then closes the menu", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: "ses_root" });
    await flush();

    view.pick("ask");
    await flush();

    expect(host.calls.set).toEqual([["ses_root", false]]);
    expect(view.menu()).toBeNull();
    expect(document.activeElement).toBe(view.chip());
  });

  test("on the new-chat screen, picking the choice the chip shows sends nothing and closes the menu", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: null });
    await flush();

    view.pick("ask");
    await flush();

    expect(host.calls.set).toEqual([]);
    expect(view.label()).toBe(ASK());
    expect(view.menu()).toBeNull();
    expect(document.activeElement).toBe(view.chip());
  });

  test("Ask for approval, picked while a dialog allow is still being read back, revokes it", async () => {
    const allowed = new Set<string>();
    const set: Array<[string, boolean]> = [];
    let holdReads = false;
    const client: ChatGrantClient = {
      getChatGrant: (root) =>
        holdReads
          ? new Promise(() => undefined)
          : Promise.resolve({ available: true, allowed: allowed.has(root) }),
      setChatGrant: async (root, allow) => {
        set.push([root, allow]);
        if (allow) allowed.add(root);
        else allowed.delete(root);
        return { allowed: allow };
      },
    };
    const view = mount({ client, selected: "ses_root" });
    await flush();
    expect(view.label()).toBe(ASK());

    // Allowed for the chat in the approval dialog; the read that would say so has not answered.
    allowed.add("ses_root");
    holdReads = true;
    view.setChanged(1);
    await flush();
    expect(view.label()).toBe(ASK());

    view.pick("ask");
    await flush();

    expect(set).toEqual([["ses_root", false]]);
    expect(allowed.has("ses_root")).toBe(false);
  });

  test("Escape closes the menu and returns focus to the chip", async () => {
    const host = fakeHost();
    const view = mount({ client: host.client, selected: "ses_root" });
    await flush();
    view.open();

    press("Escape");

    expect(view.menu()).toBeNull();
    expect(document.activeElement).toBe(view.chip());
    expect(host.calls.set).toEqual([]);
  });

  test("a click outside closes the menu", async () => {
    const view = mount({ client: fakeHost().client, selected: "ses_root" });
    await flush();
    view.open();
    expect(view.menu()).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(view.menu()).toBeNull();
  });

  test("the arrow keys move between the choices", async () => {
    const view = mount({ client: fakeHost().client, selected: "ses_root" });
    await flush();
    view.open();

    press("ArrowDown");
    expect(document.activeElement).toBe(view.item("allowed"));
    press("ArrowDown");
    expect(document.activeElement).toBe(view.item("ask"));
    press("ArrowUp");
    expect(document.activeElement).toBe(view.item("allowed"));
  });

  test("Enter or Space on a focused choice picks it once, with the click the browser fires after the key", async () => {
    const view = mount({ client: fakeHost().client, selected: "ses_root" });
    await flush();
    const setAllowed = vi.spyOn(view.access(), "setAllowed");

    view.open();
    view.item("allowed")?.focus();
    press("Enter");
    view.item("allowed")?.click();
    await flush();
    expect(setAllowed).toHaveBeenCalledTimes(1);
    expect(setAllowed).toHaveBeenLastCalledWith(true);

    setAllowed.mockClear();
    view.open();
    view.item("ask")?.focus();
    press(" ");
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    view.item("ask")?.click();
    await flush();
    expect(setAllowed).toHaveBeenCalledTimes(1);
    expect(setAllowed).toHaveBeenLastCalledWith(false);
  });

  test("a chip near the right edge shifts its menu left to stay inside the window, and back when the window widens", async () => {
    const view = mount({ client: fakeHost().client, selected: "ses_root" });
    await flush();
    const anchor = view.root.querySelector<HTMLElement>("[data-testid=chat-web-access]");
    if (!anchor) throw new Error("the switch did not render");
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 600, 160, 32));
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu" ? 384 : 0;
    });
    const innerWidth = vi.spyOn(window, "innerWidth", "get").mockReturnValue(660);

    view.open();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    // 660 - 16 - 384 = 260, so the menu starts 140px left of the chip.
    expect(view.menu()?.style.transform).toBe("translateX(-140px)");

    innerWidth.mockReturnValue(1280);
    window.dispatchEvent(new Event("resize"));

    expect(view.menu()?.style.transform).toBe("translateX(0px)");
  });

  test("the chip is disabled while a choice is being written", async () => {
    const answers: Array<() => void> = [];
    const client: ChatGrantClient = {
      getChatGrant: async () => ({ available: true, allowed: false }),
      setChatGrant: (_root, allow) => new Promise((resolve) => answers.push(() => resolve({ allowed: allow }))),
    };
    const view = mount({ client, selected: "ses_root" });
    await flush();

    view.pick("allowed");
    await flush();
    expect(view.chip()?.disabled).toBe(true);

    answers[0]?.();
    await flush();
    expect(view.chip()?.disabled).toBe(false);
    expect(view.menu()).toBeNull();
    expect(view.label()).toBe(ALLOWED());
  });

  test("a failed choice keeps the menu open with the note, and the closed chip still carries it", async () => {
    const view = mount({ client: fakeHost({ failSet: true }).client, selected: "ses_root" });
    await flush();

    view.pick("allowed");
    await flush();

    expect(view.menu()).not.toBeNull();
    const note = view.root.querySelector("[data-testid=chat-web-access-note]");
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.textContent).toBe(t("chat_web_access.allow_failed"));

    press("Escape");

    expect(view.menu()).toBeNull();
    expect(view.note()).toBe(t("chat_web_access.allow_failed"));
  });
});

describe("ChatWebAccessSwitch: wording", () => {
  test("the menu and its notes are one short sentence each, in both languages", () => {
    const expected: Record<string, [string, string]> = {
      "chat_web_access.menu_title": ["How should web page access be approved?", "网页访问如何审批？"],
      "chat_web_access.ask": ["Ask for approval", "请求批准"],
      "chat_web_access.allowed_detail": ["Opens public web pages without asking", "无需询问即可打开公开网页"],
      "chat_web_access.allow_failed": ["Couldn't allow. Still asking for approval; try again.", "未能允许。仍会请求批准，请重试。"],
      "chat_web_access.ask_failed": ["Couldn't turn off. Still allowed; try again.", "未能关闭。仍为允许，请重试。"],
      "chat_web_access.read_failed": ["Couldn't read this setting. Pick an option.", "无法读取此设置。请选择一项。"],
    };
    for (const [key, [en, zh]] of Object.entries(expected)) {
      expect(t(key, "en"), key).toBe(en);
      expect(t(key, "zh"), key).toBe(zh);
    }
  });
});

describe("ChatWebAccessSwitch: where it is not shown", () => {
  test("a Slack or Telegram chat, and its sub-agents, have no switch and nothing is read", async () => {
    const host = fakeHost();
    for (const selected of ["ses_slack", "ses_telegram_sub"]) {
      const view = mount({ client: host.client, selected });
      await flush();
      expect(view.shown(), selected).toBe(false);
      dispose?.();
      dispose = undefined;
    }
    expect(host.calls).toEqual({ get: [], set: [] });
  });

  test("without ServiceHub there is no switch", async () => {
    const view = mount({ client: null, selected: null });
    await flush();

    expect(view.shown()).toBe(false);
  });

  test("a backend without chat grants hides the switch", async () => {
    const view = mount({ client: fakeHost({ unavailable: true }).client, selected: "ses_root" });
    await flush();

    expect(view.shown()).toBe(false);
  });
});
