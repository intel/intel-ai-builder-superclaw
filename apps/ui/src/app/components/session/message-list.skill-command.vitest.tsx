import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, test } from "vitest";

import MessageList from "./message-list";
import { PlatformProvider, type Platform } from "../../context/platform";
import type { MessageWithParts } from "../../types";

const platform: Platform = {
  platform: "web",
  openLink: () => undefined,
  restart: async () => undefined,
  notify: async () => undefined,
};

afterEach(() => cleanup());

const expandedSkillText = [
  "# Skill Finder",
  "",
  "Search the skill hub and recommend a skill.",
  "",
  "Base directory for this skill: /workspace/.opencode/skills/skill-finder",
  "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
  "",
  "find a skill for resume building",
].join("\n");

const userMessage = (text: string) =>
  ({
    info: { id: "message-1", role: "user", sessionID: "session-1", time: { created: 1 } },
    parts: [{ id: "part-1", type: "text", text }],
  }) as unknown as MessageWithParts;

const renderList = (message: MessageWithParts, searchHighlightQuery?: string) =>
  render(() => (
    <PlatformProvider value={platform}>
      <MessageList
        messages={[message]}
        developerMode={false}
        showThinking={false}
        expandedStepIds={new Set<string>()}
        setExpandedStepIds={() => undefined}
        searchMatchMessageIds={searchHighlightQuery ? new Set(["message-1"]) : undefined}
        searchHighlightQuery={searchHighlightQuery}
      />
    </PlatformProvider>
  ));

test("shows an expanded skill command as a chip with its instructions behind a disclosure", async () => {
  const { container, getByRole } = renderList(userMessage(expandedSkillText));

  const chip = container.querySelector('[data-skill-command="skill-finder"]');
  expect(chip?.textContent).toContain("/skill-finder");
  expect(chip?.textContent).toContain("find a skill for resume building");
  expect(container.textContent).not.toContain("Base directory for this skill");
  expect(container.textContent).not.toContain("# Skill Finder");

  fireEvent.click(getByRole("button", { name: "Show skill instructions" }));
  await waitFor(() => {
    expect(container.textContent).toContain("Base directory for this skill");
    expect(container.textContent).toContain("# Skill Finder");
  });
});

test("still highlights search matches in the skill command's arguments", async () => {
  const { container } = renderList(userMessage(expandedSkillText), "resume");

  await waitFor(() => {
    expect(container.querySelector("mark[data-search-highlight]")?.textContent).toBe("resume");
  });
});

test("shows the chip once the real expansion replaces the typed-text placeholder mid-run", async () => {
  const assistant = {
    info: { id: "message-2", role: "assistant", sessionID: "session-1", time: { created: 2 } },
    parts: [{ id: "part-2", type: "text", text: "Looking for a skill." }],
  } as unknown as MessageWithParts;
  const withUserPart = (part: { id: string; text: string }) =>
    ({
      info: { id: "message-1", role: "user", sessionID: "session-1", time: { created: 1 } },
      parts: [{ ...part, type: "text" }],
    }) as unknown as MessageWithParts;
  const [messages, setMessages] = createSignal<MessageWithParts[]>([
    withUserPart({
      id: "message-1:reconciled-pending:0",
      text: "/skill-finder find a skill for resume building",
    }),
    assistant,
  ]);

  const { container } = render(() => (
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
  expect(container.querySelector("[data-skill-command]")).toBeNull();

  setMessages([withUserPart({ id: "part-1", text: expandedSkillText }), assistant]);
  await waitFor(() => {
    expect(container.querySelector('[data-skill-command="skill-finder"]')).toBeTruthy();
  });
});

test("labels the chip with the installed skill's name when its folder differs", () => {
  const { container } = render(() => (
    <PlatformProvider value={platform}>
      <MessageList
        messages={[userMessage(expandedSkillText)]}
        developerMode={false}
        showThinking={false}
        expandedStepIds={new Set<string>()}
        setExpandedStepIds={() => undefined}
        skills={[{ name: "find-skills", path: "/workspace/.opencode/skills/skill-finder" }]}
      />
    </PlatformProvider>
  ));

  const chip = container.querySelector('[data-skill-command="find-skills"]');
  expect(chip?.textContent).toContain("/find-skills");
});

test("leaves an ordinary user message untouched", () => {
  const { container } = renderList(userMessage("find a skill for resume building"));

  expect(container.querySelector("[data-skill-command]")).toBeNull();
  expect(container.textContent).toContain("find a skill for resume building");
});
