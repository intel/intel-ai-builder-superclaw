// Under `bun test` the lucide icons the nav model imports reach Solid's server
// build and throw on load, so the registry is covered from the vitest lane.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import en from "../../i18n/locales/en";
import zh from "../../i18n/locales/zh";
import { MCP_QUICK_CONNECT } from "~/shared/util/constants";
import { CONNECTION_SEARCH_ANCHORS } from "./identities.connection-rows";
import { SETTINGS_NAV } from "./settings-dialog.sections";
import {
  SETTINGS_SEARCH_ENTRIES,
  keywordsKeyFor,
  searchSettings,
  type SettingsSearchContext,
} from "./settings-search.registry";

// Telemetry, file cleanup and updates exist only in the installed app.
vi.mock("../utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils")>()),
  isTauriRuntime: () => true,
}));
// The context-size knob is a build-time experiment, off in release builds.
vi.mock("../lib/experimental-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/experimental-flags")>()),
  showLocalCtxSlider: () => true,
}));

const darkSafe: SettingsSearchContext["capability"] = {
  isActive: () => false,
  isAgentAllowed: () => false,
  hdrEnabled: () => false,
  forceCloudRouting: () => false,
};

const context = (overrides: Partial<SettingsSearchContext> = {}): SettingsSearchContext => ({
  voice: true,
  capability: darkSafe,
  updateEnv: null,
  serverReady: true,
  cleanupEnabled: true,
  perfWeightSupported: true,
  localCtxSupported: true,
  fileProtectionShown: true,
  ...overrides,
});

const ids = (query: string, overrides?: Partial<SettingsSearchContext>) =>
  searchSettings(query, context(overrides)).flatMap((group) => group.results.map((result) => result.entry.id));

describe("searchSettings", () => {
  test.each([
    ["dark mode", "appearance"],
    ["dark mode", "theme"],
    ["mic", "voice_device"],
    ["mic", "voice"],
    ["hotkey", "voice_hotkey"],
    ["storage", "file_cleanup"],
    ["API key", "cloud_model"],
    ["upgrade", "updates"],
    ["tracking", "telemetry"],
    ["locale", "language"],
    ["Tavily", "web_search"],
    ["appear", "appearance"],
  ])("%s finds %s", (query, id) => {
    expect(ids(query)).toContain(id);
  });

  test.each([
    ["深色模式", "appearance"],
    ["中文", "language"],
    ["麦克风", "voice_device"],
    ["快捷键", "voice_hotkey"],
    ["存储", "file_cleanup"],
    ["升级", "updates"],
    ["遥测", "telemetry"],
    ["文件保护", "file_protection"],
    ["联网搜索", "web_search"],
    ["模型", "model"],
  ])("the Chinese word %s finds %s", (query, id) => {
    expect(ids(query)).toContain(id);
  });

  test.each([
    ["aparence", "appearance"],
    ["telemtry", "telemetry"],
  ])("the typo %s still finds %s", (query, id) => {
    expect(ids(query)).toContain(id);
  });

  test("finds MCP by the name of any quick-connect server", () => {
    for (const server of MCP_QUICK_CONNECT) {
      expect(ids(server.name), server.name).toContain("mcp");
    }
    expect(ids("hugging face")).toContain("mcp");
    expect(ids("huggingface")).toContain("mcp");
    expect(ids("minimax")).toContain("mcp");
  });

  test("finds nothing for a word no setting has", () => {
    expect(searchSettings("zebra", context())).toEqual([]);
    expect(searchSettings("   ", context())).toEqual([]);
  });

  test("groups results by section in nav order, best match first", () => {
    const groups = searchSettings("theme", context());
    const order = SETTINGS_NAV.map((item) => item.id);
    const sections = groups.map((group) => group.section.id);
    expect([...sections].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(sections);
    expect(groups[0]?.section.id).toBe("app");
    expect(groups[0]?.results[0]?.entry.id).toBe("theme");
  });

  test("leaves Gmail out when the active Profile has no email-agent", () => {
    const active = { ...darkSafe, isActive: () => true };
    expect(ids("gmail", { capability: active })).not.toContain("gmail");
    expect(ids("gmail", { capability: { ...active, isAgentAllowed: (name) => name === "email-agent" } })).toContain(
      "gmail",
    );
    expect(ids("gmail")).toContain("gmail");
  });

  test("leaves Dictation and everything in it out without a voice controller", () => {
    const found = searchSettings("mic shortcut dictionary voice", context({ voice: false }));
    expect(found.some((group) => group.section.id === "voice")).toBe(false);
    expect(ids("hotkey", { voice: false })).toEqual([]);
  });

  test("leaves Slack out while the Connections page has no server", () => {
    expect(ids("slack", { serverReady: false })).not.toContain("slack");
    expect(ids("slack")).toContain("slack");
  });

  test("leaves out cards the Profile hides", () => {
    const active = { ...darkSafe, isActive: () => true };
    expect(ids("deep research", { capability: active })).not.toContain("hdr_privacy");
    expect(ids("deep research", { capability: { ...active, hdrEnabled: () => true } })).toContain("hdr_privacy");
    expect(ids("background", { capability: active })).not.toContain("keep_backend");
    expect(ids("quality", { capability: { ...darkSafe, forceCloudRouting: () => true } })).not.toContain("perf_weight");
  });

  test("leaves out Retention while automatic cleanup is off, as the card does", () => {
    expect(ids("retention", { cleanupEnabled: false })).not.toContain("cleanup_retention");
    expect(ids("retention")).toContain("cleanup_retention");
  });

  test("leaves out cards a backend read has hidden", () => {
    expect(ids("quality", { perfWeightSupported: false })).not.toContain("perf_weight");
    expect(ids("quality")).toContain("perf_weight");
    expect(ids("context", { localCtxSupported: false })).not.toContain("local_ctx");
    expect(ids("context")).toContain("local_ctx");
    // The card's check covers the controls inside it.
    for (const [query, id] of [
      ["file protection", "file_protection"],
      ["protection mode", "protection_mode"],
      ["sensitive", "sensitive_folder"],
    ]) {
      expect(ids(query)).toContain(id);
      expect(ids(query, { fileProtectionShown: false })).not.toContain(id);
    }
  });

  test("leaves out Updates when the updater is not supported", () => {
    expect(ids("upgrade", { updateEnv: { supported: false } as SettingsSearchContext["updateEnv"] })).not.toContain(
      "updates",
    );
  });
});

describe("the searchable settings", () => {
  test("never point at a developer-only section", () => {
    const sections = new Set(SETTINGS_SEARCH_ENTRIES.map((entry) => entry.section));
    expect(sections.has("den")).toBe(false);
    expect(sections.has("config")).toBe(false);
  });

  test("include every nav section, and every id is unique", () => {
    const entryIds = SETTINGS_SEARCH_ENTRIES.map((entry) => entry.id);
    expect(new Set(entryIds).size).toBe(entryIds.length);
    for (const item of SETTINGS_NAV) {
      expect(SETTINGS_SEARCH_ENTRIES.some((entry) => entry.kind === "section" && entry.id === item.id)).toBe(true);
    }
  });

  test("have a label, keywords and any description in both English and Chinese", () => {
    const locales: [string, Record<string, string>][] = [
      ["en", en],
      ["zh", zh],
    ];
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      const keys = [entry.labelKey, keywordsKeyFor(entry), entry.descriptionKey].filter(
        (key): key is string => Boolean(key),
      );
      for (const [name, strings] of locales) {
        for (const key of keys) {
          expect(strings[key], `${name} ${key}`).toBeTruthy();
        }
      }
    }
  });

  // Anchors live in markup across many files, so they are read from the source
  // rather than by rendering every section with its whole app context.
  test("match the data-settings-anchor attributes in the markup one to one", () => {
    const appDir = join(__dirname, "..");
    const tsxFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return tsxFiles(path);
        return path.endsWith(".tsx") && !/\.(test|vitest)\.tsx$/.test(path) ? [path] : [];
      });
    // Connections rows are drawn from one list, so their anchors come from its map, not a literal.
    const anchors: string[] = Object.values(CONNECTION_SEARCH_ANCHORS).filter((id): id is string => Boolean(id));
    for (const file of tsxFiles(appDir)) {
      for (const match of readFileSync(file, "utf8").matchAll(/data-settings-anchor="([a-z_]+)"/g)) {
        anchors.push(match[1]);
      }
    }
    const settingIds = SETTINGS_SEARCH_ENTRIES.filter((entry) => entry.kind === "setting").map((entry) => entry.id);
    expect([...anchors].sort()).toEqual([...settingIds].sort());
  });

  test("call the Tavily card Web search, so it is not mistaken for this search", () => {
    expect(en["settings.search_title"]).toBe("Web search");
    expect(zh["settings.search_title"]).toBe("网络搜索");
  });
});
