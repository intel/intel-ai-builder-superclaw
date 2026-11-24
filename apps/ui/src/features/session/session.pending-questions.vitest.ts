import { createRoot, createSignal } from "solid-js";
import { describe, expect, test } from "vitest";

import type { PendingQuestion } from "~/shared/types/session";
import { createSessionStore } from "./session";

// The effect that looks up parent sessions does not run in `bun test` (server build of
// solid), so this lives in the vitest lane.
describe("a subagent's question", () => {
  test("shows in the session that started it, however deep", async () => {
    // session-3 (the subagent) is a child of session-2, which is a child of session-1 (selected).
    const parents: Record<string, string | undefined> = { "session-3": "session-2", "session-2": "session-1" };
    const [selectedSession] = createSignal<string | null>("session-1");
    let store!: ReturnType<typeof createSessionStore>;
    const dispose = createRoot((d) => {
      store = createSessionStore({
        client: () =>
          ({
            session: { get: async ({ sessionID }: { sessionID: string }) => ({ data: { parentID: parents[sessionID] } }) },
          }) as never,
        activeWorkspaceRoot: () => "",
        selectedSessionId: selectedSession,
        setSelectedSessionId: () => undefined,
        sessionModelState: () => ({ overrides: {}, resolved: {} }),
        setSessionModelState: (update) => update({ overrides: {}, resolved: {} }),
        lastUserModelFromMessages: () => null,
        developerMode: () => false,
        setError: () => undefined,
        setSseConnected: () => undefined,
      });
      return d;
    });
    store.setPendingQuestions([{ id: "question-1", sessionID: "session-3" } as PendingQuestion]);
    expect(store.activeQuestion()).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(store.activeQuestion()?.id).toBe("question-1");
    dispose();
  });
});
