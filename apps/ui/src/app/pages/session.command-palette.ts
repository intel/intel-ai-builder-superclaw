import { createMemo } from "solid-js";
import type { WorkspaceSessionGroup } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";
import { COMMAND_PALETTE_THINKING_OPTIONS } from "./session.quick-agents";
import type { CommandPaletteMode } from "./session.quick-agents";

const MAX_COMMAND_PALETTE_SESSION_ITEMS = 80;

export type CommandPaletteSessionOption = {
  workspaceId: string;
  sessionId: string;
  title: string;
  workspaceTitle: string;
  updatedAt: number;
  searchText: string;
};

type CommandPaletteThinkingEntry = {
  value: string;
  label: string;
  detail: string;
  isCurrent: boolean;
};

const normalizeQuery = (query: string) => query.trim().toLowerCase();

export function matchesCommandPaletteQuery(haystack: string, query: string) {
  const needle = normalizeQuery(query);
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle);
}

export function buildCommandPaletteSessionOptions(
  groups: WorkspaceSessionGroup[],
  activeWorkspaceId: string,
  labelWorkspace: (workspace: WorkspaceInfo) => string,
): CommandPaletteSessionOption[] {
  const out: CommandPaletteSessionOption[] = [];

  for (const group of groups) {
    const workspaceId = group.workspace.id?.trim() ?? "";
    if (!workspaceId) continue;
    const workspaceTitle = labelWorkspace(group.workspace);
    for (const session of group.sessions) {
      const sessionId = session.id?.trim() ?? "";
      if (!sessionId) continue;
      const title = session.title?.trim() || "Untitled session";
      const slug = session.slug?.trim() ?? "";
      const updatedAt = session.time?.updated ?? session.time?.created ?? 0;
      out.push({
        workspaceId,
        sessionId,
        title,
        workspaceTitle,
        updatedAt,
        searchText: [title, workspaceTitle, slug].join(" ").toLowerCase(),
      });
    }
  }

  out.sort((a, b) => {
    const aActive = a.workspaceId === activeWorkspaceId;
    const bActive = b.workspaceId === activeWorkspaceId;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  return out;
}

export function filterCommandPaletteSessionOptions(
  options: CommandPaletteSessionOption[],
  query: string,
): CommandPaletteSessionOption[] {
  // searchText is prebuilt lowercase, so the needle must be too.
  const needle = normalizeQuery(query);
  const candidates = needle
    ? options.filter((option) => option.searchText.includes(needle))
    : options;
  return candidates.slice(0, MAX_COMMAND_PALETTE_SESSION_ITEMS);
}

// "balanced"/"balance" are legacy spellings of the default variant, which the
// palette must still show as the current selection.
function normalizeThinkingVariant(raw: string | null | undefined) {
  const normalized = (raw ?? "none").trim().toLowerCase();
  if (normalized === "balanced" || normalized === "balance") return "none";
  return normalized;
}

export function buildCommandPaletteThinkingEntries(
  modelVariant: string | null | undefined,
  query: string,
): CommandPaletteThinkingEntry[] {
  const activeVariant = normalizeThinkingVariant(modelVariant);
  return COMMAND_PALETTE_THINKING_OPTIONS.filter((option) =>
    matchesCommandPaletteQuery(`${option.label} ${option.detail}`, query),
  ).map((option) => ({
    value: option.value,
    label: option.label,
    detail: option.detail,
    isCurrent: activeVariant === option.value,
  }));
}

export function commandPaletteTitleForMode(mode: CommandPaletteMode) {
  if (mode === "sessions") return "Search sessions";
  if (mode === "thinking") return "Change thinking";
  return "Quick actions";
}

export function commandPalettePlaceholderForMode(mode: CommandPaletteMode) {
  if (mode === "sessions") return "Find by session title or worker";
  if (mode === "thinking") return "Filter thinking options";
  return "Search actions";
}

export type CommandPaletteItem = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  action: () => void;
};

/**
 * Reactive inputs arrive as thunks so the memos below track in the caller's
 * scope. The command callbacks are passed already bound to their focus-return
 * target, which keeps the option shapes of the underlying modals out of here.
 */
type CommandPaletteItemsDeps = {
  mode: () => CommandPaletteMode;
  query: () => string;
  sessionGroups: () => WorkspaceSessionGroup[];
  activeWorkspaceId: () => string;
  labelWorkspace: (workspace: WorkspaceInfo) => string;
  selectedSessionTitle: () => string;
  selectedSessionModelLabel: () => string;
  modelVariant: () => string | null;
  modelVariantLabel: () => string;
  /** Switch the open palette to a submode, resetting query/selection. */
  enterMode: (mode: CommandPaletteMode) => void;
  close: () => void;
  closeAndFocusComposer: () => void;
  focusComposer: () => void;
  notify: (message: string) => void;
  openNewTask: () => void;
  openRenameModal: () => void;
  openSessionModelPicker: () => void;
  openProviderAuthModal: () => Promise<void>;
  setModelVariant: (variant: string) => void;
  openSessionFromList: (workspaceId: string, sessionId: string) => void;
};

type CommandPaletteItemsController = {
  /** Options for the active mode, already filtered by the current query. */
  items: () => CommandPaletteItem[];
  /** Total sessions reachable through the palette, across all workers. */
  totalSessionCount: () => number;
  title: () => string;
  placeholder: () => string;
};

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export function createCommandPaletteItems(
  deps: CommandPaletteItemsDeps,
): CommandPaletteItemsController {
  const sessionOptions = createMemo(() =>
    buildCommandPaletteSessionOptions(
      deps.sessionGroups(),
      deps.activeWorkspaceId(),
      deps.labelWorkspace,
    ),
  );

  const totalSessionCount = createMemo(() => sessionOptions().length);

  const rootItems = createMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      {
        id: "new-session",
        title: "Create new session",
        detail: "Start a fresh task in the current worker",
        meta: "Create",
        action: () => {
          deps.close();
          deps.openNewTask();
          queueMicrotask(() => deps.focusComposer());
        },
      },
      {
        id: "rename-session",
        title: "Rename current session",
        detail:
          deps.selectedSessionTitle().trim() ||
          "Give your selected session a clearer name",
        meta: "Rename",
        action: () => {
          deps.close();
          deps.openRenameModal();
        },
      },
      {
        id: "sessions",
        title: "Search sessions",
        detail: `${totalSessionCount().toLocaleString()} available across workers`,
        meta: "Jump",
        action: () => deps.enterMode("sessions"),
      },
      {
        id: "model",
        title: "Change model",
        detail: `Current: ${deps.selectedSessionModelLabel() || "Model"}`,
        meta: "Open",
        action: () => {
          deps.close();
          deps.openSessionModelPicker();
        },
      },
      {
        id: "provider",
        title: "Connect provider",
        detail: "Open provider connection flow",
        meta: "Open",
        action: () => {
          deps.close();
          void deps.openProviderAuthModal().catch((error) => {
            deps.notify(errorMessage(error, "Failed to load providers"));
            deps.focusComposer();
          });
        },
      },
      {
        id: "thinking",
        title: "Change thinking",
        detail: `Current: ${deps.modelVariantLabel()}`,
        meta: "Adjust",
        action: () => deps.enterMode("thinking"),
      },
    ];

    return items.filter((item) =>
      matchesCommandPaletteQuery(
        `${item.title} ${item.detail ?? ""}`,
        deps.query(),
      ),
    );
  });

  const sessionItems = createMemo<CommandPaletteItem[]>(() =>
    filterCommandPaletteSessionOptions(sessionOptions(), deps.query()).map(
      (item) => ({
        id: `session:${item.workspaceId}:${item.sessionId}`,
        title: item.title,
        detail: item.workspaceTitle,
        meta:
          item.workspaceId === deps.activeWorkspaceId()
            ? "Current worker"
            : "Switch",
        action: () => {
          deps.close();
          deps.openSessionFromList(item.workspaceId, item.sessionId);
        },
      }),
    ),
  );

  const thinkingItems = createMemo<CommandPaletteItem[]>(() =>
    buildCommandPaletteThinkingEntries(deps.modelVariant(), deps.query()).map(
      (entry) => ({
        id: `thinking:${entry.value}`,
        title: entry.label,
        detail: entry.detail,
        meta: entry.isCurrent ? "Current" : undefined,
        action: () => {
          deps.setModelVariant(entry.value);
          deps.closeAndFocusComposer();
          deps.notify(`Thinking set to ${entry.label}.`);
        },
      }),
    ),
  );

  return {
    items: createMemo<CommandPaletteItem[]>(() => {
      const mode = deps.mode();
      if (mode === "sessions") return sessionItems();
      if (mode === "thinking") return thinkingItems();
      return rootItems();
    }),
    totalSessionCount,
    title: createMemo(() => commandPaletteTitleForMode(deps.mode())),
    placeholder: createMemo(() => commandPalettePlaceholderForMode(deps.mode())),
  };
}
