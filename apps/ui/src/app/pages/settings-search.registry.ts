/**
 * What the Settings search can find (#3836): every nav section, and the cards
 * and controls inside them.
 *
 * A setting entry's `id` is also its anchor: the element that carries
 * `data-settings-anchor="<id>"`, which a picked result scrolls to. Its other
 * words are the locale string `<labelKey>_keywords`, a comma-separated list in
 * the same locale file as the label, so translators can edit them. An entry is
 * offered only while its section, its card and its own `visible` check say the
 * UI shows it; those checks are the ones the cards themselves call.
 *
 * Adding a setting means adding its entry here, its anchor in the markup and
 * its keywords in `en` and `zh`; `settings-search.registry.vitest.ts` fails
 * until all three agree.
 */
import type { CapabilityGate } from "~/shared/platform/capability/capability-gate";
import { MCP_QUICK_CONNECT } from "~/shared/util/constants";
import { LANGUAGES, t } from "../../i18n";
import { showLocalCtxSlider } from "../lib/experimental-flags";
import {
  backendLifecycleVisible,
  desktopSettingVisible,
  hdrPrivacyVisible,
  perfWeightVisible,
  updateBarVisible,
} from "../lib/settings-visibility";
import type { UpdaterEnvironment } from "../lib/tauri";
import { gmailSettingsVisible } from "./settings.gmail-credentials";
import { SETTINGS_NAV, visibleSettingsNav, type SettingsNavItem, type SettingsSection } from "./settings-dialog.sections";
import {
  prepareSearchField,
  scoreSearchFields,
  searchTokens,
  type PreparedSearchField,
} from "./settings-search.match";

export type SettingsSearchContext = {
  voice: boolean;
  capability: Pick<CapabilityGate, "isActive" | "isAgentAllowed" | "hdrEnabled" | "forceCloudRouting">;
  updateEnv: UpdaterEnvironment | null | undefined;
  /** The Connections page draws its channels only with a connected server. */
  serverReady: boolean;
  /**
   * What the last backend reads said about cards that hide themselves on the
   * answer; each card's module keeps its last read past unmount.
   */
  cleanupEnabled: boolean;
  perfWeightSupported: boolean;
  localCtxSupported: boolean;
  fileProtectionShown: boolean;
};

export type SettingsSearchEntry = {
  id: string;
  kind: "section" | "setting";
  section: SettingsSection;
  /** The card a control sits in; its label is the middle of the result's path. */
  parent?: string;
  labelKey: string;
  descriptionKey?: string;
  visible?: (context: SettingsSearchContext) => boolean;
};

type SettingDefinition = Omit<SettingsSearchEntry, "kind">;

const SETTINGS: readonly SettingDefinition[] = [
  // General
  { id: "updates", section: "app", labelKey: "settings.updates_title", visible: (c) => updateBarVisible(c.updateEnv) },
  { id: "appearance", section: "app", labelKey: "settings.appearance_title" },
  { id: "theme", section: "app", parent: "appearance", labelKey: "settings.theme" },
  { id: "language", section: "app", parent: "appearance", labelKey: "settings.language" },
  {
    id: "file_cleanup",
    section: "app",
    labelKey: "settings.file_cleanup_title",
    descriptionKey: "settings.file_cleanup_subtitle",
    visible: desktopSettingVisible,
  },
  { id: "cleanup_auto", section: "app", parent: "file_cleanup", labelKey: "settings.enable_file_cleanup" },
  {
    id: "cleanup_retention",
    section: "app",
    parent: "file_cleanup",
    labelKey: "settings.cleanup_retention_label",
    visible: (c) => c.cleanupEnabled,
  },
  { id: "cleanup_run_now", section: "app", parent: "file_cleanup", labelKey: "settings.cleanup_run_now" },
  { id: "telemetry", section: "app", labelKey: "settings.telemetry_title", visible: desktopSettingVisible },
  {
    id: "telemetry_usage",
    section: "app",
    parent: "telemetry",
    labelKey: "settings.telemetry_baseline_enable",
    descriptionKey: "settings.telemetry_baseline_enable_desc",
  },
  {
    id: "telemetry_crash",
    section: "app",
    parent: "telemetry",
    labelKey: "settings.telemetry_enable",
    descriptionKey: "settings.telemetry_crash_enable_desc",
  },
  {
    id: "reset_install_id",
    section: "app",
    parent: "telemetry",
    labelKey: "settings.telemetry_reset_install_id",
    descriptionKey: "settings.telemetry_reset_install_id_desc",
  },
  {
    id: "backend_lifecycle",
    section: "app",
    labelKey: "settings.backend_lifecycle_title",
    visible: (c) => backendLifecycleVisible(c.capability),
  },
  {
    id: "keep_backend",
    section: "app",
    parent: "backend_lifecycle",
    labelKey: "settings.keep_backend_running",
    descriptionKey: "settings.keep_backend_running_desc",
  },

  // Model Routing
  { id: "local_model", section: "model", labelKey: "local.section_title" },
  { id: "cloud_model", section: "model", labelKey: "model.cloud_label" },
  {
    id: "perf_weight",
    section: "model",
    labelKey: "model.perf_weight_section",
    visible: (c) => c.perfWeightSupported && perfWeightVisible(c.capability),
  },
  {
    id: "local_ctx",
    section: "model",
    labelKey: "model.local_ctx_title",
    descriptionKey: "model.local_ctx_description",
    visible: (c) => showLocalCtxSlider() && c.localCtxSupported,
  },

  // Privacy
  { id: "file_protection", section: "privacy", labelKey: "security.section", visible: (c) => c.fileProtectionShown },
  { id: "protection_mode", section: "privacy", parent: "file_protection", labelKey: "security.mode_title" },
  {
    id: "sensitive_folder",
    section: "privacy",
    parent: "file_protection",
    labelKey: "security.sensitive_folder_title",
    descriptionKey: "security.sensitive_folder_description",
  },
  {
    id: "hdr_privacy",
    section: "privacy",
    labelKey: "settings.deep_research_privacy_title",
    visible: (c) => hdrPrivacyVisible(c.capability),
  },

  // Connections
  {
    id: "slack",
    section: "identities",
    labelKey: "identities.slack_title",
    descriptionKey: "identities.slack_card_description",
    visible: (c) => c.serverReady,
  },
  { id: "github", section: "identities", labelKey: "settings.github_title", descriptionKey: "settings.github_subtitle" },
  { id: "web_search", section: "identities", labelKey: "settings.search_title" },
  {
    id: "gmail",
    section: "identities",
    labelKey: "settings.gmail_title",
    visible: (c) => gmailSettingsVisible(c.capability),
  },

  // Dictation
  { id: "voice_mode", section: "voice", labelKey: "voice.mode_heading" },
  { id: "voice_hotkey", section: "voice", labelKey: "voice.hotkey_heading", descriptionKey: "voice.hotkey_desc" },
  { id: "voice_device", section: "voice", labelKey: "voice.device_heading" },
  { id: "read_aloud", section: "voice", labelKey: "voice.read_aloud_voice_heading" },
  { id: "voice_refine", section: "voice", labelKey: "voice.refine_heading", descriptionKey: "voice.refine_desc" },
  {
    id: "voice_dictionary",
    section: "voice",
    labelKey: "voice.dictionary_heading",
    descriptionKey: "voice.dictionary_desc",
  },
];

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  ...SETTINGS_NAV.map((item) => ({
    id: item.id,
    kind: "section" as const,
    section: item.id,
    labelKey: item.labelKey,
  })),
  ...SETTINGS.map((setting) => ({ ...setting, kind: "setting" as const })),
];

const entryById = new Map(SETTINGS_SEARCH_ENTRIES.filter((e) => e.kind === "setting").map((e) => [e.id, e]));
const navItemById = new Map(SETTINGS_NAV.map((item) => [item.id, item]));

export const keywordsKeyFor = (entry: SettingsSearchEntry): string => `${entry.labelKey}_keywords`;

/** The locale's keywords for an entry; `t` hands back the key itself when there are none. */
export function entryKeywords(entry: SettingsSearchEntry, language: (typeof LANGUAGES)[number]): string[] {
  const key = keywordsKeyFor(entry);
  const raw = t(key, language);
  if (raw === key) return [];
  return raw
    .split(/[,，、]/)
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * Names a section's page draws from a catalog rather than from locale strings:
 * the MCP quick-connect servers, so "hugging face" finds MCP. Names only; the
 * descriptions are broad enough ("search models…") to drown other results.
 */
const catalogKeywords = (entry: SettingsSearchEntry): readonly string[] =>
  entry.kind === "section" && entry.section === "mcp" ? MCP_QUICK_CONNECT.map((server) => server.name) : [];

let index: Map<string, PreparedSearchField[]> | null = null;

/** Labels, keywords and descriptions in every language, so a Chinese word finds a setting in English and back. */
function searchIndex(): Map<string, PreparedSearchField[]> {
  if (index) return index;
  index = new Map();
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    const fields: PreparedSearchField[] = [];
    const seen = new Set<string>();
    const add = (kind: PreparedSearchField["kind"], text: string) => {
      const dedupeKey = `${kind}\u0000${text}`;
      if (!text || seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      fields.push(prepareSearchField(kind, text));
    };
    for (const language of LANGUAGES) {
      add("label", t(entry.labelKey, language));
      for (const keyword of entryKeywords(entry, language)) add("keyword", keyword);
      if (entry.descriptionKey) add("description", t(entry.descriptionKey, language));
    }
    for (const name of catalogKeywords(entry)) {
      add("keyword", name);
      add("keyword", name.replace(/\s+/g, "")); // "huggingface" as often as "hugging face"
    }
    index.set(entry.id, fields);
  }
  return index;
}

function isVisible(entry: SettingsSearchEntry, context: SettingsSearchContext, sections: Set<SettingsSection>): boolean {
  if (!sections.has(entry.section)) return false;
  if (entry.visible && !entry.visible(context)) return false;
  const parent = entry.parent ? entryById.get(entry.parent) : undefined;
  return parent ? isVisible(parent, context, sections) : true;
}

/** The anchors to try for an entry, the setting itself first and then its card. */
export function anchorsFor(entry: SettingsSearchEntry): string[] {
  if (entry.kind === "section") return [];
  return entry.parent ? [entry.id, entry.parent] : [entry.id];
}

/** "General › Appearance" for Theme; just the section for a card; nothing for a section. */
export function entryPath(entry: SettingsSearchEntry): string[] {
  if (entry.kind === "section") return [];
  const sectionLabel = navItemById.get(entry.section)?.labelKey;
  const parent = entry.parent ? entryById.get(entry.parent) : undefined;
  return [sectionLabel, parent?.labelKey].filter((key): key is string => Boolean(key)).map((key) => t(key));
}

export type SettingsSearchResult = { entry: SettingsSearchEntry; score: number };
export type SettingsSearchGroup = { section: SettingsNavItem; results: SettingsSearchResult[] };

/** Matching visible entries, grouped by section in nav order, best match first within each. */
export function searchSettings(query: string, context: SettingsSearchContext): SettingsSearchGroup[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return [];
  const nav = visibleSettingsNav({ voice: context.voice });
  const sections = new Set(nav.map((item) => item.id));
  const fields = searchIndex();
  const bySection = new Map<SettingsSection, SettingsSearchResult[]>();
  SETTINGS_SEARCH_ENTRIES.forEach((entry) => {
    if (!isVisible(entry, context, sections)) return;
    const score = scoreSearchFields(tokens, fields.get(entry.id) ?? []);
    if (score === null) return;
    const list = bySection.get(entry.section) ?? [];
    list.push({ entry, score });
    bySection.set(entry.section, list);
  });
  return nav
    .filter((item) => bySection.has(item.id))
    .map((item) => ({
      section: item,
      // Array.prototype.sort is stable, so equal scores keep registry order.
      results: (bySection.get(item.id) ?? []).sort((a, b) => b.score - a.score),
    }));
}
