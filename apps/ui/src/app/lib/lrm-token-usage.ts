import type { LlmRouterUsageEvent } from "./llmrouter-client";
import { filterZeroUsagePlaceholders, mergeGenericLocalEntries, normalizeModelKey } from "../utils";

export type LrmTokenStats = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

export type LrmModelTokenStats = LrmTokenStats & {
  modelKey: string;
  providerID: string;
  modelID: string;
};

export type LrmAggregatedTokenUsage = {
  total: LrmTokenStats;
  modelStats: LrmModelTokenStats[];
  messageCount: number;
  coveredSessionIds: Set<string>;
};

const emptyStats = (): LrmTokenStats => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

function addEventToStats(stats: LrmTokenStats, event: LlmRouterUsageEvent): void {
  stats.input += event.prompt_tokens || 0;
  stats.output += event.completion_tokens || 0;
  stats.reasoning += event.reasoning_tokens || 0;
  stats.cacheRead += event.cache_read_input_tokens || 0;
  stats.cacheWrite += event.cache_creation_input_tokens || 0;
  stats.cost += event.cost_usd || 0;
}

export function aggregateLrmUsageEvents(eventsBySession: Record<string, LlmRouterUsageEvent[]>): LrmAggregatedTokenUsage {
  const total = emptyStats();
  const byModel = new Map<string, LrmModelTokenStats>();
  const coveredSessionIds = new Set<string>();
  let messageCount = 0;

  for (const [sessionId, events] of Object.entries(eventsBySession)) {
    if (events.length > 0) coveredSessionIds.add(sessionId);
    for (const event of events) {
      addEventToStats(total, event);
      messageCount += 1;

      const providerID = event.provider || event.source || "unknown";
      const modelID = event.underlying_model || event.alias || "unknown";
      const identity = normalizeModelKey(providerID, modelID);
      const modelKey = `${identity.providerID}/${identity.modelID}`;
      const existing = byModel.get(modelKey);
      if (existing) {
        addEventToStats(existing, event);
      } else {
        const stats = emptyStats();
        addEventToStats(stats, event);
        byModel.set(modelKey, {
          modelKey,
          providerID: identity.providerID,
          modelID: identity.modelID,
          ...stats,
        });
      }
    }
  }

  mergeGenericLocalEntries(byModel, (target, source) => {
    target.input += source.input;
    target.output += source.output;
    target.reasoning += source.reasoning;
    target.cacheRead += source.cacheRead;
    target.cacheWrite += source.cacheWrite;
    target.cost += source.cost;
  });

  const modelStats = filterZeroUsagePlaceholders(Array.from(byModel.values()));
  modelStats.sort((a, b) => (b.input + b.output) - (a.input + a.output));

  return { total, modelStats, messageCount, coveredSessionIds };
}
