import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import {
  createOpenworkServerClient,
  parseOpenworkWorkspaceIdFromUrl,
} from "../lib/openwork-server";
import type {
  OpenworkServerClient,
  OpenworkServerSettings,
} from "../lib/openwork-server";
import { publishOpenworkBundleJson } from "../lib/publisher";
import type { EngineInfo, OpenworkServerInfo, WorkspaceInfo } from "../lib/tauri";
import type { SkillsSetBundleV1, WorkspaceProfileBundleV1 } from "../types";
import { isTauriRuntime } from "../utils";
import {
  buildShareFields,
  hostShareToken,
  matchLocalWorkspaceIdByPath,
  remoteHostUrl,
  remoteShareToken,
  resolveOpenworkWorkspaceIdFromList,
  resolveShareNote,
  resolveShareServiceDisabledReason,
  resolveShareWorkspaceDetail,
} from "./session.share-links";
import type { ShareField } from "../components/share-workspace-modal";

/**
 * Reactive inputs arrive as thunks so the controller reads them in its
 * caller's tracking scope instead of capturing a value at setup time.
 */
type SharePublishDeps = {
  /** Workspace the share modal is currently opened for. */
  shareWorkspaceId: () => string | null;
  workspaces: () => WorkspaceInfo[];
  workspaceLabel: (workspace: WorkspaceInfo) => string;
  serverHostInfo: () => OpenworkServerInfo | null;
  serverSettings: () => OpenworkServerSettings;
  engineInfo: () => EngineInfo | null;
  exportWorkspaceBusy: () => boolean;
};

type SharePublishController = {
  workspaceName: () => string;
  workspaceDetail: () => string;
  fields: () => ShareField[];
  note: () => string | null;
  serviceDisabledReason: () => string | null;
  exportDisabledReason: () => string | null;
  workspaceProfileBusy: () => boolean;
  workspaceProfileUrl: () => string | null;
  workspaceProfileError: () => string | null;
  publishWorkspaceProfileLink: () => Promise<void>;
  skillsSetBusy: () => boolean;
  skillsSetUrl: () => string | null;
  skillsSetError: () => string | null;
  publishSkillsSetLink: () => Promise<void>;
};

/**
 * Backs the share-workspace modal: the connection fields it displays and the
 * two publish actions that export a workspace as a shareable bundle link.
 *
 * Resolving the workspace differs by kind — a local worker has to be looked up
 * on the local SuperClaw host by path, while a remote one carries its own host
 * URL and id — so both publish actions go through one shared resolution step.
 */
export function createSharePublish(
  deps: SharePublishDeps,
): SharePublishController {
  const shareWorkspace = createMemo(() => {
    const id = deps.shareWorkspaceId();
    if (!id) return null;
    return deps.workspaces().find((ws) => ws.id === id) ?? null;
  });

  const shareWorkspaceName = createMemo(() => {
    const ws = shareWorkspace();
    return ws ? deps.workspaceLabel(ws) : "";
  });

  const shareWorkspaceDetail = createMemo(() =>
    resolveShareWorkspaceDetail(shareWorkspace()),
  );

  const [shareLocalOpenworkWorkspaceId, setShareLocalOpenworkWorkspaceId] =
    createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] =
    createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = createSignal<
    string | null
  >(null);
  const [shareWorkspaceProfileError, setShareWorkspaceProfileError] =
    createSignal<string | null>(null);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(
    null,
  );
  const [shareSkillsSetError, setShareSkillsSetError] = createSignal<
    string | null
  >(null);

  createEffect(
    on(deps.shareWorkspaceId, () => {
      setShareWorkspaceProfileBusy(false);
      setShareWorkspaceProfileUrl(null);
      setShareWorkspaceProfileError(null);
      setShareSkillsSetBusy(false);
      setShareSkillsSetUrl(null);
      setShareSkillsSetError(null);
    }),
  );

  createEffect(() => {
    const ws = shareWorkspace();
    const hostInfo = deps.serverHostInfo();
    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token =
      hostInfo?.ownerToken?.trim() || hostInfo?.clientToken?.trim() || "";
    const workspacePath =
      ws?.workspaceType === "local" ? (ws.path?.trim() ?? "") : "";

    if (
      !ws ||
      ws.workspaceType !== "local" ||
      !workspacePath ||
      !baseUrl ||
      !token
    ) {
      setShareLocalOpenworkWorkspaceId(null);
      return;
    }

    let cancelled = false;
    setShareLocalOpenworkWorkspaceId(null);

    void (async () => {
      try {
        const client = createOpenworkServerClient({ baseUrl, token });
        const response = await client.listWorkspaces();
        if (cancelled) return;
        setShareLocalOpenworkWorkspaceId(
          matchLocalWorkspaceIdByPath(response, workspacePath),
        );
      } catch {
        if (!cancelled) setShareLocalOpenworkWorkspaceId(null);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const shareFields = createMemo(() =>
    buildShareFields({
      workspace: shareWorkspace(),
      hostInfo: deps.serverHostInfo(),
      settingsToken: deps.serverSettings().token,
      localOpenworkWorkspaceId: shareLocalOpenworkWorkspaceId(),
    }),
  );

  const shareNote = createMemo(() =>
    resolveShareNote(shareWorkspace(), deps.engineInfo()?.runtime),
  );

  const shareServiceDisabledReason = createMemo(() =>
    resolveShareServiceDisabledReason({
      workspace: shareWorkspace(),
      hostInfo: deps.serverHostInfo(),
      settingsToken: deps.serverSettings().token,
    }),
  );

  const resolveShareExportContext = async (): Promise<{
    client: OpenworkServerClient;
    workspaceId: string;
    workspace: WorkspaceInfo;
  }> => {
    const ws = shareWorkspace();
    if (!ws) {
      throw new Error("Select a worker first.");
    }

    if (ws.workspaceType !== "remote") {
      const hostInfo = deps.serverHostInfo();
      const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
      const token = hostShareToken(hostInfo);
      if (!baseUrl || !token) {
        throw new Error("Local SuperClaw host is not ready yet.");
      }
      const client = createOpenworkServerClient({ baseUrl, token });

      let workspaceId = shareLocalOpenworkWorkspaceId()?.trim() ?? "";
      if (!workspaceId) {
        const response = await client.listWorkspaces();
        workspaceId =
          matchLocalWorkspaceIdByPath(response, ws.path?.trim() ?? "")?.trim() ??
          "";
        setShareLocalOpenworkWorkspaceId(workspaceId || null);
      }

      if (!workspaceId) {
        throw new Error(
          "Could not resolve this worker on the local SuperClaw host.",
        );
      }

      return { client, workspaceId, workspace: ws };
    }

    if (ws.remoteType !== "openwork") {
      throw new Error(
        "Share service links are available for SuperClaw workers.",
      );
    }

    const hostUrl = remoteHostUrl(ws);
    const token = remoteShareToken(ws, deps.serverSettings().token);
    if (!hostUrl || !token) {
      throw new Error("SuperClaw host URL and token are required.");
    }

    const client = createOpenworkServerClient({ baseUrl: hostUrl, token });
    let workspaceId =
      ws.openworkWorkspaceId?.trim() ||
      parseOpenworkWorkspaceIdFromUrl(ws.openworkHostUrl ?? "") ||
      parseOpenworkWorkspaceIdFromUrl(ws.baseUrl ?? "") ||
      "";

    if (!workspaceId) {
      const response = await client.listWorkspaces();
      workspaceId = resolveOpenworkWorkspaceIdFromList(response, ws);
    }

    if (!workspaceId) {
      throw new Error("Could not resolve this worker on the SuperClaw host.");
    }

    return { client, workspaceId, workspace: ws };
  };

  const publishWorkspaceProfileLink = async () => {
    if (shareWorkspaceProfileBusy()) return;
    setShareWorkspaceProfileBusy(true);
    setShareWorkspaceProfileError(null);
    setShareWorkspaceProfileUrl(null);

    try {
      const { client, workspaceId, workspace } =
        await resolveShareExportContext();
      const exported = await client.exportWorkspace(workspaceId);
      const payload: WorkspaceProfileBundleV1 = {
        schemaVersion: 1,
        type: "workspace-profile",
        name: `${deps.workspaceLabel(workspace)} profile`,
        description:
          "Full SuperClaw workspace profile with config, MCP setup, commands, and skills.",
        workspace: exported,
      };

      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "workspace-profile",
        name: payload.name,
      });

      setShareWorkspaceProfileUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareWorkspaceProfileError(
        error instanceof Error
          ? error.message
          : "Failed to publish workspace profile",
      );
    } finally {
      setShareWorkspaceProfileBusy(false);
    }
  };

  const publishSkillsSetLink = async () => {
    if (shareSkillsSetBusy()) return;
    setShareSkillsSetBusy(true);
    setShareSkillsSetError(null);
    setShareSkillsSetUrl(null);

    try {
      const { client, workspaceId, workspace } =
        await resolveShareExportContext();
      const exported = await client.exportWorkspace(workspaceId);
      const skills = Array.isArray(exported.skills) ? exported.skills : [];
      if (!skills.length) {
        throw new Error("No skills found in this workspace.");
      }

      const payload: SkillsSetBundleV1 = {
        schemaVersion: 1,
        type: "skills-set",
        name: `${deps.workspaceLabel(workspace)} skills`,
        description: "Complete skills set from a SuperClaw workspace.",
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
        sourceWorkspace: {
          id: workspaceId,
          name: deps.workspaceLabel(workspace),
        },
      };

      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "skills-set",
        name: payload.name,
      });

      setShareSkillsSetUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareSkillsSetError(
        error instanceof Error ? error.message : "Failed to publish skills set",
      );
    } finally {
      setShareSkillsSetBusy(false);
    }
  };

  const exportDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "Export is available for local workers in the desktop app.";
    if (ws.workspaceType === "remote")
      return "Export is only supported for local workers.";
    if (!isTauriRuntime()) return "Export is available in the desktop app.";
    if (deps.exportWorkspaceBusy()) return "Export is already running.";
    return null;
  });

  return {
    workspaceName: shareWorkspaceName,
    workspaceDetail: shareWorkspaceDetail,
    fields: shareFields,
    note: shareNote,
    serviceDisabledReason: shareServiceDisabledReason,
    exportDisabledReason,
    workspaceProfileBusy: shareWorkspaceProfileBusy,
    workspaceProfileUrl: shareWorkspaceProfileUrl,
    workspaceProfileError: shareWorkspaceProfileError,
    publishWorkspaceProfileLink,
    skillsSetBusy: shareSkillsSetBusy,
    skillsSetUrl: shareSkillsSetUrl,
    skillsSetError: shareSkillsSetError,
    publishSkillsSetLink,
  };
}
