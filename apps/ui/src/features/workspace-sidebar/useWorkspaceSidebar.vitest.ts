// Not `bun test`: that resolves solid's server build, where a createMemo is
// frozen at its first value, so `sidebarWorkspaceGroups` could never update.
import { describe, expect, test } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { Session } from "@opencode-ai/sdk/v2/client";
import type { WorkspaceInfo } from "~/shared/platform/tauri";
import { createWorkspaceSidebarFeature } from "./useWorkspaceSidebar";

describe("createWorkspaceSidebarFeature", () => {
  test("keeps workspace-scoped sidebar groups and prunes removed workspaces", () => {
    createRoot(() => {
      const workspace = {
        id: "ws-1",
        name: "Mock workspace",
        path: "/tmp/mock",
        directory: "/tmp/mock",
        workspaceType: "local",
        sandboxBackend: "servicehub",
      } as WorkspaceInfo;

      const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([]);
      const [activeWorkspaceId] = createSignal(workspace.id);
      const [connectingWorkspaceId] = createSignal<string | null>(null);
      const [sessions, setSessions] = createSignal<Session[]>([
        {
          id: "session-1",
          title: "Mock session",
          directory: "/tmp/mock",
          slug: "mock-session",
          parentID: null,
          time: { created: 1, updated: 2 },
        },
      ] as unknown as Session[]);

      const feature = createWorkspaceSidebarFeature({
        sessions,
        workspaces,
        activeWorkspaceId,
        connectingWorkspaceId,
        workspaceConnectionStateById: () => ({}),
        engine: () => ({
          baseUrl: "http://localhost:4096",
          runtime: "direct",
          opencodeUsername: null,
          opencodePassword: null,
        }),
      });

      setWorkspaces([workspace]);
      feature.setSidebarSessionsByWorkspaceId((prev) => ({
        ...prev,
        [workspace.id]: [{
          id: "session-1",
          title: "Mock session",
          slug: "mock-session",
          parentID: null,
          time: { created: 1, updated: 2 },
          directory: "/tmp/mock",
        }],
      }));
      feature.setSidebarSessionStatusByWorkspaceId((prev) => ({
        ...prev,
        [workspace.id]: "ready",
      }));

      expect(feature.sidebarWorkspaceGroups()).toHaveLength(1);
      expect(feature.sidebarWorkspaceGroups()[0]?.sessions[0]?.id).toBe("session-1");

      const sessionBeforeSync = feature.sidebarWorkspaceGroups()[0]?.sessions[0];
      setSessions((current) => [...current]);
      expect(feature.sidebarWorkspaceGroups()[0]?.sessions[0]).toBe(sessionBeforeSync);

      setWorkspaces([]);
      feature.pruneSidebarSessionState(new Set());
      expect(feature.sidebarWorkspaceGroups()).toHaveLength(0);
    });
  });
});