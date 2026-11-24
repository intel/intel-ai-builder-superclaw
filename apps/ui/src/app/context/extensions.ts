import { createSignal } from "solid-js";

import { applyEdits, modify } from "jsonc-parser";
import { join } from "@tauri-apps/api/path";
import { currentLocale, t } from "../../i18n";
import { validateSkillMarkdown } from "~/shared/util/skill-markdown";
import { isSupportedSkillPackageFile } from "@different-ai/openwork-contracts/skill-package";

import type { Client, HubSkillCard, HubSkillRepo, PluginScope, ReloadReason, ReloadTrigger, SkillCard } from "../types";
import { addOpencodeCacheHint, isTauriRuntime, safeStringify } from "../utils";
import skillCreatorTemplate from "../data/skill-creator.md?raw";
import skillFinderTemplate from "../data/skill-finder.md?raw";
import { OFFLINE_SKILL_CATALOG } from "../data/skillhub/catalog";
import {
  isPluginInstalled,
  loadPluginsFromConfig as loadPluginsFromConfigHelpers,
  parsePluginListFromContent,
  stripPluginVersion,
} from "~/shared/platform/plugins";
import {
  importSkill,
  installSkillTemplate,
  listLocalSkills,
  readLocalSkill,
  uninstallSkill as uninstallSkillCommand,
  writeLocalSkill,
  pickDirectory,
  pickFile,
  scanSkillFolder,
  scanLocalFolder,
  readLocalFileChunk,
  readLocalFileBytes,
  readOpencodeConfig,
  writeOpencodeConfig,
  type OpencodeConfigFile,
} from "../lib/tauri";
import type {
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
} from "../lib/openwork-server";
import { createQueuedForcedRefresh } from "../lib/queued-forced-refresh";

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;

export function createExtensionsStore(options: {
  client: () => Client | null;
  projectDir: () => string;
  activeWorkspaceRoot: () => string;
  workspaceType: () => "local" | "remote";
  openworkServerClient: () => OpenworkServerClient | null;
  openworkServerStatus: () => OpenworkServerStatus;
  openworkServerCapabilities: () => OpenworkServerCapabilities | null;
  openworkServerWorkspaceId: () => string | null;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setError: (value: string | null) => void;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  onCommandsChanged?: () => void;
}) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());
  const localizeSkillErrorMessage = (message: string) => {
    if (message === "No hub skills found.") {
      return translate("skills.hub_no_skills_found");
    }
    if (message === "Failed to load hub skills.") {
      return translate("skills.hub_failed_to_load");
    }
    if (message === "Skill name is required.") {
      return translate("skills.validation_name_required_short");
    }
    if (message === "Skill source information is missing.") {
      return translate("skills.source_missing");
    }
    if (message === "Bundled offline skill not found.") {
      return translate("skills.offline_skill_not_found");
    }
    if (message === "OpenWork server unavailable. Connect to install skills.") {
      return translate("skills.openwork_unavailable_install");
    }
    if (message === "Online GitHub hub is disabled. Only offline bundled skills are supported.") {
      return translate("skills.online_hub_disabled");
    }
    if (message === "OpenWork server unavailable. Connect to load skills.") {
      return translate("skills.openwork_unavailable_load");
    }
    if (message === "OpenCode client unavailable.") {
      return translate("skills.opencode_client_unavailable");
    }
    if (message === "Invalid SKILL.md") {
      return translate("skills.create_invalid_markdown");
    }
    if (message === "OpenWork server with write access is required to uninstall skills on a remote worker.") {
      return translate("skills.openwork_write_required_uninstall");
    }
    if (message === "OpenWork server unavailable. Connect to view skills.") {
      return translate("skills.openwork_unavailable_view");
    }
    if (message === "Local workers are required to view skills.") {
      return translate("skills.local_workers_required_view");
    }
    if (message === "OpenWork server unavailable. Connect to edit skills.") {
      return translate("skills.openwork_unavailable_edit");
    }
    if (message === "Local workers are required to edit skills.") {
      return translate("skills.local_workers_required_edit");
    }
    if (message === "Local workers are required to install skills.") {
      return translate("skills.local_workers_required_install");
    }
    {
      const installedPartial = message.match(/^Installed (.+); (\d+) additional file\(s\) require OpenWork server\.$/);
      if (installedPartial) {
        return translate("skills.installed_partial_openwork")
          .replace("{name}", installedPartial[1] ?? "")
          .replace("{count}", installedPartial[2] ?? "");
      }
    }
    {
      const installedNamed = message.match(/^Installed (.+)\.$/);
      if (installedNamed) {
        return translate("skills.installed_named").replace("{name}", installedNamed[1] ?? "");
      }
    }
    if (message === "Invalid SKILL.md format. Add a frontmatter block between '---' lines.") {
      return translate("skills.validation_invalid_format");
    }
    {
      const yamlAt = message.match(/^Skill YAML format is invalid at line (\d+), col (\d+)\. Please check the Frontmatter YAML\.$/);
      if (yamlAt) {
        return translate("skills.validation_yaml_invalid_at")
          .replace("{line}", yamlAt[1] ?? "")
          .replace("{col}", yamlAt[2] ?? "");
      }
    }
    if (message === "Skill YAML format is invalid. Please check the Frontmatter YAML.") {
      return translate("skills.validation_yaml_invalid");
    }
    if (message === "Frontmatter must be a YAML mapping (key/value object).") {
      return translate("skills.validation_frontmatter_mapping");
    }
    if (message === "Frontmatter is missing required field: name.") {
      return translate("skills.validation_name_required");
    }
    if (message === "Frontmatter is missing required field: description.") {
      return translate("skills.validation_description_required");
    }
    if (message === "Selected folder is not a skill: no SKILL.md at its root.") {
      return translate("skills.selected_folder_not_skill");
    }
    if (message === "'description' must be 1-1024 characters.") {
      return translate("skills.validation_description_length");
    }
    if (
      message ===
      "'name' must be kebab-case, 1-64 chars: lowercase letters/digits separated by single hyphens, no leading/trailing '-' and no '--'."
    ) {
      return translate("skills.validation_name_kebab");
    }
    if (message === "'license' must be a string when provided.") {
      return translate("skills.validation_license_string");
    }
    if (message === "'compatibility' must be a string when provided.") {
      return translate("skills.validation_compatibility_string");
    }
    if (message === "'metadata' must be a mapping of string keys to string values.") {
      return translate("skills.validation_metadata_mapping");
    }
    {
      const folderNameMismatch = message.match(/^Skill folder name '(.+)' must match the 'name' '(.+)' declared in SKILL\.md\.$/);
      if (folderNameMismatch) {
        return translate("skills.validation_folder_name_match")
          .replace("{expected}", folderNameMismatch[1] ?? "")
          .replace("{actual}", folderNameMismatch[2] ?? "");
      }
    }
    return message;
  };

  const [skills, setSkills] = createSignal<SkillCard[]>([]);
  const [skillsStatus, setSkillsStatusValue] = createSignal<string | null>(null);
  const [skillsStatusTone, setSkillsStatusTone] = createSignal<"info" | "success" | "error">("info");

  const setSkillsStatus = (value: string | null, tone: "info" | "success" | "error" = "info") => {
    setSkillsStatusValue(value);
    setSkillsStatusTone(value ? tone : "info");
  };

  const [hubSkills, setHubSkills] = createSignal<HubSkillCard[]>([]);
  const [hubSkillsStatus, setHubSkillsStatus] = createSignal<string | null>(null);

  const formatSkillPath = (location: string) => location.replace(/[/\\]SKILL\.md$/i, "");
  const OFFLINE_HUB_OWNER = "local";
  const OFFLINE_HUB_REPO = "skillhub";
  const OFFLINE_HUB_REF = "local";
  const OFFLINE_BUNDLED_SKILLS = OFFLINE_SKILL_CATALOG;

  const applyHubDuplicateRules = (items: HubSkillCard[]): HubSkillCard[] => {
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

    const groupByName = (name: string): string | null => {
      const n = normalize(name);
      if (n === "pdf") return "pdf";
      if (n === "docx" || n === "word") return "word";
      if (n === "pptx" || n === "ppt" || n === "powerpoint") return "ppt";
      if (n === "xlsx" || n === "excel") return "excel";
      if (n === "mcpcreator" || n === "mcp") return "mcp";
      if (n === "markdown") return "markdown";
      return null;
    };

    const grouped = new Map<string, HubSkillCard[]>();
    for (const item of items) {
      const group = groupByName(item.name);
      if (!group) continue;
      const list = grouped.get(group) ?? [];
      list.push(item);
      grouped.set(group, list);
    }

    const filtered = [...items];
    for (const [, groupItems] of grouped.entries()) {
      const [first, ...rest] = groupItems;
      if (!first) continue;
      for (const item of rest) {
        const idx = filtered.indexOf(item);
        if (idx >= 0) filtered.splice(idx, 1);
      }
    }

    return filtered;
  };

  const DEFAULT_HUB_REPOS: HubSkillRepo[] = [];

  const [hubRepo, setHubRepoSignal] = createSignal<HubSkillRepo | null>(DEFAULT_HUB_REPOS[0] ?? null);
  const [hubRepos, setHubRepos] = createSignal<HubSkillRepo[]>(DEFAULT_HUB_REPOS);

  const normalizeHubRepo = (input?: Partial<HubSkillRepo> | null): HubSkillRepo | null => {
    const owner = input?.owner?.trim() || "";
    const repo = input?.repo?.trim() || "";
    const ref = input?.ref?.trim() || "main";
    if (!owner || !repo) return null;
    return { owner, repo, ref };
  };

  const hubRepoKey = (repo: HubSkillRepo) => `${repo.owner}/${repo.repo}@${repo.ref}`;

  const normalizeHubRepoList = (items: unknown[]): HubSkillRepo[] => {
    const seen = new Set<string>();
    const next: HubSkillRepo[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const normalized = normalizeHubRepo({
        owner: typeof record.owner === "string" ? record.owner : undefined,
        repo: typeof record.repo === "string" ? record.repo : undefined,
        ref: typeof record.ref === "string" ? record.ref : undefined,
      });
      if (!normalized) continue;
      const key = hubRepoKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(normalized);
    }
    return next;
  };

  const [pluginScope, setPluginScope] = createSignal<PluginScope>("project");
  const [pluginConfig, setPluginConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [pluginConfigPath, setPluginConfigPath] = createSignal<string | null>(null);
  const [pluginList, setPluginList] = createSignal<string[]>([]);
  const [pluginInput, setPluginInput] = createSignal("");
  const [pluginStatus, setPluginStatus] = createSignal<string | null>(null);
  const [activePluginGuide, setActivePluginGuide] = createSignal<string | null>(null);

  const [sidebarPluginList, setSidebarPluginList] = createSignal<string[]>([]);
  const [sidebarPluginStatus, setSidebarPluginStatus] = createSignal<string | null>(null);

  // Track in-flight requests to prevent duplicate calls
  let refreshSkillsInFlight = false;
  let refreshPluginsInFlight = false;
  let refreshHubSkillsInFlight = false;
  let refreshSkillsAborted = false;
  let refreshPluginsAborted = false;
  let refreshHubSkillsAborted = false;
  let skillsLoaded = false;
  let hubSkillsLoaded = false;
  let skillsRoot = "";
  let hubSkillsLoadKey = "";

  const HUB_REPOS_STORAGE_KEY = "openwork.skills.hubRepos.v2";
  const HUB_SKILLS_STORAGE_KEY = "openwork.skills.hubSkills.v2";
  const HUB_SKILLS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  const persistHubSkills = () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        HUB_SKILLS_STORAGE_KEY,
        JSON.stringify({
          items: hubSkills(),
          timestamp: Date.now(),
        }),
      );
    } catch {
      // ignore
    }
  };

  const isValidHubSkillCard = (value: unknown): value is HubSkillCard => {
    if (!value || typeof value !== "object") return false;
    const card = value as Record<string, unknown>;
    if (typeof card.name !== "string" || !card.name) return false;
    const source = card.source as Record<string, unknown> | undefined;
    if (!source || typeof source !== "object") return false;
    return (
      typeof source.owner === "string" &&
      typeof source.repo === "string" &&
      typeof source.ref === "string"
    );
  };

  const loadHubSkillsFromCache = (): HubSkillCard[] | null => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(HUB_SKILLS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { items?: any[]; timestamp?: number };
      if (!parsed.timestamp || Date.now() - parsed.timestamp > HUB_SKILLS_CACHE_TTL) {
        return null; // Cache expired
      }
      if (!Array.isArray(parsed.items)) return null;
      // Discard the cache entirely if any entry is malformed (e.g. written by an
      // older build without a `source` field). Returning null forces a re-fetch
      // instead of feeding invalid data to the renderer, which would throw on
      // `skill.source.owner` and break the reactive tree.
      const valid = parsed.items.filter(isValidHubSkillCard);
      if (valid.length !== parsed.items.length) return null;
      return valid;
    } catch {
      return null;
    }
  };

  const persistHubRepos = () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        HUB_REPOS_STORAGE_KEY,
        JSON.stringify({ selected: hubRepo(), repos: hubRepos() }),
      );
    } catch {
      // ignore
    }
  };

  const setHubRepo = (repoInput: Partial<HubSkillRepo> | null, optionsOverride?: { remember?: boolean }) => {
    const next = normalizeHubRepo(repoInput);
    setHubRepoSignal(next);
    hubSkillsLoaded = false;
    if (optionsOverride?.remember === false || !next) {
      persistHubRepos();
      return;
    }
    setHubRepos((prev) => {
      const seen = new Set<string>();
      const merged = [next, ...prev];
      const deduped: HubSkillRepo[] = [];
      for (const item of merged) {
        const key = hubRepoKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }
      return deduped;
    });
    persistHubRepos();
  };

  const addHubRepo = (repoInput: Partial<HubSkillRepo>) => {
    const next = normalizeHubRepo(repoInput);
    if (!next) return;
    setHubRepo(next);
  };

  const removeHubRepo = (repoInput: Partial<HubSkillRepo>) => {
    const target = normalizeHubRepo(repoInput);
    if (!target) return;
    const targetKey = hubRepoKey(target);
    const nextRepos = hubRepos().filter((item) => hubRepoKey(item) !== targetKey);
    setHubRepos(nextRepos);
    const activeRepo = hubRepo();
    if (activeRepo && hubRepoKey(activeRepo) === targetKey) {
      setHubRepoSignal(nextRepos[0] ?? null);
      hubSkillsLoaded = false;
      if (!nextRepos.length) {
        setHubSkills([]);
          setHubSkillsStatus("Offline marketplace catalog is empty.");
        hubSkillsLoadKey = "";
      }
    }
    persistHubRepos();
  };

  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(HUB_REPOS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { selected?: unknown; repos?: unknown[]; custom?: unknown[] };
        const storedRepos = Array.isArray(parsed?.repos)
          ? normalizeHubRepoList(parsed.repos)
          : Array.isArray(parsed?.custom)
            ? normalizeHubRepoList(parsed.custom)
            : [];
        const selected =
          parsed?.selected && typeof parsed.selected === "object"
            ? normalizeHubRepo(parsed.selected as Partial<HubSkillRepo>)
            : null;
        const selectedKey = selected ? hubRepoKey(selected) : null;
        const hasSelected = selectedKey ? storedRepos.some((item) => hubRepoKey(item) === selectedKey) : false;
        const nextRepos = selected && !hasSelected ? [selected, ...storedRepos] : storedRepos;
        setHubRepos(nextRepos);
        setHubRepoSignal(selected && nextRepos.length ? selected : nextRepos[0] ?? null);
      }
    } catch {
      // ignore
    }
  }

  async function refreshHubSkills(optionsOverride?: { force?: boolean }) {
    const root = options.activeWorkspaceRoot().trim();
    const loadKey = `${root}::offline-catalog`;

    if (loadKey !== hubSkillsLoadKey) {
      hubSkillsLoaded = false;
    }

    if (!optionsOverride?.force && hubSkillsLoaded) {
      return;
    }
    if (refreshHubSkillsInFlight) {
      return;
    }

    // Try to load from cache first
    if (!optionsOverride?.force) {
      const cached = loadHubSkillsFromCache();
      if (cached && cached.length > 0) {
        setHubSkills(cached);
        hubSkillsLoaded = true;
        hubSkillsLoadKey = loadKey;
        return;
      }
    }


    refreshHubSkillsInFlight = true;
    refreshHubSkillsAborted = false;

    const loadOfflineHubSkills = (): HubSkillCard[] => {
      const next: HubSkillCard[] = [];
      for (const entry of OFFLINE_BUNDLED_SKILLS) {
        next.push({
          name: entry.name,
          description: entry.description,
          source: {
            owner: OFFLINE_HUB_OWNER,
            repo: OFFLINE_HUB_REPO,
            ref: OFFLINE_HUB_REF,
            path: `offline/${entry.id}`,
          },
        });
      }
      return next;
    };

    try {
      setHubSkillsStatus(null);

      const offlineSkills = loadOfflineHubSkills();
      if (refreshHubSkillsAborted) return;
      const filteredSkills = applyHubDuplicateRules(offlineSkills);
      const sorted = filteredSkills.slice().sort((a, b) => a.name.localeCompare(b.name));
      setHubSkills(sorted);
      persistHubSkills(); // Save to cache
      if (!sorted.length) {
        setHubSkillsStatus(translate("skills.hub_no_skills_found"));
      }
      hubSkillsLoaded = true;
      hubSkillsLoadKey = loadKey;
    } catch (e) {
      if (refreshHubSkillsAborted) return;
      setHubSkills([]);
      setHubSkillsStatus(
        e instanceof Error ? localizeSkillErrorMessage(e.message) : translate("skills.hub_failed_to_load"),
      );
    } finally {
      refreshHubSkillsInFlight = false;
    }
  }

  async function installHubSkill(skill: HubSkillCard): Promise<{ ok: boolean; message: string }> {
    const trimmed = skill.name.trim();
    if (!trimmed) return { ok: false, message: translate("skills.validation_name_required_short") };
    const source = skill.source;
    if (!source) {
      return { ok: false, message: translate("skills.source_missing") };
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkSkillWrite =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write &&
      typeof openworkClient.upsertSkill === "function" &&
      typeof openworkClient.writeWorkspaceFile === "function";

    const isOfflineLocalSource =
      source.owner === OFFLINE_HUB_OWNER &&
      source.repo === OFFLINE_HUB_REPO &&
      source.ref === OFFLINE_HUB_REF;

    if (isOfflineLocalSource) {
      const prefix = "offline/";
      const offlineId = source.path.startsWith(prefix) ? source.path.slice(prefix.length) : "";
      const entry = OFFLINE_BUNDLED_SKILLS.find((item) => item.id === offlineId);
      if (!entry) {
        return { ok: false, message: translate("skills.offline_skill_not_found") };
      }

      try {
        const validated = { name: entry.name, description: entry.description };

        if (canUseOpenworkSkillWrite) {
          for (const file of entry.files) {
            await openworkClient.writeWorkspaceFile(openworkWorkspaceId, {
              path: `.opencode/skills/${validated.name}/${file.relativePath}`,
              content: file.content,
              force: false,
            });
          }
          await openworkClient.upsertSkill(openworkWorkspaceId, {
            name: validated.name,
            content: entry.template,
            description: validated.description,
          });
        } else if (isRemoteWorkspace) {
          if (!canUseOpenworkSkillWrite) {
            return { ok: false, message: translate("skills.openwork_unavailable_install") };
          }
        } else {
          if (!isTauriRuntime()) {
            return { ok: false, message: translate("skills.desktop_required") };
          }
          const targetDir = options.projectDir().trim();
          if (!targetDir) {
            return { ok: false, message: translate("skills.pick_project_first") };
          }
          const result = await installSkillTemplate(targetDir, validated.name, entry.template, { overwrite: false });
          if (!result.ok) {
            const reason = result.stderr || result.stdout || translate("skills.install_failed");
            return { ok: false, message: reason };
          }
          if (entry.files.length > 0) {
            setSkillsStatus(
              translate("skills.installed_partial_openwork")
                .replace("{name}", validated.name)
                .replace("{count}", String(entry.files.length)),
              "success",
            );
          }
        }

        await refreshSkills({ force: true });
        await refreshHubSkills({ force: true });
        options.onCommandsChanged?.();
        const message = translate("skills.installed_named").replace("{name}", validated.name);
        setSkillsStatus(message, "success");
        return { ok: true, message };
      } catch (e) {
        const message = e instanceof Error ? localizeSkillErrorMessage(e.message) : translate("skills.unknown_error");
        return { ok: false, message };
      }
    }

    return { ok: false, message: translate("skills.online_hub_disabled") };
  }

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(pluginList(), pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    loadPluginsFromConfigHelpers(config, setPluginList, (message) => setPluginStatus(message));
  };

  const refreshSkills = createQueuedForcedRefresh(loadSkills);

  async function loadSkills(optionsOverride?: { force?: boolean }) {
    const root = options.activeWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.read;

    if (!root) {
      setSkills([]);
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    // Prefer OpenWork server when available
    if (canUseOpenworkServer) {
      if (root !== skillsRoot) {
        skillsLoaded = false;
      }

      if (!optionsOverride?.force && skillsLoaded) {
        return;
      }

      if (refreshSkillsInFlight) {
        return;
      }

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;

      try {
        setSkillsStatus(null);
        const response = await openworkClient.listSkills(openworkWorkspaceId, {
          includeGlobal: isLocalWorkspace,
        });
        if (refreshSkillsAborted) return;
        const next: SkillCard[] = Array.isArray(response.items)
          ? response.items.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
            }))
          : [];
        setSkills(next);
        if (!next.length) {
          setSkillsStatus(translate("skills.no_skills_found"));
        }
        skillsLoaded = true;
        skillsRoot = root;
      } catch (e) {
        if (refreshSkillsAborted) return;
        setSkills([]);
        setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
      } finally {
        refreshSkillsInFlight = false;
      }

      return;
    }

    // Host/Tauri mode fallback: read directly from `.opencode/skills` or `.claude/skills`
    // so the UI still works even if the OpenCode engine is stopped or unreachable.
    if (isLocalWorkspace && isTauriRuntime()) {
      if (root !== skillsRoot) {
        skillsLoaded = false;
      }

      if (!optionsOverride?.force && skillsLoaded) {
        return;
      }

      if (refreshSkillsInFlight) {
        return;
      }

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;

      try {
        setSkillsStatus(null);
        const local = await listLocalSkills(root);
        if (refreshSkillsAborted) return;

        const next: SkillCard[] = Array.isArray(local)
          ? local.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
            }))
          : [];

        setSkills(next);
        if (!next.length) {
          setSkillsStatus(translate("skills.no_skills_found"));
        }
        skillsLoaded = true;
        skillsRoot = root;
      } catch (e) {
        if (refreshSkillsAborted) return;
        setSkills([]);
        setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
      } finally {
        refreshSkillsInFlight = false;
      }

      return;
    }

    const c = options.client();
    if (!c) {
      setSkills([]);
      setSkillsStatus(translate("skills.openwork_unavailable_load"));
      return;
    }

    if (root !== skillsRoot) {
      skillsLoaded = false;
    }

    if (!optionsOverride?.force && skillsLoaded) {
      return;
    }

    if (refreshSkillsInFlight) {
      return;
    }

    refreshSkillsInFlight = true;
    refreshSkillsAborted = false;

    try {
      setSkillsStatus(null);

      if (refreshSkillsAborted) return;

      const rawClient = c as unknown as { _client?: { get: (input: { url: string }) => Promise<any> } };
      if (!rawClient._client) {
        throw new Error(translate("skills.opencode_client_unavailable"));
      }

      const result = await rawClient._client.get({ url: "/skill" });
      if (result?.data === undefined) {
        const err = result?.error;
        const message =
          err instanceof Error ? err.message : typeof err === "string" ? err : translate("skills.failed_to_load");
        throw new Error(message);
      }
      const data = result.data as Array<{
        name: string;
        description: string;
        location: string;
      }>;

      if (refreshSkillsAborted) return;

      const next: SkillCard[] = Array.isArray(data)
        ? data.map((entry) => ({
            name: entry.name,
            description: entry.description,
            path: formatSkillPath(entry.location),
          }))
        : [];

      setSkills(next);
      if (!next.length) {
        setSkillsStatus(translate("skills.no_skills_found"));
      }
      skillsLoaded = true;
      skillsRoot = root;
    } catch (e) {
      if (refreshSkillsAborted) return;
      setSkills([]);
      setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
    } finally {
      refreshSkillsInFlight = false;
    }
  }

  async function refreshPlugins(scopeOverride?: PluginScope) {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.plugins?.read;

    // Skip if already in flight
    if (refreshPluginsInFlight) {
      return;
    }

    refreshPluginsInFlight = true;
    refreshPluginsAborted = false;

    const scope = scopeOverride ?? pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope !== "project" && !isLocalWorkspace) {
      setPluginStatus("Global plugins are only available for local workers.");
      setPluginList([]);
      setSidebarPluginStatus("Global plugins require a local worker.");
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && canUseOpenworkServer) {
      setPluginConfig(null);
      setPluginConfigPath(`opencode.json (${isRemoteWorkspace ? "remote" : "openwork"} server)`);

      try {
        setPluginStatus(null);
        setSidebarPluginStatus(null);

        if (refreshPluginsAborted) return;

        const result = await openworkClient.listPlugins(openworkWorkspaceId, { includeGlobal: false });
        if (refreshPluginsAborted) return;

        const configItems = result.items.filter((item) => item.source === "config" && item.scope === "project");
        const list = configItems.map((item) => item.spec);
        setPluginList(list);
        setSidebarPluginList(list);

        if (!list.length) {
          setPluginStatus("No plugins configured yet.");
        }
      } catch (e) {
        if (refreshPluginsAborted) return;
        setPluginList([]);
        setSidebarPluginStatus("Failed to load plugins.");
        setSidebarPluginList([]);
        setPluginStatus(e instanceof Error ? e.message : "Failed to load plugins.");
      } finally {
        refreshPluginsInFlight = false;
      }

      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      setPluginList([]);
      setSidebarPluginStatus(translate("skills.plugins_host_only"));
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    if (!isLocalWorkspace && !canUseOpenworkServer) {
      setPluginStatus("OpenWork server unavailable. Connect to manage plugins.");
      setPluginList([]);
      setSidebarPluginStatus("Connect an OpenWork server to load plugins.");
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && !targetDir) {
      setPluginStatus(translate("skills.pick_project_for_plugins"));
      setPluginList([]);
      setSidebarPluginStatus(translate("skills.pick_project_for_active"));
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    try {
      setPluginStatus(null);
      setSidebarPluginStatus(null);

      if (refreshPluginsAborted) return;

      const config = await readOpencodeConfig(scope, targetDir);

      if (refreshPluginsAborted) return;

      setPluginConfig(config);
      setPluginConfigPath(config.path ?? null);

      if (!config.exists) {
        setPluginList([]);
        setPluginStatus(translate("skills.no_opencode_found"));
        setSidebarPluginList([]);
        setSidebarPluginStatus(translate("skills.no_opencode_workspace"));
        return;
      }

      try {
        const next = parsePluginListFromContent(config.content ?? "");
        setSidebarPluginList(next);
      } catch {
        setSidebarPluginList([]);
        setSidebarPluginStatus(translate("skills.failed_parse_opencode"));
      }

      loadPluginsFromConfig(config);
    } catch (e) {
      if (refreshPluginsAborted) return;
      setPluginConfig(null);
      setPluginConfigPath(null);
      setPluginList([]);
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_load_opencode"));
      setSidebarPluginStatus(translate("skills.failed_load_active"));
      setSidebarPluginList([]);
    } finally {
      refreshPluginsInFlight = false;
    }
  }

  async function addPlugin(pluginNameOverride?: string) {
    const pluginName = (pluginNameOverride ?? pluginInput()).trim();
    const isManualInput = pluginNameOverride == null;
    const triggerName = stripPluginVersion(pluginName);

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.plugins?.write;

    if (!pluginName) {
      if (isManualInput) {
        setPluginStatus(translate("skills.enter_plugin_name"));
      }
      return;
    }

    if (pluginScope() !== "project" && !isLocalWorkspace) {
      setPluginStatus("Global plugins are only available for local workers.");
      return;
    }

    if (pluginScope() === "project" && canUseOpenworkServer) {
      try {
        setPluginStatus(null);
        await openworkClient.addPlugin(openworkWorkspaceId, pluginName);
        if (isManualInput) {
          setPluginInput("");
        }
        await refreshPlugins("project");
      } catch (e) {
        setPluginStatus(e instanceof Error ? e.message : "Failed to add plugin.");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseOpenworkServer) {
      setPluginStatus("OpenWork server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus(translate("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";

      if (!raw.trim()) {
        const payload = {
          $schema: "https://opencode.ai/config.json",
          plugin: [pluginName],
        };
        await writeOpencodeConfig(scope, targetDir, `${JSON.stringify(payload, null, 2)}\n`);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
        if (isManualInput) {
          setPluginInput("");
        }
        await refreshPlugins(scope);
        return;
      }

      const plugins = parsePluginListFromContent(raw);

      const desired = stripPluginVersion(pluginName).toLowerCase();
      if (plugins.some((entry) => stripPluginVersion(entry).toLowerCase() === desired)) {
        setPluginStatus(translate("skills.plugin_already_listed"));
        return;
      }

      const next = [...plugins, pluginName];
      const edits = modify(raw, ["plugin"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updated = applyEdits(raw, edits);

      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
      if (isManualInput) {
        setPluginInput("");
      }
      await refreshPlugins(scope);
    } catch (e) {
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_update_opencode"));
    }
  }

  async function removePlugin(pluginName: string) {
    const name = pluginName.trim();
    if (!name) return;
    const triggerName = stripPluginVersion(name);

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.plugins?.write;

    if (pluginScope() !== "project" && !isLocalWorkspace) {
      setPluginStatus("Global plugins are only available for local workers.");
      return;
    }

    if (pluginScope() === "project" && canUseOpenworkServer) {
      try {
        setPluginStatus(null);
        await openworkClient.removePlugin(openworkWorkspaceId, name);
        await refreshPlugins("project");
      } catch (e) {
        setPluginStatus(e instanceof Error ? e.message : "Failed to remove plugin.");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseOpenworkServer) {
      setPluginStatus("OpenWork server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus(translate("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";
      if (!raw.trim()) {
        setPluginStatus("No plugins configured yet.");
        return;
      }

      const plugins = parsePluginListFromContent(raw);
      const desired = stripPluginVersion(name).toLowerCase();
      const next = plugins.filter((entry) => stripPluginVersion(entry).toLowerCase() !== desired);
      if (next.length === plugins.length) {
        setPluginStatus("Plugin not found.");
        return;
      }

      const edits = modify(raw, ["plugin"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updated = applyEdits(raw, edits);
      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "removed" });
      await refreshPlugins(scope);
    } catch (e) {
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_update_opencode"));
    }
  }

  const decodeUtf8 = (bytes: number[]): string =>
    new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));

  const looksLikeSkillImportSuccess = (value: string | undefined): boolean => {
    const normalized = String(value ?? "").trim().toLowerCase();
    return normalized.startsWith("imported ") || normalized === translate("skills.imported").toLowerCase();
  };

  async function importLocalSkill(): Promise<{ ok: boolean; skillName?: string; message?: string; cancelled?: boolean }> {
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write;

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      options.setError(message);
      return { ok: false, message };
    }

    // Allow import if: local workspace OR (Tauri + remote with OpenWork server)
    if (!isLocalWorkspace && !canUseOpenworkServer) {
      const message = translate("skills.local_workers_required_import");
      options.setError(message);
      return { ok: false, message };
    }

    const targetDir = options.projectDir().trim();
    // For remote mode with OpenWork server, we don't need a local targetDir
    if (!targetDir && !canUseOpenworkServer) {
      const message = translate("skills.pick_project_first");
      options.setError(message);
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const selection = await pickDirectory({ title: translate("skills.select_skill_folder") });
      const sourceDir = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!sourceDir) {
        return { ok: false, cancelled: true };
      }

      const inferredName = sourceDir.split(/[\\/]/).filter(Boolean).pop() || "imported-skill";
      let resolvedName = inferredName;

      // Use OpenWork server for remote workspaces (Tauri + remote mode)
      if (canUseOpenworkServer && !isLocalWorkspace) {
        const packageImport = openworkCapabilities?.skills?.packageImport;
        if (packageImport?.version === 1) {
          const scan = await scanSkillFolder(sourceDir);
          const entries = Array.isArray(scan.entries) ? scan.entries : [];
          const sep = scan.root.includes("\\") ? "\\" : "/";
          const absOf = (rel: string) => scan.root + sep + rel.split("/").join(sep);

          if (scan.truncated) {
            const reason = "The selected skill folder contains too many files to scan safely.";
            setSkillsStatus(reason, "error");
            return { ok: false, message: reason };
          }

          const hasSkillMd = entries.some((entry) => entry.relativePath === "SKILL.md");
          if (!hasSkillMd) {
            const wrongCase = entries.some((entry) => entry.relativePath.toLowerCase() === "skill.md");
            const reason = wrongCase
              ? translate("skills.select_exact_skill_md")
              : translate("skills.selected_folder_not_skill");
            setSkillsStatus(reason, "error");
            return { ok: false, message: reason };
          }

          const filtered: Array<{ path: string; reason: "unsupported_type" | "ignored_directory" }> = [
            ...scan.skippedDirs.map((path) => ({ path: `${path}/`, reason: "ignored_directory" as const })),
          ];
          const included = entries.filter((entry) => {
            if (isSupportedSkillPackageFile(entry.relativePath)) return true;
            filtered.push({ path: entry.relativePath, reason: "unsupported_type" });
            return false;
          });
          const oversized = included.find((entry) => entry.size > packageImport.maxFileBytes);
          if (oversized) {
            const reason = `${oversized.relativePath} exceeds the 64 MiB skill file limit.`;
            setSkillsStatus(reason, "error");
            return { ok: false, message: reason };
          }
          if (included.length > packageImport.maxFiles) {
            const reason = `The skill folder exceeds the ${packageImport.maxFiles.toLocaleString()} file limit.`;
            setSkillsStatus(reason, "error");
            return { ok: false, message: reason };
          }
          const includedBytes = included.reduce((total, entry) => total + entry.size, 0);
          if (includedBytes > packageImport.maxTotalBytes) {
            const reason = "The supported files in this skill folder exceed the 256 MiB package limit.";
            setSkillsStatus(reason, "error");
            return { ok: false, message: reason };
          }

          const skillMdContent = decodeUtf8(await readLocalFileBytes(absOf("SKILL.md")));
          let validated: { name: string; description: string };
          try {
            validated = validateSkillMarkdown(skillMdContent, { expectedName: inferredName });
          } catch (validationError) {
            const reason = validationError instanceof Error
              ? localizeSkillErrorMessage(validationError.message)
              : translate("skills.create_invalid_markdown");
            setSkillsStatus(reason, "error");
            return { ok: false, message: reason };
          }
          resolvedName = validated.name;

          const manifest = included.map((entry, index) => ({
            id: `file-${index}`,
            path: entry.relativePath,
            size: entry.size,
          }));
          const created = await openworkClient.createSkillPackageImport(openworkWorkspaceId, {
            name: resolvedName,
            files: manifest,
            filtered,
          });
          let commitAction: "added" | "updated" = "added";
          try {
            for (const file of manifest) {
              let offset = 0;
              while (offset < file.size) {
                const length = Math.min(packageImport.chunkBytes, file.size - offset);
                const chunk = new Uint8Array(await readLocalFileChunk(absOf(file.path), offset, length));
                if (chunk.byteLength !== length) {
                  throw new Error(`Unable to read the complete file chunk: ${file.path}`);
                }
                await openworkClient.uploadSkillPackageChunk(
                  openworkWorkspaceId,
                  created.importId,
                  file.id,
                  offset,
                  chunk,
                );
                offset += chunk.byteLength;
              }
            }
            const committed = await openworkClient.commitSkillPackageImport(openworkWorkspaceId, created.importId);
            commitAction = committed.action;
            const filteredPreview = committed.filtered.slice(0, 3).map((file) => file.path).join(", ");
            const remainingFiltered = Math.max(0, committed.filtered.length - 3);
            const suffix = committed.filtered.length > 0
              ? ` (${committed.filtered.length} unsupported item(s) filtered: ${filteredPreview}${remainingFiltered ? `, +${remainingFiltered} more` : ""})`
              : "";
            setSkillsStatus(translate("skills.imported") + suffix, "success");
          } catch (error) {
            await openworkClient.abortSkillPackageImport(openworkWorkspaceId, created.importId).catch(() => undefined);
            throw error;
          }
          options.markReloadRequired?.("skills", {
            type: "skill",
            name: resolvedName,
            action: commitAction,
          });
        } else {
        // Scan the whole folder so scripts/docs/config come along, not just SKILL.md.
        const scan = await scanLocalFolder(sourceDir);
        const entries = Array.isArray(scan.entries) ? scan.entries : [];
        const sep = scan.root.includes("\\") ? "\\" : "/";
        const absOf = (rel: string) => scan.root + sep + rel.split("/").join(sep);

        // SKILL.md must exist at the folder root with the EXACT uppercase name.
        const hasSkillMd = entries.some((e) => e.relativePath === "SKILL.md");
        if (!hasSkillMd) {
          const wrongCase = entries.some((e) => e.relativePath.toLowerCase() === "skill.md");
          const reason = wrongCase
            ? translate("skills.select_exact_skill_md")
            : translate("skills.selected_folder_not_skill");
          setSkillsStatus(reason, "error");
          return { ok: false, message: reason };
        }

        // Read + validate SKILL.md. The skill name must equal the folder name.
        const skillMdContent = decodeUtf8(await readLocalFileBytes(absOf("SKILL.md")));
        let validated: { name: string; description: string };
        try {
          validated = validateSkillMarkdown(skillMdContent, { expectedName: inferredName });
        } catch (ve) {
          const reason = ve instanceof Error ? localizeSkillErrorMessage(ve.message) : translate("skills.create_invalid_markdown");
          setSkillsStatus(reason, "error");
          return { ok: false, message: reason };
        }
        resolvedName = validated.name;

        // Upload every text file (skip binaries) under .opencode/skills/<name>/.
        let skipped = 0;
        for (const entry of entries) {
          if (entry.relativePath === "SKILL.md") continue; // handled via upsertSkill below
          if (!isSupportedSkillPackageFile(entry.relativePath)) {
            skipped += 1;
            continue;
          }
          try {
            const bytes = await readLocalFileBytes(absOf(entry.relativePath));
            await openworkClient.writeWorkspaceFile(openworkWorkspaceId, {
              path: `.opencode/skills/${resolvedName}/${entry.relativePath}`,
              content: decodeUtf8(bytes),
              force: false,
            });
          } catch {
            skipped += 1;
          }
        }

        // Write SKILL.md last via upsertSkill (backend validation + engine reload).
        await openworkClient.upsertSkill(openworkWorkspaceId, {
          name: resolvedName,
          content: skillMdContent,
          description: validated.description,
        });

        setSkillsStatus(
          translate("skills.imported") + (skipped > 0 ? ` (${skipped} non-text file(s) skipped)` : ""),
          "success",
        );
        options.markReloadRequired?.("skills", {
          type: "skill",
          name: resolvedName,
          action: "added",
        });
        }
      } else {
        // Local workspace: existing local import copies the whole folder.
        const result = await importSkill(targetDir, sourceDir, { overwrite: false });
        if (!result.ok && !looksLikeSkillImportSuccess(result.stdout)) {
          const reason = result.stderr || result.stdout || translate("skills.import_failed").replace("{status}", String(result.status));
          setSkillsStatus(reason, "error");
          return { ok: false, message: reason };
        } else {
          setSkillsStatus(result.stdout || translate("skills.imported"), "success");
          options.markReloadRequired?.("skills", {
            type: "skill",
            name: resolvedName,
            action: "added",
          });
        }
      }

      await refreshSkills({ force: true });
      // Notify that commands may have changed so the slash command picker can refresh
      options.onCommandsChanged?.();
      return { ok: true, skillName: resolvedName };
    } catch (e) {
      const message = e instanceof Error ? localizeSkillErrorMessage(e.message) : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  // Import a single SKILL.md file (no other files). The picked file MUST be
  // named exactly "SKILL.md"; otherwise it is rejected.
  async function importSkillFile(): Promise<{ ok: boolean; skillName?: string; message?: string; cancelled?: boolean }> {
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write;

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      options.setError(message);
      return { ok: false, message };
    }
    if (!isLocalWorkspace && !canUseOpenworkServer) {
      const message = translate("skills.local_workers_required_import");
      options.setError(message);
      return { ok: false, message };
    }

    const targetDir = options.projectDir().trim();
    if (!targetDir && !canUseOpenworkServer) {
      const message = translate("skills.pick_project_first");
      options.setError(message);
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const selection = await pickFile({
        title: "Select a SKILL.md file",
        filters: [{ name: "SKILL.md", extensions: ["md"] }],
      });
      const filePath = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!filePath) {
        return { ok: false, cancelled: true };
      }

      // The file must be named exactly "SKILL.md" (uppercase).
      const baseName = filePath.split(/[\\/]/).filter(Boolean).pop() ?? "";
      if (baseName !== "SKILL.md") {
        const reason = translate("skills.select_exact_skill_md");
        setSkillsStatus(reason, "error");
        return { ok: false, message: reason };
      }

      const parentSepIndex = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
      const parentDir = parentSepIndex > 0 ? filePath.slice(0, parentSepIndex) : "";
      if (!parentDir) {
        const reason = translate("skills.selected_file_parent_unresolved");
        setSkillsStatus(reason, "error");
        return { ok: false, message: reason };
      }

      const scan = await scanLocalFolder(parentDir);
      const scannedEntries = Array.isArray(scan.entries) ? scan.entries : [];
      const scannedSkillMd = scannedEntries.some((entry) => entry.relativePath === "SKILL.md");
      if (!scannedSkillMd) {
        const reason = scan.truncated
          ? translate("skills.selected_skill_md_excluded_by_scan")
          : translate("skills.selected_skill_md_not_in_scan");
        setSkillsStatus(reason, "error");
        return { ok: false, message: reason };
      }

      const content = decodeUtf8(await readLocalFileBytes(filePath));
      let validated: { name: string; description: string };
      try {
        // Single-file import has no folder to match against; take name from frontmatter.
        validated = validateSkillMarkdown(content);
      } catch (ve) {
        const reason = ve instanceof Error ? localizeSkillErrorMessage(ve.message) : translate("skills.create_invalid_markdown");
        setSkillsStatus(reason, "error");
        return { ok: false, message: reason };
      }

      if (canUseOpenworkServer && !isLocalWorkspace) {
        await openworkClient.upsertSkill(openworkWorkspaceId, {
          name: validated.name,
          content,
          description: validated.description,
        });
        setSkillsStatus(translate("skills.imported"), "success");
        options.markReloadRequired?.("skills", {
          type: "skill",
          name: validated.name,
          action: "added",
        });
      } else {
        // Local workspace: create <workspace>/.opencode/skills/<name>/SKILL.md.
        // `writeLocalSkill` only updates an existing skill, so single-file import
        // must use the installer path that creates the directory on first import.
        const result = await installSkillTemplate(targetDir, validated.name, content, { overwrite: false });
        if (!result.ok && !looksLikeSkillImportSuccess(result.stdout)) {
          const reason = result.stderr || result.stdout || translate("skills.import_failed").replace("{status}", String(result.status));
          setSkillsStatus(reason, "error");
          return { ok: false, message: reason };
        }
        setSkillsStatus(result.stdout || translate("skills.imported"), "success");
        options.markReloadRequired?.("skills", {
          type: "skill",
          name: validated.name,
          action: "added",
        });
      }

      await refreshSkills({ force: true });
      options.onCommandsChanged?.();
      return { ok: true, skillName: validated.name };
    } catch (e) {
      const message = e instanceof Error
        ? localizeSkillErrorMessage(e.message)
        : safeStringify(e) || translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }


  async function installBundledSkill(opts: {
    name: string;
    template: string;
    installingMessage: string;
    installedMessage: string;
    alreadyInstalledMessage: string;
  }): Promise<{ ok: boolean; message: string }> {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write;

    // Use OpenWork server when available
    if (canUseOpenworkServer) {
      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(opts.installingMessage);

      try {
        await openworkClient.upsertSkill(openworkWorkspaceId, {
          name: opts.name,
          content: opts.template,
        });
        const message = opts.installedMessage;
        setSkillsStatus(message, "success");
        options.markReloadRequired?.("skills", { type: "skill", name: opts.name, action: "added" });
        await refreshSkills({ force: true });
        // Notify that commands may have changed so the slash command picker can refresh
        options.onCommandsChanged?.();
        return { ok: true, message };
      } catch (e) {
        const raw = e instanceof Error ? e.message : translate("skills.unknown_error");
        const message = addOpencodeCacheHint(raw);
        // Ensure we show feedback on the Skills page (not just the global error banner).
        setSkillsStatus(message, "error");
        options.setError(message);
        return { ok: false, message };
      } finally {
        options.setBusy(false);
      }
    }

    // Remote workspace without server
    if (isRemoteWorkspace) {
      const message = translate("skills.openwork_unavailable_install");
      setSkillsStatus(message, "error");
      return { ok: false, message };
    }

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setSkillsStatus(message, "error");
      return { ok: false, message };
    }

    if (!isLocalWorkspace) {
      const message = translate("skills.local_workers_required_install");
      options.setError(message);
      setSkillsStatus(message, "error");
      return { ok: false, message };
    }

    const targetDir = options.activeWorkspaceRoot().trim();
    if (!targetDir) {
      const message = translate("skills.pick_workspace_first");
      setSkillsStatus(message, "error");
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(opts.installingMessage);

    try {
      const result = await installSkillTemplate(targetDir, opts.name, opts.template, { overwrite: false });

      if (!result.ok && /already exists/i.test(result.stderr)) {
        const message = opts.alreadyInstalledMessage;
        setSkillsStatus(message, "success");
        await refreshSkills({ force: true });
        return { ok: true, message };
      } else if (!result.ok) {
        const message = result.stderr || result.stdout || translate("skills.install_failed");
        setSkillsStatus(message, "error");
        await refreshSkills({ force: true });
        return { ok: false, message };
      } else {
        const message = result.stdout || opts.installedMessage;
        setSkillsStatus(message, "success");
        options.markReloadRequired?.("skills", { type: "skill", name: opts.name, action: "added" });
        await refreshSkills({ force: true });
        // Notify that commands may have changed so the slash command picker can refresh
        options.onCommandsChanged?.();
        return { ok: true, message };
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : translate("skills.unknown_error");
      const message = addOpencodeCacheHint(raw);
      setSkillsStatus(message, "error");
      options.setError(message);
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function installSkillCreator(): Promise<{ ok: boolean; message: string }> {
    return installBundledSkill({
      name: "skill-creator",
      template: skillCreatorTemplate,
      installingMessage: translate("skills.installing_skill_creator"),
      installedMessage: translate("skills.skill_creator_installed"),
      alreadyInstalledMessage: translate("skills.skill_creator_already_installed"),
    });
  }

  async function installSkillFinder(): Promise<{ ok: boolean; message: string }> {
    return installBundledSkill({
      name: "skill-finder",
      template: skillFinderTemplate,
      installingMessage: translate("skills.installing_skill_finder"),
      installedMessage: translate("skills.skill_finder_installed"),
      alreadyInstalledMessage: translate("skills.skill_finder_already_installed"),
    });
  }

  async function revealSkillsFolder() {
    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return;
    }

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      const opencodeSkills = await join(root, ".opencode", "skills");
      const claudeSkills = await join(root, ".claude", "skills");
      const legacySkills = await join(root, ".opencode", "skill");

      const tryOpen = async (target: string) => {
        try {
          await openPath(target);
          return true;
        } catch {
          return false;
        }
      };

      // Prefer opening the folder. `revealItemInDir` expects a file path on macOS.
      if (await tryOpen(opencodeSkills)) return;
      if (await tryOpen(claudeSkills)) return;
      if (await tryOpen(legacySkills)) return;
      await revealItemInDir(opencodeSkills);
    } catch (e) {
      setSkillsStatus(e instanceof Error ? e.message : translate("skills.reveal_failed"));
    }
  }

  async function uninstallSkill(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;

    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write;

    // For remote workspaces, use the OpenWork server API
    if (!isLocalWorkspace) {
      if (!canUseOpenworkServer) {
        options.setError(translate("skills.openwork_write_required_uninstall"));
        return;
      }

      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(null);

      try {
        await openworkClient.deleteSkill(openworkWorkspaceId, trimmed);
        setSkillsStatus(translate("skills.uninstalled"));
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "removed" });
        await refreshSkills({ force: true });
        // Notify that commands may have changed so the slash command picker can refresh
        options.onCommandsChanged?.();
      } catch (e) {
        const message = e instanceof Error ? e.message : translate("skills.unknown_error");
        options.setError(message);
      } finally {
        options.setBusy(false);
      }
      return;
    }

    // Local workspace: use Tauri CLI command
    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return;
    }

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const result = await uninstallSkillCommand(root, trimmed);
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || translate("skills.uninstall_failed"));
      } else {
        setSkillsStatus(result.stdout || translate("skills.uninstalled"));
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "removed" });
      }

      await refreshSkills({ force: true });
      // Notify that commands may have changed so the slash command picker can refresh
      options.onCommandsChanged?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function readSkill(name: string): Promise<{ name: string; path: string; content: string } | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return null;
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.read &&
      typeof (openworkClient as any).getSkill === "function";

    if (canUseOpenworkServer) {
      try {
        setSkillsStatus(null);
        const result = await (openworkClient as OpenworkServerClient & { getSkill: any }).getSkill(
          openworkWorkspaceId,
          trimmed,
          { includeGlobal: isLocalWorkspace },
        );
        return {
          name: result.item.name,
          path: result.item.path,
          content: result.content,
        };
      } catch (e) {
        setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
        return null;
      }
    }

    if (isRemoteWorkspace) {
      setSkillsStatus(translate("skills.openwork_unavailable_view"));
      return null;
    }

    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return null;
    }

    if (!isLocalWorkspace) {
      setSkillsStatus(translate("skills.local_workers_required_view"));
      return null;
    }

    try {
      setSkillsStatus(null);
      const result = await readLocalSkill(root, trimmed);
      return { name: trimmed, path: result.path, content: result.content };
    } catch (e) {
      setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
      return null;
    }
  }

  async function saveSkill(input: { name: string; content: string; description?: string }): Promise<{ ok: boolean; message: string }> {
    const trimmed = input.name.trim();
    if (!trimmed) return { ok: false, message: translate("skills.validation_name_required_short") };

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      const message = translate("skills.pick_workspace_first");
      setSkillsStatus(message, "error");
      return { ok: false, message };
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write;

    if (canUseOpenworkServer && isRemoteWorkspace) {
      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(null);
      try {
        await openworkClient.upsertSkill(openworkWorkspaceId, {
          name: trimmed,
          content: input.content,
          description: input.description,
        });
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
        await refreshSkills({ force: true });
        const message = translate("skills.saved");
        setSkillsStatus(message, "success");
        options.onCommandsChanged?.();
        return { ok: true, message };
      } catch (e) {
        const message = e instanceof Error ? e.message : translate("skills.unknown_error");
        const normalized = addOpencodeCacheHint(message);
        setSkillsStatus(normalized, "error");
        options.setError(normalized);
        return { ok: false, message: normalized };
      } finally {
        options.setBusy(false);
      }
    }

    if (isRemoteWorkspace) {
      const message = translate("skills.openwork_unavailable_edit");
      setSkillsStatus(message, "error");
      return { ok: false, message };
    }

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setSkillsStatus(message, "error");
      return { ok: false, message };
    }

    if (!isLocalWorkspace) {
      const message = translate("skills.local_workers_required_edit");
      setSkillsStatus(message, "error");
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);
    try {
      let outcome: { ok: boolean; message: string } | null = null;
      const writeResult = await writeLocalSkill(root, trimmed, input.content);
      if (!writeResult.ok) {
        if ((writeResult.stderr || "").toLowerCase().includes("skill not found")) {
          const createResult = await installSkillTemplate(root, trimmed, input.content, { overwrite: false });
          if (!createResult.ok) {
            const message = createResult.stderr || createResult.stdout || translate("skills.unknown_error");
            setSkillsStatus(message, "error");
            outcome = { ok: false, message };
          } else {
            const message = createResult.stdout || translate("skills.saved");
            setSkillsStatus(message, "success");
            options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "added" });
            options.onCommandsChanged?.();
            outcome = { ok: true, message };
          }
        } else {
          const message = writeResult.stderr || writeResult.stdout || translate("skills.unknown_error");
          setSkillsStatus(message, "error");
          outcome = { ok: false, message };
        }
      } else {
        const message = writeResult.stdout || translate("skills.saved");
        setSkillsStatus(message, "success");
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
        options.onCommandsChanged?.();
        outcome = { ok: true, message };
      }
      await refreshSkills({ force: true });
      return outcome ?? { ok: false, message: translate("skills.unknown_error") };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      const normalized = addOpencodeCacheHint(message);
      setSkillsStatus(normalized, "error");
      options.setError(normalized);
      return { ok: false, message: normalized };
    } finally {
      options.setBusy(false);
    }
  }

  function abortRefreshes() {
    refreshSkillsAborted = true;
    refreshPluginsAborted = true;
    refreshHubSkillsAborted = true;
  }

  return {
    skills,
    skillsStatus,
    skillsStatusTone,
    hubSkills,
    hubSkillsStatus,
    hubRepo,
    hubRepos,
    pluginScope,
    setPluginScope,
    pluginConfig,
    pluginConfigPath,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    sidebarPluginList,
    sidebarPluginStatus,
    isPluginInstalledByName,
    refreshSkills,
    refreshHubSkills,
    setHubRepo,
    addHubRepo,
    removeHubRepo,
    refreshPlugins,
    addPlugin,
    removePlugin,
    importLocalSkill,
    importSkillFile,
    installSkillCreator,
    installSkillFinder,
    installHubSkill,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    abortRefreshes,
  };
}
