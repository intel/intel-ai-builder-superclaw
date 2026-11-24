import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type { HubSkillCard, HubSkillRepo, SkillCard } from "../types";

import Button from "../components/button";
import FilePreviewModal from "../components/file-preview-modal";
import { CheckCircle2, Compass, Edit2, Info, Link2, Loader2, Package, Plus, RefreshCw, Search, Sparkles, Trash2, Upload, WandSparkles, X, XCircle } from "lucide-solid";
import { t } from "../../i18n";
import { validateSkillMarkdown } from "~/shared/util/skill-markdown";
import type { NoticeTone, SkillBundleV1, SkillsNotice, SkillsViewProps } from "./skills.types";
import { shouldResetCreateSkillForm } from "./skills.create-form";
import { frontmatterFileForPreview } from "~/shared/util/frontmatter-preview";
import { splitSkillContentForEditor, validateEditableFrontmatter } from "./skills.skill-markdown";

// Re-exported from the extracted helpers so this module's public surface is unchanged.
export type { SkillsViewProps } from "./skills.types";

export default function SkillsView(props: SkillsViewProps) {
  // Translation helper that uses current language from i18n

  const skillCreatorInstalled = createMemo(() =>
    props.skills.some((skill) => skill.name === "skill-creator")
  );

  const skillFinderInstalled = createMemo(() =>
    props.skills.some((skill) => skill.name === "skill-finder")
  );


  const [uninstallTarget, setUninstallTarget] = createSignal<SkillCard | null>(null);
  const uninstallOpen = createMemo(() => uninstallTarget() != null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [customRepoOpen, setCustomRepoOpen] = createSignal(false);
  const [customRepoOwner, setCustomRepoOwner] = createSignal("");
  const [customRepoName, setCustomRepoName] = createSignal("");
  const [customRepoRef, setCustomRepoRef] = createSignal("main");
  const [customRepoError, setCustomRepoError] = createSignal<string | null>(null);

  const [installLinkOpen, setInstallLinkOpen] = createSignal(false);
  const [installLinkUrl, setInstallLinkUrl] = createSignal("");
  const [installLinkBusy, setInstallLinkBusy] = createSignal(false);
  const [installLinkError, setInstallLinkError] = createSignal<string | null>(null);
  const [installLinkBundle, setInstallLinkBundle] = createSignal<SkillBundleV1 | null>(null);
  const [newSkillMenuOpen, setNewSkillMenuOpen] = createSignal(false);

  const [selectedSkill, setSelectedSkill] = createSignal<SkillCard | null>(null);
  const [selectedMode, setSelectedMode] = createSignal<"preview" | "edit">("edit");
  const [selectedPreview, setSelectedPreview] = createSignal("");
  const [selectedHubSkill, setSelectedHubSkill] = createSignal<HubSkillCard | null>(null);
  const [selectedYamlContent, setSelectedYamlContent] = createSignal("");
  const [selectedBodyContent, setSelectedBodyContent] = createSignal("");
  const [selectedInitialYamlContent, setSelectedInitialYamlContent] = createSignal("");
  const [selectedInitialBodyContent, setSelectedInitialBodyContent] = createSignal("");
  const [selectedLoading, setSelectedLoading] = createSignal(false);
  const [selectedError, setSelectedError] = createSignal<string | null>(null);
  const selectedDirty = createMemo(
    () =>
      selectedYamlContent() !== selectedInitialYamlContent() ||
      selectedBodyContent() !== selectedInitialBodyContent(),
  );

  const [notice, setNotice] = createSignal<SkillsNotice | null>(null);
  const [dismissedSkillsStatus, setDismissedSkillsStatus] = createSignal<string | null>(null);
  const [installingSkillCreator, setInstallingSkillCreator] = createSignal(false);
  const [installingSkillFinder, setInstallingSkillFinder] = createSignal(false);
  // Names of hub skills currently being installed. A Set (rather than a single
  // value) lets the user install several skills at once without blocking.
  const [hubInstalling, setHubInstalling] = createSignal<Set<string>>(new Set());
  const isHubInstalling = (name: string) => hubInstalling().has(name);
  const [hubSkillsLoading, setHubSkillsLoading] = createSignal(false);
  const [createSkillName, setCreateSkillName] = createSignal("");
  const [createSkillYaml, setCreateSkillYaml] = createSignal("name: my-skill\ndescription: What this skill does");
  const [createSkillBody, setCreateSkillBody] = createSignal("# My Skill\n\nAdd usage instructions here.");
  const [createSkillBusy, setCreateSkillBusy] = createSignal(false);
  const [createSkillStatus, setCreateSkillStatus] = createSignal<string | null>(null);
  const [createSkillError, setCreateSkillError] = createSignal<string | null>(null);

  const runHubRefresh = async (options?: { force?: boolean }) => {
    if (hubSkillsLoading()) return;
    setHubSkillsLoading(true);
    try {
      await Promise.resolve(props.refreshHubSkills(options));
    } finally {
      setHubSkillsLoading(false);
    }
  };

  onMount(() => {
    // Fire and forget - completely asynchronous, no awaiting.
    // Defer hub skills loading so it never blocks the initial paint.
    const doLoad = () => {
      void runHubRefresh({ force: true });
    };
    if (typeof requestIdleCallback !== "undefined") {
      const idleId = requestIdleCallback(doLoad);
      onCleanup(() => cancelIdleCallback(idleId));
    } else {
      const timeoutId = window.setTimeout(doLoad, 500);
      onCleanup(() => window.clearTimeout(timeoutId));
    }
  });

  const pushNotice = (message: string | null, tone: NoticeTone = "info") => {
    if (!message) {
      setNotice(null);
      return;
    }
    setNotice({ message, tone });
  };

  createEffect(() => {
    const message = props.skillsStatus;
    if (!message) {
      setDismissedSkillsStatus(null);
    }
  });

  const visibleStatus = createMemo<SkillsNotice | null>(() => {
    const currentNotice = notice();
    if (currentNotice) return currentNotice;
    const message = props.skillsStatus;
    if (!message) return null;
    if (dismissedSkillsStatus() === message) return null;
    return { message, tone: props.skillsStatusTone };
  });

  const dismissVisibleStatus = () => {
    const hadNotice = !!notice();
    setNotice(null);
    if (hadNotice) return;

    const fallbackMessage = props.skillsStatus;
    if (fallbackMessage) {
      setDismissedSkillsStatus(fallbackMessage);
    }
  };

  const localizeSkillErrorMessage = (message: string) => {
    if (message === "Something went wrong") {
      return t("skills.error_generic");
    }
    if (message === "Only GitHub links to SKILL.md are supported") {
      return t("skills.github_skill_md_only");
    }
    if (message === "This link is not an OpenWork skill bundle") {
      return t("skills.link_not_openwork_bundle");
    }
    if (message === "Bundle is missing a skill name") {
      return t("skills.bundle_missing_name");
    }
    if (message === "Bundle is missing skill content") {
      return t("skills.bundle_missing_content");
    }
    if (message === "Invalid SKILL.md format. Add a frontmatter block between '---' lines.") {
      return t("skills.validation_invalid_format");
    }
    {
      const yamlAt = message.match(/^Skill YAML format is invalid at line (\d+), col (\d+)\. Please check the Frontmatter YAML\.$/);
      if (yamlAt) {
        return t("skills.validation_yaml_invalid_at")
          .replace("{line}", yamlAt[1] ?? "")
          .replace("{col}", yamlAt[2] ?? "");
      }
    }
    if (message === "Skill YAML format is invalid. Please check the Frontmatter YAML.") {
      return t("skills.validation_yaml_invalid");
    }
    if (message === "Frontmatter must be a YAML mapping (key/value object).") {
      return t("skills.validation_frontmatter_mapping");
    }
    if (message === "Frontmatter is missing required field: name.") {
      return t("skills.validation_name_required");
    }
    if (message === "Frontmatter is missing required field: description.") {
      return t("skills.validation_description_required");
    }
    if (message === "'description' must be 1-1024 characters.") {
      return t("skills.validation_description_length");
    }
    if (
      message ===
      "'name' must be kebab-case, 1-64 chars: lowercase letters/digits separated by single hyphens, no leading/trailing '-' and no '--'."
    ) {
      return t("skills.validation_name_kebab");
    }
    if (message === "'license' must be a string when provided.") {
      return t("skills.validation_license_string");
    }
    if (message === "'compatibility' must be a string when provided.") {
      return t("skills.validation_compatibility_string");
    }
    if (message === "'metadata' must be a mapping of string keys to string values.") {
      return t("skills.validation_metadata_mapping");
    }
    {
      const folderNameMismatch = message.match(/^Skill folder name '(.+)' must match the 'name' '(.+)' declared in SKILL\.md\.$/);
      if (folderNameMismatch) {
        return t("skills.validation_folder_name_match")
          .replace("{expected}", folderNameMismatch[1] ?? "")
          .replace("{actual}", folderNameMismatch[2] ?? "");
      }
    }
    {
      const skillMdFetch = message.match(/^Failed to fetch SKILL\.md \((\d+)\)(.*)$/);
      if (skillMdFetch) {
        return t("skills.fetch_skill_md_failed")
          .replace("{status}", skillMdFetch[1] ?? "")
          .replace("{detail}", skillMdFetch[2] ?? "");
      }
    }
    {
      const bundleFetch = message.match(/^Failed to fetch bundle \((\d+)\)(.*)$/);
      if (bundleFetch) {
        return t("skills.fetch_bundle_failed")
          .replace("{status}", bundleFetch[1] ?? "")
          .replace("{detail}", bundleFetch[2] ?? "");
      }
    }
    return message;
  };

  const maskError = (value: unknown) =>
    value instanceof Error ? localizeSkillErrorMessage(value.message) : t("skills.error_generic");

  const stripFrontmatter = (content: string) => {
    const raw = String(content ?? "");
    const match = raw.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
    if (!match) return raw;
    return raw.slice(match[0].length);
  };

  const resolveUniqueSkillName = (base: string, taken: Set<string>) => {
    const trimmed = String(base ?? "").trim();
    if (!trimmed) return "";
    if (!taken.has(trimmed)) return trimmed;
    for (let i = 2; i < 1_000; i++) {
      const candidate = `${trimmed}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${trimmed}-${Date.now()}`;
  };

  const hubRepoKey = (repo: HubSkillRepo) => `${repo.owner}/${repo.repo}@${repo.ref}`;
  const defaultHubRepoKey = "anthropics/skills@main";

  const activeHubRepoLabel = createMemo(() => (props.hubRepo ? hubRepoKey(props.hubRepo) : "No hub repo selected"));

  const hasDefaultHubRepo = createMemo(() => props.hubRepos.some((repo) => hubRepoKey(repo) === defaultHubRepoKey));

  const selectHubRepo = (repo: HubSkillRepo) => {
    props.setHubRepo(repo);
    void runHubRefresh({ force: true });
  };

  const openCustomRepoModal = () => {
    if (props.busy) return;
    setCustomRepoOpen(true);
    setCustomRepoOwner(props.hubRepo?.owner ?? "");
    setCustomRepoName(props.hubRepo?.repo ?? "");
    setCustomRepoRef(props.hubRepo?.ref || "main");
    setCustomRepoError(null);
  };

  const closeCustomRepoModal = () => {
    setCustomRepoOpen(false);
    setCustomRepoError(null);
  };

  const saveCustomRepo = () => {
    const owner = customRepoOwner().trim();
    const repo = customRepoName().trim();
    const ref = customRepoRef().trim() || "main";
    if (!owner || !repo) {
      setCustomRepoError(t("skills.custom_repo_owner_repo_required"));
      return;
    }
    props.addHubRepo({ owner, repo, ref });
    void runHubRefresh({ force: true });
    closeCustomRepoModal();
  };

  const filteredSkills = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) return props.skills;
    return props.skills.filter((skill) => {
      const description = skill.description ?? "";
      return (
        skill.name.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query)
      );
    });
  });

  const installedNames = createMemo(() => new Set(props.skills.map((skill) => skill.name)));

  const filteredHubSkills = createMemo(() => {
    const installed = installedNames();
    // Hide skills already installed in the workspace — they belong to the
    // "Installed skills" section, not the marketplace.
    const available = props.hubSkills.filter((skill) => !installed.has(skill.name));
    const query = searchQuery().trim().toLowerCase();
    if (!query) return available;
    return available.filter((skill) => {
      const description = skill.description ?? "";
      const trigger = skill.trigger ?? "";
      return (
        skill.name.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query) ||
        trigger.toLowerCase().includes(query)
      );
    });
  });

  // Progressive rendering for the marketplace: show HUB_PAGE_INITIAL cards, then
  // HUB_PAGE_STEP more each time the user scrolls to the bottom. Avoids rendering
  // thousands of cards at once when many repos/skills are configured.
  const HUB_PAGE_INITIAL = 30;
  const HUB_PAGE_STEP = 10;
  const [hubVisibleCount, setHubVisibleCount] = createSignal(HUB_PAGE_INITIAL);
  const [hubLoadingMore, setHubLoadingMore] = createSignal(false);

  const visibleHubSkills = createMemo(() => {
    const list = filteredHubSkills();
    // While searching, ignore the pagination limit so matches hidden below the
    // fold are still found and shown.
    if (searchQuery().trim()) return list;
    return list.slice(0, hubVisibleCount());
  });

  const canLoadMoreHub = createMemo(
    () => !searchQuery().trim() && hubVisibleCount() < filteredHubSkills().length,
  );

  let loadMoreTimer: number | undefined;
  const loadMoreHub = () => {
    if (!canLoadMoreHub() || hubLoadingMore()) return;
    setHubLoadingMore(true);
    // Small delay so the "Loading…" footer is visible and the scroll settles.
    loadMoreTimer = window.setTimeout(() => {
      loadMoreTimer = undefined;
      setHubVisibleCount((c) => c + HUB_PAGE_STEP);
      setHubLoadingMore(false);
    }, 150);
  };
  onCleanup(() => {
    if (loadMoreTimer !== undefined) window.clearTimeout(loadMoreTimer);
  });

  const onHubScroll = (e: Event & { currentTarget: HTMLElement }) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
      loadMoreHub();
    }
  };

  const installSkillCreator = async () => {
    if (props.busy || installingSkillCreator()) return;
    if (!props.canInstallSkillCreator) {
      pushNotice(props.accessHint ?? t("skills.host_only_error"), "error");
      return;
    }
    setInstallingSkillCreator(true);
    pushNotice(t("skills.installing_skill_creator"), "info");
    try {
      const result = await props.installSkillCreator();
      pushNotice(result.message, result.ok ? "success" : "error");
    } catch (e) {
      pushNotice(e instanceof Error ? e.message : t("skills.install_failed"), "error");
    } finally {
      setInstallingSkillCreator(false);
    }
  };

  const installSkillFinder = async () => {
    if (props.busy || installingSkillFinder()) return;
    if (!props.canInstallSkillCreator) {
      pushNotice(props.accessHint ?? t("skills.host_only_error"), "error");
      return;
    }
    setInstallingSkillFinder(true);
    pushNotice(t("skills.installing_skill_finder"), "info");
    try {
      const result = await props.installSkillFinder();
      pushNotice(result.message, result.ok ? "success" : "error");
    } catch (e) {
      pushNotice(e instanceof Error ? e.message : t("skills.install_failed"), "error");
    } finally {
      setInstallingSkillFinder(false);
    }
  };

  const installFromHub = async (skill: HubSkillCard) => {
    if (isHubInstalling(skill.name)) return;
    if (installedNames().has(skill.name)) {
      pushNotice(t("skills.name_already_installed"), "error");
      return;
    }
    setHubInstalling((prev) => {
      const next = new Set(prev);
      next.add(skill.name);
      return next;
    });
    pushNotice(`${t("skills.installing")} ${skill.name}`, "info");
    try {
      const result = await props.installHubSkill(skill);
      pushNotice(result.message, result.ok ? "success" : "error");
    } catch (e) {
      pushNotice(e instanceof Error ? e.message : t("skills.install_failed"), "error");
    } finally {
      setHubInstalling((prev) => {
        const next = new Set(prev);
        next.delete(skill.name);
        return next;
      });
    }
  };

  const importLocalSkillAction = async () => {
    const result = await props.importLocalSkill();
    if (result.cancelled) return;
    if (result.ok) {
      pushNotice(result.skillName
        ? t("skills.imported_named").replace("{name}", result.skillName)
        : t("skills.imported"), "success");
      return;
    }
    pushNotice(result.message ?? t("skills.unknown_error"), "error");
  };

  const importSkillFileAction = async () => {
    const result = await props.importSkillFile();
    if (result.cancelled) return;
    if (result.ok) {
      pushNotice(result.skillName
        ? t("skills.imported_named").replace("{name}", result.skillName)
        : t("skills.imported"), "success");
      return;
    }
    pushNotice(result.message ?? t("skills.unknown_error"), "error");
  };

  const pinnedInstallCards = createMemo(() => {
    const cards: Array<{
      id: "skill-finder" | "skill-creator";
      title: string;
      description: string;
      icon: any;
      onClick: () => void | Promise<void>;
      installing: boolean;
      disabled: boolean;
    }> = [];

    if (!skillFinderInstalled()) {
      cards.push({
        id: "skill-finder",
        title: "skill-finder",
        description: t("skills.install_skill_finder_hint"),
        icon: Compass,
        onClick: installSkillFinder,
        installing: installingSkillFinder(),
        disabled: props.busy || installingSkillFinder() || !props.canInstallSkillCreator,
      });
    }

    if (!skillCreatorInstalled()) {
      cards.push({
        id: "skill-creator",
        title: "skill-creator",
        description: t("skills.install_skill_creator_hint"),
        icon: WandSparkles,
        onClick: installSkillCreator,
        installing: installingSkillCreator(),
        disabled: props.busy || installingSkillCreator() || !props.canInstallSkillCreator,
      });
    }

    const query = searchQuery().trim().toLowerCase();
    if (!query) return cards;
    return cards.filter((card) =>
      card.title.toLowerCase().includes(query) ||
      card.description.toLowerCase().includes(query),
    );
  });

  const handleNewSkill = async () => {
    if (props.busy) return;
    // Ensure skill-creator exists when we can.
    if (props.canInstallSkillCreator && !skillCreatorInstalled()) {
      await installSkillCreator();
    }
    // Open a new session and preselect /skill-creator.
    props.openNewTask();
    props.setPrompt("/skill-creator");
  };

  const importSkillDisabled = createMemo(() => props.busy || !props.canImportLocalSkill);

  const openNewSkillMenu = () => {
    if (importSkillDisabled()) return;
    setNewSkillMenuOpen(true);
  };

  const closeNewSkillMenu = () => {
    setNewSkillMenuOpen(false);
  };

  const handleNewSkillMenuAction = async (action: "import-local" | "import-skill-file") => {
    if (action === "import-local") {
      if (props.busy || !props.canImportLocalSkill) {
        pushNotice(props.accessHint ?? t("skills.desktop_required"), "error");
        return;
      }
      closeNewSkillMenu();
      await importLocalSkillAction();
      return;
    }

    if (action === "import-skill-file") {
      if (props.busy || !props.canImportLocalSkill) {
        pushNotice(props.accessHint ?? t("skills.desktop_required"), "error");
        return;
      }
      closeNewSkillMenu();
      await importSkillFileAction();
      return;
    }
  };

  const openInstallFromLink = () => {
    if (props.busy) return;
    setInstallLinkOpen(true);
    setInstallLinkUrl("");
    setInstallLinkBusy(false);
    setInstallLinkError(null);
    setInstallLinkBundle(null);
  };

  const closeInstallFromLink = () => {
    setInstallLinkOpen(false);
    setInstallLinkBusy(false);
    setInstallLinkError(null);
    setInstallLinkBundle(null);
  };

  const previewInstallLink = async () => {
    const raw = installLinkUrl().trim();
    if (!raw) {
      setInstallLinkError(t("skills.preview_link_required"));
      return;
    }
    if (installLinkBusy()) return;

    setInstallLinkBusy(true);
    setInstallLinkError(null);
    setInstallLinkBundle(null);
    try {
      const url = new URL(raw);
      const normalizeGithubSkillFileUrl = (value: URL): string | null => {
        const host = value.hostname.toLowerCase();
        const pathname = value.pathname;
        if (host === "raw.githubusercontent.com") {
          return pathname.toUpperCase().endsWith("/SKILL.MD") ? value.toString() : null;
        }
        if (host !== "github.com" && host !== "www.github.com") return null;
        const parts = pathname.split("/").filter((part) => part.length > 0);
        if (parts.length < 5 || parts[2] !== "blob") return null;
        const filePath = parts.slice(4).join("/");
        const normalizedFilePath = filePath.toUpperCase();
        if (!normalizedFilePath.endsWith("/SKILL.MD") && normalizedFilePath !== "SKILL.MD") {
          throw new Error("Only GitHub links to SKILL.md are supported");
        }
        const owner = parts[0];
        const repo = parts[1];
        const ref = parts[3];
        return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
      };

      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const githubSkillFileUrl = normalizeGithubSkillFileUrl(url);
        if (githubSkillFileUrl) {
          const response = await fetch(githubSkillFileUrl, {
            method: "GET",
            headers: { Accept: "text/plain" },
            signal: controller.signal,
          });
          if (!response.ok) {
            const text = (await response.text()).trim();
            const suffix = text ? `: ${text}` : "";
            throw new Error(`Failed to fetch SKILL.md (${response.status})${suffix}`);
          }
          const content = await response.text();
          const validated = validateSkillMarkdown(content);
          setInstallLinkBundle({
            schemaVersion: 1,
            type: "skill",
            name: validated.name,
            content,
            description: validated.description,
          });
          return;
        }

        const response = await fetch(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          const text = (await response.text()).trim();
          const suffix = text ? `: ${text}` : "";
          throw new Error(`Failed to fetch bundle (${response.status})${suffix}`);
        }
        const json = (await response.json()) as Record<string, unknown>;
        const schemaVersion = typeof json.schemaVersion === "number" ? json.schemaVersion : null;
        const type = typeof json.type === "string" ? json.type : "";
        const name = typeof json.name === "string" ? json.name.trim() : "";
        const content = typeof json.content === "string" ? json.content : "";
        if (schemaVersion !== 1 || type !== "skill") {
          throw new Error("This link is not an OpenWork skill bundle");
        }
        if (!name) throw new Error("Bundle is missing a skill name");
        if (!content) throw new Error("Bundle is missing skill content");
        setInstallLinkBundle({
          schemaVersion: 1,
          type: "skill",
          name,
          content,
          description: typeof json.description === "string" ? json.description : undefined,
          trigger: typeof json.trigger === "string" ? json.trigger : undefined,
        });
      } finally {
        window.clearTimeout(timer);
      }
    } catch (e) {
      setInstallLinkError(maskError(e));
    } finally {
      setInstallLinkBusy(false);
    }
  };

  const installFromPreview = async (mode: "overwrite" | "keep-both") => {
    const bundle = installLinkBundle();
    if (!bundle) return;
    if (props.busy || installLinkBusy()) return;
    setInstallLinkBusy(true);
    setInstallLinkError(null);

    try {
      const taken = installedNames();
      const desiredName = bundle.name.trim();
      const conflict = taken.has(desiredName);
      const shouldRename = conflict && mode === "keep-both";
      const finalName = shouldRename ? resolveUniqueSkillName(desiredName, taken) : desiredName;
      const content = shouldRename ? stripFrontmatter(bundle.content) : bundle.content;

      const saved = await Promise.resolve(
        props.saveSkill({
          name: finalName,
          content,
          description: bundle.description,
        }),
      );
      if (!saved.ok) {
        setInstallLinkError(saved.message);
        return;
      }
      props.refreshSkills({ force: true });
      pushNotice(t("skills.installed_named").replace("{name}", finalName), "success");
      closeInstallFromLink();
    } catch (e) {
      setInstallLinkError(maskError(e));
    } finally {
      setInstallLinkBusy(false);
    }
  };

  const recommendedDisabledReason = (id: string) => {
    if (id === "skill-creator") {
      if (skillCreatorInstalled()) return t("skills.installed_label");
      if (props.busy || installingSkillCreator()) return t("skills.installing_skill_creator");
      if (!props.canInstallSkillCreator) {
        return props.accessHint ?? t("skills.host_only_error");
      }
      return null;
    }

    if (id === "skill-finder") {
      if (skillFinderInstalled()) return t("skills.installed_label");
      if (props.busy || installingSkillFinder()) return t("skills.installing_skill_finder");
      if (!props.canInstallSkillCreator) {
        return props.accessHint ?? t("skills.host_only_error");
      }
      return null;
    }

    if (id === "import-local") {
      if (!props.canImportLocalSkill) {
        return props.accessHint ?? t("skills.desktop_required");
      }
      return null;
    }

    // reveal-folder and other desktop-only actions
    if (!props.canUseDesktopTools) {
      return t("skills.desktop_required");
    }

    return null;
  };

  const openSkill = async (skill: SkillCard, mode: "preview" | "edit") => {
    if (props.busy) return;
    setSelectedSkill(skill);
    setSelectedMode(mode);
    setSelectedPreview("");
    setSelectedYamlContent("");
    setSelectedBodyContent("");
    setSelectedInitialYamlContent("");
    setSelectedInitialBodyContent("");
    setSelectedError(null);
    setSelectedLoading(true);
    try {
      const result = await props.readSkill(skill.name);
      if (!result) {
        setSelectedError(t("skills.editor_error_failed_load"));
        return;
      }
      const parsed = splitSkillContentForEditor(result.content);
      setSelectedPreview(frontmatterFileForPreview(result.content));
      setSelectedYamlContent(parsed.yaml);
      setSelectedBodyContent(parsed.body);
      setSelectedInitialYamlContent(parsed.yaml);
      setSelectedInitialBodyContent(parsed.body);
    } catch (e) {
      setSelectedError(e instanceof Error ? e.message : t("skills.editor_error_failed_load"));
    } finally {
      setSelectedLoading(false);
    }
  };

  const closeSkill = () => {
    setSelectedSkill(null);
    setSelectedPreview("");
    setSelectedYamlContent("");
    setSelectedBodyContent("");
    setSelectedInitialYamlContent("");
    setSelectedInitialBodyContent("");
    setSelectedError(null);
    setSelectedLoading(false);
  };

  const saveSelectedSkill = async () => {
    const skill = selectedSkill();
    if (!skill) return;
    if (!selectedDirty()) return;
    setSelectedError(null);
    try {
      const validated = validateEditableFrontmatter(
        skill.name,
        selectedYamlContent(),
        selectedBodyContent(),
      );
      const saved = await Promise.resolve(
        props.saveSkill({
          name: skill.name,
          content: validated.content,
          description: validated.description,
        }),
      );
      if (!saved.ok) {
        setSelectedError(saved.message);
        return;
      }
      setSelectedInitialYamlContent(selectedYamlContent());
      setSelectedInitialBodyContent(selectedBodyContent());
    } catch (e) {
      setSelectedError(
        e instanceof Error ? localizeSkillErrorMessage(e.message) : t("skills.editor_error_failed_save"),
      );
    }
  };

  const resetCreateSkillFields = () => {
    setCreateSkillName("");
    setCreateSkillYaml("name: my-skill\ndescription: What this skill does");
    setCreateSkillBody("# My Skill\n\nAdd usage instructions here.");
  };

  // Called from the inputs' onInput only, never from a reaction to the field
  // values: a successful create resets the fields in code and then shows its
  // success message, which must survive that reset.
  const clearCreateSkillFeedback = () => {
    setCreateSkillStatus(null);
    setCreateSkillError(null);
  };

  const resetCreateSkillForm = () => {
    if (createSkillBusy() || props.busy) return;
    resetCreateSkillFields();
    setCreateSkillStatus(null);
    setCreateSkillError(null);
  };

  const createSkillCanSubmit = createMemo(() =>
    !props.busy &&
    !createSkillBusy() &&
    createSkillName().trim().length > 0 &&
    createSkillYaml().trim().length > 0,
  );

  const createSkillFromForm = async () => {
    if (!createSkillCanSubmit()) return;
    setCreateSkillStatus(null);
    setCreateSkillError(null);

    const requestedName = createSkillName().trim();
    const installed = new Set(props.skills.map((skill) => skill.name));
    if (installed.has(requestedName)) {
      setCreateSkillError(t("skills.create_exists").replace("{name}", requestedName));
      return;
    }

    const yamlRaw = createSkillYaml().trim();
    const yamlLines = yamlRaw
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "---");
    const normalizedYaml = yamlLines.join("\n").trim();
    const body = createSkillBody();
    const content = `---\n${normalizedYaml}\n---\n\n${body}`;

    let validated: { name: string; description: string };
    try {
      validated = validateSkillMarkdown(content, { expectedName: requestedName });
    } catch (error) {
      setCreateSkillError(
        error instanceof Error ? localizeSkillErrorMessage(error.message) : t("skills.create_invalid_markdown"),
      );
      return;
    }

    setCreateSkillBusy(true);
    try {
      const saved = await Promise.resolve(
        props.saveSkill({
          name: validated.name,
          content,
          description: validated.description,
        }),
      );
      if (!saved.ok) {
        setCreateSkillError(saved.message || t("skills.create_failed"));
        return;
      }
      props.refreshSkills({ force: true });
      if (
        shouldResetCreateSkillForm(
          { name: createSkillName(), yaml: createSkillYaml(), body: createSkillBody() },
          { name: requestedName, yaml: yamlRaw, body },
        )
      ) {
        resetCreateSkillFields();
      }
      setCreateSkillStatus(t("skills.create_success").replace("{name}", validated.name));
    } catch (error) {
      setCreateSkillError(
        error instanceof Error ? localizeSkillErrorMessage(error.message) : t("skills.create_failed"),
      );
    } finally {
      setCreateSkillBusy(false);
    }
  };

  const canCreateInChat = createMemo(
    () => !props.busy && (props.canInstallSkillCreator || props.canUseDesktopTools)
  );

  return (
    <section class="space-y-8" data-testid="skills-content">
      <h2 class="text-display-lg font-bold text-dls-text">{t("skills.title")}</h2>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <button
          type="button"
          onClick={handleNewSkill}
          disabled={!canCreateInChat()}
          class={`rounded-inset border p-4 text-left transition-colors ${canCreateInChat()
            ? "border-dls-border bg-dls-surface hover:bg-dls-hover"
            : "border-dls-border bg-dls-hover text-dls-secondary"
            }`}
        >
          <div class="flex items-center gap-2 text-dls-text">
            <Sparkles size={16} />
            <span class="text-body-lg font-semibold">{t("skills.create_chat_action")}</span>
          </div>
        </button>

        <button
          type="button"
          onClick={openNewSkillMenu}
          disabled={importSkillDisabled()}
          class={`rounded-inset border p-4 text-left transition-colors ${importSkillDisabled()
            ? "border-dls-border bg-dls-hover text-dls-secondary"
            : "border-dls-border bg-dls-surface hover:bg-dls-hover"
            }`}
        >
          <div class="flex items-center gap-2 text-dls-text">
            <Upload size={16} />
            <span class="text-body-lg font-semibold">{t("skills.import_action")}</span>
          </div>
        </button>

        <button
          type="button"
          onClick={openInstallFromLink}
          disabled={props.busy}
          class={`rounded-inset border p-4 text-left transition-colors ${props.busy
            ? "border-dls-border bg-dls-hover text-dls-secondary"
            : "border-dls-border bg-dls-surface hover:bg-dls-hover"
            }`}
          title="Install a skill from a link"
        >
          <div class="flex items-center gap-2 text-dls-text">
            <Link2 size={16} />
            <span class="text-body-lg font-semibold">{t("skills.install_link_action")}</span>
          </div>
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-3 border-b border-dls-border pb-4">
        <button
          type="button"
          data-testid="skills-refresh-btn"
          onClick={() => props.refreshSkills({ force: true })}
          disabled={props.busy}
          class={`flex items-center gap-1.5 text-caption font-medium transition-colors ${props.busy
            ? "text-dls-secondary"
            : "text-dls-secondary hover:text-dls-text"
            }`}
        >
          <RefreshCw size={14} />
          {t("skills.refresh")}
        </button>
        <div class="relative">
          <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
          <input
            type="text"
            value={searchQuery()}
            onInput={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder={t("skills.search_installed_placeholder")}
            data-testid="skills-search-input"
            class="bg-dls-hover border border-dls-border rounded-control py-1.5 pl-9 pr-4 text-caption w-56 focus:w-72 focus:outline-none transition-all"
          />
        </div>
      </div>

      <Show when={props.accessHint}>
        <div class="text-caption text-dls-secondary">{props.accessHint}</div>
      </Show>
      <Show
        when={!props.accessHint && !props.canInstallSkillCreator && !props.canUseDesktopTools}
      >
        <div class="text-caption text-dls-secondary">{t("skills.host_mode_only")}</div>
      </Show>

      <Show when={visibleStatus()}>
        {(status) => {
          const tone = createMemo(() => status().tone);
          const toneClasses = createMemo(() =>
            tone() === "success"
              ? "border-dls-success-border bg-dls-success-bg text-dls-success-text"
              : tone() === "error"
                ? "border-dls-danger-border bg-dls-danger-bg text-dls-danger-text"
                : "border-dls-border bg-dls-hover text-dls-text");
          return (
            <div class={`rounded-inset border px-4 py-3 ${toneClasses()}`}>
              <div class="flex items-start justify-between gap-3">
                <div class="flex items-start gap-2 text-caption">
                  <Show
                    when={tone() === "success"}
                    fallback={
                      <Show when={tone() === "error"} fallback={<Info size={15} class="mt-0.5" />}>
                        <XCircle size={15} class="mt-0.5" />
                      </Show>
                    }
                  >
                    <CheckCircle2 size={15} class="mt-0.5" />
                  </Show>
                  <span class="whitespace-pre-wrap break-words">{status().message}</span>
                </div>
                <button
                  type="button"
                  class="inline-flex items-center justify-center rounded-subtle p-1 text-dls-secondary hover:bg-dls-active hover:text-dls-text transition-colors"
                  onClick={dismissVisibleStatus}
                  title={t("common.dismiss")}
                  aria-label={t("common.dismiss")}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          );
        }}
      </Show>

      <div class="space-y-4">
        <h3 class="text-label font-bold text-dls-secondary uppercase tracking-widest">
          {t("skills.installed")}
        </h3>
        <Show
          when={filteredSkills().length}
          fallback={
            <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg px-5 py-6 text-body-lg text-dls-secondary">
              {t("skills.no_skills")}
            </div>
          }
        >
          <div class="max-h-[calc(2*96px+1rem)] overflow-y-auto pr-2">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <For each={filteredSkills()}>
                {(skill) => (
                  <div
                    role="button"
                    tabindex="0"
                    data-testid="skill-card"
                    class="bg-dls-panel-bg border border-dls-panel-border rounded-inset p-4 flex items-start justify-between group hover:border-dls-border hover:bg-dls-hover transition-all text-left cursor-pointer"
                    onClick={() => void openSkill(skill, "preview")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        if (e.target !== e.currentTarget || e.isComposing || e.keyCode === 229) return;
                        e.preventDefault();
                        void openSkill(skill, "preview");
                      }
                    }}
                  >
                    <div class="flex gap-4 min-w-0">
                      <div class="w-10 h-10 rounded-control flex items-center justify-center shadow-sm border border-dls-panel-inset-border bg-dls-panel-inset-bg">
                        <WandSparkles size={22} class="text-dls-secondary" />
                      </div>
                      <div class="min-w-0">
                        <div class="flex items-center gap-2 mb-0.5">
                          <h4 class="text-body-lg font-semibold text-dls-text truncate">{skill.name}</h4>
                        </div>
                        <Show when={skill.description}>
                          <p class="text-caption text-dls-secondary line-clamp-1">
                            {skill.description}
                          </p>
                        </Show>
                        <div class="mt-1 text-label font-mono text-dls-secondary truncate">{skill.path}</div>
                      </div>
                    </div>
                    <div class="flex items-center gap-1">
                      <button
                        type="button"
                        class="p-1.5 text-dls-secondary hover:text-dls-text hover:bg-dls-active rounded-subtle transition-colors"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void openSkill(skill, "edit");
                        }}
                        disabled={props.busy}
                        title="Edit"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        type="button"
                        data-testid="skill-uninstall-btn"
                        class={`p-1.5 rounded-subtle transition-colors ${props.busy || !props.canUninstallSkill
                          ? "text-dls-secondary opacity-40"
                          : "text-dls-secondary hover:text-dls-danger-text hover:bg-dls-danger-bg"
                          }`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (props.busy || !props.canUninstallSkill) return;
                          setUninstallTarget(skill);
                        }}
                        disabled={props.busy || !props.canUninstallSkill}
                        title={t("skills.uninstall")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-label font-bold text-dls-secondary uppercase tracking-widest">Install skills</h3>
          <div class="flex items-center gap-2">
            {/* "Add git repo" temporarily hidden. Flip to true to re-enable custom repos. */}
            <Show when={false}>
              <button
                type="button"
                onClick={openCustomRepoModal}
                disabled={props.busy}
                class={`inline-flex items-center gap-1.5 rounded-subtle border px-2.5 py-1.5 text-caption font-medium transition-colors ${
                  props.busy
                    ? "border-dls-border bg-dls-hover text-dls-secondary"
                    : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-active"
                }`}
                title="Add custom GitHub repo"
              >
                <Plus size={14} />
                Add git repo
              </button>
            </Show>
          </div>
        </div>

        <Show when={props.hubSkillsStatus}>
          <div class="rounded-inset border border-dls-border bg-dls-hover px-4 py-3 text-caption text-dls-secondary whitespace-pre-wrap break-words">
            {props.hubSkillsStatus}
          </div>
        </Show>

        <Show
          when={hubSkillsLoading()}
          fallback={
            <Show
              when={pinnedInstallCards().length || filteredHubSkills().length}
              fallback={
                <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg px-5 py-6 text-body-lg text-dls-secondary">
                  No hub skills available.
                </div>
              }
            >
              <div
                class="grid grid-cols-2 gap-4 max-h-[calc(2*280px+1rem)] overflow-y-auto pr-2"
                onScroll={onHubScroll}
              >
                <For each={pinnedInstallCards()}>
                  {(item) => (
                    <div
                      role="button"
                      tabindex="0"
                      class={`bg-dls-panel-bg border border-dls-panel-border rounded-inset p-4 flex flex-col items-start justify-between gap-4 group transition-all text-left ${item.disabled ? "opacity-80" : "hover:border-dls-border hover:bg-dls-hover"}`}
                      onClick={() => {
                        if (item.disabled) {
                          const reason = props.accessHint ?? t("skills.host_only_error");
                          if (!props.canInstallSkillCreator && reason) pushNotice(reason, "error");
                          return;
                        }
                        void item.onClick();
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        if (e.isComposing || e.keyCode === 229) return;
                        e.preventDefault();
                        if (item.disabled) {
                          const reason = props.accessHint ?? t("skills.host_only_error");
                          if (!props.canInstallSkillCreator && reason) pushNotice(reason, "error");
                          return;
                        }
                        void item.onClick();
                      }}
                      title={item.title}
                    >
                      <div class="flex gap-4 w-full min-w-0">
                        <div class="w-10 h-10 rounded-control flex-shrink-0 flex items-center justify-center shadow-sm border border-dls-panel-inset-border bg-dls-panel-inset-bg">
                          <item.icon size={20} class="text-dls-secondary" />
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2 mb-0.5">
                            <h4 class="text-body-lg font-semibold text-dls-text truncate">{item.title}</h4>
                          </div>
                          <p class="text-caption text-dls-secondary line-clamp-2">{item.description}</p>
                          <Show when={!props.canInstallSkillCreator}>
                            <div class="mt-1 text-label text-dls-secondary">
                              {props.accessHint ?? t("skills.host_only_error")}
                            </div>
                          </Show>
                        </div>
                      </div>
                      <button
                        type="button"
                        class={`w-full inline-flex items-center justify-center gap-1.5 rounded-subtle border px-2.5 py-1.5 text-caption font-medium transition-colors ${
                          item.disabled
                            ? "border-dls-border bg-dls-hover text-dls-secondary opacity-60"
                            : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-active"
                        }`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (item.disabled) {
                            const reason = props.accessHint ?? t("skills.host_only_error");
                            if (!props.canInstallSkillCreator && reason) pushNotice(reason, "error");
                            return;
                          }
                          void item.onClick();
                        }}
                        disabled={item.disabled}
                        title={item.title}
                      >
                        <Show when={item.installing} fallback={<Plus size={14} />}>
                          <Loader2 size={14} class="animate-spin" />
                        </Show>
                        {item.installing ? t("skills.installing") : t("common.install")}
                      </button>
                    </div>
                  )}
                </For>

                <For each={visibleHubSkills()}>
                  {(skill) => (
                    <div
                      role="button"
                      tabindex="0"
                      class="bg-dls-panel-bg border border-dls-panel-border rounded-inset p-4 flex flex-col items-start justify-between gap-4 group hover:border-dls-border hover:bg-dls-hover transition-all text-left cursor-pointer"
                      onClick={() => setSelectedHubSkill(skill)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        if (e.isComposing || e.keyCode === 229) return;
                        e.preventDefault();
                        setSelectedHubSkill(skill);
                      }}
                      title="Click to view full description"
                    >
                      <div class="flex gap-4 w-full min-w-0">
                        <div class="w-10 h-10 rounded-control flex-shrink-0 flex items-center justify-center shadow-sm border border-dls-panel-inset-border bg-dls-panel-inset-bg">
                          <Package size={20} class="text-dls-secondary" />
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2 mb-0.5">
                            <h4 class="text-body-lg font-semibold text-dls-text truncate">{skill.name}</h4>
                          </div>
                          <Show when={skill.description}>
                            <p class="text-caption text-dls-secondary line-clamp-1">{skill.description}</p>
                          </Show>
                        </div>
                      </div>
                      <button
                        type="button"
                        data-testid="skill-install-btn"
                        class={`w-full inline-flex items-center justify-center gap-1.5 rounded-subtle border px-2.5 py-1.5 text-caption font-medium transition-colors ${
                          isHubInstalling(skill.name)
                            ? "border-dls-border bg-dls-hover text-dls-secondary"
                            : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-active"
                        }`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void installFromHub(skill);
                        }}
                        disabled={isHubInstalling(skill.name)}
                        title={`Install ${skill.name}`}
                      >
                        <Show
                          when={isHubInstalling(skill.name)}
                          fallback={<Plus size={14} />}
                        >
                          <Loader2 size={14} class="animate-spin" />
                        </Show>
                        {isHubInstalling(skill.name) ? t("skills.installing") : t("common.install")}
                      </button>
                    </div>
                  )}
                </For>
                <Show when={canLoadMoreHub()}>
                  <div class="col-span-2 flex items-center justify-center py-3 text-caption text-dls-secondary">
                    <Show
                      when={hubLoadingMore()}
                      fallback={<span>Scroll to load more…</span>}
                    >
                      <Loader2 size={14} class="animate-spin mr-1.5" />
                      Loading…
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
          }
        >
          <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg px-5 py-6 text-body-lg text-dls-secondary flex items-center justify-center gap-2">
            <Loader2 size={16} class="animate-spin" />
            Loading hub skills...
          </div>
        </Show>
      </div>

      <div class="space-y-4">
        <h3 class="text-label font-bold text-dls-secondary uppercase tracking-widest">
          {t("skills.create_new")}
        </h3>
        <div class="rounded-card border border-dls-panel-border bg-dls-panel-bg px-5 py-5 space-y-4">
          <div class="space-y-1.5">
            <label class="text-caption font-medium text-dls-secondary">{t("common.name")}</label>
            <input
              type="text"
              value={createSkillName()}
              onInput={(e) => {
                setCreateSkillName(e.currentTarget.value);
                clearCreateSkillFeedback();
              }}
              placeholder="my-skill"
              class="w-full rounded-control bg-dls-panel-input-bg px-3 py-2 text-body-lg text-dls-text border border-dls-panel-input-border shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.3)] focus:border-[var(--dls-accent)] transition-all"
            />
            <div class="text-caption text-dls-secondary">
              {t("skills.create_name_match_hint")}
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="text-caption font-medium text-dls-secondary">{t("skills.create_yaml_label")}</label>
            <textarea
              rows={5}
              value={createSkillYaml()}
              onInput={(e) => {
                setCreateSkillYaml(e.currentTarget.value);
                clearCreateSkillFeedback();
              }}
              placeholder={"name: my-skill\ndescription: What this skill does"}
              class="w-full rounded-control bg-dls-panel-input-bg px-3 py-2 text-body-lg font-mono text-dls-text border border-dls-panel-input-border shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.3)] focus:border-[var(--dls-accent)] transition-all resize-y"
            />
          </div>

          <div class="space-y-1.5">
            <label class="text-caption font-medium text-dls-secondary">{t("skills.create_body_label")}</label>
            <textarea
              rows={8}
              value={createSkillBody()}
              onInput={(e) => {
                setCreateSkillBody(e.currentTarget.value);
                clearCreateSkillFeedback();
              }}
              placeholder={"# My Skill\n\nExplain when and how to use this skill."}
              class="w-full rounded-control bg-dls-panel-input-bg px-3 py-2 text-body-lg font-mono text-dls-text border border-dls-panel-input-border shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgb(var(--dls-accent-rgb)/0.3)] focus:border-[var(--dls-accent)] transition-all resize-y"
            />
          </div>

          {/* Live regions stay mounted: content inserted into an existing region is
              announced reliably, a freshly inserted region often is not. */}
          <div role="status" class="empty:hidden">
            <Show when={createSkillStatus()}>
              {(status) => (
                <div class="rounded-inset border border-dls-success-border bg-dls-success-bg px-3 py-2 text-body-lg text-dls-success-text" data-testid="skill-create-success">
                  <div class="flex items-start gap-2">
                    <CheckCircle2 size={16} class="mt-0.5 shrink-0 text-dls-success-text" />
                    <span>{status()}</span>
                  </div>
                </div>
              )}
            </Show>
          </div>
          <div role="alert" class="empty:hidden">
            <Show when={createSkillError()}>
              {(error) => (
                <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-3 py-2 text-body-lg text-dls-danger-text" data-testid="skill-create-error">
                  <div class="flex items-start gap-2">
                    <XCircle size={16} class="mt-0.5 shrink-0 text-dls-danger-text" />
                    <span>{error()}</span>
                  </div>
                </div>
              )}
            </Show>
          </div>

          <div class="flex items-center justify-end gap-3">
            <Button variant="outline" onClick={resetCreateSkillForm} disabled={createSkillBusy() || props.busy}>
              {t("settings.reset")}
            </Button>
            <Button variant="secondary" onClick={() => void createSkillFromForm()} disabled={!createSkillCanSubmit()}>
              <Show when={createSkillBusy()} fallback={<>{t("skills.create_action")}</>}>
                <Loader2 size={16} class="animate-spin" />
                <span class="ml-2">{t("skills.creating")}</span>
              </Show>
            </Button>
          </div>
        </div>
      </div>

      <Show when={selectedSkill() && selectedMode() === "preview"}>
        <FilePreviewModal
          open
          title={selectedSkill()?.name ?? ""}
          content={selectedPreview()}
          loading={selectedLoading()}
          error={selectedError()}
          onClose={closeSkill}
          headerActions={
            <button
              type="button"
              data-testid="skill-preview-edit-btn"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-caption font-medium rounded-control bg-dls-hover text-dls-text hover:bg-dls-active transition-colors disabled:opacity-60"
              onClick={() => setSelectedMode("edit")}
              disabled={props.busy}
            >
              <Edit2 size={14} />
              {t("common.edit")}
            </button>
          }
        />
      </Show>

      <Show when={selectedSkill() && selectedMode() === "edit"}>
        <div class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="w-full max-w-4xl rounded-card border border-dls-border bg-dls-surface-solid shadow-2xl overflow-hidden">
            <div class="px-5 py-4 border-b border-dls-border flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-body-lg font-semibold text-dls-text truncate">{selectedSkill()!.name}</div>
                <div class="text-caption text-dls-secondary truncate">{selectedSkill()!.path}</div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class={`px-3 py-2 rounded-inset text-caption font-medium transition-colors ${selectedDirty() && !props.busy && props.canEditSkill
                    ? "bg-dls-text text-dls-surface-solid hover:opacity-90"
                    : "bg-dls-active text-dls-secondary"
                    }`}
                  disabled={!selectedDirty() || props.busy || !props.canEditSkill}
                  onClick={() => void saveSelectedSkill()}
                >
                  Save
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 text-caption font-medium rounded-control bg-dls-hover text-dls-text hover:bg-dls-active transition-colors"
                  onClick={closeSkill}
                >
                  Close
                </button>
              </div>
            </div>

            <div class="p-5">
              <Show when={selectedError()}>
                <div class="mb-3 rounded-inset border border-dls-danger-border bg-dls-danger-bg px-4 py-3 text-caption text-dls-danger-text">
                  {selectedError()}
                </div>
              </Show>
              <Show
                when={!selectedLoading()}
                fallback={<div class="text-caption text-dls-secondary">Loading…</div>}
              >
                <div class="space-y-3">
                  <div>
                    <div class="text-label font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.editor_name_label")}</div>
                    <div class="mt-1 rounded-control border border-dls-border bg-dls-hover px-3 py-2 text-caption font-mono text-dls-text">
                      {selectedSkill()?.name ?? ""}
                    </div>
                    <div class="mt-1 text-label text-dls-secondary">
                      {t("skills.editor_name_locked_hint")}
                    </div>
                  </div>

                  <div>
                    <div class="text-label font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.editor_frontmatter_label")}</div>
                    <textarea
                      value={selectedYamlContent()}
                      onInput={(e) => {
                        if (!props.canEditSkill) return;
                        setSelectedYamlContent(e.currentTarget.value);
                      }}
                      readOnly={!props.canEditSkill}
                      class="mt-1 w-full min-h-[150px] rounded-inset border border-dls-border bg-dls-hover px-4 py-3 text-caption font-mono text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb)/0.25)]"
                      spellcheck={false}
                    />
                    <div class="mt-1 text-label text-dls-secondary">
                      {t("skills.editor_frontmatter_hint")}
                    </div>
                  </div>

                  <div>
                    <div class="text-label font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.editor_body_label")}</div>
                    <textarea
                      value={selectedBodyContent()}
                      onInput={(e) => {
                        if (!props.canEditSkill) return;
                        setSelectedBodyContent(e.currentTarget.value);
                      }}
                      readOnly={!props.canEditSkill}
                      class="mt-1 w-full min-h-[230px] rounded-inset border border-dls-border bg-dls-hover px-4 py-3 text-caption font-mono text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb)/0.25)]"
                      spellcheck={false}
                    />
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={selectedHubSkill()}>
        <div
          class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setSelectedHubSkill(null)}
        >
          <div
            class="w-full max-w-lg rounded-card border border-dls-border bg-dls-surface-solid shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="px-5 py-4 border-b border-dls-border flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-body-lg font-semibold text-dls-text truncate">{selectedHubSkill()!.name}</div>
                <div class="text-caption text-dls-secondary truncate">
                  {selectedHubSkill()!.source?.owner}/{selectedHubSkill()!.source?.repo}
                </div>
              </div>
              <button
                type="button"
                class="px-3 py-1.5 text-caption font-medium rounded-control bg-dls-hover text-dls-text hover:bg-dls-active transition-colors"
                onClick={() => setSelectedHubSkill(null)}
              >
                {t("common.close")}
              </button>
            </div>
            <div class="p-5 space-y-3 max-h-[60vh] overflow-y-auto">
              <Show
                when={selectedHubSkill()!.description}
                fallback={<p class="text-caption text-dls-secondary">No description available.</p>}
              >
                <p class="text-body-lg text-dls-text whitespace-pre-wrap break-words">{selectedHubSkill()!.description}</p>
              </Show>
              <Show when={selectedHubSkill()!.trigger}>
                <div class="rounded-inset border border-dls-border bg-dls-hover px-4 py-3 text-caption text-dls-secondary">
                  <span class="font-semibold text-dls-text">When to use: </span>
                  {selectedHubSkill()!.trigger}
                </div>
              </Show>
            </div>
            <div class="px-5 pb-5 flex justify-end">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-subtle border border-dls-border bg-dls-surface px-3 py-1.5 text-caption font-medium text-dls-text hover:bg-dls-active transition-colors disabled:opacity-60"
                onClick={() => {
                  const skill = selectedHubSkill();
                  setSelectedHubSkill(null);
                  if (skill) void installFromHub(skill);
                }}
                disabled={props.busy}
              >
                <Plus size={14} />
                Add
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={uninstallOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface-solid border border-dls-border w-full max-w-md rounded-card shadow-2xl overflow-hidden">
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-heading font-semibold text-dls-text">{t("skills.uninstall_title")}</h3>
                  <p class="text-body-lg text-dls-secondary mt-1">
                    {t("skills.uninstall_warning").replace("{name}", uninstallTarget()?.name ?? "")}
                  </p>
                </div>
              </div>

              <div class="mt-4 rounded-inset bg-dls-hover border border-dls-border p-3 text-caption text-dls-secondary font-mono break-all">
                {uninstallTarget()?.path}
              </div>

              <div class="mt-6 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setUninstallTarget(null)} disabled={props.busy}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="danger"
                  data-testid="skill-uninstall-confirm-btn"
                  onClick={() => {
                    const target = uninstallTarget();
                    setUninstallTarget(null);
                    if (!target) return;
                    props.uninstallSkill(target.name);
                  }}
                  disabled={props.busy}
                >
                  {t("skills.uninstall")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={installLinkOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface-solid border border-dls-border w-full max-w-lg rounded-card shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div>
                <h3 class="text-heading font-semibold text-dls-text">{t("skills.install_from_link")}</h3>
                <p class="text-body-lg text-dls-secondary mt-1">{t("skills.install_from_link_desc")}</p>
              </div>

              <div class="space-y-2">
                <div class="text-caption font-semibold uppercase tracking-widest text-dls-secondary">{t("skills.link_label")}</div>
                <input
                  type="url"
                  value={installLinkUrl()}
                  onInput={(e) => setInstallLinkUrl(e.currentTarget.value)}
                  placeholder={t("skills.install_link_placeholder")}
                  class="w-full bg-dls-hover border border-dls-border rounded-control px-3 py-2 text-caption font-mono text-dls-text focus:outline-none"
                  spellcheck={false}
                />
              </div>

              <Show when={installLinkError()}>
                <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-4 py-3 text-caption text-dls-danger-text">
                  {installLinkError()}
                </div>
              </Show>

              <Show when={installLinkBundle()}>
                {(bundle) => {
                  const taken = installedNames();
                  const conflict = taken.has(bundle().name.trim());
                  return (
                    <div class="rounded-inset border border-dls-border bg-dls-hover p-4 space-y-2">
                      <div class="text-caption font-semibold text-dls-text">{t("skills.preview")}</div>
                      <div class="text-caption text-dls-secondary">
                        {t("skills.skill_label")} <span class="font-mono">{bundle().name}</span>
                      </div>
                      <Show when={bundle().description}>
                        <div class="text-caption text-dls-secondary">{bundle().description}</div>
                      </Show>
                      <Show when={conflict}>
                        <div class="text-caption text-dls-warning-text">{t("skills.name_already_installed")}</div>
                      </Show>
                    </div>
                  );
                }}
              </Show>

              <div class="flex justify-end gap-2">
                <Button variant="outline" onClick={closeInstallFromLink} disabled={installLinkBusy()}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void previewInstallLink()}
                  disabled={installLinkBusy() || !installLinkUrl().trim()}
                >
                  {installLinkBusy() && !installLinkBundle() ? t("common.loading") : t("skills.preview")}
                </Button>
                <Show when={installLinkBundle()} keyed>
                  {(bundle) => {
                    const conflict = installedNames().has(bundle.name.trim());
                    return (
                      <Show
                        when={conflict}
                        fallback={
                          <Button
                            variant="secondary"
                            onClick={() => void installFromPreview("overwrite")}
                            disabled={installLinkBusy()}
                          >
                            {installLinkBusy() ? t("skills.installing") : t("common.install")}
                          </Button>
                        }
                      >
                        <div class="flex gap-2">
                          <Button
                            variant="outline"
                            onClick={() => void installFromPreview("keep-both")}
                            disabled={installLinkBusy()}
                          >
                            {installLinkBusy() ? t("skills.installing") : t("skills.keep_both")}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => void installFromPreview("overwrite")}
                            disabled={installLinkBusy()}
                          >
                            {installLinkBusy() ? t("skills.installing") : t("skills.overwrite")}
                          </Button>
                        </div>
                      </Show>
                    );
                  }}
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={newSkillMenuOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface-solid border border-dls-border w-full max-w-lg rounded-card shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div>
                <h3 class="text-heading font-semibold text-dls-text">{t("skills.import_action")}</h3>
                <p class="text-body-lg text-dls-secondary mt-1">{t("skills.import_dialog_hint")}</p>
              </div>

              <div class="grid grid-cols-1 gap-3">
                <button
                  type="button"
                  class={`w-full rounded-inset border px-4 py-3 text-left transition-colors ${props.busy || !props.canImportLocalSkill
                    ? "border-dls-border bg-dls-hover text-dls-secondary opacity-70"
                    : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-hover"
                    }`}
                  onClick={() => void handleNewSkillMenuAction("import-local")}
                  disabled={props.busy || !props.canImportLocalSkill}
                >
                  <div class="text-body-lg font-semibold">{t("skills.import_local")}</div>
                  <div class="mt-1 text-caption text-dls-secondary">{t("skills.import_local_hint")}</div>
                </button>

                <button
                  type="button"
                  class={`w-full rounded-inset border px-4 py-3 text-left transition-colors ${props.busy || !props.canImportLocalSkill
                    ? "border-dls-border bg-dls-hover text-dls-secondary opacity-70"
                    : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-hover"
                    }`}
                  onClick={() => void handleNewSkillMenuAction("import-skill-file")}
                  disabled={props.busy || !props.canImportLocalSkill}
                >
                  <div class="text-body-lg font-semibold">{t("skills.import_skill_file_title")}</div>
                  <div class="mt-1 text-caption text-dls-secondary">{t("skills.import_skill_file_hint")}</div>
                </button>

              </div>

              <div class="flex justify-end gap-2">
                <Button variant="outline" onClick={closeNewSkillMenu}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={customRepoOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface-solid border border-dls-border w-full max-w-lg rounded-card shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div>
                <h3 class="text-heading font-semibold text-dls-text">Add custom GitHub repo</h3>
                <p class="text-body-lg text-dls-secondary mt-1">
                  Skills are loaded from <span class="font-mono">skills/&lt;name&gt;/SKILL.md</span>.
                </p>
              </div>

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label class="space-y-1">
                  <div class="text-caption font-semibold uppercase tracking-widest text-dls-secondary">Owner</div>
                  <input
                    type="text"
                    value={customRepoOwner()}
                    onInput={(e) => setCustomRepoOwner(e.currentTarget.value)}
                    placeholder="different-ai"
                    class="w-full bg-dls-hover border border-dls-border rounded-control px-3 py-2 text-caption font-mono text-dls-text focus:outline-none"
                    spellcheck={false}
                  />
                </label>
                <label class="space-y-1">
                  <div class="text-caption font-semibold uppercase tracking-widest text-dls-secondary">Repo</div>
                  <input
                    type="text"
                    value={customRepoName()}
                    onInput={(e) => setCustomRepoName(e.currentTarget.value)}
                    placeholder="openwork-hub"
                    class="w-full bg-dls-hover border border-dls-border rounded-control px-3 py-2 text-caption font-mono text-dls-text focus:outline-none"
                    spellcheck={false}
                  />
                </label>
              </div>

              <label class="space-y-1">
                <div class="text-caption font-semibold uppercase tracking-widest text-dls-secondary">Ref (branch/tag/commit)</div>
                <input
                  type="text"
                  value={customRepoRef()}
                  onInput={(e) => setCustomRepoRef(e.currentTarget.value)}
                  placeholder="main"
                  class="w-full bg-dls-hover border border-dls-border rounded-control px-3 py-2 text-caption font-mono text-dls-text focus:outline-none"
                  spellcheck={false}
                />
              </label>

              <Show when={customRepoError()}>
                <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-4 py-3 text-caption text-dls-danger-text">
                  {customRepoError()}
                </div>
              </Show>

              <div class="flex justify-end gap-2">
                <Button variant="outline" onClick={closeCustomRepoModal} disabled={props.busy}>
                  {t("common.cancel")}
                </Button>
                <Button variant="secondary" onClick={saveCustomRepo} disabled={props.busy}>
                  Save and load
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
