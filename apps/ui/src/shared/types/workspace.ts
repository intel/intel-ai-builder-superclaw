import type { WorkspaceInfo } from "~/shared/platform/tauri";
import type { SidebarSessionItem } from "~/shared/types/session";

export type WorkspacePreset = "starter" | "automation" | "minimal";

export type WorkspaceDisplay = WorkspaceInfo & {
  name: string;
};

export type WorkspaceSessionGroup = {
  workspace: WorkspaceInfo;
  sessions: SidebarSessionItem[];
  status: "idle" | "loading" | "ready" | "error";
  error?: string | null;
};

export type WorkspaceConnectionStatus = "idle" | "connecting" | "connected" | "error";

export type WorkspaceConnectionState = {
  status: WorkspaceConnectionStatus;
  message?: string | null;
  checkedAt?: number | null;
};


export type WorkspaceOpenworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};
