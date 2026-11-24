import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ChevronsDown, ChevronsRight, MoreHorizontal, Plus, Star } from "lucide-solid";

import type { WorkspaceConnectionState, WorkspaceSessionGroup } from "../../types";
import { formatRelativeTime, getWorkspaceTaskLoadErrorDisplay, localizeSessionTitle } from "../../utils";
import { t } from "../../../i18n";
import { createStartupConnectingState, startupConnectingGrace } from "~/shared/platform/capability/capability-startup-signal";
import { Tooltip } from "~/shared/ui/tooltip";
import {
  getSessionPinStorage,
  getPinnedSessionIds,
  splitPinnedSessions,
  togglePinnedSessionId,
} from "~/features/workspace-sidebar";

type Props = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  activeWorkspaceId: string;
  selectedSessionId: string | null;
  showSessionActions?: boolean;
  sessionStatusById?: Record<string, string>;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  newTaskDisabled: boolean;
  importingWorkspaceConfig: boolean;
  onActivateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onCreateTaskInWorkspace: (workspaceId: string) => void;
  onOpenRenameSession?: (sessionId: string) => void;
  onOpenDeleteSession?: (sessionId: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onRecoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onOpenCreateWorkspace: () => void;
  onOpenCreateRemoteWorkspace: () => void;
  onImportWorkspaceConfig: () => void;
  hideNewTaskButton?: boolean;
};

const MAX_SESSIONS_PREVIEW = 10;
const COLLAPSED_SESSIONS_PREVIEW = 1;

type SessionListItem = WorkspaceSessionGroup["sessions"][number];

const normalizeSessionParentID = (session: SessionListItem) => {
  const parentID = session.parentID?.trim();
  return parentID || "";
};

const getRootSessions = (sessions: WorkspaceSessionGroup["sessions"]) => {
  return sessions.filter((session) => !normalizeSessionParentID(session));
};

const getPreviewRootSessions = (
  rootSessions: SessionListItem[],
  rootLimit: number,
  selectedSessionId: string | null,
) => {
  const preview = rootSessions.slice(0, rootLimit);
  const selected = selectedSessionId
    ? rootSessions.slice(rootLimit).find((session) => session.id === selectedSessionId)
    : undefined;
  // Leads the list so a chat opened from outside the preview (e.g. from search)
  // is visible without scrolling past every recent chat.
  return selected ? [selected, ...preview] : preview;
};

// Module-level signals shared across all WorkspaceSessionList instances,
// so `session `page and dashboard page stay in sync.
const [expandedWorkspaceIds, setExpandedWorkspaceIds] = createSignal<Set<string>>(new Set());
const [previewCountByWorkspaceId, setPreviewCountByWorkspaceId] = createSignal<Record<string, number>>({});
const [sessionGroupsExpandedByWorkspaceId, setSessionGroupsExpandedByWorkspaceId] = createSignal<
  Record<string, { pinned: boolean; recent: boolean }>
>({});
const [pinnedSessionIds, setPinnedSessionIds] = createSignal<Set<string>>(
  getPinnedSessionIds(getSessionPinStorage()),
);

const isWorkspaceExpanded = (workspaceId: string) => expandedWorkspaceIds().has(workspaceId);

const syncPinnedSessionIds = () => {
  setPinnedSessionIds(getPinnedSessionIds(getSessionPinStorage()));
};

const isSessionGroupExpanded = (workspaceId: string, section: "pinned" | "recent") => {
  const state = sessionGroupsExpandedByWorkspaceId()[workspaceId] ?? { pinned: true, recent: true };
  return state[section];
};

const setSessionGroupExpanded = (workspaceId: string, section: "pinned" | "recent", expanded: boolean) => {
  setSessionGroupsExpandedByWorkspaceId((prev) => {
    const current = prev[workspaceId] ?? { pinned: true, recent: true };
    if (current[section] === expanded) return prev;
    return { ...prev, [workspaceId]: { ...current, [section]: expanded } };
  });
};

const expandWorkspace = (workspaceId: string) => {
  const id = workspaceId.trim();
  if (!id) return;
  setExpandedWorkspaceIds((prev) => {
    if (prev.has(id)) return prev;
    const next = new Set(prev);
    next.add(id);
    return next;
  });
};

export default function WorkspaceSessionList(props: Props) {
  const [sessionMenuOpen, setSessionMenuOpen] = createSignal(false);
  const [sessionMenuSessionId, setSessionMenuSessionId] = createSignal<string | null>(null);
  const [sessionMenuPos, setSessionMenuPos] = createSignal<{ top: number; left: number } | null>(null);
  let addWorkspaceMenuRef: HTMLDivElement | undefined;
  let sessionMenuRef: HTMLDivElement | undefined;

  onMount(() => {
    expandWorkspace(props.activeWorkspaceId);
  });

  createEffect(() => {
    expandWorkspace(props.activeWorkspaceId);
  });

  const previewCount = (workspaceId: string) => {
    const base = previewCountByWorkspaceId()[workspaceId] ?? MAX_SESSIONS_PREVIEW;
    return isWorkspaceExpanded(workspaceId)
      ? base
      : Math.min(COLLAPSED_SESSIONS_PREVIEW, base);
  };

  // The selected session is rendered even when it falls past the preview, so
  // it never counts as hidden.
  const selectedPastPreview = (rootSessions: SessionListItem[], limit: number) =>
    rootSessions.findIndex((session) => session.id === props.selectedSessionId) >= limit;

  const hiddenRootCount = (workspaceId: string, rootSessions: SessionListItem[]) => {
    const limit = previewCount(workspaceId);
    const hidden = Math.max(0, rootSessions.length - limit);
    return selectedPastPreview(rootSessions, limit) ? hidden - 1 : hidden;
  };

  const showMoreSessions = (workspaceId: string, rootSessions: SessionListItem[]) => {
    const shown = previewCount(workspaceId);
    const step = Math.min(MAX_SESSIONS_PREVIEW, hiddenRootCount(workspaceId, rootSessions));
    const selectedIndex = rootSessions.findIndex((session) => session.id === props.selectedSessionId);
    const selectedInStep = selectedIndex >= shown && selectedIndex < shown + step;
    expandWorkspace(workspaceId);
    setPreviewCountByWorkspaceId((current) => ({
      ...current,
      [workspaceId]: Math.min(shown + step + (selectedInStep ? 1 : 0), rootSessions.length),
    }));
  };

  const showMoreLabel = (workspaceId: string, rootSessions: SessionListItem[]) =>
    `Show ${Math.min(MAX_SESSIONS_PREVIEW, hiddenRootCount(workspaceId, rootSessions))} more`;

  const remoteWorkspaceGroups = () =>
    props.workspaceSessionGroups.filter((group) => group.workspace.workspaceType === "remote");

  createEffect(() => {
    props.selectedSessionId;
    setSessionMenuOpen(false);
    setSessionMenuSessionId(null);
  });

  createEffect(() => {
    if (!sessionMenuOpen()) return;
    const closeMenu = (event: PointerEvent) => {
      if (!sessionMenuRef) return;
      const target = event.target as Node | null;
      if (target && sessionMenuRef.contains(target)) return;
      if (target instanceof Element && target.closest('[data-testid="session-actions-btn"]')) return;
      setSessionMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    onCleanup(() => window.removeEventListener("pointerdown", closeMenu));
  });

  const toggleSessionFavourite = (sessionId: string) => {
    togglePinnedSessionId(getSessionPinStorage(), sessionId);
    syncPinnedSessionIds();
    setSessionMenuOpen(false);
    setSessionMenuSessionId(null);
  };

  const renderSessionRow = (workspaceId: string, sessionItem: SessionListItem) => {
    const session = () => sessionItem;
    const sessionTitle = () => localizeSessionTitle(session().title ?? "");
    const [sessionTitleTruncated, setSessionTitleTruncated] = createSignal(false);
    let sessionTitleContainer: HTMLDivElement | undefined;
    let sessionTitleElement: HTMLSpanElement | undefined;
    const isSelected = () => props.selectedSessionId === session().id;
    const isSessionActive = () => (props.sessionStatusById?.[session().id] ?? "idle") !== "idle";
    const isPinned = () => pinnedSessionIds().has(session().id);
    const canManageSession = () =>
      Boolean(
        props.showSessionActions &&
          (props.onOpenRenameSession || props.onOpenDeleteSession),
      );

    const openSession = () => {
      setSessionMenuOpen(false);
      props.onOpenSession(workspaceId, session().id);
    };

    const updateSessionTitleTruncation = () => {
      if (!sessionTitleElement) return;
      setSessionTitleTruncated(sessionTitleElement.scrollWidth > sessionTitleElement.clientWidth);
    };

    onMount(() => {
      updateSessionTitleTruncation();
      if (typeof ResizeObserver === "undefined" || !sessionTitleContainer) return;
      const observer = new ResizeObserver(updateSessionTitleTruncation);
      observer.observe(sessionTitleContainer);
      onCleanup(() => observer.disconnect());
    });

    return (
      <div class="relative">
        <div
          class="group relative"
          data-testid="session-item"
        >
          <button
            type="button"
            class={`flex min-h-10 w-full items-center justify-between rounded-inset border px-2.5 py-2 text-left transition-[background-color,border-color,box-shadow,transform] ${
              isSelected()
                ? "border-dls-border/80 bg-dls-surface/95 text-dls-text shadow-[var(--dls-session-selected-shadow)]"
                : "border-transparent bg-transparent text-dls-secondary hover:bg-dls-hover/80 hover:text-dls-text"
            }`}
            onClick={openSession}
          >
            <div
              class={`flex min-w-0 flex-1 items-center gap-2 overflow-hidden ${
                canManageSession() ? "pr-[52px]" : "pr-[34px]"
              }`}
            >
              <Show when={isSessionActive()}>
                <span class="h-1.5 w-1.5 shrink-0 rounded-pill bg-dls-live-dot" />
              </Show>
              <div
                ref={sessionTitleContainer}
                class="relative min-w-0 max-w-full flex-1 overflow-hidden"
                style={{
                  "mask-image": "linear-gradient(to right, var(--dls-mask-opaque) calc(100% - 3px), transparent 100%)",
                  "-webkit-mask-image": "linear-gradient(to right, var(--dls-mask-opaque) calc(100% - 3px), transparent 100%)",
                }}
              >
                <Show
                  when={sessionTitleTruncated()}
                  fallback={
                    <span
                      ref={sessionTitleElement}
                      class="block w-full truncate text-body font-medium text-current"
                      data-testid="session-item-title"
                    >
                      {sessionTitle()}
                    </span>
                  }
                >
                  <Tooltip
                    content={`${sessionTitle()}${
                      session().time?.updated
                        ? `\n${t("session.updated")} ${formatRelativeTime(session().time?.updated ?? Date.now())}`
                        : ""
                    }`}
                    placement="right"
                    placementOffset={64}
                    delayMs={0}
                    maxWidthClass="max-w-[280px]"
                    class="!block min-w-0 max-w-full overflow-hidden"
                  >
                    <span
                      ref={sessionTitleElement}
                      class="block w-full truncate text-body font-medium text-current"
                      data-testid="session-item-title"
                    >
                      {sessionTitle()}
                    </span>
                  </Tooltip>
                </Show>
              </div>
            </div>
          </button>

          <div class="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0">
            <button
              type="button"
              class={`flex h-6 w-6 items-center justify-center rounded-control transition-[opacity,background-color,color] duration-150 ease-out ${
                isSelected()
                  ? "opacity-100 pointer-events-auto"
                  : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
              } ${
                isPinned()
                  ? "bg-dls-warm-accent/8 text-dls-warm-accent hover:bg-dls-warm-accent/12 hover:text-dls-warning-text"
                  : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
              }`}
              aria-label={isPinned() ? t("session.remove_favourite") : t("session.add_favourite")}
              data-testid={isPinned() ? "session-favourite-active" : "session-favourite-inactive"}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleSessionFavourite(session().id);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Show when={isPinned()} fallback={<Star size={13} />}>
                <Star size={13} fill="currentColor" />
              </Show>
            </button>

            <Show when={canManageSession()}>
              <button
                type="button"
                class={`flex h-7 w-7 items-center justify-center rounded-control text-dls-secondary transition-[opacity,background-color,color] duration-150 ease-out hover:bg-dls-hover hover:text-dls-text ${
                  isSelected()
                    ? "opacity-100 pointer-events-auto"
                    : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
                }`}
                aria-label="Session actions"
                data-testid="session-actions-btn"
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (sessionMenuOpen() && sessionMenuSessionId() === session().id) {
                    setSessionMenuOpen(false);
                    setSessionMenuSessionId(null);
                    setSessionMenuPos(null);
                    return;
                  }
                  const btn = event.currentTarget as HTMLElement;
                  const rect = btn.getBoundingClientRect();
                  // A backdrop-filter on an ancestor is the containing block for
                  // this fixed menu. Shell frost is on ::before, so the shell's
                  // own filter is none and the menu stays viewport-positioned.
                  // The check still corrects a shell that has a real filter.
                  const container = btn.closest(".rounded-shell");
                  const isContainingBlock =
                    container != null &&
                    getComputedStyle(container).backdropFilter !== "none";
                  const offset =
                    isContainingBlock && container
                      ? container.getBoundingClientRect()
                      : { top: 0, left: 0 };
                  const menuWidth = 192;
                  const top = rect.bottom - offset.top + 4;
                  const left = Math.max(8, rect.right - offset.left - menuWidth);
                  setSessionMenuPos({ top, left });
                  setSessionMenuSessionId(session().id);
                  setSessionMenuOpen(true);
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            </Show>
          </div>
        </div>

        <Show when={canManageSession() && sessionMenuOpen() && sessionMenuSessionId() === session().id && sessionMenuPos()}>
          <div
            ref={(el) => (sessionMenuRef = el)}
            class="fixed z-50 w-48 rounded-dialog border border-dls-border bg-dls-surface-solid p-1.5 shadow-[var(--dls-shell-shadow)]"
            style={{ top: `${sessionMenuPos()!.top}px`, left: `${sessionMenuPos()!.left}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              data-testid={isPinned() ? "unpin-session-btn" : "pin-session-btn"}
              aria-pressed={isPinned()}
              class="w-full rounded-inset px-3 py-2 text-left text-body-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={() => toggleSessionFavourite(session().id)}
            >
              {isPinned() ? t("session.remove_favourite") : t("session.add_favourite")}
            </button>

            <Show when={props.onOpenRenameSession}>
              <button
                type="button"
                data-testid="rename-session-btn"
                class="w-full rounded-inset px-3 py-2 text-left text-body-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                onClick={() => {
                  setSessionMenuOpen(false);
                  props.onOpenRenameSession?.(session().id);
                }}
              >
                {t("session.rename_title")}
              </button>
            </Show>

            <Show when={props.onOpenDeleteSession}>
              <button
                type="button"
                data-testid="delete-session-btn"
                class="w-full rounded-inset px-3 py-2 text-left text-body-lg text-dls-danger-text transition-colors hover:bg-dls-danger-bg"
                onClick={() => {
                  setSessionMenuOpen(false);
                  props.onOpenDeleteSession?.(session().id);
                }}
              >
                {t("session.delete_title")}
              </button>
            </Show>
          </div>
        </Show>
      </div>
    );
  };

  return (
    <>
      <Show when={!props.hideNewTaskButton}>
        <div class="relative mb-3" ref={(el) => (addWorkspaceMenuRef = el)}>
          <button
            type="button"
            class="w-full flex items-center justify-center gap-2 rounded-inset border border-dls-border/80 bg-dls-surface/90 px-3.5 py-2.5 text-caption font-medium text-dls-secondary shadow-[var(--dls-card-shadow)] transition-colors hover:bg-dls-hover"
            onClick={(event) => {
              event.stopPropagation();
              props.onCreateTaskInWorkspace(props.activeWorkspaceId);
            }}
            disabled={props.newTaskDisabled}
            aria-label="New task"
            data-testid="new-project-btn"
          >
            <Plus size={14} />
            {t("session.new_task")}
          </button>
        </div>
      </Show>

      <div class="mb-3 space-y-3" data-testid="workspace-list">
        <Show when={startupConnectingGrace() && remoteWorkspaceGroups().length === 0}>
          <div class="w-full rounded-card border border-dls-warning-border bg-dls-warning-bg px-3 py-2.5 text-left text-label text-dls-warning-text">
            Connecting
          </div>
        </Show>

        <For each={remoteWorkspaceGroups().map((group) => group.workspace.id)}>
          {(workspaceId) => {
            const group = () =>
              remoteWorkspaceGroups().find((candidate) => candidate.workspace.id === workspaceId);

            return (
              <Show when={group()}>
                {(currentGroup) => {
            const workspace = () => currentGroup().workspace;
            const rootSessions = createMemo(() => getRootSessions(currentGroup().sessions));
            const split = createMemo(() => splitPinnedSessions(rootSessions(), pinnedSessionIds()));
            const pinnedRootSessions = createMemo(() => split().pinned);
            const unpinnedRootSessions = createMemo(() => split().unpinned);
            const previewRootSessions = createMemo(() =>
              getPreviewRootSessions(unpinnedRootSessions(), previewCount(workspace().id), props.selectedSessionId),
            );
            const taskLoadError = () => getWorkspaceTaskLoadErrorDisplay(currentGroup().error);
            const startupConnecting = createStartupConnectingState(() => currentGroup().status === "ready");
            const pinnedExpanded = () => isSessionGroupExpanded(workspace().id, "pinned");
            const recentExpanded = () => isSessionGroupExpanded(workspace().id, "recent");

            return (
              <div class="space-y-2">
                <div class="mt-1 space-y-2">
                  <Show
                    when={currentGroup().status === "loading" && currentGroup().sessions.length === 0}
                    fallback={
                      <Show
                        when={rootSessions().length > 0}
                        fallback={
                          <>
                            <Show when={currentGroup().status === "ready"}>
                              <button
                                type="button"
                                class="group/empty w-full rounded-card border border-transparent px-3 py-2.5 text-left text-label text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                                onClick={() => props.onCreateTaskInWorkspace(workspace().id)}
                                disabled={props.newTaskDisabled}
                              >
                                <span class="group-hover/empty:hidden">{t("session.no_task")}</span>
                                <span class="hidden group-hover/empty:inline font-medium">+ {t("session.new_task")}</span>
                              </button>
                            </Show>
                            <Show when={currentGroup().status === "error"}>
                              <div
                                class={`w-full rounded-card border px-3 py-2.5 text-left text-label ${
                                  startupConnecting()
                                    ? "border-dls-warning-border bg-dls-warning-bg text-dls-warning-text"
                                    : "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text"
                                }`}
                                title={startupConnecting() ? "Connecting" : taskLoadError().title}
                              >
                                {startupConnecting() ? "Connecting" : taskLoadError().message}
                              </div>
                            </Show>
                          </>
                        }
                      >
                        <Show when={pinnedRootSessions().length > 0}>
                          <div class="w-full overflow-hidden">
                            <button
                              type="button"
                              aria-expanded={pinnedExpanded()}
                              class="transform-gpu flex w-full items-center justify-between rounded-inset px-2 py-1.5 text-left transition-colors hover:bg-dls-hover/80"
                              onClick={() => setSessionGroupExpanded(workspace().id, "pinned", !pinnedExpanded())}
                            >
                              <span class="flex items-center gap-2">
                                <span class="text-tiny font-medium uppercase tracking-[0.18em] text-dls-secondary">
                                  {t("session.favourites")}
                                </span>
                              </span>
                              <span class="inline-flex items-center text-dls-secondary">
                                {pinnedExpanded() ? <ChevronsDown size={14} /> : <ChevronsRight size={14} />}
                              </span>
                            </button>

                            <div
                              class="grid overflow-hidden transition-[grid-template-rows,opacity] duration-300 ease-out"
                              style={{
                                "grid-template-rows": pinnedExpanded() ? "minmax(0, 1fr)" : "0fr",
                                opacity: pinnedExpanded() ? "1" : "0",
                              }}
                            >
                              <div class="overflow-hidden">
                                <div class="space-y-1 pt-1.5">
                                  <For each={pinnedRootSessions()}>
                                    {(session) => renderSessionRow(workspace().id, session)}
                                  </For>
                                </div>
                              </div>
                            </div>
                          </div>
                        </Show>

                        <Show when={unpinnedRootSessions().length > 0}>
                          <div
                            class={`overflow-hidden ${
                              pinnedRootSessions().length > 0 ? "border-t border-dls-border/50 pt-2" : ""
                            }`}
                          >
                            <button
                              type="button"
                              aria-expanded={recentExpanded()}
                              class="flex w-full items-center justify-between rounded-inset px-2 py-1.5 text-left transition-colors hover:bg-dls-hover/80"
                              onClick={() => setSessionGroupExpanded(workspace().id, "recent", !recentExpanded())}
                            >
                              <span class="flex items-center gap-2">
                                <span class="text-tiny font-medium uppercase tracking-[0.18em] text-dls-secondary">
                                  {t("session.recent")}
                                </span>
                              </span>
                              <span class="inline-flex items-center text-dls-secondary">
                                {recentExpanded() ? <ChevronsDown size={14} /> : <ChevronsRight size={14} />}
                              </span>
                            </button>

                            <div
                              class="grid overflow-hidden transition-[grid-template-rows,opacity] duration-300 ease-out"
                              style={{
                                "grid-template-rows": recentExpanded() ? "minmax(0, 1fr)" : "0fr",
                                opacity: recentExpanded() ? "1" : "0",
                              }}
                            >
                              <div class="overflow-hidden">
                                <div class="space-y-1 pt-1.5">
                                  <For each={previewRootSessions()}>
                                    {(session) => renderSessionRow(workspace().id, session)}
                                  </For>

                                  <Show when={hiddenRootCount(workspace().id, unpinnedRootSessions()) > 0}>
                                    <button
                                      type="button"
                                      class="w-full rounded-inset border border-transparent px-3 py-2.5 text-left text-label text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                                      onClick={() => showMoreSessions(workspace().id, unpinnedRootSessions())}
                                    >
                                      {showMoreLabel(workspace().id, unpinnedRootSessions())}
                                    </button>
                                  </Show>
                                </div>
                              </div>
                            </div>
                          </div>
                        </Show>
                      </Show>
                    }
                  >
                    <div
                      class={`w-full rounded-card px-3 py-2.5 text-left text-label ${
                        startupConnecting()
                          ? "border border-dls-warning-border bg-dls-warning-bg text-dls-warning-text"
                          : "text-dls-secondary"
                      }`}
                    >
                      {startupConnecting() ? "Connecting" : "Loading tasks..."}
                    </div>
                  </Show>
                </div>
              </div>
            );
                }}
              </Show>
            );
          }}
        </For>
      </div>
    </>
  );
}
