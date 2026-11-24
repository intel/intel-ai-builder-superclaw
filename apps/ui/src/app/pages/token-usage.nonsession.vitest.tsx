/**
 * Data & Usage → the all-time spend section.
 *
 * Why this section exists at all: dictation clean-up calls the cloud with
 * session_id = null, so the per-session view above it can never see them. A
 * user who had only dictated reported "token usage is always 0" while the
 * router's ledger held nine real requests. These tests pin the two claims that
 * make the fix honest — the section renders when the per-session view is empty,
 * and a breakdown that does not add up to the lifetime total says so.
 *
 * Not `bun test`: the aggregate fetch is fired from a createEffect, which is a
 * no-op in the SSR build `bun test` resolves, so every assertion here would
 * pass vacuously against an unrendered section.
 */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, test } from "vitest";

import type { LlmRouterClient, LlmRouterUsageAggregateResponse } from "../lib/llmrouter-client";
import { t } from "../../i18n";

import TokenUsageView from "./token-usage";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

/** Effects fire off-tick, and the fetch is awaited inside one. */
const settle = async (ticks = 4) => {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const totals = (over: Partial<LlmRouterUsageAggregateResponse["total"]> = {}) => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  reasoning_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cost_usd: 0,
  request_count: 0,
  first_seen_at: null,
  last_updated_at: null,
  ...over,
});

/**
 * Only `getUsage` is real: with no workspace sessions passed in, the
 * per-session paths never touch the rest of the client surface.
 */
const stubClient = (aggregate: LlmRouterUsageAggregateResponse) => {
  const calls: string[] = [];
  const client = {
    getUsage: async (groupBy: string) => {
      calls.push(groupBy);
      return aggregate;
    },
  } as unknown as LlmRouterClient;
  return { client, calls };
};

const renderView = async (aggregate: LlmRouterUsageAggregateResponse) => {
  const { client, calls } = stubClient(aggregate);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => <TokenUsageView workspaceSessionGroups={[]} llmRouterClient={client} />,
    host,
  );
  await settle();
  return { host, calls };
};

describe("token usage — all-time spend", () => {
  test("an alias this build has never heard of is shown verbatim, not hidden", async () => {
    // The fall-through is deliberate and worth guarding: an unrecognised alias
    // is still real money, and the raw string is the only clue to what spent
    // it. Hiding it would make the rows silently fail to add up to the total;
    // renaming it to "other" would throw away the clue.
    const { host } = await renderView({
      total: totals({ total_tokens: 1000, request_count: 2, cost_usd: 0.0004 }),
      groups: [
        { ...totals({ total_tokens: 1000, request_count: 2, cost_usd: 0.0004 }), alias: "some-future-caller" },
      ],
    });

    expect(host.textContent ?? "").toContain("some-future-caller");
  });

  test("names dictation clean-up as its own line while the per-session view is empty", async () => {
    const { host, calls } = await renderView({
      total: totals({ total_tokens: 9558, request_count: 9, cost_usd: 0.00172 }),
      groups: [
        { ...totals({ total_tokens: 5000, request_count: 5, cost_usd: 0.001 }), alias: "cloud-model" },
        { ...totals({ total_tokens: 4558, request_count: 4, cost_usd: 0.00072 }), alias: "dictation-refine" },
      ],
    });

    // The alias dimension is the whole point of the query; model/provider
    // grouping cannot separate dictation from chat on a shared model.
    expect(calls).toEqual(["alias"]);
    const text = host.textContent ?? "";
    expect(text).toContain(t("token.nonsession_title"));
    expect(text).toContain(t("token.nonsession_alias_dictation"));
    // LLMRouter's own model aliases get a human label too -- "Purpose:
    // cloud-model" tells a user nothing. The raw string must be GONE, because
    // leaving it is the gap this label closes.
    expect(text).toContain(t("token.nonsession_alias_cloud_model"));
    expect(text).not.toContain("cloud-model");
    // The per-session view is empty, and must still say so rather than borrow
    // these numbers.
    expect(text).toContain(t("token.usage_no_data"));
    expect(text).toContain(t("token.usage_nonsession_hint"));
    // Sub-cent cost must not round to "$0.00" — it is real money.
    expect(text).toContain("$0.0017");
  });

  test("shows the gap when alias rows sum below the lifetime total", async () => {
    const { host } = await renderView({
      total: totals({ total_tokens: 1000, request_count: 10, cost_usd: 0.5 }),
      groups: [{ ...totals({ total_tokens: 400, request_count: 4, cost_usd: 0.2 }), alias: "dictation-refine" }],
    });

    const text = host.textContent ?? "";
    expect(text).toContain(t("token.nonsession_unattributed"));
    // 600 unattributed tokens, rendered by the shared formatter.
    expect(text).toContain("600");
  });

  test("a router that rejects group_by=alias leaves the section out entirely", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const client = {
      getUsage: async () => {
        throw new Error("invalid_group_by");
      },
    } as unknown as LlmRouterClient;
    dispose = render(
      () => <TokenUsageView workspaceSessionGroups={[]} llmRouterClient={client} />,
      host,
    );
    await settle();

    // Half a money figure is worse than none, so the whole card stays away.
    expect(host.textContent ?? "").not.toContain(t("token.nonsession_title"));
  });
});

describe("token usage — whose spend is on screen", () => {
  /** One router's spend, identifiable by its alias label on screen. */
  const DICTATION_SPEND = {
    total: totals({ total_tokens: 9558, request_count: 9, cost_usd: 0.00172 }),
    groups: [
      { ...totals({ total_tokens: 9558, request_count: 9, cost_usd: 0.00172 }), alias: "dictation-refine" },
    ],
  };
  /** A different router's spend, with a different label. */
  const CHAT_SPEND = {
    total: totals({ total_tokens: 120, request_count: 1, cost_usd: 0.5 }),
    groups: [
      { ...totals({ total_tokens: 120, request_count: 1, cost_usd: 0.5 }), alias: "cloud-model" },
    ],
  };

  const dictationShown = (host: HTMLElement) =>
    (host.textContent ?? "").includes(t("token.nonsession_alias_dictation"));
  const sectionShown = (host: HTMLElement) =>
    (host.textContent ?? "").includes(t("token.nonsession_title"));

  /** Renders with a swappable client, so a reconnect can be exercised. */
  const renderSwappable = (initial: LlmRouterClient | null) => {
    const [client, setClient] = createSignal<LlmRouterClient | null>(initial);
    const host = document.createElement("div");
    document.body.appendChild(host);
    dispose = render(
      () => (
        <TokenUsageView
          workspaceSessionGroups={[]}
          llmRouterClient={client() as LlmRouterClient}
        />
      ),
      host,
    );
    return { host, setClient };
  };

  test("disconnecting the router takes its totals off screen", async () => {
    // These are money figures attributed to one install. Leaving them rendered
    // after the router they came from is gone states that spend as the current
    // connection's — and the early return for a null client used to do exactly
    // that, because nothing cleared the previous value.
    const { host, setClient } = renderSwappable(stubClient(DICTATION_SPEND).client);
    await settle();
    expect(dictationShown(host)).toBe(true);

    setClient(null);
    await settle();

    expect(dictationShown(host)).toBe(false);
    expect(sectionShown(host)).toBe(false);
  });

  test("a replacement router that rejects group_by=alias does not inherit the old totals", async () => {
    // The nastiest arm: on a 400 there is nothing to overwrite the stale value
    // with, so without an up-front clear the previous router's spend stays
    // visible under a different connection indefinitely.
    const { host, setClient } = renderSwappable(stubClient(DICTATION_SPEND).client);
    await settle();
    expect(dictationShown(host)).toBe(true);

    setClient({
      getUsage: async () => {
        throw new Error("invalid_group_by");
      },
    } as unknown as LlmRouterClient);
    await settle();

    expect(dictationShown(host)).toBe(false);
    expect(sectionShown(host)).toBe(false);
  });

  test("a superseded reply does not overwrite the current router's totals", async () => {
    // Resolved in reverse order: the slow first router answers after the second
    // has already rendered. Its rows must not land on top of the current ones.
    let releaseSlow: (() => void) | undefined;
    const slow = {
      getUsage: async () => {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        return DICTATION_SPEND;
      },
    } as unknown as LlmRouterClient;

    const { host, setClient } = renderSwappable(slow);
    await settle();

    setClient(stubClient(CHAT_SPEND).client);
    await settle();
    expect((host.textContent ?? "").includes(t("token.nonsession_alias_cloud_model"))).toBe(true);

    releaseSlow?.();
    await settle();

    expect((host.textContent ?? "").includes(t("token.nonsession_alias_cloud_model"))).toBe(true);
    expect(dictationShown(host)).toBe(false);
  });
});
