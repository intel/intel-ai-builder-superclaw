// Under `bun test` the lucide icons this module imports reach Solid's server
// build and throw on load, so the nav model is covered from the vitest lane.
import { describe, expect, test } from "vitest";

import {
  SETTINGS_NAV,
  isSettingsViewPane,
  stepSettingsNav,
  visibleSettingsNav,
} from "./settings-dialog.sections";

describe("the Settings nav", () => {
  test("lists the sections in the old tab strip's order", () => {
    expect(SETTINGS_NAV.map((item) => item.id)).toEqual([
      "app",
      "model",
      "privacy",
      "identities",
      "voice",
      "agent",
      "skills",
      "mcp",
      "scheduled",
    ]);
  });

  test("keeps the test ids the e2e page objects find sections by", () => {
    expect(SETTINGS_NAV.map((item) => item.testId)).toEqual([
      "app-settings-button",
      "model-settings-button",
      "privacy-settings-button",
      "channels-settings-button",
      "voice-settings-button",
      "agents-settings-button",
      "skills-settings-button",
      "mcp-settings-button",
      "scheduler-settings-button",
    ]);
  });

  test("leaves Dictation out when there is no voice controller", () => {
    expect(visibleSettingsNav({ voice: false }).map((item) => item.id)).not.toContain("voice");
    expect(visibleSettingsNav({ voice: true }).map((item) => item.id)).toContain("voice");
  });

  test("has no developer-mode sections", () => {
    const ids = SETTINGS_NAV.map((item) => item.id);
    expect(ids).not.toContain("den");
    expect(ids).not.toContain("config");
  });
});

describe("isSettingsViewPane", () => {
  test("is true only for the panes SettingsView draws", () => {
    for (const pane of ["app", "model", "privacy", "voice", "den"] as const) {
      expect(isSettingsViewPane(pane)).toBe(true);
    }
    for (const page of ["identities", "agent", "skills", "mcp", "scheduled", "config"] as const) {
      expect(isSettingsViewPane(page)).toBe(false);
    }
  });
});

describe("stepSettingsNav", () => {
  const items = visibleSettingsNav({ voice: false });

  test("moves one section down and up", () => {
    expect(stepSettingsNav(items, "model", "ArrowDown")).toBe("privacy");
    expect(stepSettingsNav(items, "model", "ArrowUp")).toBe("app");
  });

  test("wraps at both ends", () => {
    expect(stepSettingsNav(items, "scheduled", "ArrowDown")).toBe("app");
    expect(stepSettingsNav(items, "app", "ArrowUp")).toBe("scheduled");
  });

  test("Home and End jump to the ends", () => {
    expect(stepSettingsNav(items, "mcp", "Home")).toBe("app");
    expect(stepSettingsNav(items, "model", "End")).toBe("scheduled");
  });

  test("starts from the first section when the current one is not in the nav", () => {
    expect(stepSettingsNav(items, "config", "ArrowDown")).toBe("app");
  });

  test("returns null for an empty nav", () => {
    expect(stepSettingsNav([], "model", "ArrowDown")).toBeNull();
  });
});
