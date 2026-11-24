import { createMemo, createSignal, type Accessor } from "solid-js";
import type { ScheduledJob } from "~/shared/platform/tauri";

export type SchedulerSource = "local" | "remote";

// Duck-typed rather than importing OpenworkServerError: this module only needs
// to recognize the server's typed error code, not the transport that produced it.
function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export type UseSchedulerDeps = {
  workspaceType: Accessor<"local" | "remote">;
  activeWorkspaceRoot: Accessor<string>;
  openworkServerClient: Accessor<{
    listScheduledJobs?: (workspaceId: string) => Promise<{ items?: ScheduledJob[]; supported?: boolean }>;
    deleteScheduledJob?: (workspaceId: string, name: string) => Promise<{ job: ScheduledJob }>;
  } | null>;
  openworkServerWorkspaceId: Accessor<string | null>;
  openworkServerStatus: Accessor<"connected" | "limited" | "disconnected">;
  isPluginInstalledByName: (pluginName: string, aliases?: string[]) => boolean;
  isTauriRuntime: () => boolean;
  isWindowsPlatform: () => boolean;
  schedulerListJobs: (scopeRoot?: string) => Promise<ScheduledJob[]>;
  schedulerDeleteJob: (name: string, scopeRoot?: string) => Promise<ScheduledJob>;
};

export function useScheduler(deps: UseSchedulerDeps) {
  const [scheduledJobs, setScheduledJobs] = createSignal<ScheduledJob[]>([]);
  const [scheduledJobsStatus, setScheduledJobsStatus] = createSignal<string | null>(null);
  const [scheduledJobsBusy, setScheduledJobsBusy] = createSignal(false);
  const [scheduledJobsUpdatedAt, setScheduledJobsUpdatedAt] = createSignal<number | null>(null);

  // Legacy support belongs to the backend that reported it; another backend is unknown until refreshed.
  const schedulerIdentity = () => {
    const source = deps.workspaceType();
    return source === "remote"
      ? { source, client: deps.openworkServerClient(), workspaceId: deps.openworkServerWorkspaceId() }
      : { source, client: null, workspaceId: null };
  };
  type SchedulerIdentity = ReturnType<typeof schedulerIdentity>;
  const isCurrentIdentity = (identity: SchedulerIdentity) => {
    const current = schedulerIdentity();
    return current.source === identity.source && current.client === identity.client && current.workspaceId === identity.workspaceId;
  };
  const [legacySupport, setLegacySupport] = createSignal<{ identity: SchedulerIdentity; supported: boolean | null } | null>(null);
  const legacySchedulerSupported = () => {
    const support = legacySupport();
    return support && isCurrentIdentity(support.identity) ? support.supported : null;
  };

  const resolveOpenworkScheduler = () => {
    const isRemoteWorkspace = deps.workspaceType() === "remote";
    if (!isRemoteWorkspace) return null;

    const client = deps.openworkServerClient();
    const workspaceId = deps.openworkServerWorkspaceId();

    if (deps.openworkServerStatus() !== "connected" || !client || !workspaceId) {
      return null;
    }

    return { client, workspaceId };
  };

  const scheduledJobsSource = createMemo<SchedulerSource>(() =>
    deps.workspaceType() === "remote" ? "remote" : "local",
  );

  const scheduledJobsSourceReady = createMemo(() => {
    if (scheduledJobsSource() !== "remote") return true;
    const client = deps.openworkServerClient();
    const workspaceId = deps.openworkServerWorkspaceId();
    return (
      deps.openworkServerStatus() === "connected" && Boolean(client && workspaceId)
    );
  });

  const schedulerPluginInstalled = createMemo(() =>
    deps.isPluginInstalledByName("opencode-scheduler"),
  );

  const refreshScheduledJobs = async (options?: { force?: boolean }) => {
    if (scheduledJobsBusy() && !options?.force) return;
    const identity = schedulerIdentity();
    const setLegacySchedulerSupported = (supported: boolean | null) => setLegacySupport({ identity, supported });

    if (scheduledJobsSource() === "remote") {
      const scheduler = resolveOpenworkScheduler();
      if (!scheduler) {
        setLegacySchedulerSupported(null);
        setScheduledJobs([]);
        const status =
          deps.openworkServerStatus() === "disconnected"
            ? "SuperClaw server unavailable. Connect to sync scheduled tasks."
            : deps.openworkServerStatus() === "limited"
              ? "SuperClaw server needs a token to load scheduled tasks."
              : "SuperClaw server not ready.";
        setScheduledJobsStatus(status);
        return;
      }

      setScheduledJobsBusy(true);
      setScheduledJobsStatus(null);

      try {
        const response = await scheduler.client.listScheduledJobs?.(scheduler.workspaceId);
        if (!isCurrentIdentity(identity)) return;
        const jobs = Array.isArray(response?.items) ? response.items : [];
        setLegacySchedulerSupported(typeof response?.supported === "boolean" ? response.supported : null);
        setScheduledJobs(jobs);
        setScheduledJobsUpdatedAt(Date.now());
      } catch (error) {
        if (!isCurrentIdentity(identity)) return;
        // The legacy launchd/systemd-backed endpoint always 400s with this code on a
        // platform it doesn't support (e.g. Windows) — that's a truthful "no jobs
        // here" for a read-only list, not an error to surface. Checking the server's
        // error code (not the client's OS) is correct regardless of whether the
        // client and the remote sandbox run on the same machine.
        if (isErrorCode(error, "scheduler_unsupported")) {
          setLegacySchedulerSupported(false);
          setScheduledJobs([]);
          setScheduledJobsStatus(null);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setLegacySchedulerSupported(null);
        setScheduledJobs([]);
        setScheduledJobsStatus(message || "Failed to load scheduled tasks.");
      } finally {
        setScheduledJobsBusy(false);
      }
      return;
    }

    if (!deps.isTauriRuntime()) {
      setLegacySchedulerSupported(null);
      setScheduledJobs([]);
      setScheduledJobsStatus(null);
      return;
    }

    if (deps.isWindowsPlatform()) {
      setLegacySchedulerSupported(false);
      setScheduledJobs([]);
      setScheduledJobsStatus(null);
      return;
    }

    if (!schedulerPluginInstalled()) {
      setLegacySchedulerSupported(null);
      setScheduledJobs([]);
      setScheduledJobsStatus(null);
      return;
    }

    setScheduledJobsBusy(true);
    setScheduledJobsStatus(null);

    try {
      const root = deps.activeWorkspaceRoot().trim();
      const jobs = await deps.schedulerListJobs(root || undefined);
      if (!isCurrentIdentity(identity)) return;
      setLegacySchedulerSupported(true);
      setScheduledJobs(jobs);
      setScheduledJobsUpdatedAt(Date.now());
    } catch (error) {
      if (!isCurrentIdentity(identity)) return;
      const message = error instanceof Error ? error.message : String(error);
      setLegacySchedulerSupported(null);
      setScheduledJobs([]);
      setScheduledJobsStatus(message || "Failed to load scheduled tasks.");
    } finally {
      setScheduledJobsBusy(false);
    }
  };

  const deleteScheduledJob = async (name: string) => {
    if (scheduledJobsSource() === "remote") {
      const scheduler = resolveOpenworkScheduler();
      if (!scheduler) {
        throw new Error("SuperClaw server unavailable. Connect to sync scheduled tasks.");
      }

      const response = await scheduler.client.deleteScheduledJob?.(
        scheduler.workspaceId,
        name,
      );
      if (!response || !response.job) {
        throw new Error("Failed to delete scheduled task.");
      }
      setScheduledJobs((current) =>
        current.filter((entry) => entry.slug !== response.job.slug),
      );
      return;
    }

    if (!deps.isTauriRuntime()) {
      throw new Error("Scheduled tasks require the desktop app.");
    }
    if (deps.isWindowsPlatform()) {
      throw new Error("Scheduler is not supported on Windows yet.");
    }

    const root = deps.activeWorkspaceRoot().trim();
    const job = await deps.schedulerDeleteJob(name, root || undefined);
    setScheduledJobs((current) =>
      current.filter((entry) => entry.slug !== job.slug),
    );
  };

  return {
    scheduledJobs,
    scheduledJobsStatus,
    legacySchedulerSupported,
    scheduledJobsBusy,
    scheduledJobsUpdatedAt,
    scheduledJobsSource,
    scheduledJobsSourceReady,
    schedulerPluginInstalled,
    refreshScheduledJobs,
    deleteScheduledJob,
    resolveOpenworkScheduler,
    setScheduledJobs,
    setScheduledJobsStatus,
    setScheduledJobsBusy,
    setScheduledJobsUpdatedAt,
  };
}

export type SchedulerFeature = ReturnType<typeof useScheduler>;