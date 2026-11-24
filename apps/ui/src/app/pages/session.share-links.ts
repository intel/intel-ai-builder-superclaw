import { t } from "../../i18n";
import {
  buildOpenworkConnectInviteUrl,
  buildOpenworkWorkspaceBaseUrl,
} from "../lib/openwork-server";
import type { OpenworkServerSettings } from "../lib/openwork-server";
import type { OpenworkWorkspaceList } from "~/shared/platform/transport/openwork-server.types";
import type { EngineInfo, OpenworkServerInfo, WorkspaceInfo } from "../lib/tauri";
import { isTauriRuntime, normalizeDirectoryPath } from "../utils";
import type { ShareField } from "../components/share-workspace-modal";

type ShareWorkspaceContext = {
  workspace: WorkspaceInfo | null;
  hostInfo: OpenworkServerInfo | null;
  settingsToken: OpenworkServerSettings["token"];
};

type ShareLinkContext = ShareWorkspaceContext & {
  localOpenworkWorkspaceId: string | null;
};

export const hostShareToken = (hostInfo: OpenworkServerInfo | null) =>
  hostInfo?.ownerToken?.trim() || hostInfo?.clientToken?.trim() || "";

export const remoteShareToken = (
  ws: WorkspaceInfo,
  settingsToken: OpenworkServerSettings["token"],
) => ws.openworkToken?.trim() || settingsToken?.trim() || "";

export const remoteHostUrl = (ws: WorkspaceInfo) =>
  ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";

const openworkWorkspaceUrl = (ws: WorkspaceInfo) => {
  const hostUrl = remoteHostUrl(ws);
  return buildOpenworkWorkspaceBaseUrl(hostUrl, ws.openworkWorkspaceId) || hostUrl;
};

export function resolveShareWorkspaceDetail(ws: WorkspaceInfo | null): string {
  if (!ws) return "";
  if (ws.workspaceType === "remote") {
    if (ws.remoteType === "openwork") return openworkWorkspaceUrl(ws);
    return ws.baseUrl?.trim() || "";
  }
  return ws.path?.trim() || "";
}

export function buildShareFields(ctx: ShareLinkContext): ShareField[] {
  const ws = ctx.workspace;
  if (!ws) return [];

  if (ws.workspaceType !== "remote") {
    const hostUrl =
      ctx.hostInfo?.connectUrl?.trim() ||
      ctx.hostInfo?.lanUrl?.trim() ||
      ctx.hostInfo?.mdnsUrl?.trim() ||
      ctx.hostInfo?.baseUrl?.trim() ||
      "";
    const mountedUrl = ctx.localOpenworkWorkspaceId
      ? buildOpenworkWorkspaceBaseUrl(hostUrl, ctx.localOpenworkWorkspaceId)
      : null;
    const url = mountedUrl || hostUrl;
    const ownerToken = ctx.hostInfo?.ownerToken?.trim() || "";
    const collaboratorToken = ctx.hostInfo?.clientToken?.trim() || "";
    const inviteToken = ownerToken || collaboratorToken;
    const inviteUrl = buildOpenworkConnectInviteUrl({
      workspaceUrl: url,
      token: inviteToken,
    });
    return [
      {
        label: "SuperClaw invite link",
        value: inviteUrl,
        secret: true,
        placeholder: !isTauriRuntime()
          ? "Desktop app required"
          : "Starting server...",
        hint: ownerToken
          ? "One link that prefills the worker URL and owner token for permission prompts."
          : "One link that prefills the worker URL and collaborator token.",
      },
      {
        label: "SuperClaw worker URL",
        value: url,
        placeholder: !isTauriRuntime()
          ? "Desktop app required"
          : "Starting server...",
        hint: mountedUrl
          ? "Use on phones or laptops connecting to this worker."
          : hostUrl
            ? "Worker URL is resolving; host URL shown as fallback."
            : undefined,
      },
      {
        label: "Owner token",
        value: ownerToken,
        secret: true,
        placeholder: isTauriRuntime() ? "-" : "Desktop app required",
        hint: mountedUrl
          ? "Use on phones or laptops connecting to this worker."
          : "Use on phones or laptops connecting to this host when the remote client must answer permission prompts.",
      },
      {
        label: "Collaborator token",
        value: collaboratorToken,
        secret: true,
        placeholder: isTauriRuntime() ? "-" : "Desktop app required",
        hint: mountedUrl
          ? "Routine remote access when you do not need owner-only actions."
          : "Routine remote access to this host without owner-only actions.",
      },
    ];
  }

  if (ws.remoteType === "openwork") {
    const url = openworkWorkspaceUrl(ws);
    const token = remoteShareToken(ws, ctx.settingsToken);
    const inviteUrl = buildOpenworkConnectInviteUrl({
      workspaceUrl: url,
      token,
    });
    return [
      {
        label: "SuperClaw invite link",
        value: inviteUrl,
        secret: true,
        hint: "One link that prefills worker URL and token.",
      },
      {
        label: "SuperClaw worker URL",
        value: url,
      },
      {
        label: "Connected token",
        value: token,
        secret: true,
        placeholder: token ? undefined : "Set token in workspace settings",
        hint: "This worker is currently connected with this token.",
      },
    ];
  }

  return [
    {
      label: t("session.base_url_label"),
      value: ws.baseUrl?.trim() || ws.path?.trim() || "",
    },
    {
      label: "Directory",
      value: ws.directory?.trim() || "",
      placeholder: "(auto)",
    },
  ];
}

export function resolveShareNote(
  ws: WorkspaceInfo | null,
  engineRuntime: EngineInfo["runtime"] | undefined,
): string | null {
  if (!ws) return null;
  if (ws.workspaceType === "local" && engineRuntime === "direct") {
    return "Engine runtime is set to Direct. Switching local workers can restart the host and disconnect clients. The token may change after a restart.";
  }
  return null;
}

export function resolveShareServiceDisabledReason(
  ctx: ShareWorkspaceContext,
): string | null {
  const ws = ctx.workspace;
  if (!ws) return "Select a worker first.";
  if (ws.workspaceType === "remote" && ws.remoteType !== "openwork") {
    return "Share service links are available for SuperClaw workers.";
  }
  if (ws.workspaceType !== "remote") {
    const baseUrl = ctx.hostInfo?.baseUrl?.trim() ?? "";
    if (!baseUrl || !hostShareToken(ctx.hostInfo)) {
      return "Local SuperClaw host is not ready yet.";
    }
  } else {
    if (!remoteHostUrl(ws)) return "Missing SuperClaw host URL.";
    if (!remoteShareToken(ws, ctx.settingsToken)) {
      return "Missing SuperClaw token.";
    }
  }
  return null;
}

const listedWorkspaces = (response: OpenworkWorkspaceList) =>
  Array.isArray(response.items) ? response.items : [];

export function matchLocalWorkspaceIdByPath(
  response: OpenworkWorkspaceList,
  workspacePath: string,
): string | null {
  const targetPath = normalizeDirectoryPath(workspacePath);
  const match = listedWorkspaces(response).find(
    (entry) => normalizeDirectoryPath(entry.path) === targetPath,
  );
  return match?.id ?? null;
}

export function resolveOpenworkWorkspaceIdFromList(
  response: OpenworkWorkspaceList,
  ws: WorkspaceInfo,
): string {
  const items = listedWorkspaces(response);
  const directoryHint = normalizeDirectoryPath(
    ws.directory?.trim() ?? ws.path?.trim() ?? "",
  );
  const match = directoryHint
    ? items.find((entry) => {
        const entryPath = normalizeDirectoryPath(
          (
            entry.opencode?.directory ??
            entry.directory ??
            entry.path ??
            ""
          ).trim(),
        );
        return Boolean(entryPath && entryPath === directoryHint);
      })
    : ((response.activeId
        ? items.find((entry) => entry.id === response.activeId)
        : null) ?? items[0]);
  return (match?.id ?? "").trim();
}