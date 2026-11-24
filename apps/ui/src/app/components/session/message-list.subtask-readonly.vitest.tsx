import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";

import MessageList from "./message-list";
import { PlatformProvider, type Platform } from "../../context/platform";
import type { MessageWithParts } from "../../types";

const platform: Platform = {
  platform: "web",
  openLink: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
};

function textMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: "session-1",
      role,
      time: { created: 1_000 },
      modelID: "cloud-model",
      providerID: "llmrouter",
      mode: "chat",
      path: { cwd: "/w", root: "/w" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as MessageWithParts["info"],
    parts: [
      { id: `${id}-p0`, type: "text", text } as unknown as MessageWithParts["parts"][number],
    ],
  };
}

function toolMessage(
  id: string,
  tool: string,
  state: Record<string, unknown>,
): MessageWithParts {
  const message = textMessage(id, "assistant", "");
  return {
    ...message,
    parts: [
      {
        id: `${id}-tool`,
        type: "tool",
        tool,
        state,
      } as unknown as MessageWithParts["parts"][number],
    ],
  };
}

function completedAssistantTextMessage(id: string, text: string): MessageWithParts {
  const message = textMessage(id, "assistant", text);
  return {
    ...message,
    info: {
      ...message.info,
      time: { created: 1_000, completed: 2_000 },
    } as MessageWithParts["info"],
  };
}

function taskMessage(
  id: string,
  childSessionId: string,
  status: "completed" | "running" = "completed",
): MessageWithParts {
  return toolMessage(id, "task", {
    status,
    input: {
      subagent_type: "websearch-agent",
      description: "Find notable places in Penang",
    },
    metadata: { sessionId: childSessionId },
    time: { start: 1_000, end: status === "completed" ? 2_000 : undefined },
  });
}

const transcript = () => [
  textMessage("msg-user-1", "user", "What is the weather?"),
  textMessage("msg-asst-1", "assistant", "It is sunny."),
];

function renderList(props: Partial<Parameters<typeof MessageList>[0]>) {
  return render(() => (
    <PlatformProvider value={platform}>
      <MessageList
        messages={transcript()}
        developerMode={false}
        showThinking={false}
        expandedStepIds={new Set<string>()}
        setExpandedStepIds={() => undefined}
        {...props}
      />
    </PlatformProvider>
  ));
}

afterEach(() => cleanup());

describe("MessageList edit/retry affordances gate on the subtask wiring", () => {
  test("a normal session exposes Edit and Retry", () => {
    renderList({
      onSubmitEditedUserMessage: () => undefined,
      onRetry: () => undefined,
      canEditLastUserMessage: true,
    });

    expect(screen.queryByLabelText("Edit message")).not.toBeNull();
    expect(screen.queryByLabelText("Retry")).not.toBeNull();
  });

  test("a subtask session (callbacks omitted, editing disabled) hides Edit and Retry", () => {
    // Mirrors session.tsx's read-only wiring when parentSessionId() is set:
    // both mutation callbacks omitted and canEditLastUserMessage forced false.
    renderList({
      onSubmitEditedUserMessage: undefined,
      onRetry: undefined,
      canEditLastUserMessage: false,
    });

    expect(screen.queryByLabelText("Edit message")).toBeNull();
    expect(screen.queryByLabelText("Retry")).toBeNull();
  });
});

describe("MessageList Activity labels", () => {
  test("sanitizes secondary detail while preserving a user-facing primary label", () => {
    renderList({
      messages: [
        toolMessage("msg-tool-1", "notion_search_pages", {
          status: "completed",
          title: "ACTION_DENIED: User declined the secure-file action",
        }),
      ],
    });

    expect(screen.getByTestId("tool-headline").textContent).toBe(
      "Used external tool",
    );
    expect(screen.getByTestId("tool-detail").textContent).toBe(
      "File Protection confirmation was declined. Your file will be processed without the secure pipeline for this request.",
    );
    expect(screen.queryByText(/ACTION_DENIED/)).toBeNull();
  });

  test("shows a denied email action as cancelled instead of sent", () => {
    renderList({
      messages: [
        toolMessage("msg-email-1", "email_send", {
          status: "completed",
          output:
            "ACTION_DENIED: The user declined the send-email confirmation.\nStatus: NOT performed.",
        }),
      ],
    });

    expect(screen.getByTestId("tool-headline").textContent).toBe(
      "Email send cancelled",
    );
    expect(
      screen.getByTestId("tool-status-dot").getAttribute("data-status"),
    ).toBe("cancelled");
  });

  test("shows a protected-pipeline guard denial as cancelled, not a sub-agent failure", () => {
    renderList({
      messages: [
        toolMessage("msg-task-guard", "task", {
          status: "error",
          input: {
            subagent_type: "protected-file-agent",
            description: "Read DOCX document",
          },
          error:
            "DENIED by protected-pipeline-confirm-guard: you must call confirm_file_protection and receive APPROVED before dispatching to protected-file-agent.",
        }),
      ],
    });

    expect(screen.getByTestId("tool-headline").textContent).toBe(
      "Sub-agent cancelled",
    );
    expect(screen.getByTestId("tool-detail").textContent).toBe(
      "Read DOCX document",
    );
    expect(
      screen.getByTestId("tool-status-dot").getAttribute("data-status"),
    ).toBe("cancelled");
    expect(screen.queryByText("Sub-agent failed")).toBeNull();
  });
});

describe("nested Activity-only sub-agent traces", () => {
  const childTranscript = () => [
    textMessage("child-user", "user", "Child prompt must stay private"),
    toolMessage("child-tool", "bash", {
      status: "completed",
      input: { command: "echo activity" },
      output: "activity output",
      time: { start: 1_000, end: 1_500 },
    }),
    completedAssistantTextMessage("child-final", "Child final prose must stay private"),
  ];

  test("renders tools but not prompt or final prose in the nested variant", () => {
    renderList({ messages: childTranscript(), variant: "nested" });

    expect(screen.queryByText("Child prompt must stay private")).toBeNull();
    expect(screen.queryByText("Child final prose must stay private")).toBeNull();
    expect(screen.getByTestId("tool-headline").textContent).toBe("Completed activity");
  });

  test("keeps the complete transcript in the default variant", () => {
    renderList({ messages: childTranscript() });

    expect(screen.queryByText("Child prompt must stay private")).not.toBeNull();
    expect(screen.queryByText("Child final prose must stay private")).not.toBeNull();
    expect(screen.getByTestId("tool-headline").textContent).toBe("Completed activity");
  });

  test("embeds only child activity and preserves the independent Open session action", () => {
    const openSessionById = vi.fn();
    renderList({
      messages: [taskMessage("parent-task", "child-session")],
      getSessionById: () =>
        ({
          id: "child-session",
          title: "Famous tourist spots in Penang (@websearch-agent subagent)",
        }) as never,
      getMessagesBySessionId: () => childTranscript(),
      openSessionById,
      activityModelExecutions: {
        "parent-task-tool": { source: "cloud", modelLabel: "cloud-model" },
      },
    });

    expect(screen.getAllByTestId("tool-headline").some((element) =>
      element.textContent === "Famous tourist spots in Penang",
    )).toBe(true);
    expect(screen.queryByText("Child prompt must stay private")).toBeNull();
    expect(screen.queryByText("Child final prose must stay private")).toBeNull();
    expect(screen.queryByText("Websearch task completed")).toBeNull();
    expect(screen.queryByText("Websearch Agent")).toBeNull();
    expect(screen.getByTestId("activity-model-source").textContent).toBe("Cloud");

    const rowToggle = screen.getAllByTestId("tool-step-button").find((element) =>
      element.getAttribute("aria-controls")?.startsWith("subagent-"),
    );
    const openSession = screen.getByRole("button", {
      name: "Open sub-agent session",
    });
    expect(rowToggle?.contains(openSession)).toBe(false);
    openSession.click();
    expect(openSessionById).toHaveBeenCalledWith("child-session");
  });

  test("shows a Hybrid tag on a sub-agent row whose calls mixed local and cloud", () => {
    renderList({
      messages: [taskMessage("parent-task", "child-session")],
      getSessionById: () => ({ id: "child-session", title: "Mixed sub-agent" }) as never,
      getMessagesBySessionId: () => childTranscript(),
      activityModelExecutions: { "parent-task-tool": { source: "hybrid" } },
    });

    const tag = screen.getByTestId("activity-model-source");
    expect(tag.textContent).toBe("Hybrid");
    expect(tag.getAttribute("data-model-source")).toBe("hybrid");
  });

  test("does not expose an empty completed child transcript as an expander", () => {
    renderList({
      messages: [taskMessage("parent-task", "child-session")],
      getSessionById: () =>
        ({ id: "child-session", title: "Empty sub-agent" }) as never,
      getMessagesBySessionId: () => [
        textMessage("child-user", "user", "No activity prompt"),
        completedAssistantTextMessage("child-final", "No activity final"),
      ],
      openSessionById: () => undefined,
    });

    expect(screen.queryByTestId("tool-step-button")).toBeNull();
    expect(screen.queryByText("No activity prompt")).toBeNull();
    expect(screen.queryByText("No activity final")).toBeNull();
    expect(screen.queryByText(/message/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open sub-agent session" }),
    ).not.toBeNull();
  });

  test("hides Open session until the child session metadata resolves", () => {
    const [resolved, setResolved] = createSignal(false);
    renderList({
      messages: [taskMessage("parent-task", "child-session")],
      getSessionById: () =>
        resolved()
          ? ({ id: "child-session", title: "Late sub-agent" } as never)
          : null,
      getMessagesBySessionId: () => childTranscript(),
      openSessionById: () => undefined,
    });

    expect(
      screen.queryByRole("button", { name: "Open sub-agent session" }),
    ).toBeNull();

    setResolved(true);

    expect(
      screen.getByRole("button", { name: "Open sub-agent session" }),
    ).not.toBeNull();
  });

  test("shows the activity-specific placeholder for a running child", () => {
    renderList({
      messages: [taskMessage("parent-task", "child-session", "running")],
      sessionLoadingById: () => true,
      getMessagesBySessionId: () => [
        textMessage("child-user", "user", "Waiting prompt"),
      ],
    });

    expect(screen.getByText("Waiting for sub-agent activity")).not.toBeNull();
    expect(screen.queryByText("Waiting prompt")).toBeNull();
    expect(screen.getByText("Loading sub-agent activity")).not.toBeNull();
  });

  test("keeps recursively embedded sub-agent traces Activity-only", () => {
    renderList({
      messages: [taskMessage("parent-task", "child-session")],
      getMessagesBySessionId: (sessionId) => {
        if (sessionId === "child-session") {
          return [
            textMessage("child-user", "user", "Child nested prompt"),
            taskMessage("child-task", "grandchild-session"),
            completedAssistantTextMessage("child-final", "Child nested final"),
          ];
        }
        if (sessionId === "grandchild-session") {
          return [
            textMessage("grandchild-user", "user", "Grandchild prompt"),
            toolMessage("grandchild-tool", "bash", {
              status: "completed",
              input: { command: "echo nested activity" },
              output: "nested activity output",
              time: { start: 1_000, end: 1_200 },
            }),
            completedAssistantTextMessage("grandchild-final", "Grandchild final"),
          ];
        }
        return [];
      },
    });

    expect(screen.queryByText("Child nested prompt")).toBeNull();
    expect(screen.queryByText("Child nested final")).toBeNull();
    expect(screen.queryByText("Grandchild prompt")).toBeNull();
    expect(screen.queryByText("Grandchild final")).toBeNull();
    expect(screen.getAllByTestId("tool-headline").length).toBeGreaterThan(1);
  });

  test("preserves ordinary parentheses in embedded titles", () => {
    renderList({
      messages: [taskMessage("parent-task", "child-session")],
      getSessionById: () =>
        ({ id: "child-session", title: "Compare Intel (US) and Intel (Malaysia)" }) as never,
      getMessagesBySessionId: () => childTranscript(),
    });

    expect(screen.getAllByTestId("tool-headline").some((element) =>
      element.textContent === "Compare Intel (US) and Intel (Malaysia)",
    )).toBe(true);
  });
});

describe("failed tool steps", () => {
  const failedStepButton = () =>
    screen
      .getAllByTestId("tool-step-button")
      .find((button) => button.textContent?.includes("File edit failed"));

  test("lets the user open a thrown failure to read its error", () => {
    renderList({
      messages: [
        toolMessage("msg-edit", "edit", {
          status: "error",
          input: { filePath: "src/app.ts" },
          error: "ENOENT: no such file or directory",
        }),
      ],
    });

    expect(failedStepButton()?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(failedStepButton() as HTMLElement);

    expect(document.querySelector("pre")?.textContent).toContain(
      "ENOENT: no such file or directory",
    );
  });

  test("lets the user open a failed tool inside a subagent", () => {
    renderList({
      messages: [taskMessage("parent-task", "child-session")],
      getMessagesBySessionId: (sessionId) =>
        sessionId === "child-session"
          ? [
              toolMessage("child-edit", "edit", {
                status: "error",
                input: { filePath: "notes.md" },
                error: "permission denied",
              }),
            ]
          : [],
    });

    fireEvent.click(failedStepButton() as HTMLElement);

    expect(screen.getByText("permission denied")).toBeTruthy();
  });
});

describe("Activity of a running turn", () => {
  const readPart = (id: string, filePath: string) => ({
    id,
    type: "tool",
    tool: "read",
    state: { status: "completed", input: { filePath }, output: "file text" },
  });
  const runningTurn = (parts: ReturnType<typeof readPart>[]): MessageWithParts => ({
    ...textMessage("msg-asst-live", "assistant", ""),
    parts: parts as unknown as MessageWithParts["parts"],
  });

  function renderTurn(initial: MessageWithParts[]) {
    const [messages, setMessages] = createSignal(initial);
    const [streaming, setStreaming] = createSignal(true);
    const [expanded, setExpanded] = createSignal(new Set<string>());
    render(() => (
      <PlatformProvider value={platform}>
        <MessageList
          messages={messages()}
          isStreaming={streaming()}
          developerMode={false}
          showThinking={false}
          expandedStepIds={expanded()}
          setExpandedStepIds={(updater) => setExpanded(updater)}
        />
      </PlatformProvider>
    ));
    return { setMessages, setStreaming };
  }

  const groupButton = () =>
    document.querySelector<HTMLButtonElement>(
      '[data-row-kind="group"] [data-testid="tool-step-button"]',
    );

  test("stays open while the turn runs, then collapses when it ends", () => {
    const { setStreaming } = renderTurn([
      textMessage("msg-user-live", "user", "Read the notes"),
      runningTurn([readPart("read-1", "notes.md")]),
    ]);

    expect(groupButton()?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("tool-headline").some((el) => el.textContent === "Read file")).toBe(
      true,
    );

    setStreaming(false);

    expect(groupButton()?.getAttribute("aria-expanded")).toBe("false");
  });

  test("stays closed after the user closes it, across streamed updates", () => {
    const { setMessages } = renderTurn([
      textMessage("msg-user-live", "user", "Read the notes"),
      runningTurn([readPart("read-1", "notes.md")]),
    ]);

    fireEvent.click(groupButton() as HTMLButtonElement);
    setMessages([
      textMessage("msg-user-live", "user", "Read the notes"),
      runningTurn([readPart("read-1", "notes.md"), readPart("read-2", "todo.md")]),
    ]);

    expect(groupButton()?.getAttribute("aria-expanded")).toBe("false");
  });

  test("does not reopen the previous turn while a new prompt waits for its first step", () => {
    renderTurn([
      textMessage("msg-user-1", "user", "Read the notes"),
      {
        ...runningTurn([readPart("read-1", "notes.md")]),
        info: {
          ...textMessage("msg-asst-done", "assistant", "").info,
          time: { created: 1_000, completed: 2_000 },
        } as MessageWithParts["info"],
      },
      textMessage("msg-user-2", "user", "And the todo list?"),
    ]);

    expect(groupButton()?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Hybrid Deep Research activity", () => {
  const hdrMessage = (later: boolean) =>
    toolMessage("msg-hdr", "hybrid_dr_post_polish_processor", {
      status: "running",
      title: "Hybrid Deep Research [4/9: Drafting sections]",
      metadata: {
        webSearches: [
          { query: "npu benchmarks", results: [{ title: "NPU", url: "https://www.intel.com/npu" }] },
        ],
        hdrProgress: {
          phases: [
            { phase: "input_local", label: "Reading local data", status: "done" },
            { phase: "input_web", label: "Web research", status: "done", durationMs: 61_000 },
            { phase: "section_write", label: "Drafting sections", status: "running" },
            { phase: "polish", label: "Polishing report", status: "pending" },
          ],
          localFiles: ["q3.xlsx"],
          sectionCount: 3,
          sections: later
            ? [
                { title: "Introduction", stage: "done" },
                { title: "Outlook", stage: "done" },
                { title: "Risks", stage: "reviewing", attempt: 2 },
              ]
            : [
                { title: "Introduction", stage: "done" },
                { title: "Outlook", stage: "writing", attempt: 1 },
              ],
        },
      },
    });
  const stepButton = (headline: string) =>
    screen
      .getAllByTestId("tool-step-button")
      .find((button) => button.querySelector('[data-testid="tool-headline"]')?.textContent === headline);

  test("opens to its phases, which open to what they searched and wrote, across refreshes", () => {
    const [messages, setMessages] = createSignal([hdrMessage(false)]);
    render(() => (
      <PlatformProvider value={platform}>
        <MessageList
          messages={messages()}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
        />
      </PlatformProvider>
    ));

    fireEvent.click(stepButton("Hybrid Deep Research") as HTMLElement);
    expect(screen.getByText("1 file")).toBeTruthy();
    expect(screen.getByText("1/3 sections written")).toBeTruthy();
    expect(screen.getByText("1m 1s")).toBeTruthy();

    fireEvent.click(stepButton("Web research") as HTMLElement);
    expect(screen.getByText("npu benchmarks")).toBeTruthy();

    fireEvent.click(stepButton("Drafting sections") as HTMLElement);
    expect(screen.getByText("Writing draft 1")).toBeTruthy();
    expect(screen.queryByText("Risks")).toBeNull();

    setMessages([hdrMessage(true)]);
    expect(screen.getByText("2/3 sections written")).toBeTruthy();
    expect(screen.getByText("npu benchmarks")).toBeTruthy();
    expect(screen.getByText("Risks")).toBeTruthy();
    expect(screen.getByText("Reviewing draft 2")).toBeTruthy();
  });
});

describe("Activity web sources", () => {
  test("shows sources found by a subagent that is not the websearch agent", () => {
    const message: MessageWithParts = {
      ...completedAssistantTextMessage("msg-build", ""),
      parts: [
        {
          id: "read-1",
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "notes.md" }, output: "text" },
        },
        {
          id: "task-build",
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { subagent_type: "build", description: "Check the API docs" },
            metadata: { sessionId: "child-build" },
          },
        },
      ] as unknown as MessageWithParts["parts"],
    };

    renderList({
      messages: [message],
      getMessagesBySessionId: (sessionId) =>
        sessionId === "child-build"
          ? [
              toolMessage("child-search", "sc_search_web", {
                status: "completed",
                input: { query: "api docs" },
                output:
                  "Web search results for query: 'api docs' [via Tavily]\n=== RESULT 1 ===\nURL: https://docs.example.com/api\nTITLE: API\n",
              }),
            ]
          : [],
    });

    expect(document.querySelector('[aria-label="1 source"]')).not.toBeNull();
  });
});
