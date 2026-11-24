import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import { AlertTriangle, Bot, Check, ChevronRight, Edit2, Loader2, RefreshCw, Trash2, Upload } from "lucide-solid";

import Card from "~/shared/ui/card";
import { Tooltip } from "~/shared/ui/tooltip";
import Button from "~/shared/ui/button";
import TextInput, { formControlChromeClass } from "~/shared/ui/text-input";
import AgentCreatorCapabilitySelection from "./agent-creator-capability-selection";
import AgentEditForm, { AgentEditModeToggle, type AgentEditMode } from "./agent-edit-form";
import {
  AGENT_FORM_UNSUPPORTED,
  agentFileForPreview,
  patchAgentDescription,
  readAgentDescription,
} from "./agent-creator-frontmatter";
import { availableCategoryIds, classifyToolCategory, classifyToolRisk, classifySkillCategory, classifySkillRisk, generateAgentMarkdown, parseUploadedAgentMarkdown, requiredToolsFromSkills } from "./agent-creator-markdown";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { validateAgentMarkdown } from "~/shared/util/agent-markdown";
import { t } from "../../i18n";
import { CAPABILITY_CATEGORIES } from "./agent-creator.presets";
import type { AgentCreatorViewProps, AgentInfo, CapabilityItem, PackageLevel, RiskLevel } from "./agent-creator.types";

export default function AgentCreatorView(props: AgentCreatorViewProps) {
  // Create form state
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [systemPrompt, setSystemPrompt] = createSignal("");
  const [uploadedFileName, setUploadedFileName] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [uploadError, setUploadError] = createSignal<string | null>(null);
  const [autoFilledFields, setAutoFilledFields] = createSignal<string[]>([]);
  const [availableTools, setAvailableTools] = createSignal<CapabilityItem[]>([]);
  const [availableSkills, setAvailableSkills] = createSignal<CapabilityItem[]>([]);
  const [protectedFilePipelineAvailable, setProtectedFilePipelineAvailable] = createSignal(false);
  const [protectedFilePipelineEnabled, setProtectedFilePipelineEnabled] = createSignal(false);
  const [availableMcpServers, setAvailableMcpServers] = createSignal<Array<{ name: string; source: "config.project" | "config.global" | "config.remote" }>>([]);
  const [lastQuickSetupSource, setLastQuickSetupSource] = createSignal<"upload" | null>(null);
  const [quickSetupCollapsed, setQuickSetupCollapsed] = createSignal(false);
  const [selectedTools, setSelectedTools] = createSignal<string[]>([]);
  const [selectedSkills, setSelectedSkills] = createSignal<string[]>([]);
  const [selectedCustomTools, setSelectedCustomTools] = createSignal<string[]>([]);
  const [selectedCustomSkills, setSelectedCustomSkills] = createSignal<string[]>([]);
  const [expandedCategory, setExpandedCategory] = createSignal<string | null>(null);
  const [categoryPackageSelection, setCategoryPackageSelection] = createSignal<Record<string, PackageLevel>>(
    Object.fromEntries(CAPABILITY_CATEGORIES.map((category) => [category.id, "none"])) as Record<string, PackageLevel>,
  );
  const [catalogLoading, setCatalogLoading] = createSignal(false);
  const [catalogError, setCatalogError] = createSignal<string | null>(null);
  let uploadInputRef: HTMLInputElement | undefined;

  // Capability categories this machine can actually back. The catalog reflects
  // the Product Profile published into /config/opencode, so it is already
  // Profile-correct — a Profile shipping no email tools/skills (today:
  // `lite`/`standard`) drops the "Email & Calendar Operations" card entirely
  // rather than offering a package that selects nothing. Mirrors how Settings
  // already hides its Email section there (settings.tsx `isAgentAllowed("email-agent")`).
  const availableCategories = createMemo(() =>
    availableCategoryIds(
      availableTools().map((item) => item.name),
      availableSkills().map((item) => item.name),
    ),
  );
  const visibleCategories = createMemo(() =>
    CAPABILITY_CATEGORIES.filter((category) => availableCategories().has(category.id)),
  );

  // Force unavailable categories back to "none". Hiding the card only closes
  // the click path; loadMarkdownFile writes the whole selection object directly,
  // so without this stale state could leave e.g.
  // `email-calendar-operations: "high"` in state. That grants nothing today
  // (the category has no catalog items to select), but if availability later
  // flips the card would reappear pre-set to Advanced, skipping its confirm.
  const clampPackageSelection = (
    selection: Record<string, PackageLevel>,
    available: ReadonlySet<string>,
  ): Record<string, PackageLevel> => {
    const next: Record<string, PackageLevel> = { ...selection };
    for (const category of CAPABILITY_CATEGORIES) {
      if (!available.has(category.id)) next[category.id] = "none";
    }
    return next;
  };

  // Dark-safe MCP gate: only a validated active Profile that says MCP is off
  // hides the block. No provider / loading / recovery keeps current behavior,
  // matching the `!isActive() || flag` idiom used across settings.tsx. A
  // customized agent's own permission block (see generateAgentMarkdown) is
  // what actually scopes it to the MCPs checked here — the engine now enforces
  // that per agent instead of blanket-blocking every non-default agent.
  const capability = useCapabilityGate();
  const mcpBlockVisible = () => !capability.isActive() || capability.mcpEnabled();

  // Edit modal state
  const [editTarget, setEditTarget] = createSignal<AgentInfo | null>(null);
  const [editView, setEditView] = createSignal<"preview" | "edit">("edit");
  const [editContent, setEditContent] = createSignal("");
  const [editMode, setEditMode] = createSignal<AgentEditMode>("form");
  const [editDescription, setEditDescription] = createSignal("");
  const [editLoading, setEditLoading] = createSignal(false);
  const [editDirty, setEditDirty] = createSignal(false);
  const [editError, setEditError] = createSignal<string | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = createSignal<AgentInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = createSignal(false);

  // Toast
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  const localizeAgentValidationMessage = (message: string): string => {
    if (message === "Invalid Agent Markdown format. Add a frontmatter block between '---' lines.") {
      return t("agents.validation_invalid_format");
    }
    const yamlAt = message.match(/^Agent YAML format is invalid at line (\d+), col (\d+)\. Please check the Frontmatter YAML\.$/);
    if (yamlAt) {
      return t("agents.validation_yaml_invalid_at")
        .replace("{line}", yamlAt[1] ?? "")
        .replace("{col}", yamlAt[2] ?? "");
    }
    if (message === "Agent YAML format is invalid. Please check the Frontmatter YAML.") {
      return t("agents.validation_yaml_invalid");
    }
    if (message === "Frontmatter must be a YAML mapping (key/value object).") {
      return t("agents.validation_frontmatter_mapping");
    }
    if (message === AGENT_FORM_UNSUPPORTED) {
      return t("agents.edit_form_unsupported");
    }
    if (message === "Frontmatter is missing required field: description.") {
      return t("agents.validation_description_required");
    }
    if (message === "Frontmatter is missing required field: mode.") {
      return t("agents.validation_mode_required");
    }
    if (message === "Frontmatter is missing required field: permission mapping.") {
      return t("agents.validation_permission_required");
    }
    if (message === "'mode' must be one of: primary, subagent, all.") {
      return t("agents.validation_mode_enum");
    }
    if (message === "System prompt body cannot be empty.") {
      return t("agents.validation_system_prompt_required");
    }
    if (message === "'description' must be 1-1024 characters.") {
      return t("agents.validation_description_length");
    }
    if (message === "'name' may contain only letters, numbers, hyphens, and underscores.") {
      return t("agents.validation_name_pattern");
    }
    const unknownField = message.match(/^Unknown frontmatter field: (.+)\.$/);
    if (unknownField) {
      return t("agents.validation_unknown_frontmatter").replace("{field}", unknownField[1] ?? "");
    }
    const toolKey = message.match(/^Tool permission key '(.+)' is not allowed\.$/);
    if (toolKey) {
      return t("agents.validation_tool_key_not_allowed").replace("{tool}", toolKey[1] ?? "");
    }
    const permissionKey = message.match(/^Permission key '(.+)' is not allowed\. Only '\*', 'skill', 'task', and allowlisted tool keys are allowed\.$/);
    if (permissionKey) {
      return t("agents.validation_permission_key_not_allowed").replace("{key}", permissionKey[1] ?? "");
    }
    const permissionBlockType = message.match(/^Permission block '(.+)' must be a mapping containing only '\*' key\.$/);
    if (permissionBlockType) {
      return t("agents.validation_permission_block_mapping").replace("{block}", permissionBlockType[1] ?? "");
    }
    const permissionBlockMissingWildcard = message.match(/^Permission block '(.+)' must define '\*' key\.$/);
    if (permissionBlockMissingWildcard) {
      return t("agents.validation_permission_block_wildcard_required").replace("{block}", permissionBlockMissingWildcard[1] ?? "");
    }
    const permissionBlockUnexpectedKey = message.match(/^Permission block '(.+)' only allows '\*' key; found '(.+)'\.$/);
    if (permissionBlockUnexpectedKey) {
      return t("agents.validation_permission_block_unexpected_key")
        .replace("{block}", permissionBlockUnexpectedKey[1] ?? "")
        .replace("{key}", permissionBlockUnexpectedKey[2] ?? "");
    }
    if (/^Permission at '.+' must be one of: allow, ask, deny\.$/.test(message)) {
      return t("agents.validation_permission_enum");
    }
    if (/^Permission at '.+' must be a string \(allow\/ask\/deny\) or a mapping\.$/.test(message)) {
      return t("agents.validation_permission_value_shape");
    }
    if (/^Permission key under '.+' cannot be empty\.$/.test(message) || message === "Permission keys cannot be empty.") {
      return t("agents.validation_permission_key_empty");
    }
    return message;
  };

  onCleanup(() => {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  });

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      setToast(null);
      toastTimer = null;
    }, 2400);
  };

  const loadCatalog = async () => {
    if (!props.loadToolsSkills) {
      setAvailableTools([]);
      setAvailableSkills([]);
      setProtectedFilePipelineAvailable(false);
      setProtectedFilePipelineEnabled(false);
      setAvailableMcpServers([]);
      setSelectedTools([]);
      setSelectedSkills([]);
      setSelectedCustomTools([]);
      setSelectedCustomSkills([]);
      setCatalogError(null);
      return;
    }

    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const next = await props.loadToolsSkills();
      const tools = (next.tools ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      const skills = (next.skills ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      const mcpServers = (next.mcpServers ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      setAvailableTools(tools);
      setAvailableSkills(skills);
      const pipelineAvailable = next.protectedFilePipelineAvailable === true;
      setProtectedFilePipelineAvailable(pipelineAvailable);
      if (!pipelineAvailable) setProtectedFilePipelineEnabled(false);
      setAvailableMcpServers(mcpServers);

      // A catalog reload can flip category availability mid-session (bundle
      // switch, edge connect). Clamp the persisted selection to what the new
      // catalog backs, and drop out of a detail view whose category just went
      // away — it would otherwise sit on an empty panel.
      const nextAvailable = availableCategoryIds(
        tools.map((item) => item.name),
        skills.map((item) => item.name),
      );
      const packageSnapshot = clampPackageSelection(categoryPackageSelection(), nextAvailable);
      setCategoryPackageSelection(packageSnapshot);
      const expanded = expandedCategory();
      if (expanded && !nextAvailable.has(expanded)) setExpandedCategory(null);

      const selectedByPackageTools = CAPABILITY_CATEGORIES.flatMap((category) => {
        const level = packageSnapshot[category.id] ?? "none";
        if (level === "none") return [] as string[];
        return riskToolItems(category.id, level).map((item) => item.name);
      });
      const selectedByPackageSkills = CAPABILITY_CATEGORIES.flatMap((category) => {
        const level = packageSnapshot[category.id] ?? "none";
        if (level === "none") return [] as string[];
        return riskSkillItems(category.id, level).map((item) => item.name);
      });

      const customSkills = skills
        .filter((item) => classifySkillCategory(item.name) === null && item.source === "workspace-user")
        .map((item) => item.name);
      const customMcpTools = mcpServers.map((item) => `${item.name}_*`);
      const customSkillSet = new Set(customSkills);
      const customToolSet = new Set(customMcpTools);

      const nextCustomSkills = selectedCustomSkills().filter((name) => customSkillSet.has(name));
      const nextCustomTools = selectedCustomTools().filter((name) => customToolSet.has(name));
      setSelectedCustomSkills(nextCustomSkills);
      setSelectedCustomTools(nextCustomTools);

      const autoTools = tools.filter((item) => classifyToolCategory(item.name) === null).map((item) => item.name);
      const autoSkills = skills
        .filter((item) => classifySkillCategory(item.name) === null && item.source !== "workspace-user")
        .map((item) => item.name);

      const nextSelectedSkills = [...new Set([...selectedByPackageSkills, ...nextCustomSkills, ...autoSkills])];
      const nextSelectedTools = [...new Set([...selectedByPackageTools, ...nextCustomTools, ...autoTools, ...requiredToolsFromSkills(nextSelectedSkills)])];

      setSelectedSkills(nextSelectedSkills);
      setSelectedTools(nextSelectedTools);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : "Failed to load tools and skills.");
      setAvailableTools([]);
      setAvailableSkills([]);
      setProtectedFilePipelineAvailable(false);
      setProtectedFilePipelineEnabled(false);
      setAvailableMcpServers([]);
    } finally {
      setCatalogLoading(false);
    }
  };

  onMount(() => {
    void loadCatalog();

    if (!props.watchToolsSkillsChanges) return;

    let stopped = false;
    let cursor: number | undefined;
    let initialized = false;
    let timerRef: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      if (stopped) return;
      try {
        const events = await props.watchToolsSkillsChanges?.(cursor);
        if (!events || stopped) return;

        if (events.disabled) {
          stopped = true;
          if (timerRef !== undefined) clearInterval(timerRef);
          return;
        }

        cursor = typeof events.cursor === "number" ? events.cursor : cursor;

        if (!initialized) {
          initialized = true;
          return;
        }

        const changed = (events.items ?? []).some((item) => {
          return item.reason === "skills" || item.reason === "plugins" || item.reason === "commands" || item.reason === "config" || item.reason === "agents" || item.reason === "mcp";
        });
        if (changed) {
          await loadCatalog();
        }
      } catch {
        // Keep polling after transient errors.
      }
    };

    timerRef = setInterval(() => {
      void tick();
    }, 5000);

    onCleanup(() => {
      stopped = true;
      if (timerRef !== undefined) clearInterval(timerRef);
    });
  });

  // Tools/skills that don't match any of the four capability categories are
  // treated as a fixed baseline, not a "none"-gated capability: they're
  // included unconditionally, independent of categoryPackageSelection, and
  // never rendered as a checkbox for the user to uncheck. This is deliberate
  // for OpenCode runtime primitives (doom_loop/question) that every agent
  // needs regardless of which categories it opts into.
  //
  // todowrite and todoread are NOT in this baseline and NOT in the catalog at
  // all (tool-skill-catalog.ts excludes them alongside internal pipeline
  // tools). This aligns with the shipped specialist agent design: only
  // the coordinator agent (superclaw-default) receives these
  // tools via explicit permission grants. User-created agents are specialist
  // agents and must not loop via planning-only tool calls when stuck.
  //
  // Internal-pipeline tools (protected-file pipeline, direct local sensitive
  // reads, messaging bridge, hybrid-DR sidecar) are excluded from the catalog.
  // Protected-file access is available only through the gated option above.
  const autoIncludedToolNames = (items: CapabilityItem[] = availableTools()) =>
    items.filter((item) => classifyToolCategory(item.name) === null).map((item) => item.name);

  const autoIncludedSkillNames = (items: CapabilityItem[] = availableSkills()) =>
    items
      .filter((item) => classifySkillCategory(item.name) === null && item.source !== "workspace-user")
      .map((item) => item.name);

  const customSkillItems = () =>
    availableSkills().filter(
      (item) => classifySkillCategory(item.name) === null && item.source === "workspace-user",
    );

  const recomputeSelectedCapabilities = (
    packageSelection: Record<string, PackageLevel>,
    customTools: string[] = selectedCustomTools(),
    customSkills: string[] = selectedCustomSkills(),
    availableToolItems: CapabilityItem[] = availableTools(),
    availableSkillItems: CapabilityItem[] = availableSkills(),
  ) => {
    const selectedByPackageTools = CAPABILITY_CATEGORIES.flatMap((category) => {
      const level = packageSelection[category.id] ?? "none";
      if (level === "none") return [] as string[];
      return riskToolItems(category.id, level).map((item) => item.name);
    });
    const selectedByPackageSkills = CAPABILITY_CATEGORIES.flatMap((category) => {
      const level = packageSelection[category.id] ?? "none";
      if (level === "none") return [] as string[];
      return riskSkillItems(category.id, level).map((item) => item.name);
    });

    const autoTools = autoIncludedToolNames(availableToolItems);
    const autoSkills = autoIncludedSkillNames(availableSkillItems);

    const nextSelectedSkills = [...new Set([...selectedByPackageSkills, ...customSkills, ...autoSkills])];
    const nextSelectedTools = [...new Set([...selectedByPackageTools, ...customTools, ...autoTools, ...requiredToolsFromSkills(nextSelectedSkills)])];

    setSelectedSkills(nextSelectedSkills);
    setSelectedTools(nextSelectedTools);
  };

  const updatePackageSelection = (updater: (prev: Record<string, PackageLevel>) => Record<string, PackageLevel>) => {
    setCategoryPackageSelection((prev) => {
      const next = updater(prev);
      recomputeSelectedCapabilities(next);
      return next;
    });
  };

  const toggleCustomTool = (name: string) => {
    setSelectedCustomTools((prev) => {
      const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name];
      recomputeSelectedCapabilities(categoryPackageSelection(), next, selectedCustomSkills());
      return next;
    });
  };

  const toggleCustomSkill = (name: string) => {
    setSelectedCustomSkills((prev) => {
      const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name];
      recomputeSelectedCapabilities(categoryPackageSelection(), selectedCustomTools(), next);
      return next;
    });
  };

  const setCategoryPackage = (categoryId: string, level: PackageLevel) => {
    updatePackageSelection((prev) => ({ ...prev, [categoryId]: level }));
  };

  const categoryToolItems = (categoryId: string) => {
    return availableTools().filter((item) => classifyToolCategory(item.name) === categoryId);
  };

  const categorySkillItems = (categoryId: string) => {
    return availableSkills().filter((item) => classifySkillCategory(item.name) === categoryId);
  };

  const coreRiskToolItems = (categoryId: string, level: RiskLevel) => {
    return categoryToolItems(categoryId).filter((item) => classifyToolRisk(item.name) === level);
  };

  const coreRiskSkillItems = (categoryId: string, level: RiskLevel) => {
    return categorySkillItems(categoryId).filter((item) => classifySkillRisk(item.name) === level);
  };

  const riskToolItems = (categoryId: string, level: RiskLevel) => {
    if (level === "low") return coreRiskToolItems(categoryId, "low");
    return [...new Map([...coreRiskToolItems(categoryId, "low"), ...coreRiskToolItems(categoryId, "high")].map((item) => [item.name, item])).values()];
  };

  const riskSkillItems = (categoryId: string, level: RiskLevel) => {
    if (level === "low") return coreRiskSkillItems(categoryId, "low");
    return [...new Map([...coreRiskSkillItems(categoryId, "low"), ...coreRiskSkillItems(categoryId, "high")].map((item) => [item.name, item])).values()];
  };

  const riskToolNames = (categoryId: string, level: RiskLevel) => riskToolItems(categoryId, level).map((item) => item.name);
  const riskSkillNames = (categoryId: string, level: RiskLevel) => riskSkillItems(categoryId, level).map((item) => item.name);

  const displayRiskToolItems = (categoryId: string, level: RiskLevel) => {
    const baseTools = riskToolItems(categoryId, level);
    const levelSkills = riskSkillItems(categoryId, level).map((item) => item.name);
    const dependencyToolNames = requiredToolsFromSkills(levelSkills);
    const dependencyTools = dependencyToolNames.map((name) => {
      return availableTools().find((item) => item.name === name) ?? ({ name } as CapabilityItem);
    });
    return [...new Map([...baseTools, ...dependencyTools].map((item) => [item.name, item])).values()];
  };

  const displayRiskToolNames = (categoryId: string, level: RiskLevel) =>
    displayRiskToolItems(categoryId, level).map((item) => item.name);

  const isCustomToolSelected = (name: string) => selectedCustomTools().includes(name);
  const isCustomSkillSelected = (name: string) => selectedCustomSkills().includes(name);

  const customMcpTools = () =>
    availableMcpServers().map((item) => ({
      name: `${item.name}_*`,
      serverName: item.name,
    }));

  const categoryPackageLevel = (categoryId: string): PackageLevel => categoryPackageSelection()[categoryId] ?? "none";

  const categoryEnabled = (categoryId: string) => {
    const level = categoryPackageLevel(categoryId);
    return level === "high" || level === "low";
  };

  const toggleCategoryPackage = (categoryId: string, enabled: boolean) => {
    if (!enabled) {
      setCategoryPackage(categoryId, "none");
      if (expandedCategory() === categoryId) setExpandedCategory(null);
      return;
    }
    const label = t(CAPABILITY_CATEGORIES.find((item) => item.id === categoryId)?.labelKey ?? "");
    const confirmed = window.confirm(t("agents.high_permission_confirm").replace("{name}", label));
    if (!confirmed) return;
    setCategoryPackage(categoryId, "high");
  };

  const expandedCategoryLabel = () => {
    const categoryId = expandedCategory();
    if (!categoryId) return "";
    const category = CAPABILITY_CATEGORIES.find((item) => item.id === categoryId);
    return category ? t(category.labelKey) : categoryId;
  };

  // All agents come from .opencode/agents/ (server-side filtered)
  const userAgents = () => props.agents;

  const canSave = () => {
    const n = name().trim();
    if (!n) return false;
    if (/\s/.test(n)) return false;
    if (/[^a-zA-Z0-9_-]/.test(n)) return false;
    return !busy() && !props.busy;
  };

  const loadMarkdownFile = async (file: File) => {
    const fileName = (file.name || "").trim();
    if (!/\.md$/i.test(fileName)) {
      clearUploadedMarkdown();
      setStatus(null);
      setUploadError(t("agents.upload_invalid_type"));
      return;
    }
    const content = await file.text();
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      clearUploadedMarkdown();
      setStatus(null);
      setUploadError(t("agents.upload_empty"));
      return;
    }

    const parsed = parseUploadedAgentMarkdown(content, fileName);
    if (parsed.invalidFields.length) {
      clearUploadedMarkdown();
      setAutoFilledFields([]);
      setStatus(null);
      setUploadError(
        `${t("agents.upload_parse_error_prefix")}${t("agents.upload_parse_error_fields").replace("{fields}", parsed.invalidFields.join(", "))}`,
      );
      return;
    }

    setName(parsed.name);
    setDescription(parsed.description);
    setSystemPrompt(parsed.systemPrompt);
    setProtectedFilePipelineEnabled(false);
    updatePackageSelection((prev) => {
      const next: Record<string, PackageLevel> = { ...prev };
      for (const category of CAPABILITY_CATEGORIES) {
        next[category.id] = "none";
      }
      return clampPackageSelection(next, availableCategories());
    });
    setAutoFilledFields([
      t("agents.field_name"),
      t("agents.field_description"),
      t("agents.field_system_prompt"),
    ]);
    setUploadedFileName(fileName);
    setLastQuickSetupSource("upload");
    setStatus(t("agents.upload_success").replace("{name}", fileName));
    setError(null);
    setUploadError(null);
    if (uploadInputRef) uploadInputRef.value = "";
  };

  const clearUploadedMarkdown = () => {
    setUploadedFileName(null);
    setAutoFilledFields([]);
    if (uploadInputRef) {
      uploadInputRef.value = "";
    }
  };

  const resetForm = () => {
    setName("");
    setDescription("");
    setSystemPrompt("");
    setSelectedTools([]);
    setSelectedSkills([]);
    setSelectedCustomTools([]);
    setSelectedCustomSkills([]);
    setProtectedFilePipelineEnabled(false);
    updatePackageSelection((prev) => {
      const next: Record<string, PackageLevel> = { ...prev };
      for (const category of CAPABILITY_CATEGORIES) {
        next[category.id] = "none";
      }
      return next;
    });
    clearUploadedMarkdown();
    setLastQuickSetupSource(null);
    setStatus(null);
    setError(null);
    setUploadError(null);
  };

  // Called from the inputs' onInput only, never from a reaction to the field
  // values: resetForm clears the fields in code right before a success
  // message is set, and that message must survive it.
  const clearSaveFeedback = () => {
    setError(null);
    if (lastQuickSetupSource() !== "upload") setStatus(null);
  };

  const handleSave = async () => {
    const trimmedName = name().trim();
    if (/\s/.test(trimmedName)) {
      setError(t("agents.name_no_spaces"));
      return;
    }
    if (!canSave()) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await props.onSave({
        name: trimmedName,
        description: description(),
        systemPrompt: systemPrompt(),
        selectedTools: selectedTools(),
        selectedSkills: selectedSkills(),
        askTools: selectedTools().filter((toolName) => classifyToolRisk(toolName) === "high"),
        protectedFilePipelineEnabled: protectedFilePipelineEnabled(),
      });
      resetForm();
      setStatus(t("agents.create_success").replace("{name}", trimmedName));
      props.refreshAgents();
    } catch (err) {
      if (err instanceof Error) {
        setError(localizeAgentValidationMessage(err.message));
      } else {
        setError("Failed to create agent");
      }
    } finally {
      setBusy(false);
    }
  };

  // Edit modal handlers. editContent holds the file; the form's description is
  // patched into it on save or on switching to markdown. A file whose
  // frontmatter does not parse opens in markdown mode.
  const showEditForm = (content: string) => {
    try {
      setEditDescription(readAgentDescription(content));
      setEditMode("form");
    } catch (e) {
      setEditMode("markdown");
      setEditError(e instanceof Error ? localizeAgentValidationMessage(e.message) : "Failed to read agent file.");
    }
  };

  // Trim what the user typed; a description left as parsed is kept byte-for-byte.
  const currentEditContent = () => {
    if (editMode() !== "form" || !editDirty()) return editContent();
    const typed = editDescription();
    const value = typed === readAgentDescription(editContent()) ? typed : typed.trim();
    return patchAgentDescription(editContent(), value);
  };

  const switchEditMode = (mode: AgentEditMode) => {
    if (mode === editMode()) return;
    setEditError(null);
    if (mode === "form") {
      showEditForm(editContent());
      return;
    }
    try {
      setEditContent(currentEditContent());
      setEditMode("markdown");
    } catch (e) {
      setEditError(e instanceof Error ? localizeAgentValidationMessage(e.message) : "Failed to update agent file.");
    }
  };

  // The card opens a read-only preview, the pencil opens the editor. Each open
  // or close starts a new session; a read that finishes after its session
  // ended must not touch the dialog, or saving would write it to another agent.
  let editSession = 0;
  const openAgent = async (agent: AgentInfo, view: "preview" | "edit") => {
    if (props.busy) return;
    const session = ++editSession;
    setEditTarget(agent);
    setEditView(view);
    setEditContent("");
    setEditMode("form");
    setEditDescription("");
    setEditDirty(false);
    setEditError(null);
    setEditLoading(true);
    try {
      const result = await props.readAgent(agent.name);
      if (session !== editSession) return;
      if (!result) {
        setEditMode("markdown");
        setEditError("Failed to load agent file.");
        return;
      }
      setEditContent(result.content);
      if (view === "edit") showEditForm(result.content);
    } catch (e) {
      if (session !== editSession) return;
      setEditMode("markdown");
      setEditError(e instanceof Error ? `Failed to load agent file: ${e.message}` : "Failed to load agent file.");
    } finally {
      if (session === editSession) setEditLoading(false);
    }
  };

  // A load error has already put the editor in markdown mode; keep its message.
  const editFromPreview = () => {
    setEditView("edit");
    if (!editError()) showEditForm(editContent());
  };

  const closeEdit = () => {
    editSession += 1;
    setEditTarget(null);
    setEditContent("");
    setEditMode("form");
    setEditDescription("");
    setEditDirty(false);
    setEditError(null);
    setEditLoading(false);
  };

  const saveEdit = async () => {
    const agent = editTarget();
    if (!agent || !editDirty()) return;
    const session = editSession;
    setEditError(null);
    try {
      const content = currentEditContent();
      validateAgentMarkdown(content);
      const draft = { content: editContent(), description: editDescription(), mode: editMode() };
      await props.saveAgent(agent.name, content);
      showToast(`Agent "${agent.name}" saved.`);
      // The dialog may have closed, switched agents or been edited during the
      // save; only an untouched draft becomes the saved file.
      if (
        editTarget() !== agent ||
        editContent() !== draft.content ||
        editDescription() !== draft.description ||
        editMode() !== draft.mode
      ) {
        return;
      }
      setEditContent(content);
      setEditDirty(false);
    } catch (e) {
      const message = e instanceof Error ? localizeAgentValidationMessage(e.message) : "Failed to save agent.";
      // Once the dialog has moved on, its banner belongs to another file.
      if (session !== editSession) {
        showToast(`Agent "${agent.name}" was not saved: ${message}`);
        return;
      }
      setEditError(message);
    }
  };

  // Delete handlers
  const confirmDelete = async () => {
    const agent = deleteTarget();
    if (!agent) return;
    setDeleteBusy(true);
    try {
      await props.deleteAgent(agent.name);
      setDeleteTarget(null);
      showToast(`Agent "${agent.name}" deleted.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to delete agent.");
      setDeleteTarget(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  const inputClasses =
    `w-full rounded-control ${formControlChromeClass} px-3 py-2 text-body-lg shadow-sm`;

  let createDescriptionRef: HTMLTextAreaElement | undefined;
  let createSystemPromptRef: HTMLTextAreaElement | undefined;
  const DESCRIPTION_MIN_HEIGHT_PX = 56;
  const SYSTEM_PROMPT_MIN_HEIGHT_PX = 72;

  const fitTextareaHeight = (el: HTMLTextAreaElement | undefined, minHeightPx: number) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeightPx, el.scrollHeight)}px`;
  };

  createEffect(() => {
    description();
    queueMicrotask(() => fitTextareaHeight(createDescriptionRef, DESCRIPTION_MIN_HEIGHT_PX));
  });

  createEffect(() => {
    systemPrompt();
    queueMicrotask(() => fitTextareaHeight(createSystemPromptRef, SYSTEM_PROMPT_MIN_HEIGHT_PX));
  });

  const filledInputClass = (value: string) =>
    value.trim()
      ? "border-dls-success-border shadow-[var(--dls-success-focus-shadow)]"
      : "";

  return (
    <div class="space-y-8" data-testid="agents-content">
      {/* Toast */}
      <Show when={toast()}>
        <div class="fixed bottom-6 right-6 z-50 max-w-sm rounded-inset border border-dls-border bg-dls-surface-solid px-4 py-3 text-caption text-dls-text shadow-2xl">
          {toast()}
        </div>
      </Show>

      {/* Header */}
      <div>
        <h2 class="text-display-lg font-bold text-dls-text">{t("agents.name")}</h2>
      </div>

      {/* Installed agents list */}
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-label font-bold text-dls-secondary uppercase tracking-widest">
            {t("agents.your_agent")}
          </h3>
          <button
            type="button"
            onClick={() => {
              props.refreshAgents();
              void loadCatalog();
            }}
            disabled={props.busy || catalogLoading()}
            class={`flex items-center gap-1.5 text-caption font-medium transition-colors ${props.busy || catalogLoading()
              ? "text-dls-secondary"
              : "text-dls-secondary hover:text-dls-text"
              }`}
          >
            <RefreshCw size={14} class={catalogLoading() ? "animate-spin" : ""} />
            {t("common.refresh")}
          </button>
        </div>

        <Show
          when={userAgents().length}
          fallback={
            <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg px-5 py-6 text-body-lg text-dls-secondary">
              {t("agents.no_custom_agents")}
            </div>
          }
        >
          <div
            class={`overflow-hidden rounded-inset border border-dls-panel-border bg-dls-panel-bg divide-y divide-dls-border ${userAgents().length > 6 ? "max-h-[22rem] overflow-y-auto" : ""}`}
          >
            <For each={userAgents()}>
              {(agent) => (
                <Tooltip
                  content={agent.description?.trim() || t("agents.agent_description_unavailable")}
                  maxWidthClass="max-w-[280px]"
                  class="flex w-full min-w-0"
                  anchorToCursor
                >
                  <div
                    role="button"
                    tabindex="0"
                    data-testid="user-agent-card"
                    class="flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-dls-hover"
                    onClick={() => void openAgent(agent, "preview")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        if (e.target !== e.currentTarget || e.isComposing || e.keyCode === 229) return;
                        e.preventDefault();
                        void openAgent(agent, "preview");
                      }
                    }}
                  >
                  <div class="flex min-w-0 items-center gap-3">
                    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-dls-hover/60 text-dls-secondary">
                      <Bot size={18} />
                    </div>
                    <h4 class="min-w-0 truncate text-body-lg font-semibold text-dls-text">{agent.name}</h4>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      data-testid="user-agent-edit-btn"
                      class="p-1.5 text-dls-secondary hover:text-dls-text hover:bg-dls-active rounded-subtle transition-colors"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void openAgent(agent, "edit");
                      }}
                      disabled={props.busy}
                      title={t("common.edit")}
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      type="button"
                      data-testid="user-agent-delete-btn"
                      class={`p-1.5 rounded-subtle transition-colors ${props.busy || !props.canDelete
                        ? "text-dls-secondary opacity-40"
                        : "text-dls-secondary hover:text-dls-danger-text hover:bg-dls-danger-bg"
                        }`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (props.busy || !props.canDelete) return;
                        setDeleteTarget(agent);
                      }}
                      disabled={props.busy || !props.canDelete}
                      title={t("common.delete")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  </div>
                </Tooltip>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* Create new agent form */}
      <div class="space-y-4">
        <h3 class="text-label font-bold text-dls-secondary uppercase tracking-widest">
          {t("agents.create_new")}
        </h3>

        <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg shadow-[var(--dls-card-shadow-rest)]">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 border-b border-dls-border px-5 py-4 text-left"
            onClick={() => setQuickSetupCollapsed((prev) => !prev)}
            aria-expanded={!quickSetupCollapsed()}
          >
            <div class="text-body-lg font-semibold text-dls-text">{t("agents.quick_setup_title")}</div>
            <ChevronRight size={14} class={`text-dls-secondary transition-transform ${quickSetupCollapsed() ? "" : "rotate-90"}`} />
          </button>

          <Show when={!quickSetupCollapsed()}>
            <div class="space-y-4 px-5 py-4">
            <div>
              <div role="alert" class="empty:hidden">
                <Show when={uploadError()}>
                  {(msg) => (
                    <div class="mb-3 rounded-inset border border-dls-danger-border bg-dls-danger-bg px-3 py-2 text-body-lg text-dls-danger-text" data-testid="agent-upload-error">
                      <div class="flex items-start gap-2">
                        <AlertTriangle size={16} class="mt-0.5 shrink-0 text-dls-danger-text" />
                        <span>{msg()}</span>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
              <Show when={lastQuickSetupSource() === "upload" && (status() || autoFilledFields().length)}>
                <div class="mb-3 rounded-inset border border-dls-success-border bg-dls-success-bg px-3 py-2 text-body-lg text-dls-success-text">
                  <div class="flex items-start gap-2">
                    <Check size={16} class="mt-0.5 shrink-0 text-dls-success-text" />
                    <div class="min-w-0">
                      <Show when={status()}>
                        {(msg) => <div>{msg()}</div>}
                      </Show>
                      <Show when={autoFilledFields().length}>
                        <div>
                          {t("agents.upload_autofill_success").replace("{fields}", autoFilledFields().join(", "))}
                        </div>
                      </Show>
                      <div>{t("agents.quick_setup_next_step")}</div>
                    </div>
                  </div>
                </div>
              </Show>
              <div class="mb-2 text-caption text-dls-secondary">{t("agents.upload_section_title")}</div>
            <input
              ref={uploadInputRef}
              type="file"
              accept=".md,text/markdown"
              class="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                void loadMarkdownFile(file);
              }}
            />

            <div
              role="button"
              tabindex="0"
              aria-disabled={busy()}
              class="w-full cursor-pointer rounded-inset border border-dashed border-dls-panel-inset-border bg-dls-panel-inset-bg px-4 py-6 text-left transition-colors hover:bg-dls-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
              onClick={() => {
                if (!busy()) uploadInputRef?.click();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (!busy()) uploadInputRef?.click();
                }
              }}
            >
              <div class="flex items-start gap-3">
                <div class="mt-0.5 rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg p-2">
                  <Upload size={16} class="text-dls-secondary" />
                </div>
                <div class="min-w-0">
                  <p class="text-body-lg font-medium text-dls-text">{t("agents.upload_hint")}</p>
                  <Show when={uploadedFileName()}>
                    <div class="mt-2 flex items-center justify-between gap-2 rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg px-3 py-2">
                      <span class="truncate text-caption text-dls-text">{uploadedFileName()}</span>
                      <button
                        type="button"
                        class="shrink-0 text-caption text-dls-secondary hover:text-dls-text"
                        onClick={(event) => {
                          event.stopPropagation();
                          clearUploadedMarkdown();
                        }}
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
            </div>
          </div>
          </Show>
        </div>

        {/* resetForm runs when the save completes, so anything edited while it is
            pending would be discarded. */}
        <fieldset disabled={busy()} class="min-w-0" data-testid="agent-custom-setup">
        <Card title={t("agents.custom_setup_title")} class="!bg-dls-panel-bg !border-dls-panel-border">
          <div class="space-y-6">
            <div class="space-y-5">
              <div>
                <label class="block mb-1.5 text-caption font-medium text-dls-secondary">
                  {t("common.name")}
                </label>
                <TextInput
                  data-testid="agent-name-input"
                  value={name()}
                  onInput={(e) => {
                    setName(e.currentTarget.value);
                    clearSaveFeedback();
                  }}
                  placeholder="my-agent"
                  hint={t("agents.hint")}
                  class={filledInputClass(name())}
                />
                <Show when={/\s/.test(name().trim())}>
                  <p class="mt-1 text-caption text-dls-danger-text">{t("agents.name_no_spaces")}</p>
                </Show>
              </div>

              <div>
                <label class="block mb-1.5 text-caption font-medium text-dls-secondary">
                  {t("agents.description_title")}
                </label>
                <textarea
                  ref={createDescriptionRef}
                  data-testid="agent-description-input"
                  class={`${inputClasses} resize-none overflow-hidden ${filledInputClass(description())}`}
                  rows={2}
                  value={description()}
                  onInput={(e) => {
                    setDescription(e.currentTarget.value);
                    clearSaveFeedback();
                    fitTextareaHeight(e.currentTarget, DESCRIPTION_MIN_HEIGHT_PX);
                  }}
                  placeholder={t("agents.description_placeholder")}
                />
              </div>

              <div>
                <label class="block mb-1.5 text-caption font-medium text-dls-secondary">
                  {t("agents.system_prompt_card")}
                </label>
                <textarea
                  ref={createSystemPromptRef}
                  data-testid="agent-system-prompt-input"
                  class={`${inputClasses} resize-none overflow-hidden ${filledInputClass(systemPrompt())}`}
                  rows={2}
                  value={systemPrompt()}
                  onInput={(e) => {
                    setSystemPrompt(e.currentTarget.value);
                    clearSaveFeedback();
                    fitTextareaHeight(e.currentTarget, SYSTEM_PROMPT_MIN_HEIGHT_PX);
                  }}
                  placeholder={t("agents.system_prompt_hint")}
                />
                <p class="mt-2 text-caption text-dls-secondary">
                  {t("agents.system_instructions")}
                </p>
              </div>
            </div>

            <div class="border-t border-dls-border pt-4">
              <div class="mb-2 text-body-lg font-semibold text-dls-text">{t("agents.tools_skills_card")}</div>
              <AgentCreatorCapabilitySelection
                visibleCategories={visibleCategories()}
                categoryEnabled={categoryEnabled}
                onToggleCategory={toggleCategoryPackage}
                catalogError={catalogError()}
                expandedCategory={expandedCategory()}
                setExpandedCategory={setExpandedCategory}
                expandedCategoryLabel={expandedCategoryLabel()}
                grantedDisplayRiskToolItems={(categoryId) => displayRiskToolItems(categoryId, "high")}
                grantedRiskSkillItems={(categoryId) => riskSkillItems(categoryId, "high")}
                categoryIncludedWhenChecked={(categoryId) => categoryEnabled(categoryId)}
                customSkillItems={customSkillItems}
                isCustomSkillSelected={isCustomSkillSelected}
                toggleCustomSkill={toggleCustomSkill}
                mcpBlockVisible={mcpBlockVisible}
                customMcpTools={customMcpTools}
                isCustomToolSelected={isCustomToolSelected}
                toggleCustomTool={toggleCustomTool}
                protectedFilePipelineAvailable={protectedFilePipelineAvailable()}
                protectedFilePipelineEnabled={protectedFilePipelineEnabled()}
                onProtectedFilePipelineChange={setProtectedFilePipelineEnabled}
                skillDescription={props.skillDescription}
              />
            </div>

            {/* Live regions stay mounted: content inserted into an existing region is
                announced reliably, a freshly inserted region often is not. */}
            <div role="alert" class="empty:hidden">
              <Show when={error()}>
                {(msg) => (
                  <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-3 py-2 text-body-lg text-dls-danger-text">
                    <div class="flex items-start gap-2">
                      <AlertTriangle size={16} class="mt-0.5 shrink-0 text-dls-danger-text" />
                      <span>{msg()}</span>
                    </div>
                  </div>
                )}
              </Show>
            </div>

            <div role="status" class="empty:hidden">
              <Show when={lastQuickSetupSource() !== "upload" && status()}>
                {(msg) => (
                  <div class="rounded-inset border border-dls-success-border bg-dls-success-bg px-3 py-2 text-body-lg text-dls-success-text" data-testid="agent-create-success">
                    <div class="flex items-start gap-2">
                      <Check size={16} class="mt-0.5 shrink-0 text-dls-success-text" />
                      <span>{msg()}</span>
                    </div>
                  </div>
                )}
              </Show>
            </div>

            {/* Actions */}
            <div class="flex items-center justify-end gap-3 border-t border-dls-border pt-4">
              <Button variant="outline" onClick={resetForm} disabled={busy() || props.busy}>
                {t("settings.reset")}
              </Button>
              <Button variant="secondary" onClick={handleSave} disabled={!canSave()} data-testid="create-agent-btn">
                <Show when={busy()} fallback={<>{t("agents.create_agent")}</>}>
                  <Loader2 size={16} class="animate-spin" />
                  <span class="ml-2">{t("common.saving")}</span>
                </Show>
              </Button>
            </div>
          </div>
        </Card>
        </fieldset>
      </div>

      <Show when={editTarget() && editView() === "preview"}>
        <Dynamic
          component={props.filePreview}
          open
          title={editTarget()?.name ?? ""}
          content={agentFileForPreview(editContent())}
          loading={editLoading()}
          error={editError()}
          onClose={closeEdit}
          headerActions={
            <button
              type="button"
              data-testid="agent-preview-edit-btn"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-caption font-medium rounded-control bg-dls-hover text-dls-text hover:bg-dls-active transition-colors disabled:opacity-60"
              onClick={editFromPreview}
              disabled={props.busy || editLoading()}
            >
              <Edit2 size={14} />
              {t("common.edit")}
            </button>
          }
        />
      </Show>

      {/* Edit modal */}
      <Show when={editTarget() && editView() === "edit"}>
        <div class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="w-full max-w-4xl rounded-card border border-dls-border bg-dls-surface-solid shadow-2xl overflow-hidden">
            <div class="px-5 py-4 border-b border-dls-border flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-body-lg font-semibold text-dls-text truncate">{editTarget()!.name}</div>
                <div class="text-caption text-dls-secondary truncate">.opencode/agents/{editTarget()!.name}.md</div>
              </div>
              <div class="flex items-center gap-2">
                <AgentEditModeToggle mode={editMode()} disabled={editLoading()} onChange={switchEditMode} />
                <button
                  type="button"
                  data-testid="agent-edit-save-btn"
                  class={`px-3 py-1.5 text-caption font-medium rounded-control transition-colors ${editDirty() && !props.busy && props.canEdit
                    ? "bg-dls-text text-dls-surface-solid hover:opacity-90"
                    : "bg-dls-active text-dls-secondary"
                    }`}
                  disabled={!editDirty() || props.busy || !props.canEdit}
                  onClick={() => void saveEdit()}
                >
                  {t("common.save")}
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 text-caption font-medium rounded-control bg-dls-hover text-dls-text hover:bg-dls-active transition-colors"
                  onClick={closeEdit}
                >
                  {t("common.close")}
                </button>
              </div>
            </div>

            <div class="p-5 min-h-[460px]">
              <Show when={editError()}>
                <div class="mb-3 rounded-inset border border-dls-danger-border bg-dls-danger-bg px-4 py-3 text-caption text-dls-danger-text">
                  {editError()}
                </div>
              </Show>
              <Show
                when={!editLoading()}
                fallback={<div class="text-caption text-dls-secondary">{t("common.loading")}</div>}
              >
                <Show
                  when={editMode() === "markdown"}
                  fallback={
                    <AgentEditForm
                      name={editTarget()?.name ?? ""}
                      description={editDescription()}
                      readOnly={!props.canEdit}
                      onDescriptionInput={(value) => {
                        if (!props.canEdit) return;
                        setEditDescription(value);
                        setEditDirty(true);
                      }}
                    />
                  }
                >
                  <textarea
                    data-testid="agent-edit-markdown-input"
                    value={editContent()}
                    onInput={(e) => {
                      if (!props.canEdit) return;
                      setEditContent(e.currentTarget.value);
                      setEditDirty(true);
                    }}
                    readOnly={!props.canEdit}
                    class="block w-full min-h-[420px] rounded-inset border border-dls-border bg-dls-hover px-4 py-3 text-caption font-mono text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb)/0.25)]"
                    spellcheck={false}
                  />
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      {/* Delete confirmation modal */}
      <Show when={deleteTarget()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface-solid border border-dls-border w-full max-w-md rounded-card shadow-2xl overflow-hidden">
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-heading font-semibold text-dls-text">{t("agents.delete_agent")}</h3>
                  <p class="text-body-lg text-dls-secondary mt-1">
                    {t("agents.delete_confirmation").replace("{name}", deleteTarget()?.name ?? "")}
                  </p>
                </div>
              </div>

              <div class="mt-4 rounded-inset bg-dls-hover border border-dls-border p-3 text-caption text-dls-secondary font-mono break-all">
                .opencode/agents/{deleteTarget()?.name}.md
              </div>

              <div class="mt-6 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteBusy()}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="danger"
                  data-testid="agent-delete-confirm-btn"
                  onClick={() => void confirmDelete()}
                  disabled={deleteBusy()}
                >
                  <Show when={deleteBusy()} fallback={t("agents.delete_agent")}>
                    <Loader2 size={14} class="animate-spin" />
                    <span class="ml-1">{t("session.deleting")}</span>
                  </Show>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
