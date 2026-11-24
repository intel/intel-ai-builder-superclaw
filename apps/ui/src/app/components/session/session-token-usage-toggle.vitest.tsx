import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";
import { setLocale } from "~/i18n";
import {
  routeModelBreakdown,
  SessionTokenUsageToggle,
  splitTokensByRoute,
  TOKEN_USAGE_EXPANDED_KEY,
} from "./session-token-usage-toggle";

const formatTokens = (count: number) => `${count}t`;
const formatModelLabel = (providerID: string, modelID: string) => `${providerID}/${modelID}`;

const CLOUD = {
  providerID: "openai", modelID: "gpt-5", isLocal: false, inputTokens: 10_000, outputTokens: 8_400,
};
const LOCAL = {
  providerID: "llama", modelID: "qwen3-4b", isLocal: true, inputTokens: 5_000, outputTokens: 1_200,
};

type Models = Parameters<typeof splitTokensByRoute>[0];

function renderToggle(initial: Models | null) {
  const [models, setModels] = createSignal(initial);
  render(() => (
    <SessionTokenUsageToggle
      tokensByModel={models()}
      formatTokens={formatTokens}
      formatModelLabel={formatModelLabel}
    >
      <h1>Title</h1>
    </SessionTokenUsageToggle>
  ));
  return { setModels };
}

const toggle = () => screen.queryByTestId("session-token-usage-toggle");
const line = () => screen.queryByTestId("session-token-usage-line");

function requireToggle(): HTMLElement {
  const button = toggle();
  if (!button) throw new Error("chevron missing");
  return button;
}

function segmentTrigger(route: "cloud" | "local"): HTMLElement {
  const trigger = line()
    ?.querySelector(`[data-model-route="${route}"]`)
    ?.closest<HTMLElement>("[tabindex='0']");
  if (!trigger) throw new Error(`${route} segment is not focusable`);
  return trigger;
}

afterEach(() => {
  cleanup();
  setLocale("en");
  window.localStorage.removeItem(TOKEN_USAGE_EXPANDED_KEY);
});

describe("splitTokensByRoute", () => {
  test("sums input and output per route", () => {
    expect(splitTokensByRoute([CLOUD, LOCAL, { ...CLOUD, inputTokens: 1 }])).toEqual({
      cloud: 18_400 + 8_401,
      local: 6_200,
    });
  });
});

describe("routeModelBreakdown", () => {
  test("lists one route's models with usage, largest first", () => {
    const small = { ...CLOUD, modelID: "gpt-5-mini", inputTokens: 100, outputTokens: 0 };
    const unused = { ...CLOUD, modelID: "idle", inputTokens: 0, outputTokens: 0 };
    expect(
      routeModelBreakdown([small, LOCAL, CLOUD, unused], false, formatTokens, formatModelLabel),
    ).toBe("openai/gpt-5 · 18400t\nopenai/gpt-5-mini · 100t");
  });
});

describe("SessionTokenUsageToggle", () => {
  test("no chevron or line until the session has usage", () => {
    setLocale("en");
    const { setModels } = renderToggle(null);
    expect(toggle()).toBeNull();
    expect(line()).toBeNull();

    setModels([{ ...LOCAL, inputTokens: 0, outputTokens: 0 }]);
    expect(toggle()).toBeNull();

    setModels([LOCAL]);
    expect(toggle()).not.toBeNull();
    expect(line()).not.toBeNull();
  });

  test("the line shows by default and the chevron toggles it", () => {
    setLocale("en");
    renderToggle([CLOUD, LOCAL]);
    const button = requireToggle();
    expect(button.getAttribute("aria-label")).toBe("Token usage");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const shown = line();
    expect(shown?.id).toBe(button.getAttribute("aria-controls"));
    expect(shown?.textContent).toBe("Cloud 18400tLocal 6200t");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(line()).toBeNull();

    fireEvent.click(button);
    expect(line()).not.toBeNull();
  });

  test("the user's choice is remembered on the next mount", () => {
    setLocale("en");
    renderToggle([CLOUD]);
    fireEvent.click(requireToggle());
    expect(window.localStorage.getItem(TOKEN_USAGE_EXPANDED_KEY)).toBe("0");

    cleanup();
    renderToggle([CLOUD]);
    expect(requireToggle().getAttribute("aria-expanded")).toBe("false");
    expect(line()).toBeNull();

    fireEvent.click(requireToggle());
    expect(window.localStorage.getItem(TOKEN_USAGE_EXPANDED_KEY)).toBe("1");

    cleanup();
    renderToggle([CLOUD]);
    expect(line()).not.toBeNull();
  });

  test("focusing a segment names only that route's models", () => {
    setLocale("en");
    renderToggle([CLOUD, LOCAL]);

    const cloud = segmentTrigger("cloud");
    fireEvent.focusIn(cloud);
    expect(screen.getByRole("tooltip").textContent).toContain("openai/gpt-5 · 18400t");
    expect(screen.getByRole("tooltip").textContent).not.toContain("qwen3-4b");

    fireEvent.focusOut(cloud);
    fireEvent.focusIn(segmentTrigger("local"));
    expect(screen.getByRole("tooltip").textContent).toContain("llama/qwen3-4b · 6200t");
    expect(screen.getByRole("tooltip").textContent).not.toContain("gpt-5");
  });

  test("a usage refresh keeps an open segment tooltip", () => {
    setLocale("en");
    const { setModels } = renderToggle([CLOUD, LOCAL]);

    const trigger = segmentTrigger("cloud");
    fireEvent.focusIn(trigger);

    setModels([{ ...CLOUD, outputTokens: 9_400 }, LOCAL]);
    expect(trigger.isConnected).toBe(true);
    expect(line()?.textContent).toContain("Cloud 19400t");
    expect(screen.getByRole("tooltip").textContent).toContain("openai/gpt-5 · 19400t");
  });

  test("a route with no usage is left off", () => {
    setLocale("en");
    renderToggle([LOCAL]);
    expect(line()?.textContent).toBe("Local 6200t");
    expect(line()?.querySelector('[data-model-route="cloud"]')).toBeNull();
  });
});
