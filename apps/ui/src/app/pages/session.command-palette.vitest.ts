import { createRoot, createSignal } from "solid-js";
import { describe, expect, test, vi } from "vitest";

import type { WorkspaceSessionGroup } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";
import { createCommandPaletteItems } from "./session.command-palette";
import type { CommandPaletteMode } from "./session.quick-agents";

/**
 * `createCommandPaletteItems`' REACTIVE half: the memos that pick a mode's
 * items, re-filter on the query, and the action wiring behind each row.
 *
 * Deliberately not in `session.command-palette.test.ts`, which covers the pure
 * builders. The bun lane resolves Solid's server build, where a `createMemo` is
 * frozen at its first value, so every "changing X re-derives Y" assertion below
 * would pass vacuously there.
 */
const workspace = (id: string, name: string): WorkspaceInfo => ({
  id,
  name,
  path: `C:\\workspaces\\${id}`,
  preset: "starter",
  workspaceType: "local",
});

const group = (
  id: string,
  name: string,
  sessions: WorkspaceSessionGroup["sessions"],
): WorkspaceSessionGroup => ({
  workspace: workspace(id, name),
  sessions,
  status: "ready",
});

const defaultGroups = (): WorkspaceSessionGroup[] => [
  group("ws1", "Alpha", [
    { id: "s1", title: "Fix Login Bug", slug: "fix-login", time: { updated: 20, created: 10 } },
    { id: "s2", title: "Ship Release", slug: "ship", time: { updated: 15, created: 10 } },
  ]),
  group("ws2", "Beta", [
    { id: "s3", title: "Audit Billing", slug: "audit", time: { updated: 30, created: 10 } },
  ]),
];

function harness(initial?: {
  mode?: CommandPaletteMode;
  groups?: WorkspaceSessionGroup[];
  providerAuth?: () => Promise<void>;
}) {
  const [mode, setMode] = createSignal<CommandPaletteMode>(initial?.mode ?? "root");
  const [query, setQuery] = createSignal("");
  const [groups, setGroups] = createSignal(initial?.groups ?? defaultGroups());
  const [selectedSessionTitle, setSelectedSessionTitle] = createSignal("Fix Login Bug");
  const [modelVariantLabel, setModelVariantLabel] = createSignal("High");

  const calls = {
    enterMode: vi.fn<(mode: CommandPaletteMode) => void>(),
    close: vi.fn<() => void>(),
    closeAndFocusComposer: vi.fn<() => void>(),
    focusComposer: vi.fn<() => void>(),
    notify: vi.fn<(message: string) => void>(),
    openNewTask: vi.fn<() => void>(),
    openRenameModal: vi.fn<() => void>(),
    openSessionModelPicker: vi.fn<() => void>(),
    setModelVariant: vi.fn<(variant: string) => void>(),
    openSessionFromList: vi.fn<(workspaceId: string, sessionId: string) => void>(),
  };

  let dispose = () => {};
  const palette = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createCommandPaletteItems({
      mode,
      query,
      sessionGroups: groups,
      activeWorkspaceId: () => "ws1",
      labelWorkspace: (ws) => ws.name,
      selectedSessionTitle,
      selectedSessionModelLabel: () => "Auto",
      modelVariant: () => "high",
      modelVariantLabel,
      ...calls,
      openProviderAuthModal: initial?.providerAuth ?? (() => Promise.resolve()),
    });
  });

  const byId = (id: string) => {
    const found = palette.items().find((item) => item.id === id);
    if (!found) throw new Error(`no palette item with id ${id}`);
    return found;
  };

  return {
    palette,
    byId,
    calls,
    setMode,
    setQuery,
    setGroups,
    setSelectedSessionTitle,
    setModelVariantLabel,
    dispose,
  };
}

describe("mode switching", () => {
  test("root mode offers the six quick actions with the mode's own chrome", () => {
    const h = harness();

    expect(h.palette.items().map((item) => item.id)).toEqual([
      "new-session",
      "rename-session",
      "sessions",
      "model",
      "provider",
      "thinking",
    ]);
    expect(h.palette.title()).toBe("Quick actions");
    expect(h.palette.placeholder()).toBe("Search actions");
    h.dispose();
  });

  test("switching to sessions mode re-derives the list and the chrome", () => {
    const h = harness();

    h.setMode("sessions");

    expect(h.palette.title()).toBe("Search sessions");
    expect(h.palette.placeholder()).toBe("Find by session title or worker");
    // Active worker first, then by recency within each worker.
    expect(h.palette.items().map((item) => item.title)).toEqual([
      "Fix Login Bug",
      "Ship Release",
      "Audit Billing",
    ]);
    h.dispose();
  });

  test("switching to thinking mode marks the current variant", () => {
    const h = harness();

    h.setMode("thinking");

    expect(h.palette.title()).toBe("Change thinking");
    const current = h.palette.items().filter((item) => item.meta === "Current");
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe("thinking:high");
    h.dispose();
  });

  test("a session from another worker is labelled Switch, not Current worker", () => {
    const h = harness();
    h.setMode("sessions");

    const metas = new Map(h.palette.items().map((item) => [item.title, item.meta]));
    expect(metas.get("Fix Login Bug")).toBe("Current worker");
    expect(metas.get("Audit Billing")).toBe("Switch");
    h.dispose();
  });
});

describe("query filtering", () => {
  test("a root-mode query filters on title and detail together", () => {
    const h = harness();

    h.setQuery("thinking");

    expect(h.palette.items().map((item) => item.id)).toEqual(["thinking"]);
    h.dispose();
  });

  test("a sessions-mode query matches the slug, not just the title", () => {
    // searchText folds in the slug and worker name, which is why a user can
    // find a session by its URL-ish handle.
    const h = harness({ mode: "sessions" });

    h.setQuery("audit");

    expect(h.palette.items().map((item) => item.title)).toEqual(["Audit Billing"]);
    h.dispose();
  });

  test("clearing the query restores the full list", () => {
    const h = harness({ mode: "sessions" });
    h.setQuery("audit");
    expect(h.palette.items()).toHaveLength(1);

    h.setQuery("");

    expect(h.palette.items()).toHaveLength(3);
    h.dispose();
  });
});

describe("live detail lines", () => {
  test("the session count reacts to workers appearing", () => {
    const h = harness();
    expect(h.palette.totalSessionCount()).toBe(3);
    expect(h.byId("sessions").detail).toBe("3 available across workers");

    h.setGroups([
      ...defaultGroups(),
      group("ws3", "Gamma", [
        { id: "s4", title: "New Thing", slug: "new", time: { updated: 40, created: 10 } },
      ]),
    ]);

    expect(h.palette.totalSessionCount()).toBe(4);
    expect(h.byId("sessions").detail).toBe("4 available across workers");
    h.dispose();
  });

  test("renaming the open session is reflected in its row", () => {
    const h = harness();
    expect(h.byId("rename-session").detail).toBe("Fix Login Bug");

    h.setSelectedSessionTitle("   ");

    // A blank title falls back to the prompt rather than rendering empty.
    expect(h.byId("rename-session").detail).toBe(
      "Give your selected session a clearer name",
    );
    h.dispose();
  });

  test("the thinking row tracks the current variant label", () => {
    const h = harness();
    expect(h.byId("thinking").detail).toBe("Current: High");

    h.setModelVariantLabel("Low");

    expect(h.byId("thinking").detail).toBe("Current: Low");
    h.dispose();
  });
});

describe("action wiring", () => {
  test("Create new session opens a new task and returns focus to the composer", async () => {
    // This is the #2629 path: the palette calls openNewTask() rather than the
    // createSessionAndOpen() helper that no longer exists. Keeping the other
    // side of that conflict would have reverted it silently, so this is the
    // assertion that guards it.
    const h = harness();

    h.byId("new-session").action();

    expect(h.calls.close).toHaveBeenCalledTimes(1);
    expect(h.calls.openNewTask).toHaveBeenCalledTimes(1);
    // Focus is returned in a microtask, after the palette has gone.
    expect(h.calls.focusComposer).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(h.calls.focusComposer).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  test("Rename closes the palette before opening the modal", () => {
    const h = harness();

    h.byId("rename-session").action();

    expect(h.calls.close).toHaveBeenCalledTimes(1);
    expect(h.calls.openRenameModal).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  test("Search sessions enters a submode instead of closing", () => {
    // Closing here would drop the user out of the palette they are navigating.
    const h = harness();

    h.byId("sessions").action();

    expect(h.calls.enterMode).toHaveBeenCalledWith("sessions");
    expect(h.calls.close).not.toHaveBeenCalled();
    h.dispose();
  });

  test("Change thinking enters a submode instead of closing", () => {
    const h = harness();

    h.byId("thinking").action();

    expect(h.calls.enterMode).toHaveBeenCalledWith("thinking");
    expect(h.calls.close).not.toHaveBeenCalled();
    h.dispose();
  });

  test("Change model closes the palette and opens the picker", () => {
    const h = harness();

    expect(h.byId("model").detail).toBe("Current: Auto");

    h.byId("model").action();

    expect(h.calls.close).toHaveBeenCalledTimes(1);
    expect(h.calls.openSessionModelPicker).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  test("picking a thinking option applies it and says so", () => {
    const h = harness({ mode: "thinking" });
    const option = h.palette.items().find((item) => item.id !== "thinking:high");
    expect(option).toBeDefined();

    option?.action();

    expect(h.calls.setModelVariant).toHaveBeenCalledTimes(1);
    expect(h.calls.closeAndFocusComposer).toHaveBeenCalledTimes(1);
    expect(h.calls.notify).toHaveBeenCalledWith(
      `Thinking set to ${option?.title}.`,
    );
    h.dispose();
  });

  test("picking a session opens it in its own worker", () => {
    const h = harness({ mode: "sessions" });

    h.palette.items().find((item) => item.title === "Audit Billing")?.action();

    expect(h.calls.close).toHaveBeenCalledTimes(1);
    expect(h.calls.openSessionFromList).toHaveBeenCalledWith("ws2", "s3");
    h.dispose();
  });
});

describe("the provider flow's error path", () => {
  test("a failed provider load reports its message and restores focus", async () => {
    // The palette is already closed by this point, so a swallowed rejection
    // would leave the user with no dialog and no explanation.
    const h = harness({
      providerAuth: () => Promise.reject(new Error("no providers configured")),
    });

    h.byId("provider").action();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.calls.notify).toHaveBeenCalledWith("no providers configured");
    expect(h.calls.focusComposer).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  test("a non-Error rejection still produces a usable message", async () => {
    const h = harness({ providerAuth: () => Promise.reject("socket hung up") });

    h.byId("provider").action();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.calls.notify).toHaveBeenCalledWith("Failed to load providers");
    h.dispose();
  });
});
