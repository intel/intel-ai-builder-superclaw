import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { Coins, ScrollText, Zap } from "lucide-solid";

import type { WorkspaceSessionGroup, Client } from "../types";
import type {
  LlmRouterClient,
  LlmRouterUsageAggregateResponse,
  LlmRouterUsageEvent,
} from "../lib/llmrouter-client";
import { aggregateLrmUsageEvents } from "../lib/lrm-token-usage";
import Card from "~/shared/ui/card";
import { getModelRouteAlias, type ModelRouteAlias } from "~/shared/util/model-ref";
import { t } from "../../i18n";

export type TokenUsageViewProps = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  client?: Client | null;
  llmRouterClient?: LlmRouterClient | null;
};

type TokenStats = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
};

type ModelTokenStats = TokenStats & {
  modelKey: string;
  providerID: string;
  modelID: string;
};

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(2)}M`;
}

/**
 * Sub-cent spend is still spend: `toFixed(2)` would print a real $0.0017 charge
 * as "$0.00", which reads as free. Below a cent we show four decimals instead.
 */
function formatCostUsd(usd: number): string {
  if (!(usd > 0)) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Must match `usage_store._UNALIASED_BUCKET`. */
const UNALIASED_BUCKET = "unaliased";
const DICTATION_REFINE_ALIAS = "dictation-refine";

/** A row of the all-time breakdown, already labelled for a human. */
type AliasUsageRow = {
  key: string;
  label: string;
  tokens: number;
  requests: number;
  cost: number;
};

/**
 * "alias" is a routing word; a user has never heard it. Translate the aliases
 * we own and fall back to the raw string for the rest — inventing a friendly
 * name for every routing alias would be one more thing to keep in sync with
 * the router, and a raw alias is at least truthful.
 */
/**
 * LRM's three model aliases, which arrive here as the `alias` on anything that
 * went through the ordinary chat route. They are internal names -- a user
 * reading "Purpose: cloud-model" learns nothing -- so they get labels too.
 *
 * They are deliberately NOT called "dictation": clean-up in `agent` mode also
 * goes through that route and is recorded under the model alias, so this bucket
 * is agent turns AND agent-mode clean-up mixed together. The short labels
 * name the route only.
 */
const MODEL_ALIAS_LABEL_KEYS: Record<ModelRouteAlias, string> = {
  "cloud-model": "token.nonsession_alias_cloud_model",
  "local-model": "token.nonsession_alias_local_model",
  auto: "token.nonsession_alias_auto",
};

function aliasLabel(alias: string): string {
  if (alias === DICTATION_REFINE_ALIAS) return t("token.nonsession_alias_dictation");
  if (alias === UNALIASED_BUCKET) return t("token.nonsession_alias_unaliased");
  const routeAlias = getModelRouteAlias(alias);
  const key = routeAlias ? MODEL_ALIAS_LABEL_KEYS[routeAlias] : undefined;
  if (key) return t(key);
  // An alias this build has never heard of is shown verbatim rather than hidden
  // or renamed: it is still real spend, and the raw string is the only clue to
  // what produced it.
  return alias;
}

function toAliasRows(aggregate: LlmRouterUsageAggregateResponse): AliasUsageRow[] {
  const rows: AliasUsageRow[] = [];
  let accountedTokens = 0;
  let accountedRequests = 0;
  let accountedCost = 0;
  for (const group of aggregate.groups ?? []) {
    const tokens = group.total_tokens || 0;
    const requests = group.request_count || 0;
    if (tokens <= 0 && requests <= 0) continue;
    const alias = group.alias || UNALIASED_BUCKET;
    accountedTokens += tokens;
    accountedRequests += requests;
    accountedCost += group.cost_usd || 0;
    rows.push({ key: alias, label: aliasLabel(alias), tokens, requests, cost: group.cost_usd || 0 });
  }

  // The alias rows are summed from the router's capped per-request trail, while
  // `total` is the never-pruned lifetime aggregate. Once a device passes the cap
  // the rows stop adding up to the total, so the gap gets its own row: money
  // that quietly disappears from a breakdown is worse than money labelled
  // "we no longer have the detail".
  const missingTokens = (aggregate.total.total_tokens || 0) - accountedTokens;
  const missingRequests = (aggregate.total.request_count || 0) - accountedRequests;
  const missingCost = (aggregate.total.cost_usd || 0) - accountedCost;
  if (missingTokens > 0 || missingRequests > 0) {
    rows.push({
      key: "__unattributed__",
      label: t("token.nonsession_unattributed"),
      tokens: Math.max(0, missingTokens),
      requests: Math.max(0, missingRequests),
      cost: Math.max(0, missingCost),
    });
  }
  return rows;
}

export default function TokenUsageView(props: TokenUsageViewProps) {
  const [childSessionIds, setChildSessionIds] = createSignal<string[]>([]);
  const [lrmEvents, setLrmEvents] = createSignal<Record<string, LlmRouterUsageEvent[]>>({});
  const [fetchedParentSessions, setFetchedParentSessions] = createSignal<Set<string>>(new Set());

  const fetchLrmEventsForSession = async (sessionId: string, client: LlmRouterClient) => {
    const events: LlmRouterUsageEvent[] = [];
    let sinceMs: number | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await client.getUsageEvents({ sessionId, sinceMs, limit: 1000 });
      events.push(...response.events);
      if (response.next_since_ms === undefined) break;
      if (response.next_since_ms === sinceMs) break;
      sinceMs = response.next_since_ms;
    }
    setLrmEvents((prev) => ({ ...prev, [sessionId]: events }));
  };
  
  createEffect(
    on(
      () => [props.client, props.workspaceSessionGroups] as const,
      async ([client, groups]) => {
        if (!client) return;
        
        const parentSessionIds: string[] = [];
        for (const group of groups) {
          for (const session of group.sessions) {
            if (!fetchedParentSessions().has(session.id)) {
              parentSessionIds.push(session.id);
            }
          }
        }
        
        if (parentSessionIds.length === 0) return;
        
        setFetchedParentSessions((prev) => {
          const next = new Set(prev);
          for (const id of parentSessionIds) {
            next.add(id);
          }
          return next;
        });

        for (const parentId of parentSessionIds) {
          try {
            const childrenResult = await client.session.children({ sessionID: parentId });
            if (!childrenResult.data || childrenResult.data.length === 0) continue;
            setChildSessionIds((prev) => {
              const next = new Set(prev);
              for (const child of childrenResult.data ?? []) next.add(child.id);
              return Array.from(next);
            });
          } catch (error) {
            console.debug("Failed to fetch child sessions for token usage", { parentId, error });
          }
        }
      },
      { defer: true }
    )
  );

  createEffect(
    on(
      () => [props.llmRouterClient, props.workspaceSessionGroups, childSessionIds()] as const,
      async ([lrmClient, groups, childIds]) => {
        if (!lrmClient) return;
        const sessionIds = new Set<string>();
        for (const group of groups) {
          for (const session of group.sessions) sessionIds.add(session.id);
        }
        for (const childSessionId of childIds) sessionIds.add(childSessionId);
        const current = lrmEvents();
        await Promise.all(
          Array.from(sessionIds).map(async (sessionId) => {
            if (current[sessionId]?.length > 0) return;
            try {
              await fetchLrmEventsForSession(sessionId, lrmClient);
            } catch (error) {
              console.debug("Failed to fetch LRM usage events", { sessionId, error });
            }
          })
        );
      }
    )
  );

  const aggregatedStats = createMemo(() => {
    const lrmEventsMap = lrmEvents();

    const currentSessionIds = new Set<string>();
    for (const group of props.workspaceSessionGroups) {
      for (const session of group.sessions) currentSessionIds.add(session.id);
    }
    for (const childSessionId of childSessionIds()) currentSessionIds.add(childSessionId);
    const currentLrmEvents: Record<string, LlmRouterUsageEvent[]> = {};
    for (const sessionId of currentSessionIds) {
      const events = lrmEventsMap[sessionId];
      if (events) currentLrmEvents[sessionId] = events;
    }

    const hasLrmEvents = Object.values(currentLrmEvents).some((events) => events.length > 0);
    const lrmUsage = hasLrmEvents ? aggregateLrmUsageEvents(currentLrmEvents) : null;

    return {
      total: lrmUsage?.total ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      modelStats: (lrmUsage?.modelStats ?? []) as ModelTokenStats[],
      messageCount: lrmUsage?.messageCount ?? 0,
    };
  });

  const hasData = createMemo(() => {
    const stats = aggregatedStats();
    return stats.total.input > 0 || stats.total.output > 0;
  });

  // ── All-time spend ────────────────────────────────────────────────────────
  // This deliberately runs a SECOND, different query from the per-session view
  // above, and the two must not be merged. The view above pages
  // /usage/events?session_id=<id> once per task in the workspace; a dictation
  // clean-up call carries session_id = null because it belongs to no task, so a
  // session-scoped query can never return it — which is why a user who had only
  // dictated saw nothing but zeroes. The aggregate endpoint is the only one with
  // no session dimension at all, so it is the only one that can see that spend.
  // Do not "simplify" this into the per-session query, and do not solve it by
  // inventing a session id for background calls: that would put cloud cost on a
  // task that never made the call.
  const [allTimeUsage, setAllTimeUsage] = createSignal<LlmRouterUsageAggregateResponse | null>(null);

  createEffect(
    on(
      () => props.llmRouterClient,
      async (lrmClient) => {
        // Cleared FIRST, on every client change including a disconnect. These
        // are money figures attributed to one router's install: keeping the
        // previous connection's totals on screen while a different (or absent)
        // router is selected states someone else's spend as this one's. The
        // early return below used to leave them rendered.
        setAllTimeUsage(null);
        if (!lrmClient) return;
        try {
          const aggregate = await lrmClient.getUsage("alias");
          // A reply that arrives after the client changed describes the old
          // install, and would overwrite the new totals with it.
          if (props.llmRouterClient !== lrmClient) return;
          setAllTimeUsage(aggregate);
        } catch (error) {
          // A router older than group_by=alias answers 400. Leaving the section
          // unrendered beats showing a half-populated money figure — which is
          // also why the clear above has to happen before the request, not in
          // this handler: on a 400 there is nothing to replace the stale value
          // with, so it would simply stay.
          console.debug("Failed to fetch all-time usage aggregate", { error });
        }
      }
    )
  );

  const allTimeRows = createMemo(() => {
    const aggregate = allTimeUsage();
    return aggregate ? toAliasRows(aggregate) : [];
  });

  const hasAllTimeData = createMemo(() => (allTimeUsage()?.total.total_tokens || 0) > 0);

  return (
    <div class="space-y-8">
      <h2 class="text-display font-semibold text-dls-text">{t("token.usage_title")}</h2>

      <Show
        when={hasData()}
        fallback={
          <Card>
            <div class="flex flex-col items-center justify-center py-12 text-center">
              <div class="mb-4 flex h-12 w-12 items-center justify-center rounded-pill bg-dls-hover">
                <Coins size={24} class="text-dls-secondary" />
              </div>
              <h3 class="text-title leading-title font-medium text-dls-text">{t("token.usage_no_data")}</h3>
              <p class="mt-1 max-w-sm text-body-lg text-dls-secondary">
                {t("token.usage_placeholder")}
              </p>
              {/* Without this, a user whose only spend is background work reads
                  "No token data yet" as "you have used nothing" and goes looking
                  for a bug. Point them at the section that does hold it. */}
              <Show when={hasAllTimeData()}>
                <p class="mt-3 max-w-sm text-caption text-dls-secondary">
                  {t("token.usage_nonsession_hint")}
                </p>
              </Show>
            </div>
          </Card>
        }
      >
        {/* Summary Cards */}
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg p-4">
            <div class="flex items-center gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-control bg-dls-secondary-accent-bg">
                <Zap size={20} class="text-dls-secondary-accent" />
              </div>
              <div>
                <p class="text-caption font-medium text-dls-secondary">{t("session.tokens_total")}</p>
                <p class="text-heading font-semibold text-dls-panel-text">
                  {formatTokens(aggregatedStats().total.input + aggregatedStats().total.output)}
                </p>
              </div>
            </div>
          </div>

          <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg p-4">
            <div class="flex items-center gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-control bg-dls-metric-input-bg">
                <Zap size={20} class="text-dls-metric-input" />
              </div>
              <div>
                <p class="text-caption font-medium text-dls-secondary">{t("session.tokens_input")}</p>
                <p class="text-heading font-semibold text-dls-panel-text">
                  {formatTokens(aggregatedStats().total.input)}
                </p>
              </div>
            </div>
          </div>

          <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg p-4">
            <div class="flex items-center gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-control bg-dls-metric-output-bg">
                <Zap size={20} class="text-dls-metric-output" />
              </div>
              <div>
                <p class="text-caption font-medium text-dls-secondary">{t("session.tokens_output")}</p>
                <p class="text-heading font-semibold text-dls-panel-text">
                  {formatTokens(aggregatedStats().total.output)}
                </p>
              </div>
            </div>
          </div>

          <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg p-4">
            <div class="flex items-center gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-control bg-dls-metric-messages-bg">
                <ScrollText size={20} class="text-dls-metric-messages" />
              </div>
              <div>
                <p class="text-caption font-medium text-dls-secondary">{t("session.tokens_messages")}</p>
                <p class="text-heading font-semibold text-dls-panel-text">
                  {aggregatedStats().messageCount.toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Cache Stats */}
        <Show when={aggregatedStats().total.cacheRead > 0 || aggregatedStats().total.cacheWrite > 0}>
          <Card title="Cache Usage" class="!bg-dls-panel-bg !border-dls-panel-border">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <p class="text-caption font-medium text-dls-secondary">Cache Read</p>
                <p class="text-title leading-title font-semibold text-dls-text">
                  {formatTokens(aggregatedStats().total.cacheRead)} tokens
                </p>
              </div>
              <div>
                <p class="text-caption font-medium text-dls-secondary">Cache Write</p>
                <p class="text-title leading-title font-semibold text-dls-text">
                  {formatTokens(aggregatedStats().total.cacheWrite)} tokens
                </p>
              </div>
            </div>
          </Card>
        </Show>

        {/* Usage by Model */}
        <Card title="Usage by Model" class="!bg-dls-panel-bg !border-dls-panel-border">
          <Show
            when={aggregatedStats().modelStats.length > 0}
            fallback={
              <p class="text-body-lg text-dls-secondary">{t("token.usage_no_model_data")}</p>
            }
          >
            <div class="overflow-x-auto">
              <table class="w-full text-body-lg">
                <thead>
                  <tr class="border-b border-dls-border text-left">
                    <th class="pb-3 pr-4 font-medium text-dls-secondary">{t("session.model")}</th>
                    <th class="pb-3 pr-4 text-right font-medium text-dls-secondary">{t("session.tokens_input")}</th>
                    <th class="pb-3 pr-4 text-right font-medium text-dls-secondary">{t("session.tokens_output")}</th>
                    <th class="pb-3 pr-4 text-right font-medium text-dls-secondary">{t("session.tokens_total")}</th>
                    <th class="pb-3 text-right font-medium text-dls-secondary">{t("session.tokens_share")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={aggregatedStats().modelStats}>
                    {(model) => (
                      <tr class="border-b border-dls-border/50 last:border-0">
                        <td class="py-3 pr-4">
                          <div class="flex flex-col">
                            <span class="font-medium text-dls-text">{model.modelID || "Unknown"}</span>
                            <span class="text-caption text-dls-secondary">{model.providerID || "Unknown provider"}</span>
                          </div>
                        </td>
                        <td class="py-3 pr-4 text-right text-dls-text">
                          {formatTokens(model.input)}
                        </td>
                        <td class="py-3 pr-4 text-right text-dls-text">
                          {formatTokens(model.output)}
                        </td>
                        <td class="py-3 pr-4 text-right font-medium text-dls-text">
                          {formatTokens(model.input + model.output)}
                        </td>
                        <td class="py-3 text-right text-dls-text">
                          {(() => {
                            const grandTotal = aggregatedStats().total.input + aggregatedStats().total.output;
                            if (grandTotal === 0) return "0%";
                            const pct = ((model.input + model.output) / grandTotal) * 100;
                            return pct < 0.1 ? "<0.1%" : `${pct.toFixed(1)}%`;
                          })()}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
                <tfoot>
                  <tr class="border-t border-dls-border">
                    <td class="pt-3 pr-4 font-semibold text-dls-text">{t("session.tokens_total")}</td>
                    <td class="pt-3 pr-4 text-right font-semibold text-dls-text">
                      {formatTokens(aggregatedStats().total.input)}
                    </td>
                    <td class="pt-3 pr-4 text-right font-semibold text-dls-text">
                      {formatTokens(aggregatedStats().total.output)}
                    </td>
                    <td class="pt-3 pr-4 text-right font-semibold text-dls-text">
                      {formatTokens(aggregatedStats().total.input + aggregatedStats().total.output)}
                    </td>
                    <td class="pt-3 text-right font-semibold text-dls-text">
                      100%
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Show>
        </Card>
      </Show>

      {/* All-time spend — sits OUTSIDE the Show above on purpose: when the
          per-session view is empty this is the only section with numbers in it,
          and it is exactly the number the user came looking for. */}
      <Show when={allTimeUsage()}>
        {(aggregate) => (
          <Card title={t("token.nonsession_title")} class="!bg-dls-panel-bg !border-dls-panel-border">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <p class="text-caption font-medium text-dls-secondary">{t("token.nonsession_tokens")}</p>
                <p class="text-title leading-title font-semibold text-dls-text">
                  {formatTokens(aggregate().total.total_tokens || 0)}
                </p>
              </div>
              <div>
                <p class="text-caption font-medium text-dls-secondary">{t("token.nonsession_requests")}</p>
                <p class="text-title leading-title font-semibold text-dls-text">
                  {(aggregate().total.request_count || 0).toLocaleString()}
                </p>
              </div>
              <div>
                <p class="text-caption font-medium text-dls-secondary">{t("token.nonsession_cost")}</p>
                <p class="text-title leading-title font-semibold text-dls-text">
                  {formatCostUsd(aggregate().total.cost_usd || 0)}
                </p>
              </div>
            </div>

            <Show
              when={allTimeRows().length > 0}
              fallback={
                <p class="mt-4 text-body-lg text-dls-secondary">{t("token.nonsession_empty")}</p>
              }
            >
              <div class="mt-4 overflow-x-auto">
                <table class="w-full text-body-lg">
                  <thead>
                    <tr class="border-b border-dls-border text-left">
                      <th class="pb-3 pr-4 font-medium text-dls-secondary">{t("token.nonsession_purpose")}</th>
                      <th class="pb-3 pr-4 text-right font-medium text-dls-secondary">{t("token.nonsession_requests")}</th>
                      <th class="pb-3 pr-4 text-right font-medium text-dls-secondary">{t("token.nonsession_tokens")}</th>
                      <th class="pb-3 text-right font-medium text-dls-secondary">{t("token.nonsession_cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={allTimeRows()}>
                      {(row) => (
                        <tr class="border-b border-dls-border/50 last:border-0">
                          <td class="py-3 pr-4 font-medium text-dls-text">{row.label}</td>
                          <td class="py-3 pr-4 text-right text-dls-text">{row.requests.toLocaleString()}</td>
                          <td class="py-3 pr-4 text-right text-dls-text">{formatTokens(row.tokens)}</td>
                          <td class="py-3 text-right text-dls-text">{formatCostUsd(row.cost)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>

            {/* Only worth the line when there is money on screen to qualify. */}
            <Show when={(aggregate().total.cost_usd || 0) > 0}>
              <p class="mt-3 text-caption text-dls-secondary">{t("token.nonsession_cost_note")}</p>
            </Show>
          </Card>
        )}
      </Show>
    </div>
  );
}
