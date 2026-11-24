import { createMemo, createRoot } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";

import { setLocale } from "../../i18n";
import { agentDisplayNames, agentTriggerLabel } from "./session.quick-agents";

afterEach(() => setLocale("en"));

describe("agentTriggerLabel", () => {
  test("the implicit and the explicitly selected default both read General", () => {
    // #3320: the two paths used to come from separate literals.
    expect(agentTriggerLabel(null)).toBe("General");
    expect(agentTriggerLabel("superclaw-default")).toBe("General");
  });

  test("other agents keep their display name, or fall back to the agent id", () => {
    expect(agentTriggerLabel("build")).toBe("Hybrid Coding Agent");
    expect(agentTriggerLabel("my-custom-agent")).toBe("my-custom-agent");
  });

  test("the default label follows a locale switch", () => {
    createRoot((dispose) => {
      const label = createMemo(() => agentTriggerLabel(null));
      expect(label()).toBe("General");
      setLocale("zh");
      expect(label()).toBe("通用");
      dispose();
    });
  });

  test("a quick agent's label is translated like its quick button", () => {
    setLocale("zh");
    expect(agentTriggerLabel("build")).toBe("混合编程助手");
  });
});

describe("agentDisplayNames", () => {
  test("names every quick agent, and only those", () => {
    expect(agentDisplayNames()).toEqual({
      build: "Hybrid Coding Agent",
      "hybrid-deep-research": "Hybrid Deep Research",
      "email-agent": "Email Agent",
    });
  });
});
