import { For, Show, createMemo, createSignal, createEffect, on, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../../i18n";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import type { ScheduledJob, ModelOption, ModelRef } from "../types";
import type { OpenworkServerClient, AgentLabSchedulePayload } from "../lib/openwork-server";
import { useCapabilityGate } from "~/shared/platform/capability/capability-gate";
import { getVisibleAgentOptions } from "~/shared/platform/capability/visible-agent-roster";
import { formControlChromeClass, formControlClass } from "~/shared/ui/text-input";
import { DEFAULT_MODEL } from "../constants";
import { usePlatform } from "../context/platform";
import { formatRelativeTime, isTauriRuntime } from "../utils";
import Button from "../components/button";
import ModelPickerModal from "../components/model-picker-modal";
import AutomationAgentSelect from "./scheduled.agent-select";
import {
  Check,
  ChevronDown,
  Clock,
  Plus,
  PlugZap,
  X,
} from "lucide-solid";
import { AutomationJobCard } from "./scheduled.cards";
import { AgentLabAutomationWithStatus, buildAutomationPrompt, buildCronFromDaily, isAutomationFormComplete, buildCronFromInterval, dayOptions, humanizeCron, pad2, scheduleDayReviewMessage, scheduleNeedsDayReview } from "./scheduled.cron";

const MODEL_PANEL_MAX_HEIGHT = 288;
const MODEL_PANEL_VIEWPORT_MARGIN = 8;

export type ScheduledTasksViewProps = {
  jobs: ScheduledJob[];
  source: "local" | "remote";
  sourceReady: boolean;
  status: string | null;
  legacySchedulerSupported?: boolean | null;
  busy: boolean;
  lastUpdatedAt: number | null;
  refreshJobs: (options?: { force?: boolean }) => void;
  deleteJob: (name: string) => Promise<void> | void;
  isWindows: boolean;
  activeWorkspaceRoot: string;
  openNewTask: () => void;
  setPrompt: (value: string) => void;
  newTaskDisabled: boolean;
  schedulerInstalled: boolean;
  canEditPlugins: boolean;
  addPlugin: (pluginNameOverride?: string) => void;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  canReloadWorkspace: boolean;
  openworkServerClient: OpenworkServerClient | null;
  openworkServerWorkspaceId: string | null;
  selectedModel: { providerID: string; modelID: string } | null;
  modelOptions: ModelOption[];
  openProviderAuthModal: () => Promise<void>;
  providerAuthModalOpen: boolean;
  /** Primary agents an automation can run as; absent hides the agent picker. */
  listAgents?: () => Promise<Agent[]>;
  /** Live per-session status ("running" while a turn is in flight), keyed by session id — the server never persists this for automations itself. */
  sessionStatusById?: Record<string, string>;
  onDetailsOpenChange?: (open: boolean) => void;
};

export default function ScheduledTasksView(props: ScheduledTasksViewProps) {
  const platform = usePlatform();
  const [installingScheduler, setInstallingScheduler] = createSignal(false);
  const [schedulerInstallRequested, setSchedulerInstallRequested] = createSignal(false);

  // --- AgentLab scheduler state ---
  const [agentLabAutomations, setAgentLabAutomations] = createSignal<AgentLabAutomationWithStatus[]>([]);
  const [agentLabBusy, setAgentLabBusy] = createSignal(false);
  const [agentLabError, setAgentLabError] = createSignal<string | null>(null);

  // Serialize only server-owned fields so a quiet refresh can detect real
  // changes (e.g. a scheduler auto-run updating lastRunAt) and skip re-render
  // otherwise — avoids row churn from identical polls.
  // lastRunStatus is excluded: runAutomationNow sets "failed" locally after a
  // rejected request, but the server's list never echoes that back, so
  // including it here would make every unchanged quiet poll replace the local
  // "failed" record with the server's ("ran"/undefined), clearing the badge.
  const serializeAutomations = (items: AgentLabAutomationWithStatus[]) =>
    JSON.stringify(
      items.map((a) => ({
        id: a.id,
        name: a.name,
        enabled: a.enabled,
        schedule: a.schedule,
        prompt: a.prompt,
        model: a.model,
        agent: a.agent,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        lastRunAt: a.lastRunAt,
        lastRunSessionId: a.lastRunSessionId,
        lastRunError: a.lastRunError,
      })),
    );

  const loadAgentLabAutomations = async (options?: { quiet?: boolean }) => {
    const client = props.openworkServerClient;
    const wsId = props.openworkServerWorkspaceId?.trim();
    if (!client || !wsId) {
      return;
    }
    // Quiet reloads (background poll) must not toggle agentLabBusy — that flag
    // drives the action buttons' disabled styling and would make them flicker.
    if (!options?.quiet) {
      setAgentLabBusy(true);
      setAgentLabError(null);
    }
    try {
      const res = await client.listAgentLabAutomations(wsId);
      const items = Array.isArray(res.items) ? res.items : [];
      setAgentLabAutomations((prev) =>
        options?.quiet && serializeAutomations(prev) === serializeAutomations(items) ? prev : items,
      );
    } catch (err) {
      if (!options?.quiet) {
        console.error("[Automations] Load failed:", err);
        setAgentLabError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!options?.quiet) setAgentLabBusy(false);
    }
  };

  // Load schedulers when the component mounts or workspace changes.
  // Guard against reloading on unrelated prop churn (host-info is polled every ~10s upstream, which re-fires this effect). 
  // Only reload when the workspace id actually changes, otherwise agentLabBusy toggles and the action buttons flicker.
  let lastAutomationsWsId: string | null = null;
  createEffect(() => {
    const wsId = props.openworkServerWorkspaceId?.trim() || null;
    const hasClient = Boolean(props.openworkServerClient);
    if (!wsId || !hasClient) {
      lastAutomationsWsId = null;
      return;
    }
    if (wsId === lastAutomationsWsId) return;
    lastAutomationsWsId = wsId;
    void loadAgentLabAutomations();
  });

  // Background poll so server-side scheduler runs (which update lastRunAt on the
  // server) are reflected in the status badge without the user navigating away.
  // Reads props at call time (not a tracked scope) so the ~10s prop churn does
  // not reset the timer, and stays quiet to avoid button flicker.
  if (typeof window !== "undefined") {
    const automationsPollTimer = window.setInterval(() => {
      if (document.hidden) return;
      const wsId = props.openworkServerWorkspaceId?.trim();
      if (!wsId || !props.openworkServerClient) return;
      void loadAgentLabAutomations({ quiet: true });
    }, 15_000);
    onCleanup(() => window.clearInterval(automationsPollTimer));
  }

  // On an automation's first scheduled run (or after its session is replaced),
  // lastRunSessionId isn't known locally until the next poll above — up to 15s
  // away — so a short run can start and finish without ever reading "Running".
  // sessionStatusById updates over SSE as soon as the server starts the run, well
  // before that poll would. When a session we don't yet track turns running/retry,
  // poll immediately instead of waiting out the interval.
  const seenUnassociatedSessionIds = new Set<string>();
  createEffect(() => {
    const statuses = props.sessionStatusById;
    if (!statuses) return;
    const knownSessionIds = new Set(
      agentLabAutomations()
        .map((a) => a.lastRunSessionId)
        .filter((id): id is string => Boolean(id)),
    );
    let foundUnassociated = false;
    for (const [sessionId, status] of Object.entries(statuses)) {
      if (status !== "running" && status !== "retry") continue;
      if (knownSessionIds.has(sessionId) || seenUnassociatedSessionIds.has(sessionId)) continue;
      seenUnassociatedSessionIds.add(sessionId);
      foundUnassociated = true;
    }
    if (foundUnassociated) void loadAgentLabAutomations({ quiet: true });
  });

  // Convert AgentLab schedulers into the ScheduledJob shape used by the UI
  const agentLabAsJobs = createMemo((): ScheduledJob[] =>
    agentLabAutomations().map((a): ScheduledJob => {
      const scheduleToCron = (s: AgentLabSchedulePayload): string => {
        if (s.kind === "interval") return `*/${Math.round(s.seconds / 60)} * * * *`;
        if (s.kind === "daily") return `${s.minute} ${s.hour} * * *`;
        if (s.kind === "weekly") return `${s.minute} ${s.hour} * * ${s.weekday}`;
        if (s.kind === "days") return `${s.minute} ${s.hour} * * ${s.weekdays.join(",")}`;
        return "* * * * *";
      };
      return {
        slug: a.id,
        name: a.name,
        schedule: scheduleToCron(a.schedule),
        prompt: a.prompt,
        source: "agentlab",
        createdAt: new Date(a.createdAt).toISOString(),
        updatedAt: a.updatedAt ? new Date(a.updatedAt).toISOString() : undefined,
        lastRunAt: a.lastRunAt ? new Date(a.lastRunAt).toISOString() : undefined,
        lastRunStatus: a.lastRunStatus ?? (a.lastRunError ? "failed" : a.lastRunAt ? "ran" : undefined),
        lastRunError: a.lastRunError,
        needsDayReview: scheduleNeedsDayReview(a.schedule),
        run: {
          prompt: a.prompt,
          title: `Automation: ${a.name}`,
          agent: a.agent,
          model: a.model,
        },
      };
    }),
  );

  // Merge legacy jobs with AgentLab schedulers (deduplicate by slug/name)
  const allJobs = createMemo((): ScheduledJob[] => {
    const legacy = props.jobs;
    const agentLab = agentLabAsJobs();
    const legacySlugs = new Set(legacy.map((j) => j.slug));
    // Only add AgentLab jobs that don't already exist in the legacy list
    return [...legacy, ...agentLab.filter((j) => !legacySlugs.has(j.slug))];
  });

  const supported = createMemo(() => {
    if (props.source === "remote") return props.sourceReady;
    return (
      isTauriRuntime() &&
      !props.isWindows &&
      props.schedulerInstalled &&
      !schedulerInstallRequested()
    );
  });
  const schedulerGateActive = createMemo(() => {
    if (props.source !== "local") return false;
    if (!isTauriRuntime() || props.isWindows) return false;
    return !props.schedulerInstalled || schedulerInstallRequested();
  });
  const schedulerGateMode = createMemo(() => (props.schedulerInstalled ? "reload" : "install"));
  const automationDisabled = createMemo(() => props.newTaskDisabled || schedulerGateActive());
  const supportNote = createMemo(() => {
    if (props.source === "remote") {
      if (!props.sourceReady) return t("scheduled.server_unavailable_sync");
      return props.legacySchedulerSupported === false ? t("scheduled.legacy_unsupported") : null;
    }
    if (!isTauriRuntime()) return t("scheduled.requires_desktop");
    if (props.legacySchedulerSupported === false) return t("scheduled.legacy_unsupported");
    if (!props.schedulerInstalled || schedulerInstallRequested()) return null;
    return null;
  });
  const sourceLabel = createMemo(() =>
    props.source === "remote" ? t("scheduled.source_label_remote") : t("scheduled.source_label_local")
  );
  const schedulerLabel = createMemo(() => (props.source === "remote" ? t("scheduled.scheduler_label_remote") : t("scheduled.scheduler_label_local")));
  const schedulerHint = createMemo(() =>
    props.source === "remote" ? t("scheduled.scheduler_hint_remote") : t("scheduled.scheduler_hint_local")
  );
  const schedulerUnavailableHint = createMemo(() =>
    props.source === "remote" ? t("scheduled.scheduler_unavailable_remote") : t("scheduled.scheduler_unavailable_local")
  );
  const deleteDescription = createMemo(() =>
    props.source === "remote"
      ? t("scheduled.delete_desc_remote")
      : t("scheduled.delete_desc_local")
  );

  const lastUpdatedLabel = createMemo(() => {
    if (!props.lastUpdatedAt) return t("scheduled.not_synced_yet");
    return formatRelativeTime(props.lastUpdatedAt);
  });

  const [deleteTarget, setDeleteTarget] = createSignal<ScheduledJob | null>(null);
  const [deleteBusy, setDeleteBusy] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  // Keyed by slug, not by the job object: agentLabAsJobs() rebuilds every job
  // object on each poll/toggle, so identity-based state on the row itself
  // (e.g. a local createSignal in AutomationJobCard) gets reset by <For>'s
  // identity-based reconciliation even when that row's own data didn't change.
  const [openDetailsSlug, setOpenDetailsSlug] = createSignal<string | null>(null);
  const toggleExpanded = (slug: string) => {
    setOpenDetailsSlug((current) => (current === slug ? null : slug));
  };
  // A card deleted elsewhere unmounts without toggling, so drop its stale slug.
  createEffect(() => {
    const slug = openDetailsSlug();
    if (slug && !allJobs().some((job) => job.slug === slug)) setOpenDetailsSlug(null);
  });
  createEffect(() => props.onDetailsOpenChange?.(openDetailsSlug() !== null));
  onCleanup(() => props.onDetailsOpenChange?.(false));
  const [createModalOpen, setCreateModalOpen] = createSignal(false);
  const [editingAutomationId, setEditingAutomationId] = createSignal<string | null>(null);
  const [automationName, setAutomationName] = createSignal("");
  const [automationPrompt, setAutomationPrompt] = createSignal("");
  const [scheduleMode, setScheduleMode] = createSignal<"daily" | "interval">("daily");
  const [scheduleTime, setScheduleTime] = createSignal("09:00");
  const [scheduleDays, setScheduleDays] = createSignal(["mo", "tu", "we", "th", "fr"]);
  // Set while editing a `daily`/`weekly` record saved by the picker that
  // predated multi-day schedules — its original day selection could not be
  // recovered, so the restored days shown here are a guess the user must confirm.
  const [scheduleReviewMessage, setScheduleReviewMessage] = createSignal<string | null>(null);
  const [intervalMinutes, setIntervalMinutes] = createSignal("60");
  const [intervalBlurred, setIntervalBlurred] = createSignal(false);
  const validIntervalMinutes = () => /^\d+$/.test(intervalMinutes()) && Number(intervalMinutes()) >= 1 && Number(intervalMinutes()) <= 1440;
  const intervalErrorVisible = () => /\.\d/.test(intervalMinutes()) || Number(intervalMinutes()) > 1440 ||
    (intervalBlurred() && intervalMinutes() !== "" && !validIntervalMinutes());
  createEffect(() => {
    if (!createModalOpen()) {
      setEditingAutomationId(null);
    }
  });
  const [runningJobSlugs, setRunningJobSlugs] = createSignal<Set<string>>(new Set());

  // Model selection for schedulers – defaults to selectedModel or DEFAULT_MODEL
  const initialModel = (): ModelRef =>
    props.selectedModel ?? DEFAULT_MODEL;
  const [automationModel, setAutomationModel] = createSignal<ModelRef>(initialModel());
  // Quick inline dropdown (matches the composer's model picker); the full
  // ModelPickerModal is reserved for search/connecting a new provider.
  const [modelDropdownOpen, setModelDropdownOpen] = createSignal(false);
  const [modelDropdownPos, setModelDropdownPos] = createSignal<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number }>({
    left: 0,
    width: 0,
    maxHeight: MODEL_PANEL_MAX_HEIGHT,
  });
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");
  let modelDropdownButtonRef: HTMLButtonElement | undefined;
  let modelDropdownPanelRef: HTMLDivElement | undefined;

  // Flip above the trigger and cap height to the space actually available,
  // so the panel never renders off-screen near the bottom of a short window.
  const repositionModelDropdown = () => {
    if (!modelDropdownButtonRef) return;
    const rect = modelDropdownButtonRef.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - MODEL_PANEL_VIEWPORT_MARGIN;
    const spaceAbove = rect.top - MODEL_PANEL_VIEWPORT_MARGIN;
    if (spaceBelow >= Math.min(160, MODEL_PANEL_MAX_HEIGHT) || spaceBelow >= spaceAbove) {
      setModelDropdownPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(MODEL_PANEL_MAX_HEIGHT, Math.max(spaceBelow, 0)),
      });
    } else {
      setModelDropdownPos({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(MODEL_PANEL_MAX_HEIGHT, Math.max(spaceAbove, 0)),
      });
    }
  };

  // Fixed-position popover portaled to <body>: opening it never grows the
  // modal's scroll area, it overlays whatever sits below instead.
  createEffect(() => {
    if (!modelDropdownOpen()) return;
    repositionModelDropdown();
    const handleReflow = () => repositionModelDropdown();
    window.addEventListener("scroll", handleReflow, true);
    window.addEventListener("resize", handleReflow);
    onCleanup(() => {
      window.removeEventListener("scroll", handleReflow, true);
      window.removeEventListener("resize", handleReflow);
    });
  });

  createEffect(() => {
    if (!modelDropdownOpen()) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modelDropdownButtonRef?.contains(target) || modelDropdownPanelRef?.contains(target)) return;
      setModelDropdownOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  // Show all model options — same data source as the session model picker.
  const allModelOptions = createMemo(() => props.modelOptions ?? []);

  // Keyboard nav follows the ARIA APG collapsible-listbox pattern: focus stays
  // on the trigger, Up/Down move a highlighted entry (models + the trailing
  // "Manage models…" action), Enter/Space commits it, Escape closes in place.
  const [modelHighlighted, setModelHighlighted] = createSignal(0);
  const modelListboxId = "scheduler-model-listbox";
  const modelOptionId = (index: number) => `${modelListboxId}-option-${index}`;
  const modelMenuLength = createMemo(() => allModelOptions().length + 1);

  const openModelMenu = () => {
    const current = automationModel();
    const index = allModelOptions().findIndex(
      (opt) => opt.providerID === current.providerID && opt.modelID === current.modelID,
    );
    setModelHighlighted(index >= 0 ? index : 0);
    setModelDropdownOpen(true);
  };

  createEffect(
    on(
      allModelOptions,
      () => {
        if (modelDropdownOpen()) setModelDropdownOpen(false);
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!modelDropdownOpen()) return;
    document.getElementById(modelOptionId(modelHighlighted()))?.scrollIntoView({ block: "nearest" });
  });

  const moveModelHighlight = (delta: number) => {
    const count = modelMenuLength();
    if (count === 0) return;
    setModelHighlighted((current) => (current + delta + count) % count);
  };

  const commitModelHighlight = () => {
    const index = modelHighlighted();
    const options = allModelOptions();
    if (index >= options.length) {
      setModelDropdownOpen(false);
      setModelPickerQuery("");
      setModelPickerOpen(true);
      return;
    }
    const model = options[index];
    if (!model) return;
    setAutomationModel({ providerID: model.providerID, modelID: model.modelID });
    setModelDropdownOpen(false);
  };

  const handleModelKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!modelDropdownOpen()) openModelMenu();
      else moveModelHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!modelDropdownOpen()) openModelMenu();
      else moveModelHighlight(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!modelDropdownOpen()) openModelMenu();
      else commitModelHighlight();
    } else if (event.key === "Escape" && modelDropdownOpen()) {
      event.preventDefault();
      event.stopPropagation();
      setModelDropdownOpen(false);
    } else if (event.key === "Tab" && modelDropdownOpen()) {
      setModelDropdownOpen(false);
    }
  };

  const filteredAutomationModelOptions = createMemo(() => {
    const q = modelPickerQuery().trim().toLowerCase();
    const options = allModelOptions();
    if (!q) return options;
    return options.filter((opt) =>
      [opt.title, opt.description ?? "", opt.footer ?? "", `${opt.providerID}/${opt.modelID}`]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  });

  // Agent the automation runs as. "" = OpenCode's default agent
  // (superclaw-default), which is sandboxed to /workspace (#2865).
  const capability = useCapabilityGate();
  const [automationAgent, setAutomationAgent] = createSignal("");
  const [automationAgentOptions, setAutomationAgentOptions] = createSignal<Agent[]>([]);
  createEffect(() => {
    if (!createModalOpen() || !props.listAgents) return;
    props
      .listAgents()
      .then((agents) =>
        setAutomationAgentOptions(
          getVisibleAgentOptions(
            agents,
            capability.isActive(),
            capability.isAgentAllowed,
            capability.productProfileId(),
          ).sort((a, b) => a.name.localeCompare(b.name)),
        ),
      )
      .catch((err) => console.error("[Automations] Loading agents failed:", err));
  });

  const automationModelLabel = createMemo(() => {
    const m = automationModel();
    const match = (props.modelOptions ?? []).find(
      (opt) => opt.providerID === m.providerID && opt.modelID === m.modelID,
    );
    return match?.title ?? `${m.providerID}/${m.modelID}`;
  });

  const modelLabelFor = (value?: string) => {
    if (!value) return undefined;
    const separator = value.indexOf("/");
    if (separator < 0) return value;
    const providerID = value.slice(0, separator);
    const modelID = value.slice(separator + 1);
    return props.modelOptions.find((option) => option.providerID === providerID && option.modelID === modelID)?.title ?? value;
  };

  const confirmDelete = async () => {
    const target = deleteTarget();
    if (!target) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      // AgentLab schedulers use the dedicated API with auto-approval
      if (target.source === "agentlab") {
        await deleteAgentLabAutomation(target.slug);
      } else {
        await props.deleteJob(target.slug);
      }
      setDeleteTarget(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDeleteError(message || t("scheduled.delete_failed"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const cronExpression = createMemo(() => {
    if (scheduleMode() === "interval") {
      return buildCronFromInterval(Number(intervalMinutes()));
    }
    return buildCronFromDaily(scheduleTime(), scheduleDays());
  });

  const createPromptValue = createMemo(() =>
    buildAutomationPrompt({
      name: automationName(),
      prompt: automationPrompt().trim(),
      schedule: cronExpression(),
      workdir: props.activeWorkspaceRoot,
    })
  );

  const canCreateAutomation = createMemo(() =>
    isAutomationFormComplete({
      name: automationName(),
      prompt: automationPrompt(),
      schedule: cronExpression(),
      intervalValid: scheduleMode() !== "interval" || validIntervalMinutes(),
    }),
  );

  const openSchedulerDocs = () => {
    platform.openLink("https://github.com/different-ai/opencode-scheduler");
  };

  const markJobRunning = (slug: string) => {
    setRunningJobSlugs((current) => {
      const next = new Set(current);
      next.add(slug);
      return next;
    });
  };

  const clearJobRunning = (slug: string) => {
    setRunningJobSlugs((current) => {
      const next = new Set(current);
      next.delete(slug);
      return next;
    });
  };

  // True while a manual "Run now" API call is in flight, OR while the
  // automation's last-triggered session is actively streaming a turn — the
  // latter is what catches a scheduler-triggered (not manually clicked) run.
  // "retry" is still an active turn (auto-retrying), same as session.tsx.
  const isJobRunning = (slug: string) => {
    if (runningJobSlugs().has(slug)) return true;
    const sessionId = agentLabAutomations().find((a) => a.id === slug)?.lastRunSessionId;
    if (!sessionId) return false;
    const status = props.sessionStatusById?.[sessionId];
    return status === "running" || status === "retry";
  };

  const handleInstallScheduler = async () => {
    if (installingScheduler() || !props.canEditPlugins) return;
    setInstallingScheduler(true);
    setSchedulerInstallRequested(true);
    try {
      await Promise.resolve(props.addPlugin("opencode-scheduler"));
    } finally {
      setInstallingScheduler(false);
    }
  };

  const openCreateModal = () => {
    if (automationDisabled()) return;
    setAutomationName("");
    setAutomationPrompt("");
    setScheduleMode("daily");
    setScheduleTime("09:00");
    setScheduleDays(["mo", "tu", "we", "th", "fr"]);
    setScheduleReviewMessage(null);
    setIntervalMinutes("60");
    setIntervalBlurred(false);
    setAutomationModel(props.selectedModel ?? DEFAULT_MODEL);
    setAutomationAgent("");
    setEditingAutomationId(null);
    setCreateModalOpen(true);
  };

  const openEditModal = (job: ScheduledJob) => {
    if (automationDisabled()) return;
    const match = agentLabAutomations().find((a) => a.id === job.slug);
    if (!match) return;
    setAutomationName(match.name);
    setAutomationPrompt(match.prompt);
    setIntervalBlurred(false);

    const schedule = match.schedule;
    setScheduleReviewMessage(scheduleDayReviewMessage(schedule));
    if (schedule.kind === "interval") {
      setScheduleMode("interval");
      setIntervalMinutes(String(Math.max(1, Math.ceil(schedule.seconds / 60))));
    } else {
      setScheduleMode("daily");
      setScheduleTime(`${pad2(schedule.hour)}:${pad2(schedule.minute)}`);
      if (schedule.kind === "weekly") {
        const weekdayMap: Record<number, string> = { 1: "mo", 2: "tu", 3: "we", 4: "th", 5: "fr", 6: "sa", 7: "su" };
        setScheduleDays([weekdayMap[schedule.weekday] ?? "mo"]);
      } else if (schedule.kind === "days") {
        const weekdayMap: Record<number, string> = { 1: "mo", 2: "tu", 3: "we", 4: "th", 5: "fr", 6: "sa", 7: "su" };
        setScheduleDays(schedule.weekdays.map((weekday) => weekdayMap[weekday]).filter((day): day is string => !!day));
      } else {
        setScheduleDays(dayOptions.map((d) => d.id));
      }
    }

    if (match.model) {
      const [providerID, ...rest] = match.model.split("/");
      const modelID = rest.join("/");
      if (providerID && modelID) {
        setAutomationModel({ providerID, modelID });
      } else {
        setAutomationModel(props.selectedModel ?? DEFAULT_MODEL);
      }
    } else {
      setAutomationModel(props.selectedModel ?? DEFAULT_MODEL);
    }
    setAutomationAgent(match.agent ?? "");

    setEditingAutomationId(match.id);
    setCreateModalOpen(true);
  };

  const handleCreateAutomation = async () => {
    if (automationDisabled()) {
      return;
    }
    const name = automationName().trim();
    const prompt = automationPrompt().trim();
    if (!name || !prompt) {
      return;
    }
    if (scheduleMode() === "interval" && !validIntervalMinutes()) return;

    const client = props.openworkServerClient;
    const wsId = props.openworkServerWorkspaceId?.trim();

    if (client && wsId) {
      const schedule = buildSchedulePayload();
      const m = automationModel();
      const model = `${m.providerID}/${m.modelID}`;
      const editingId = editingAutomationId();
      const enabled = editingId
        ? agentLabAutomations().find((a) => a.id === editingId)?.enabled
        : undefined;
      setAgentLabBusy(true);
      setAgentLabError(null);
      try {
        await client.withAutoApproval(() =>
          client.createAgentLabAutomation(wsId, {
            ...(editingId ? { id: editingId } : {}),
            name,
            prompt,
            schedule,
            model,
            // Only send `agent` when the picker is shown; "" resets to the default agent.
            ...(props.listAgents ? { agent: automationAgent() } : {}),
            ...(enabled === undefined ? {} : { enabled }),
          }),
        );
        await loadAgentLabAutomations();
        setCreateModalOpen(false);
      } catch (err) {
        console.error("[Automations] Save failed:", err);
        setAgentLabError(err instanceof Error ? err.message : String(err));
      } finally {
        setAgentLabBusy(false);
      }
      return;
    }

    // Fallback: legacy prompt-based flow when server client is unavailable
    const promptValue = createPromptValue();
    if (!promptValue) return;
    props.openNewTask();
    props.setPrompt(promptValue);
    setCreateModalOpen(false);
  };

  /**
   * Convert the UI schedule controls (mode, time, days, interval) into an
   * AgentLabSchedulePayload that the server understands.
   */
  const buildSchedulePayload = (): AgentLabSchedulePayload => {
    if (scheduleMode() === "interval") {
      return { kind: "interval", seconds: Number(intervalMinutes()) * 60 };
    }
    const [hourStr, minuteStr] = scheduleTime().split(":");
    const hour = Number.parseInt(hourStr ?? "9", 10);
    const minute = Number.parseInt(minuteStr ?? "0", 10);
    const days = scheduleDays();
    const dayMap: Record<string, number> = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 7 };
    const weekdays = dayOptions.flatMap((day) => (days.includes(day.id) ? [dayMap[day.id]] : []));
    // Always save the exact selection as `days`, even for a single day or all
    // seven — collapsing to `daily`/`weekly` discarded the original selection
    // for records saved by this picker (#3069 follow-up).
    return { kind: "days", weekdays, hour, minute };
  };

  const runAutomationNow = async (job: ScheduledJob) => {
    const client = props.openworkServerClient;
    const wsId = props.openworkServerWorkspaceId?.trim();

    // Run via AgentLab API only for AgentLab-backed jobs
    if (client && wsId && job.source === "agentlab") {
      const match = agentLabAutomations().find((a) => a.id === job.slug);
      if (match) {
        // Prefer the model stored on the automation; fall back to the session model or DEFAULT_MODEL
        const storedModel = match.model;
        const fallbackModel = props.selectedModel
          ? `${props.selectedModel.providerID}/${props.selectedModel.modelID}`
          : `${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`;
        const model = storedModel || fallbackModel;
        markJobRunning(job.slug);
        setAgentLabBusy(true);
        setAgentLabError(null);
        try {
          await client.runAgentLabAutomation(wsId, match.id, model);
          // API accepted the run request — mark as "ran" until explicit completion status exists
          setAgentLabAutomations((current) =>
            current.map((item) =>
              item.id === match.id ? { ...item, lastRunAt: Date.now(), lastRunStatus: "ran" } : item,
            ),
          );
          await loadAgentLabAutomations();
        } catch (err) {
          console.error("[Automations] Run failed:", err);
          // API rejected the run — mark as failed
          setAgentLabAutomations((current) =>
            current.map((item) =>
              item.id === match.id ? { ...item, lastRunStatus: "failed" } : item,
            ),
          );
          setAgentLabError(err instanceof Error ? err.message : String(err));
        } finally {
          setAgentLabBusy(false);
          clearJobRunning(job.slug);
        }
        return;
      }
    }

    // Fallback: legacy prompt-based run (navigates away immediately — no running state needed)
    const run = job.run;
    const workdir = (job.workdir ?? props.activeWorkspaceRoot ?? "").trim();
    const schedule = humanizeCron(job.schedule, job.source);

    if (run?.prompt || job.prompt) {
      const promptBody = (run?.prompt ?? job.prompt ?? "").trim();
      const workdirHint = workdir ? `\n\nRun from ${workdir}.` : "";
      props.openNewTask();
      props.setPrompt(`Run this scheduler now: ${job.name}.\nSchedule: ${schedule}.\n\n${promptBody}${workdirHint}`.trim());
      return;
    }

    if (run?.command) {
      const args = run.arguments ? ` ${run.arguments}` : "";
      const cmd = `${run.command}${args}`.trim();
      const workdirHint = workdir ? `\n\nRun from ${workdir}.` : "";
      props.openNewTask();
      props.setPrompt(
        `Run this scheduler now: ${job.name}.\nSchedule: ${schedule}.\n\nRun the following command:\n${cmd}${workdirHint}`.trim()
      );
      return;
    }

    props.openNewTask();
    props.setPrompt(`Run this scheduler now: ${job.name}.\nSchedule: ${schedule}.`);
  };

  const isJobEnabled = (job: ScheduledJob) => {
    if (job.source !== "agentlab") return true;
    const match = agentLabAutomations().find((a) => a.id === job.slug);
    return match ? match.enabled : true;
  };

  const toggleAutomationEnabled = async (job: ScheduledJob) => {
    const client = props.openworkServerClient;
    const wsId = props.openworkServerWorkspaceId?.trim();
    if (!client || !wsId || job.source !== "agentlab") return;
    const match = agentLabAutomations().find((a) => a.id === job.slug);
    if (!match) return;
    setAgentLabBusy(true);
    setAgentLabError(null);
    try {
      await client.withAutoApproval(() =>
        client.createAgentLabAutomation(wsId, {
          id: match.id,
          name: match.name,
          prompt: match.prompt,
          schedule: match.schedule,
          model: match.model,
          enabled: !match.enabled,
        }),
      );
      await loadAgentLabAutomations();
    } catch (err) {
      console.error("[Automations] Toggle failed:", err);
      setAgentLabError(err instanceof Error ? err.message : String(err));
    } finally {
      setAgentLabBusy(false);
    }
  };

  const deleteAgentLabAutomation = async (automationId: string) => {
    const client = props.openworkServerClient;
    const wsId = props.openworkServerWorkspaceId?.trim();
    if (!client || !wsId) {
      return;
    }
    setAgentLabBusy(true);
    setAgentLabError(null);
    try {
      await client.withAutoApproval(() =>
        client.deleteAgentLabAutomation(wsId, automationId),
      );
      await loadAgentLabAutomations();
    } catch (err) {
      console.error("[Automations] Delete failed:", err);
      setAgentLabError(err instanceof Error ? err.message : String(err));
    } finally {
      setAgentLabBusy(false);
    }
  };

  const toggleDay = (id: string) => {
    setScheduleDays((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return Array.from(next);
    });
  };

  return (
    <section class="space-y-8" data-testid="scheduler-content">
      <h2 class="text-display-lg font-bold text-dls-text">{t("scheduled.title")}</h2>

      <div class="flex flex-wrap items-center gap-3 border-b border-dls-border pb-4">
        <button
          type="button"
          onClick={openCreateModal}
          disabled={automationDisabled()}
          class={`inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-caption font-medium transition-colors ${automationDisabled()
            ? "bg-dls-active text-dls-secondary cursor-not-allowed"
            : "bg-dls-text text-dls-surface-solid hover:opacity-90"
            }`}
        >
          <Plus size={14} />
          {t("scheduled.new_scheduler")}
        </button>
      </div>

      <Show when={schedulerGateActive()}>
        <div class="rounded-card border border-dls-panel-border bg-dls-panel-bg px-5 py-5 shadow-sm">
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div class="flex items-start gap-3">
              <div class="flex h-10 w-10 items-center justify-center rounded-inset border border-dls-panel-inset-border bg-dls-panel-inset-bg">
                <PlugZap size={18} class="text-dls-secondary" />
              </div>
              <div>
                <div class="text-body-lg font-semibold text-dls-text">
                  {schedulerGateMode() === "reload"
                    ? t("scheduled.gate_reload_title")
                    : t("scheduled.gate_install_title")}
                </div>
                <div class="mt-1 text-caption text-dls-secondary">
                  {schedulerGateMode() === "reload"
                    ? t("scheduled.gate_reload_desc")
                    : t("scheduled.gate_install_desc")}
                </div>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={handleInstallScheduler}
                disabled={!props.canEditPlugins || installingScheduler()}
              >
                {installingScheduler() ? t("scheduled.installing") : t("scheduled.install_scheduler")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void props.reloadWorkspaceEngine()}
                disabled={!props.canReloadWorkspace || props.reloadBusy || !props.schedulerInstalled}
              >
                {props.reloadBusy ? t("scheduled.reloading") : t("scheduled.reload_superclaw")}
              </Button>
              <button
                type="button"
                onClick={openSchedulerDocs}
                class="text-caption font-medium text-dls-secondary transition-colors hover:text-dls-text"
              >
                {t("scheduled.view_docs")}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={supportNote()}>
        <div class="rounded-inset border border-dls-panel-border bg-dls-panel-bg px-5 py-4 text-body-lg text-dls-secondary">
          {supportNote()}
        </div>
      </Show>

      <Show when={props.status}>
        <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-5 py-4 text-body-lg text-dls-danger-text">
          {props.status}
        </div>
      </Show>

      <Show when={deleteError()}>
        <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-5 py-4 text-body-lg text-dls-danger-text">
          {deleteError()}
        </div>
      </Show>

      <Show
        when={allJobs().length > 0}
        fallback={
          <div class={`rounded-inset border border-dashed border-dls-border px-5 py-10 text-center ${schedulerGateActive() ? "opacity-60 pointer-events-none" : ""}`}>
            <Clock size={24} class="mx-auto mb-3 text-dls-secondary/30" />
            <div class="text-body-lg font-medium text-dls-secondary">{t("scheduled.empty_state_title")}</div>
            <div class="mt-1 text-caption text-dls-secondary/60">{t("scheduled.empty_state")}</div>
          </div>
        }
      >
        <div class={`grid w-full grid-cols-1 items-stretch gap-2 sm:grid-cols-2 lg:grid-cols-3 ${schedulerGateActive() ? "opacity-60 pointer-events-none" : ""}`}>
          <For each={allJobs()}>
            {(job) => (
              <AutomationJobCard
                job={job}
                supported={supported()}
                busy={props.busy || deleteBusy() || (job.source === "agentlab" ? agentLabBusy() : false)}
                running={isJobRunning(job.slug)}
                enabled={isJobEnabled(job)}
                modelLabel={modelLabelFor(job.run?.model)}
                expanded={openDetailsSlug() === job.slug}
                onToggleExpanded={() => toggleExpanded(job.slug)}
                onDelete={() => setDeleteTarget(job)}
                onRun={() => runAutomationNow(job)}
                onEdit={() => openEditModal(job)}
                onToggleEnabled={() => toggleAutomationEnabled(job)}
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={deleteTarget()}>
        <Portal>
          <div class="fixed inset-0 z-50 dls-modal-backdrop flex items-center justify-center p-4">
            <div class="border w-full max-w-md overflow-hidden dls-modal-surface">
              <div class="p-6 space-y-4">
                <div class="flex items-start justify-between gap-4">
                  <div>
                    <h3 class="text-heading font-semibold text-dls-text">{t("scheduled.delete_automation_title")}</h3>
                    <p class="text-body-lg text-dls-secondary mt-1">{deleteDescription()}</p>
                  </div>
                </div>
                <div class="rounded-inset bg-dls-hover border border-dls-border p-3 text-caption text-dls-secondary font-mono break-all">
                  {deleteTarget()?.name}
                </div>
                <div class="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteBusy()}>
                    {t("scheduled.cancel")}
                  </Button>
                  <Button variant="danger" onClick={confirmDelete} disabled={deleteBusy()}>
                    {deleteBusy() ? t("scheduled.deleting") : t("scheduled.delete")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>

      <Show when={createModalOpen()}>
        <Portal>
          <div
            class="fixed inset-0 z-50 flex items-center justify-center dls-modal-backdrop p-4"
          >
            <div class="w-full max-w-2xl overflow-hidden border flex flex-col max-h-[calc(100vh-2rem)] dls-modal-surface">
              <div
                class="flex-1 min-h-0 p-8 space-y-6 overflow-y-auto"
                style={{ "scrollbar-gutter": "stable" }}
              >
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h2 class="text-heading-lg font-semibold text-dls-text">{editingAutomationId() ? t("scheduled.edit_scheduler") : t("scheduled.create_scheduler")}</h2>
                  <Show when={editingAutomationId()}>
                    <p class="text-caption text-dls-secondary mt-2">{t("scheduled.edit_scheduler_desc")}</p>
                  </Show>
                </div>
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  class="rounded-pill p-1 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                >
                  <X size={18} />
                </button>
              </div>

              <Show when={agentLabError()}>
                <div class="rounded-inset border border-dls-danger-border bg-dls-danger-bg px-4 py-3 text-body-lg text-dls-danger-text">
                  {agentLabError()}
                </div>
              </Show>

              <div class="space-y-6">
                <div>
                  <label class="mb-2 block text-label font-bold uppercase tracking-wider text-dls-secondary">
                    {t("scheduled.field_name")}
                  </label>
                  <input
                    type="text"
                    value={automationName()}
                    onInput={(event) => setAutomationName(event.currentTarget.value)}
                    placeholder={t("scheduled.field_name_placeholder")}
                    class={`${formControlClass} placeholder:text-dls-secondary`}
                  />
                </div>
                <div>
                  <label class="mb-2 block text-label font-bold uppercase tracking-wider text-dls-secondary">
                    {t("scheduled.field_prompt")}
                  </label>
                  <textarea
                    rows={4}
                    value={automationPrompt()}
                    onInput={(event) => setAutomationPrompt(event.currentTarget.value)}
                    placeholder={t("scheduled.field_prompt_placeholder")}
                    class={`${formControlClass} resize-none placeholder:text-dls-secondary`}
                  />
                </div>
                <div>
                  <div class="mb-2 flex items-center justify-between">
                    <label class="block text-label font-bold uppercase tracking-wider text-dls-secondary">
                      {t("scheduled.field_schedule")}
                    </label>
                    <div class="flex rounded-control bg-dls-active p-0.5">
                      <button
                        type="button"
                        onClick={() => setScheduleMode("daily")}
                        class={`px-3 py-1 text-tiny font-bold rounded-subtle transition-colors ${scheduleMode() === "daily"
                          ? "bg-dls-surface text-dls-text shadow-sm"
                          : "text-dls-secondary"
                          }`}
                      >
                        {t("scheduled.mode_daily")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setScheduleMode("interval")}
                        class={`px-3 py-1 text-tiny font-bold rounded-subtle transition-colors ${scheduleMode() === "interval"
                          ? "bg-dls-surface text-dls-text shadow-sm"
                          : "text-dls-secondary"
                          }`}
                      >
                        {t("scheduled.mode_interval")}
                      </button>
                    </div>
                  </div>
                  <div class="min-h-10">
                    <Show
                      when={scheduleMode() === "daily"}
                      fallback={
                        <div class="min-h-10">
                          <div class={`flex h-10 w-fit items-center gap-2 rounded-control px-3 py-2 text-body-lg focus-within:ring-2 focus-within:ring-[rgb(var(--dls-accent-rgb)/0.3)] ${intervalErrorVisible() ? "border border-dls-danger-border bg-dls-panel-input-bg text-dls-panel-text" : `${formControlChromeClass} focus-within:border-[var(--dls-accent)]`}`}>
                            <span>{t("scheduled.every")}</span>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={intervalMinutes()}
                              onInput={(event) => setIntervalMinutes(event.currentTarget.value)}
                              onFocus={() => setIntervalBlurred(false)}
                              onBlur={() => setIntervalBlurred(true)}
                              aria-label={t("scheduled.mode_interval")}
                              aria-invalid={intervalErrorVisible()}
                              aria-describedby={intervalErrorVisible() ? "scheduler-interval-error" : undefined}
                              class="w-16 bg-transparent text-right focus:outline-none"
                            />
                            <span>{t("scheduled.minutes")}</span>
                          </div>
                          <Show when={intervalErrorVisible()}>
                            <p id="scheduler-interval-error" class="mt-1 text-caption text-dls-danger-text" role="alert">{t("scheduled.interval_whole_minutes_error")}</p>
                          </Show>
                        </div>
                      }
                    >
                      <div class="flex min-h-10 flex-wrap items-center gap-3">
                        <div class={`flex h-10 items-center justify-between rounded-control px-3 py-2 text-body-lg focus-within:ring-2 focus-within:ring-[rgb(var(--dls-accent-rgb)/0.3)] focus-within:border-[var(--dls-accent)] ${formControlChromeClass}`}>
                          <input
                            type="time"
                            value={scheduleTime()}
                            onInput={(event) => setScheduleTime(event.currentTarget.value)}
                            class="bg-transparent focus:outline-none"
                          />
                          <Clock size={16} class="text-dls-secondary" />
                        </div>
                        <div class="flex flex-wrap gap-1">
                          <For each={dayOptions}>
                            {(day) => (
                              <button
                                type="button"
                                onClick={() => toggleDay(day.id)}
                                class={`h-8 w-8 rounded-pill text-tiny font-bold transition-colors ${scheduleDays().includes(day.id)
                                  ? "bg-dls-text text-dls-surface-solid"
                                  : "bg-dls-active text-dls-secondary"
                                  }`}
                              >
                                {day.label}
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                    <Show when={scheduleMode() === "daily" && scheduleDays().length === 0}>
                      <p class="mt-1 text-caption text-dls-danger-text" role="alert">{t("scheduled.select_at_least_one_day")}</p>
                    </Show>
                    <Show when={scheduleMode() === "daily" && scheduleDays().length > 0 && scheduleReviewMessage()}>
                      <p class="mt-1 text-caption text-dls-warning-text" role="status">{scheduleReviewMessage()}</p>
                    </Show>
                  </div>
                </div>
                <div>
                  <label id="scheduler-model-select-label" for="scheduler-model-select" class="mb-2 block text-label font-bold uppercase tracking-wider text-dls-secondary">
                    {t("scheduled.field_model")}
                  </label>
                  <button
                    ref={modelDropdownButtonRef}
                    type="button"
                    id="scheduler-model-select"
                    data-testid="scheduler-model-picker-btn"
                    role="combobox"
                    aria-haspopup="listbox"
                    aria-expanded={modelDropdownOpen()}
                    aria-controls={modelListboxId}
                    aria-labelledby="scheduler-model-select-label scheduler-model-select-value"
                    aria-activedescendant={modelDropdownOpen() ? modelOptionId(modelHighlighted()) : undefined}
                    onClick={() => (modelDropdownOpen() ? setModelDropdownOpen(false) : openModelMenu())}
                    onKeyDown={handleModelKeyDown}
                    class={`${formControlChromeClass} flex w-full items-center justify-between rounded-control px-3 py-2 text-body-lg hover:bg-dls-panel-hover-bg`}
                  >
                    <span id="scheduler-model-select-value" class="truncate">{automationModelLabel()}</span>
                    <ChevronDown
                      size={14}
                      class="text-dls-secondary shrink-0 ml-2 transition-transform duration-200"
                      classList={{ "rotate-180": modelDropdownOpen() }}
                    />
                  </button>
                  <Show when={modelDropdownOpen()}>
                    <Portal>
                      <div
                        ref={modelDropdownPanelRef}
                        id={modelListboxId}
                        role="listbox"
                        tabIndex={-1}
                        data-testid="scheduler-model-dropdown"
                        style={{
                          position: "fixed",
                          ...(modelDropdownPos().top !== undefined
                            ? { top: `${modelDropdownPos().top}px` }
                            : { bottom: `${modelDropdownPos().bottom}px` }),
                          left: `${modelDropdownPos().left}px`,
                          width: `${modelDropdownPos().width}px`,
                          "max-height": `${modelDropdownPos().maxHeight}px`,
                        }}
                        class="z-[999] overflow-y-auto rounded-card border border-dls-border bg-dls-surface-solid shadow-[var(--dls-shell-shadow)]"
                      >
                        <div class="p-2 space-y-1">
                          <For each={allModelOptions()}>
                            {(model, index) => {
                              const active = () =>
                                automationModel().providerID === model.providerID &&
                                automationModel().modelID === model.modelID;
                              const isHighlighted = () => modelHighlighted() === index();
                              return (
                                <button
                                  type="button"
                                  id={modelOptionId(index())}
                                  role="option"
                                  aria-selected={active()}
                                  tabIndex={-1}
                                  data-testid="scheduler-model-option"
                                  class={`w-full flex items-center justify-between rounded-control px-3 py-2 text-left text-caption transition-colors ${active()
                                    ? "bg-dls-active text-dls-text"
                                    : isHighlighted()
                                      ? "bg-dls-hover text-dls-text"
                                      : "text-dls-secondary hover:bg-dls-hover"
                                    }`}
                                  onMouseEnter={() => setModelHighlighted(index())}
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    setAutomationModel({ providerID: model.providerID, modelID: model.modelID });
                                    setModelDropdownOpen(false);
                                  }}
                                >
                                  <span class="shrink-0 truncate">{model.title}</span>
                                  <span class="ml-3 flex min-w-0 items-center gap-2">
                                    <Show when={model.footer}>
                                      <span class="truncate">{model.footer}</span>
                                    </Show>
                                    <Show when={active()}>
                                      <Check size={14} class="shrink-0" />
                                    </Show>
                                  </span>
                                </button>
                              );
                            }}
                          </For>
                          <button
                            type="button"
                            id={modelOptionId(allModelOptions().length)}
                            role="option"
                            aria-selected={false}
                            tabIndex={-1}
                            data-testid="scheduler-model-manage-btn"
                            class={`w-full rounded-control border-t border-dls-border px-3 py-2 text-left text-caption transition-colors ${modelHighlighted() === allModelOptions().length
                              ? "bg-dls-hover text-dls-text"
                              : "text-dls-secondary hover:bg-dls-hover"
                              }`}
                            onMouseEnter={() => setModelHighlighted(allModelOptions().length)}
                            onClick={() => {
                              setModelDropdownOpen(false);
                              setModelPickerQuery("");
                              setModelPickerOpen(true);
                            }}
                          >
                            {t("scheduled.manage_models")}
                          </button>
                        </div>
                      </div>
                    </Portal>
                  </Show>
                  <div class="mt-1 text-label text-dls-secondary">
                    {t("scheduled.model_used_hint")}
                  </div>
                </div>
                <Show when={props.listAgents}>
                  <div>
                    <label
                      for="scheduler-agent-select"
                      class="mb-2 block text-label font-bold uppercase tracking-wider text-dls-secondary"
                    >
                      {t("scheduled.field_agent")}
                    </label>
                    <AutomationAgentSelect
                      id="scheduler-agent-select"
                      value={automationAgent()}
                      options={automationAgentOptions().map((agent) => agent.name)}
                      defaultLabel={t("scheduled.agent_default")}
                      onChange={setAutomationAgent}
                      class={`${formControlChromeClass} flex w-full items-center justify-between rounded-control px-3 py-2 text-body-lg hover:bg-dls-panel-hover-bg`}
                    />
                    <div class="mt-1 text-label text-dls-secondary">
                      {t("scheduled.agent_used_hint")}
                    </div>
                  </div>
                </Show>
              </div>
            </div>
            <div class="flex items-center justify-end gap-4 border-t border-dls-border bg-dls-hover/60 px-8 py-4">
              {/* <button
                type="button"
                onClick={openSchedulerDocs}
                class="text-caption font-medium text-dls-secondary transition-colors hover:text-dls-text"
              >
                View scheduler docs
              </button> */}
              <ModelPickerModal
                open={modelPickerOpen()}
                options={allModelOptions()}
                filteredOptions={filteredAutomationModelOptions()}
                query={modelPickerQuery()}
                setQuery={setModelPickerQuery}
                target="session"
                current={automationModel()}
                onSelect={(m) => {
                  setAutomationModel(m);
                  setModelPickerOpen(false);
                }}
                onClose={() => setModelPickerOpen(false)}
                suspended={props.providerAuthModalOpen}
              />
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  class="px-4 py-2 text-caption font-medium text-dls-secondary transition-colors hover:text-dls-text"
                >
                  {t("scheduled.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleCreateAutomation}
                  disabled={!canCreateAutomation() || automationDisabled() || agentLabBusy()}
                  class={`px-4 py-2 text-caption font-medium rounded-control transition-colors ${!canCreateAutomation() || automationDisabled() || agentLabBusy()
                    ? "bg-dls-active text-dls-secondary cursor-not-allowed"
                    : "bg-dls-text text-dls-surface-solid hover:opacity-90"
                    }`}
                >
                  {editingAutomationId() ? t("scheduled.save") : t("scheduled.create")}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      </Show>
    </section>
  );
}
