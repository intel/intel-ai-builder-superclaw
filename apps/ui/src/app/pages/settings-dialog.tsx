/**
 * Settings, opened as a modal dialog over whatever view is current (#3815).
 *
 * The sections sit in a vertical tab list on the left; the selected one draws
 * in a pane on the right that scrolls on its own. X, Escape and a click on the
 * backdrop close it, and focus goes back to the control that opened it.
 *
 * Sections open overlays of their own (the scheduler details panel, the skill
 * editor, MCP setup, the dictionary and cleanup dialogs). Many of them listen
 * for Escape on `window` and some carry no dialog role, so whether Escape
 * belongs to one of them is decided in the capture phase, before any of them
 * can close and leave the DOM: while one is open, Escape and outside clicks are
 * left to it.
 *
 * The panel carries no transform or filter, so a `fixed inset-0` overlay a
 * section renders inline still covers the window rather than the panel.
 *
 * A search field sits above the sections (#3836). While it holds a query the
 * pane lists matching settings instead of the section, which stays mounted
 * underneath so clearing the query returns to it as it was. Picking a result
 * opens its section and brings the setting into view.
 */
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { ExternalLink, Search, X } from "lucide-solid";

import { usePlatform } from "../context/platform";
import { localCtxSupported } from "../components/local-ctx-size-slider";
import { perfWeightSupported } from "../components/perf-weight-slider";
import { fileProtectionShown, prefetchFileProtection } from "../components/security-settings-section";
import { cleanupRetentionShown } from "./settings.workspace-cleanup";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { t } from "../../i18n";
import type { DashboardViewProps } from "./dashboard.types";
import SettingsDialogContent from "./settings-dialog.content";
import { LAYER, hasInnerLayer } from "./settings-dialog.layers";
import {
  stepSettingsNav,
  visibleSettingsNav,
  type SettingsSection,
} from "./settings-dialog.sections";
import { anchorsFor, searchSettings, type SettingsSearchEntry } from "./settings-search.registry";
import SettingsSearchResults from "./settings-search.results";
import { revealSettingsAnchor } from "./settings-search.reveal";

export type SettingsDialogProps = DashboardViewProps & {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  /** Where focus goes on close when the opener is gone (a button in a drawer that closed). */
  returnFocus?: HTMLElement;
  onClose: () => void;
};

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function SettingsDialog(props: SettingsDialogProps) {
  const platform = usePlatform();
  const baseId = createUniqueId();
  const titleId = `${baseId}-title`;
  const panelId = `${baseId}-panel`;
  const tabId = (section: SettingsSection) => `${baseId}-tab-${section}`;
  const listboxId = `${baseId}-search-results`;
  const optionId = (entryId: string) => `${baseId}-search-result-${entryId}`;

  const navItems = createMemo(() => visibleSettingsNav({ voice: Boolean(props.voice) }));
  const selectedItem = createMemo(() => navItems().find((item) => item.id === props.section) ?? null);
  // Roving tabindex: the selected tab is the one Tab lands on; with none selected, the first.
  const tabStop = () => selectedItem()?.id ?? navItems()[0]?.id;

  const capability = useCapabilityGate();
  const [query, setQuery] = createSignal("");
  const [activeResult, setActiveResult] = createSignal<string | null>(null);
  const [searchFocused, setSearchFocused] = createSignal(false);
  const searching = () => query().trim().length > 0;
  const searchGroups = createMemo(() =>
    searching()
      ? searchSettings(query(), {
          voice: Boolean(props.voice),
          capability,
          updateEnv: props.updateEnv?.(),
          serverReady: props.openworkServerStatus === "connected" && Boolean(props.openworkServerClient),
          cleanupEnabled: cleanupRetentionShown(),
          perfWeightSupported: perfWeightSupported(),
          localCtxSupported: localCtxSupported(),
          fileProtectionShown: fileProtectionShown(),
        })
      : [],
  );
  const flatResults = createMemo(() => searchGroups().flatMap((group) => group.results.map((result) => result.entry)));
  // The best match is highlighted as soon as the list changes, so Enter opens it.
  createEffect(on(flatResults, (list) => setActiveResult(list[0]?.id ?? null)));
  createEffect(() => {
    const id = activeResult();
    if (id) document.getElementById(optionId(id))?.scrollIntoView?.({ block: "nearest" });
  });
  const activeOptionId = () => {
    const id = activeResult();
    return id && searching() ? optionId(id) : undefined;
  };

  let rootEl: HTMLDivElement | undefined;
  let panelEl: HTMLDivElement | undefined;
  let searchEl: HTMLInputElement | undefined;
  let contentEl: HTMLDivElement | undefined;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // A reveal still waiting for its setting must not take focus or scroll once
  // the user has moved on: another section, by any route, or a new query.
  let cancelReveal: (() => void) | undefined;
  let revealSection: SettingsSection | null = null;
  const stopReveal = () => {
    cancelReveal?.();
    cancelReveal = undefined;
    revealSection = null;
  };
  onCleanup(stopReveal);
  createEffect(
    on(
      () => props.section,
      (section) => {
        if (revealSection && section !== revealSection) stopReveal();
      },
      { defer: true },
    ),
  );
  createEffect(on(query, (next) => next && stopReveal(), { defer: true }));

  const selectSection = (section: SettingsSection) => {
    stopReveal();
    setQuery("");
    props.onSectionChange(section);
  };

  const pickResult = (entry: SettingsSearchEntry) => {
    selectSection(entry.section);
    const anchors = anchorsFor(entry);
    if (anchors.length === 0 || !contentEl) return;
    revealSection = entry.section;
    cancelReveal = revealSettingsAnchor(contentEl, anchors);
  };

  const onSearchKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const list = flatResults();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (list.length === 0) return;
      event.preventDefault();
      const index = list.findIndex((entry) => entry.id === activeResult());
      const next =
        index < 0
          ? event.key === "ArrowDown" ? 0 : list.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      setActiveResult(list[next].id);
      return;
    }
    if (event.key === "Enter") {
      const entry = list.find((item) => item.id === activeResult());
      if (!entry) return;
      event.preventDefault();
      pickResult(entry);
    }
  };

  const onFindShortcut = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "f" || event.defaultPrevented) return;
    // Consumed even with an inner overlay open, so WebView2's own Find bar
    // cannot open over the modal; focus stays with the overlay.
    event.preventDefault();
    if (rootEl && hasInnerLayer(rootEl)) return;
    searchEl?.focus();
    searchEl?.select();
  };
  window.addEventListener("keydown", onFindShortcut);
  onCleanup(() => window.removeEventListener("keydown", onFindShortcut));

  onMount(() => {
    // So the search knows about file protection without Privacy being opened first.
    prefetchFileProtection();
    const target = tabStop();
    (target ? document.getElementById(tabId(target)) : panelEl)?.focus();
  });
  onCleanup(() => {
    const target = opener?.isConnected && opener !== document.body ? opener : props.returnFocus;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });

  let escapeForInnerLayer = false;
  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (event.key === "Escape" && rootEl) escapeForInnerLayer = hasInnerLayer(rootEl);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) return;
    if (event.defaultPrevented || escapeForInnerLayer) return;
    event.preventDefault();
    // A query is cleared first wherever focus is, as it is from the field.
    if (query()) setQuery("");
    else props.onClose();
  };
  window.addEventListener("keydown", onKeyDownCapture, true);
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDownCapture, true);
    window.removeEventListener("keydown", onKeyDown);
  });

  // On `window`, since an inner overlay portaled outside the panel (the
  // scheduler details) holds focus where the panel's own events never see it.
  // Focus in an inner overlay, inside the panel (Add MCP server, the skill
  // editor) or portaled out of it, cycles inside that overlay; anywhere else
  // behind the dialog, it is brought back into the panel.
  const trapTab = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.defaultPrevented || !panelEl || !rootEl) return;
    const active = document.activeElement;
    const layer = active instanceof HTMLElement ? active.closest<HTMLElement>(LAYER) : null;
    const scope = layer && layer !== panelEl && !layer.contains(rootEl) ? layer : panelEl;
    const focusable = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.getClientRects().length > 0,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      scope.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!(active instanceof Node) || !scope.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && (active === first || active === scope)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  window.addEventListener("keydown", trapTab);
  onCleanup(() => window.removeEventListener("keydown", trapTab));

  const onNavKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = stepSettingsNav(navItems(), props.section, event.key);
    if (!next) return;
    selectSection(next);
    document.getElementById(tabId(next))?.focus();
  };

  // A press that starts while an inner overlay is open is that overlay's outside click.
  let backdropPress = false;

  return (
    <div
      ref={rootEl}
      data-settings-dialog-layer=""
      class="fixed inset-0 z-50 grid grid-cols-[1fr_auto_1fr] grid-rows-[1fr_auto_1fr] font-sans"
      data-testid="settings-dialog-root"
    >
      <div
        class="absolute inset-0 dls-modal-dim"
        aria-hidden="true"
        data-testid="settings-dialog-backdrop"
        onPointerDown={() => {
          backdropPress = rootEl ? !hasInnerLayer(rootEl) : false;
        }}
        onClick={() => {
          if (backdropPress) props.onClose();
          backdropPress = false;
        }}
      />
      {/* The blur is drawn only around the panel, never under it: the WebView
          re-blurs a whole backdrop-filter area on every frame the content above
          it scrolls, which at full screen halves the frame rate. The panel's
          rounded corners leave its cell's corners uncovered, so each gets a
          patch the size of the radius.
          A blur only reads the backdrop inside its own box, so two strips
          blurred apart leave a visible line where they meet. Each piece
          reaches 0.75rem (three blur radii) past every edge it shares with
          another and clips that overhang off, so both sides of a seam are
          blurred from the same pixels. */}
      <div class="dls-modal-blur pointer-events-none col-span-3 row-start-1 -mb-3 [clip-path:inset(0_0_0.75rem_0)]" aria-hidden="true" />
      <div class="dls-modal-blur pointer-events-none col-start-1 row-start-2 -my-3 [clip-path:inset(0.75rem_0)]" aria-hidden="true" />
      <div class="dls-modal-blur pointer-events-none col-start-3 row-start-2 -my-3 [clip-path:inset(0.75rem_0)]" aria-hidden="true" />
      <For each={["self-start justify-self-start", "self-start justify-self-end", "self-end justify-self-start", "self-end justify-self-end"]}>
        {(corner) => (
          <div
            class={`dls-modal-blur pointer-events-none col-start-2 row-start-2 -m-3 h-[calc(var(--radius-dialog)+1.5rem)] w-[calc(var(--radius-dialog)+1.5rem)] [clip-path:inset(0.75rem)] ${corner}`}
            aria-hidden="true"
          />
        )}
      </For>
      <div class="dls-modal-blur pointer-events-none col-span-3 row-start-3 -mt-3 [clip-path:inset(0.75rem_0_0_0)]" aria-hidden="true" />
      <div
        ref={panelEl}
        data-settings-dialog-layer=""
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="settings-dialog"
        class="relative col-start-2 row-start-2 flex h-[90vh] max-h-[960px] min-h-[min(480px,calc(100vh-2rem))] w-[75vw] min-w-[min(720px,calc(100vw-2rem))] max-w-[min(1280px,calc(100vw-2rem))] flex-col overflow-hidden rounded-dialog border border-dls-panel-border bg-dls-surface-solid text-dls-text shadow-[var(--dls-shell-shadow)] focus:outline-none"
      >
        <header class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-dls-border px-5">
          <h2 id={titleId} class="truncate text-title leading-title font-semibold text-dls-text">
            {t("dashboard.advanced")}
          </h2>
          <button
            type="button"
            data-testid="close-settings"
            aria-label={t("dashboard.close_settings")}
            title={t("dashboard.close_settings")}
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={() => props.onClose()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div class="flex min-h-0 flex-1">
          {/* Icon-only below md, but wide while the search is in use so a query can be read. */}
          <nav
            aria-label={t("dashboard.advanced")}
            class={`flex shrink-0 flex-col gap-2 border-r border-dls-border bg-dls-sidebar p-2 ${
              searchFocused() || searching() ? "w-52" : "w-14 md:w-52"
            }`}
          >
            <div class="relative shrink-0">
              <Search
                size={14}
                aria-hidden="true"
                class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary"
              />
              <input
                ref={searchEl}
                type="search"
                role="combobox"
                data-testid="settings-search-input"
                aria-label={t("settings_search.placeholder")}
                aria-expanded={flatResults().length > 0}
                aria-controls={flatResults().length > 0 ? listboxId : undefined}
                aria-autocomplete="list"
                aria-activedescendant={activeOptionId()}
                placeholder={t("settings_search.placeholder")}
                autocomplete="off"
                spellcheck={false}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={onSearchKeyDown}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                class="h-9 w-full rounded-control border border-dls-border bg-dls-surface pl-8 pr-2 text-body text-dls-text placeholder:text-dls-secondary focus:border-dls-accent focus:outline-none max-md:placeholder:text-transparent"
              />
            </div>

            <div
              role="tablist"
              aria-orientation="vertical"
              aria-labelledby={titleId}
              class="flex min-h-0 flex-col gap-0.5 overflow-y-auto"
              onKeyDown={onNavKeyDown}
            >
              <For each={navItems()}>
                {(item) => {
                  const selected = () => props.section === item.id;
                  const label = () => t(item.labelKey);
                  const Icon = item.icon;
                  return (
                    <button
                      type="button"
                      role="tab"
                      id={tabId(item.id)}
                      data-testid={item.testId}
                      aria-selected={selected()}
                      aria-controls={panelId}
                      tabIndex={tabStop() === item.id ? 0 : -1}
                      title={label()}
                      class={`flex min-h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-body font-medium transition-colors duration-150 max-md:justify-center ${selected()
                        ? "bg-dls-active text-dls-text shadow-sm"
                        : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                        }`}
                      onClick={() => selectSection(item.id)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span class="truncate max-md:sr-only">{label()}</span>
                    </button>
                  );
                }}
              </For>
            </div>

            {/* Leaves the app for the browser, so it carries the external-link
                icon the sections do not, and says so to screen readers. */}
            <button
              type="button"
              title={t("dashboard.license_agreement")}
              class="mt-auto flex min-h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-caption font-medium text-dls-secondary transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text max-md:justify-center"
              onClick={() => platform.openLink("https://aibuilder.intel.com/eula.txt")}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span class="truncate max-md:sr-only">{t("dashboard.license_agreement")}</span>
              <span class="sr-only"> {t("dashboard.opens_in_browser")}</span>
            </button>
          </nav>

          <div
            id={panelId}
            role="tabpanel"
            aria-labelledby={selectedItem() ? tabId(props.section) : titleId}
            class="min-w-0 flex-1"
          >
            <Show when={searching()}>
              <SettingsSearchResults
                query={query()}
                groups={searchGroups()}
                activeId={activeResult()}
                listboxId={listboxId}
                optionId={optionId}
                onActivate={setActiveResult}
                onPick={pickResult}
              />
            </Show>
            <div ref={contentEl} class={searching() ? "hidden" : "h-full"}>
              {/* A section that hands a prompt to chat (Skills' Create in chat,
                  a scheduler Create/Run) would otherwise leave Settings over it. */}
              <SettingsDialogContent
                {...props}
                openNewTask={() => {
                  props.onClose();
                  props.openNewTask();
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
