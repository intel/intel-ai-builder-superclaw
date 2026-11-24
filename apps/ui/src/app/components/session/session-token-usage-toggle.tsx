import { ChevronDown } from "lucide-solid";
import { createMemo, createSignal, Show, type JSX } from "solid-js";

import { t } from "../../../i18n";
import { Tooltip } from "~/shared/ui/tooltip";

type RouteTokenStats = {
  providerID: string;
  modelID: string;
  isLocal: boolean;
  inputTokens: number;
  outputTokens: number;
};

export type RouteTokenTotals = { cloud: number; local: number };

export function splitTokensByRoute(models: readonly RouteTokenStats[]): RouteTokenTotals {
  const totals = { cloud: 0, local: 0 };
  for (const model of models) {
    const tokens = model.inputTokens + model.outputTokens;
    if (model.isLocal) totals.local += tokens;
    else totals.cloud += tokens;
  }
  return totals;
}

/** One `model · tokens` line per model on the route, largest first. */
export function routeModelBreakdown(
  models: readonly RouteTokenStats[],
  isLocal: boolean,
  formatTokens: (count: number) => string,
  formatModelLabel: (providerID: string, modelID: string) => string,
): string {
  return models
    .filter((model) => model.isLocal === isLocal)
    .map((model) => ({ model, tokens: model.inputTokens + model.outputTokens }))
    .filter(({ tokens }) => tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map(({ model, tokens }) =>
      `${formatModelLabel(model.providerID, model.modelID)} · ${formatTokens(tokens)}`,
    )
    .join("\n");
}

type SessionTokenUsageToggleProps = {
  tokensByModel: readonly RouteTokenStats[] | null;
  formatTokens: (count: number) => string;
  formatModelLabel: (providerID: string, modelID: string) => string;
  /** The session title; the chevron sits to its right and the line under it. */
  children: JSX.Element;
};

const LINE_ID = "session-token-usage-line";
export const TOKEN_USAGE_EXPANDED_KEY = "openwork.session.token-usage-expanded.v1";

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(TOKEN_USAGE_EXPANDED_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(TOKEN_USAGE_EXPANDED_KEY, expanded ? "1" : "0");
  } catch {
    // ignore persistence failures
  }
}

export function SessionTokenUsageToggle(props: SessionTokenUsageToggleProps) {
  const [open, setOpen] = createSignal(readExpanded());

  const toggle = () => {
    const next = !open();
    setOpen(next);
    writeExpanded(next);
  };

  const totals = createMemo((): RouteTokenTotals | null => {
    const models = props.tokensByModel;
    if (!models || models.length === 0) return null;
    const split = splitTokensByRoute(models);
    return split.cloud + split.local > 0 ? split : null;
  });

  const breakdown = (isLocal: boolean) =>
    routeModelBreakdown(
      props.tokensByModel ?? [],
      isLocal,
      props.formatTokens,
      props.formatModelLabel,
    );

  return (
    <div class="flex min-w-0 flex-col">
      <div class="flex min-w-0 items-center gap-1">
        {props.children}
        <Show when={totals()}>
          <button
            type="button"
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded-compact text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--dls-accent-rgb)/0.2)]"
            data-testid="session-token-usage-toggle"
            aria-label={t("session.token_usage")}
            title={t("session.token_usage")}
            aria-expanded={open()}
            aria-controls={LINE_ID}
            onClick={toggle}
          >
            <ChevronDown
              size={10}
              class={`transition-transform ${open() ? "rotate-180" : ""}`}
            />
          </button>
        </Show>
      </div>
      <Show when={open() && totals()}>
        {(split) => (
          <div
            id={LINE_ID}
            data-testid="session-token-usage-line"
            class="flex items-center gap-3 truncate text-caption leading-compact text-dls-secondary"
          >
            <Show when={split().cloud > 0}>
              <Tooltip content={breakdown(false)} placement="bottom" class="inline-flex" focusable>
                <span class="flex items-center gap-1" data-model-route="cloud">
                  <span class="h-1.5 w-1.5 shrink-0 rounded-pill bg-dls-model-cloud-dot" />
                  {t("session.model_badge_cloud")} {props.formatTokens(split().cloud)}
                </span>
              </Tooltip>
            </Show>
            <Show when={split().local > 0}>
              <Tooltip content={breakdown(true)} placement="bottom" class="inline-flex" focusable>
                <span class="flex items-center gap-1" data-model-route="local">
                  <span class="h-1.5 w-1.5 shrink-0 rounded-pill bg-dls-model-local-dot" />
                  {t("session.model_badge_local")} {props.formatTokens(split().local)}
                </span>
              </Tooltip>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
