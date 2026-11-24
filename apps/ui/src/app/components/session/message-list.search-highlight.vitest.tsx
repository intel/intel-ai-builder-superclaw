import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, test } from "vitest";

import MessageList from "./message-list";
import type { SearchNavState } from "./message-list.search-nav";
import { createSearchHighlightBudget } from "../part-view.highlight";
import { PlatformProvider, type Platform } from "../../context/platform";
import type { MessageWithParts } from "../../types";

const platform: Platform = {
  platform: "web",
  openLink: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
};

afterEach(() => cleanup());

/** Captures the nav controller/state callbacks MessageList registers, so a
 * test can drive Next/Prev exactly like the Session view does. The search
 * controller observes `scrollElement`, so the harness's root ref must be
 * assigned inline (in the same render pass as MessageList, like session.tsx's
 * real chat container) rather than from `render()`'s returned container,
 * which isn't available until after the component's own mount effects run. */
const createNavHarness = () => {
  let controller: { requestNav: (offset: number) => void } | null = null;
  let root: HTMLElement | undefined;
  const [state, setState] = createSignal<SearchNavState>({
    activeIndex: 0,
    total: 0,
  });
  return {
    props: {
      scrollElement: () => root,
      setSearchMatchController: (
        next: { requestNav: (offset: number) => void } | null,
      ) => {
        controller = next;
      },
      onSearchNavStateChange: (next: SearchNavState) => setState(next),
    },
    setRoot: (el: HTMLElement) => {
      root = el;
    },
    state,
    requestNav: (offset: number) => controller?.requestNav(offset),
  };
};

test("highlights matches when search opens on a mounted message and clears them when closed", async () => {
  const [query, setQuery] = createSignal("");
  const [matchingIds, setMatchingIds] = createSignal<ReadonlySet<string>>(new Set());
  const nav = createNavHarness();
  const message = {
    info: { id: "message-1", role: "user", sessionID: "session-1", time: { created: 1 } },
    parts: [{ id: "part-1", type: "text", text: "needle and needle" }],
  } as unknown as MessageWithParts;

  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={[message]}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={matchingIds()}
          searchHighlightQuery={query()}
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));

  expect(container.querySelectorAll("mark[data-search-highlight]")).toHaveLength(0);
  setMatchingIds(new Set(["message-1"]));
  setQuery("needle");
  await waitFor(() => {
    expect(container.querySelectorAll("mark[data-search-highlight]")).toHaveLength(2);
    expect(nav.state().total).toBe(2);
    expect(container.innerHTML).not.toContain("outline-amber-7/50");
  });

  setQuery("");
  setMatchingIds(new Set<string>());
  await waitFor(() => {
    expect(container.querySelectorAll("mark[data-search-highlight]")).toHaveLength(0);
    expect(nav.state().total).toBe(0);
  });
});

test("caps rendered matches and reports when the shared occurrence budget truncates", async () => {
  const nav = createNavHarness();
  const budget = createSearchHighlightBudget(1);
  const message = {
    info: { id: "message-capped", role: "user", sessionID: "session-1", time: { created: 1 } },
    parts: [{ id: "part-capped", type: "text", text: "needle needle" }],
  } as unknown as MessageWithParts;

  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={[message]}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={new Set(["message-capped"])}
          searchHighlightQuery="needle"
          searchHighlightBudget={budget}
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));

  await waitFor(() => {
    expect(container.querySelectorAll("mark[data-search-highlight]")).toHaveLength(1);
    expect(nav.state()).toMatchObject({ total: 1, truncated: true });
  });
});

test("highlights rendered assistant Markdown and moves the active mark with requestNav", async () => {
  const nav = createNavHarness();
  const message = {
    info: { id: "message-2", role: "assistant", sessionID: "session-1", time: { created: 1, completed: 2 } },
    parts: [{ id: "part-2", type: "text", text: "First **needle**. Second needle." }],
  } as unknown as MessageWithParts;

  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={[message]}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={new Set(["message-2"])}
          searchHighlightQuery="needle"
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));

  await waitFor(() => {
    expect(container.querySelectorAll("mark[data-search-highlight]")).toHaveLength(2);
    expect(nav.state()).toEqual({ activeIndex: 0, total: 2 });
  });

  nav.requestNav(1);
  await waitFor(() => {
    expect(nav.state().activeIndex).toBe(1);
    expect(
      container.querySelectorAll("mark[data-search-highlight]")[1]
        ?.hasAttribute("data-search-highlight-active"),
    ).toBe(true);
  });
});

test("counts matches across coalesced source text parts in document order", async () => {
  const nav = createNavHarness();
  const message = {
    info: { id: "message-coalesced", role: "assistant", sessionID: "session-1", time: { created: 1, completed: 2 } },
    parts: [
      { id: "part-first", type: "text", text: "First needle. " },
      { id: "part-second", type: "text", text: "Second needle." },
    ],
  } as unknown as MessageWithParts;

  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={[message]}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={new Set(["message-coalesced"])}
          searchHighlightQuery="needle"
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));

  await waitFor(() => {
    expect(container.querySelectorAll("mark[data-search-highlight]")).toHaveLength(2);
    expect(nav.state().total).toBe(2);
  });

  nav.requestNav(1);
  await waitFor(() => {
    const marks = container.querySelectorAll("mark[data-search-highlight]");
    expect(marks[1]?.hasAttribute("data-search-highlight-active")).toBe(true);
    expect(marks[1]?.textContent).toBe("needle");
  });
});

test("reveals and highlights a tool-step label from a collapsed activity", async () => {
  const nav = createNavHarness();
  const message = {
    info: {
      id: "message-tool-search",
      role: "assistant",
      sessionID: "session-1",
      time: { created: 1, completed: 2 },
    },
    parts: [
      {
        id: "tool-search-target",
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { description: "run the dedicated tool label search" },
          output: "output remains collapsed",
        },
      },
      {
        id: "tool-search-other",
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "src/example.ts" },
          output: "another hidden output",
        },
      },
    ],
  } as unknown as MessageWithParts;

  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={[message]}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={new Set(["message-tool-search"])}
          searchHighlightQuery="dedicated tool label search"
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));

  await waitFor(() => {
    expect(
      container.querySelector(
        'mark[data-search-highlight][data-search-part-id="tool-search-target"]',
      )?.textContent,
    ).toBe("dedicated tool label search");
  });
});

test("reveals and highlights tool output that matches the query", async () => {
  const nav = createNavHarness();
  const message = {
    info: {
      id: "message-tool-output-search",
      role: "assistant",
      sessionID: "session-1",
      time: { created: 1, completed: 2 },
    },
    parts: [
      {
        id: "tool-output-target",
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { description: "unrelated label" },
          output: "visible needle output",
        },
      },
    ],
  } as unknown as MessageWithParts;

  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={[message]}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={new Set(["message-tool-output-search"])}
          searchHighlightQuery="needle"
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));

  await waitFor(() => {
    const mark = container.querySelector(
      'mark[data-search-highlight][data-search-part-id="tool-output-target"]',
    );
    expect(mark?.textContent).toBe("needle");
    expect(mark?.closest("pre")?.textContent).toContain("visible needle output");
  });
});

test("keeps linked task collapsed by default and reveals matching child activity", async () => {
  const [query, setQuery] = createSignal("");
  const nav = createNavHarness();
  const message = {
    info: {
      id: "message-task-output-search",
      role: "assistant",
      sessionID: "session-1",
      time: { created: 1, completed: 2 },
    },
    parts: [
      {
        id: "task-output-target",
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { subagent_type: "websearch", description: "Search the web" },
          metadata: { sessionId: "child-session" },
          output: "Task completed with unrelated summary text.",
        },
      },
    ],
  } as unknown as MessageWithParts;
  const childTool = {
    info: {
      id: "child-websearch-activity",
      role: "assistant",
      sessionID: "child-session",
      time: { created: 1, completed: 2 },
    },
    parts: [
      {
        id: "child-websearch-tool",
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "search web" },
          output: "The child web search found the needle result.",
        },
      },
    ],
  } as unknown as MessageWithParts;

  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={[message]}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          getMessagesBySessionId={() => [childTool]}
          searchMatchMessageIds={new Set(["message-task-output-search"])}
          searchHighlightQuery={query()}
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));

  expect(container.textContent).not.toContain("The child web search found");
  setQuery("needle");

  await waitFor(() => {
    const mark = container.querySelector(
      'mark[data-search-highlight][data-search-part-id="child-websearch-tool"]',
    );
    expect(mark?.textContent).toBe("needle");
    expect(mark?.closest("pre")?.textContent).toContain(
      "The child web search found the needle result.",
    );
    expect(container.textContent).not.toContain(
      "Task completed with unrelated summary text.",
    );
  });
});

test("reveals a match beyond a collapsed long-message preview", async () => {
  const nav = createNavHarness();
  const message = {
    info: { id: "message-long", role: "assistant", sessionID: "session-1", time: { created: 1, completed: 2 } },
    parts: [{ id: "part-long", type: "text", text: `${"prefix ".repeat(2_000)}needle` }],
  } as unknown as MessageWithParts;

  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={[message]}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={new Set(["message-long"])}
          searchHighlightQuery="needle"
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));

  await waitFor(() => {
    expect(container.querySelector("mark[data-search-highlight]")?.textContent).toBe("needle");
  });
});

test("counts and navigates late matches without mounting nonmatching virtual rows", async () => {
  const nav = createNavHarness();
  let root: HTMLElement | undefined;
  let maxMountedMessages = 0;
  const observer = new MutationObserver(() => {
    maxMountedMessages = Math.max(
      maxMountedMessages,
      root?.querySelectorAll("[data-message-id]").length ?? 0,
    );
  });
  const initialMessages = Array.from({ length: 501 }, (_, index) => {
    const hasMatch = index < 32 || index === 500;
    return {
      info: {
        id: `message-${index}`,
        role: index === 500 ? "assistant" : "user",
        sessionID: "session-1",
        time: { created: index },
      },
      parts: [
        {
          id: `part-${index}`,
          type: "text",
          text: index === 500
            ? "First **needle**. Second needle."
            : hasMatch
              ? `message ${index} contains needle`
              : `message ${index}`,
        },
      ],
    } as unknown as MessageWithParts;
  });
  const [messages, setMessages] = createSignal(initialMessages);

  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div
        ref={(element) => {
          root = element;
          nav.setRoot(element);
          observer.observe(element, { childList: true, subtree: true });
        }}
      >
        <MessageList
          messages={messages()}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={new Set([
            ...Array.from({ length: 32 }, (_, index) => `message-${index}`),
            "message-500",
          ])}
          searchHighlightQuery="needle"
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));

  await waitFor(() => {
    expect(container.querySelectorAll("[data-message-id]")).toHaveLength(1);
    expect(container.querySelector('[data-message-id="message-0"]')).not.toBeNull();
    expect(
      container
        .querySelector("[data-search-navigation-index]")
        ?.querySelectorAll("mark[data-search-highlight]"),
    ).toHaveLength(34);
    expect(nav.state()).toEqual({ activeIndex: 0, total: 34 });
  });
  observer.disconnect();
  expect(maxMountedMessages).toBeLessThanOrEqual(16);

  nav.requestNav(32);
  await waitFor(() => {
    const marks = container.querySelectorAll(
      'mark[data-search-highlight][data-search-part-id="part-500"]',
    );
    expect(marks).toHaveLength(2);
    expect(marks[0]?.hasAttribute("data-search-highlight-active")).toBe(true);
    expect(marks[1]?.hasAttribute("data-search-highlight-active")).toBe(false);
  });

  setMessages((current) =>
    current.map((message, index) =>
      index === 500
        ? {
            ...message,
            parts: [
              {
                ...(message.parts[0] as object),
                text: "First **needle**. Second needle. Third needle.",
              },
            ] as MessageWithParts["parts"],
          }
        : message,
    ),
  );
  await waitFor(() => {
    expect(nav.state().total).toBe(35);
  });
});

const hdrSearchMessage = (stage: "writing" | "reviewing") =>
  ({
    info: {
      id: "message-hdr-search",
      role: "assistant",
      sessionID: "session-1",
      time: { created: 1 },
    },
    parts: [
      {
        id: "hdr-search-target",
        type: "tool",
        tool: "hybrid_dr_post_polish_processor",
        state: {
          status: "completed",
          input: {},
          output: JSON.stringify({ summary: "Report saved to the needle folder" }),
          metadata: {
            webSearches: [
              { query: "needle benchmarks", results: [{ title: "NPU", url: "https://www.intel.com/npu" }] },
            ],
            hdrProgress: {
              phases: [
                { phase: "input_web", label: "Web research", status: "done" },
                { phase: "section_write", label: "Drafting sections", status: "running" },
              ],
              localFiles: [],
              sectionCount: 1,
              sections: [{ title: "Needle outlook", stage, attempt: 1 }],
            },
          },
        },
      },
    ],
  }) as unknown as MessageWithParts;

test("highlights Hybrid Deep Research results and opens the phases that match", async () => {
  const nav = createNavHarness();
  const [messages, setMessages] = createSignal([hdrSearchMessage("writing")]);
  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={messages()}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={new Set(["message-hdr-search"])}
          searchHighlightQuery="needle"
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  ));
  const marks = () =>
    Array.from(
      container.querySelectorAll('mark[data-search-highlight][data-search-part-id="hdr-search-target"]'),
      (mark) => mark.closest(".search-highlight-block, div")?.textContent,
    );

  await waitFor(() => {
    expect(marks()).toEqual([
      "needle benchmarks",
      "Needle outlook",
      "Report saved to the needle folder",
    ]);
  });
  expect(container.textContent).toContain("Writing draft 1");

  setMessages([hdrSearchMessage("reviewing")]);
  await waitFor(() => {
    expect(container.textContent).toContain("Reviewing draft 1");
    expect(marks()).toHaveLength(3);
  });
});

const hdrRowsMessage = {
  info: { id: "message-hdr-rows", role: "assistant", sessionID: "session-1", time: { created: 1, completed: 2 } },
  parts: [
    {
      id: "hdr-rows",
      type: "tool",
      tool: "hybrid_dr_post_polish_processor",
      state: {
        status: "completed",
        input: {},
        output: JSON.stringify({ summary: "Report saved." }),
        metadata: {
          webSearches: [{ query: "npu benchmarks", results: [{ title: "NPU", url: "https://news.example.com/a" }] }],
          hdrProgress: {
            phases: [
              { phase: "input_local", label: "Reading local data", status: "done" },
              { phase: "input_web", label: "Web research", status: "done" },
              { phase: "section_write", label: "Drafting sections", status: "done" },
            ],
            localFiles: ["q3-forecast.xlsx"],
            sectionCount: 1,
            sections: [{ title: "Thermal limits", stage: "done" }],
          },
        },
      },
    },
  ],
} as unknown as MessageWithParts;

const renderHdrSearch = (query: string) => {
  const nav = createNavHarness();
  return render(() => (
    <PlatformProvider value={platform}>
      <div ref={nav.setRoot}>
        <MessageList
          messages={[hdrRowsMessage]}
          developerMode={false}
          showThinking={false}
          expandedStepIds={new Set<string>()}
          setExpandedStepIds={() => undefined}
          searchMatchMessageIds={new Set(["message-hdr-rows"])}
          searchHighlightQuery={query}
          {...nav.props}
        />
      </div>
    </PlatformProvider>
  )).container;
};

test.each([
  ["forecast", "q3-forecast.xlsx"],
  ["thermal", "Thermal limits"],
])("opens Hybrid Deep Research to a match only in its rows (%s)", async (query, row) => {
  const container = renderHdrSearch(query);
  await waitFor(() => {
    const marks = container.querySelectorAll('mark[data-search-highlight][data-search-part-id="hdr-rows"]');
    expect(Array.from(marks, (mark) => mark.closest(".search-highlight-block")?.textContent)).toEqual([row]);
  });
});

test("leaves Hybrid Deep Research closed for a match only in a result URL it does not show", async () => {
  const container = renderHdrSearch("news.example");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(container.querySelector("#tool-output-hdr-rows")).toBeNull();
});
