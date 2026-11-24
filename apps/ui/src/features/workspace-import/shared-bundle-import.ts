import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { OpenworkWorkspaceExport, OpenworkWorkspaceList, } from "~/shared/platform/transport/openwork-server.types";
import type { ReloadReason, ReloadTrigger } from "~/shared/types/opencode-connection";
import type { WorkspaceDisplay } from "~/shared/types/workspace";
import type { WorkspaceInfo } from "~/shared/platform/tauri";
import { isTauriRuntime } from "~/shared/platform/runtime-env";
import { safeStringify } from "~/shared/util/format";
import type { SharedBundleDeepLink } from "./deep-links";

export type SharedSkillItem = {
  name: string;
  description?: string;
  trigger?: string;
  content: string;
};

export type SharedSkillBundleV1 = {
  schemaVersion: 1;
  type: "skill";
  name: string;
  description?: string;
  trigger?: string;
  content: string;
};

export type SharedSkillsSetBundleV1 = {
  schemaVersion: 1;
  type: "skills-set";
  name: string;
  description?: string;
  skills: SharedSkillItem[];
};

export type SharedWorkspaceProfileBundleV1 = {
  schemaVersion: 1;
  type: "workspace-profile";
  name: string;
  description?: string;
  workspace: OpenworkWorkspaceExport;
};

export type SharedBundleV1 =
  | SharedSkillBundleV1
  | SharedSkillsSetBundleV1
  | SharedWorkspaceProfileBundleV1;

export type SharedBundleImportTarget = {
  workspaceId?: string | null;
  localRoot?: string | null;
  directoryHint?: string | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readSkillItem(value: unknown): SharedSkillItem | null {
  const record = readRecord(value);
  if (!record) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!name || !content) return null;
  return {
    name,
    description:
      typeof record.description === "string" ? record.description : undefined,
    trigger: typeof record.trigger === "string" ? record.trigger : undefined,
    content,
  };
}

export function parseSharedBundle(value: unknown): SharedBundleV1 {
  const record = readRecord(value);
  if (!record) {
    throw new Error("Invalid shared bundle payload.");
  }

  const schemaVersion =
    typeof record.schemaVersion === "number" ? record.schemaVersion : null;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";

  if (schemaVersion !== 1) {
    throw new Error("Unsupported bundle schema version.");
  }

  if (type === "skill") {
    const content = typeof record.content === "string" ? record.content : "";
    if (!name || !content) {
      throw new Error("Invalid skill bundle payload.");
    }
    return {
      schemaVersion: 1,
      type: "skill",
      name,
      description:
        typeof record.description === "string" ? record.description : undefined,
      trigger: typeof record.trigger === "string" ? record.trigger : undefined,
      content,
    };
  }

  if (type === "skills-set") {
    const skills = Array.isArray(record.skills)
      ? record.skills
          .map(readSkillItem)
          .filter((item): item is SharedSkillItem => Boolean(item))
      : [];
    if (!skills.length) {
      throw new Error("Skills set bundle has no importable skills.");
    }
    return {
      schemaVersion: 1,
      type: "skills-set",
      name: name || "Shared skills",
      description:
        typeof record.description === "string" ? record.description : undefined,
      skills,
    };
  }

  if (type === "workspace-profile") {
    const workspace = readRecord(record.workspace);
    if (!workspace) {
      throw new Error("Workspace profile bundle is missing workspace payload.");
    }
    return {
      schemaVersion: 1,
      type: "workspace-profile",
      name: name || "Shared workspace profile",
      description:
        typeof record.description === "string" ? record.description : undefined,
      workspace: workspace as OpenworkWorkspaceExport,
    };
  }

  throw new Error(`Unsupported bundle type: ${type || "unknown"}`);
}

export async function fetchSharedBundle(bundleUrl: string): Promise<SharedBundleV1> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(bundleUrl);
  } catch {
    throw new Error("Invalid shared bundle URL.");
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    throw new Error("Shared bundle URL must use http(s).");
  }

  if (!targetUrl.searchParams.has("format")) {
    targetUrl.searchParams.set("format", "json");
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);

  try {
    let response: Response;
    try {
      response = isTauriRuntime()
        ? await tauriFetch(targetUrl.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          })
        : await fetch(targetUrl.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : safeStringify(error);
      throw new Error(
        `Failed to load shared bundle from ${targetUrl.toString()}: ${message}`,
      );
    }

    if (!response.ok) {
      const details = (await response.text()).trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(
        `Failed to fetch bundle from ${targetUrl.toString()} (${response.status})${suffix}`,
      );
    }

    return parseSharedBundle(await response.json());
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function buildImportPayloadFromBundle(bundle: SharedBundleV1): {
  payload: Record<string, unknown>;
  importedSkillsCount: number;
} {
  if (bundle.type === "skill") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: [
          {
            name: bundle.name,
            description: bundle.description,
            trigger: bundle.trigger,
            content: bundle.content,
          },
        ],
      },
      importedSkillsCount: 1,
    };
  }

  if (bundle.type === "skills-set") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: bundle.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
      },
      importedSkillsCount: bundle.skills.length,
    };
  }

  const workspace = bundle.workspace;
  const payload: Record<string, unknown> = {
    mode: {
      opencode: "merge",
      openwork: "merge",
      skills: "merge",
      commands: "merge",
    },
  };

  if (workspace.opencode && typeof workspace.opencode === "object") {
    payload.opencode = workspace.opencode;
  }
  if (workspace.openwork && typeof workspace.openwork === "object") {
    payload.openwork = workspace.openwork;
  }
  if (Array.isArray(workspace.skills) && workspace.skills.length) {
    payload.skills = workspace.skills;
  }
  if (Array.isArray(workspace.commands) && workspace.commands.length) {
    payload.commands = workspace.commands;
  }

  return {
    payload,
    importedSkillsCount: Array.isArray(workspace.skills)
      ? workspace.skills.length
      : 0,
  };
}

export type SharedBundleImportFlowDeps = {
  openworkServerClient: () => {
    listWorkspaces: () => Promise<OpenworkWorkspaceList>;
    importWorkspace: (
      workspaceId: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>;
  } | null;
  openworkServerStatus: () => string;
  openworkServerWorkspaceId?: () => string | null;
  setOpenworkServerWorkspaceId: (id: string | null) => void;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshHubSkills: (options?: { force?: boolean }) => Promise<void>;
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  safeStringify: (value: unknown) => string;
  setError: (message: string | null) => void;
  resolveSharedBundleWorkerTarget: () => { hostUrl: string; token: string };
  resolveSharedBundleImportTargetForWorkspace: (
    workspace: WorkspaceDisplay | WorkspaceInfo | null,
  ) => SharedBundleImportTarget | undefined;
  resolveActiveSharedBundleImportTarget: () => SharedBundleImportTarget;
  findSharedBundleImportWorkspaceId: (
    items: Array<{
      id: string;
      path?: string;
      directory?: string;
      opencode?: { directory?: string };
    }>,
    target?: SharedBundleImportTarget,
  ) => string | null;
  workspaceStore: {
    createRemoteWorkspaceFlow: (options: {
      openworkHostUrl: string;
      openworkToken: string;
      directory: string | null;
      displayName: string;
      manageBusy: boolean;
      closeModal: boolean;
    }) => Promise<boolean>;
    activateWorkspace: (workspaceId: string) => Promise<boolean>;
    setCreateWorkspaceOpen: (value: boolean) => void;
    workspaces: () => Array<WorkspaceDisplay | WorkspaceInfo>;
  };
  openSettings: (section: "scheduled" | "skills") => void;
  setSharedSkillDestinationRequest: (
    value: { request: SharedBundleDeepLink; bundle: SharedSkillBundleV1 } | null,
  ) => void;
  setSharedBundleImportChoice: (
    value: { request: SharedBundleDeepLink; bundle: SharedBundleV1 } | null,
  ) => void;
  setSharedBundleCreateWorkerRequest: (
    value: {
      request: SharedBundleDeepLink;
      bundle: SharedBundleV1;
      defaultPreset: string;
    } | null,
  ) => void;
  setSharedBundleNoticeShown: (value: boolean) => void;
  sharedBundleNoticeShown: () => boolean;
  showSharedSkillSuccessToast?: (toast: {
    title: string;
    description: string;
  }) => void;
  describeWorkspaceForToasts?: (workspace: WorkspaceDisplay | WorkspaceInfo | null) => string;
  setSharedSkillDestinationBusyId?: (value: string | null) => void;
  sharedSkillDestinationBusyId?: () => string | null;
  sharedSkillDestinationRequest?: () => {
    request: SharedBundleDeepLink;
    bundle: SharedSkillBundleV1;
  } | null;
  setSharedBundleImportBusy?: (value: boolean) => void;
  sharedBundleImportBusy?: () => boolean;
  pendingSharedBundleInvite?: () => SharedBundleDeepLink | null;
  isSharedBundleImportWorkspace?: (
    workspace: WorkspaceDisplay | WorkspaceInfo | null,
  ) => boolean;
};

export function createSharedBundleImportFlow(deps: SharedBundleImportFlowDeps) {
  const waitForSharedBundleImportTarget = async (
    timeoutMs = 20_000,
    target?: SharedBundleImportTarget,
  ) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const client = deps.openworkServerClient();
      if (client && deps.openworkServerStatus() === "connected") {
        try {
          const response = await client.listWorkspaces();
          const items = Array.isArray(response.items) ? response.items : [];
          const explicitId = target?.workspaceId?.trim() ?? "";
          const localRoot = target?.localRoot?.trim() ?? "";
          const directoryHint = target?.directoryHint?.trim() ?? "";

          if (explicitId || localRoot || directoryHint) {
            const matchId = deps.findSharedBundleImportWorkspaceId(items, target);
            if (matchId) {
              deps.setOpenworkServerWorkspaceId(matchId);
              return { client, workspaceId: matchId };
            }
          }

          const currentId = deps.openworkServerWorkspaceId?.() ?? null;
          const fallbackId =
            currentId?.trim() ||
            response.activeId?.trim() ||
            items[0]?.id?.trim() ||
            null;

          if (fallbackId) {
            deps.setOpenworkServerWorkspaceId(fallbackId);
            return { client, workspaceId: fallbackId };
          }
        } catch {
          // ignore and keep polling
        }
      }
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 200);
      });
    }
    throw new Error("OpenWork worker is not ready yet.");
  };

  const importSharedBundlePayload = async (
    bundle: SharedBundleV1,
    target?: SharedBundleImportTarget,
  ) => {
    const { client, workspaceId } = await waitForSharedBundleImportTarget(
      20_000,
      target,
    );
    const { payload, importedSkillsCount } = buildImportPayloadFromBundle(bundle);
    await client.importWorkspace(workspaceId, payload);
    await deps.refreshSkills({ force: true });
    await deps.refreshHubSkills({ force: true });
    if (importedSkillsCount > 0) {
      deps.markReloadRequired("skills", {
        type: "skill",
        name: bundle.name?.trim() || undefined,
        action: "added",
      });
      console.log(
        `[openwork] imported ${importedSkillsCount} skills from share bundle`,
      );
    }
  };

  const importSharedBundleIntoActiveWorker = async (
    request: SharedBundleDeepLink,
    target?: SharedBundleImportTarget,
    bundleOverride?: SharedBundleV1,
  ) => {
    try {
      const bundle =
        bundleOverride ?? (await fetchSharedBundle(request.bundleUrl));
      await importSharedBundlePayload(bundle, target);
      deps.setError(null);
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : deps.safeStringify(error);
      deps.setError(message);
      return false;
    }
  };

  const createWorkerForSharedBundle = async (
    request: SharedBundleDeepLink,
    bundle: SharedBundleV1,
  ) => {
    const target = deps.resolveSharedBundleWorkerTarget();
    const hostUrl = target.hostUrl.trim();
    const token = target.token.trim();
    if (!hostUrl || !token) {
      throw new Error(
        "Share link detected. Configure an OpenWork worker host and token, then open the link again.",
      );
    }

    const label = (
      request.label?.trim() ||
      bundle.name?.trim() ||
      "Shared setup"
    ).slice(0, 80);
    const ok = await deps.workspaceStore.createRemoteWorkspaceFlow({
      openworkHostUrl: hostUrl,
      openworkToken: token,
      directory: null,
      displayName: label,
      manageBusy: false,
      closeModal: false,
    });

    if (!ok) {
      throw new Error("Failed to create a worker from this share link.");
    }
  };

  const processSharedBundleInvite = async (request: SharedBundleDeepLink) => {
    const bundle = await fetchSharedBundle(request.bundleUrl);

    if (bundle.type === "skill") {
      deps.openSettings("scheduled");
      deps.setError(null);
      deps.setSharedSkillDestinationRequest({ request, bundle });
      return { mode: "choice" as const, bundle };
    }

    if (bundle.type === "skills-set") {
      deps.openSettings("skills");
      deps.setError(null);
      deps.setSharedBundleImportChoice({ request, bundle });
      return { mode: "choice" as const, bundle };
    }

    if (request.intent === "new_worker" && isTauriRuntime()) {
      deps.openSettings("scheduled");
      deps.setError(null);
      deps.setSharedBundleCreateWorkerRequest({
        request,
        bundle,
        defaultPreset: "automation",
      });
      deps.workspaceStore.setCreateWorkspaceOpen(true);
      return { mode: "new_worker_modal" as const, bundle };
    }

    if (request.intent === "import_current") {
      const client = deps.openworkServerClient();
      const connected = deps.openworkServerStatus() === "connected";
      const target = deps.resolveActiveSharedBundleImportTarget();
      const hasTargetHint = Boolean(
        target.workspaceId?.trim() ||
          target.localRoot?.trim() ||
          target.directoryHint?.trim(),
      );
      if (!client || !connected || !hasTargetHint) {
        if (!deps.sharedBundleNoticeShown()) {
          deps.setSharedBundleNoticeShown(true);
          deps.setError(
            "Share link detected. Connect to a writable OpenWork worker to import this bundle.",
          );
        }
        return { mode: "blocked_import_current" as const, bundle };
      }
    } else {
      const target = deps.resolveSharedBundleWorkerTarget();
      if (!target.hostUrl.trim() || !target.token.trim()) {
        if (!deps.sharedBundleNoticeShown()) {
          deps.setSharedBundleNoticeShown(true);
          deps.setError(
            "Share link detected. Configure an OpenWork host and token to create a new worker.",
          );
        }
        return { mode: "blocked_new_worker" as const, bundle };
      }
    }

    if (request.intent === "new_worker") {
      await createWorkerForSharedBundle(request, bundle);
    }

    await importSharedBundlePayload(bundle, deps.resolveActiveSharedBundleImportTarget());
    deps.setError(null);
    return { mode: "imported" as const, bundle };
  };

  return {
    importSharedBundlePayload,
    importSharedBundleIntoActiveWorker,
    createWorkerForSharedBundle,
    processSharedBundleInvite,
  };
}