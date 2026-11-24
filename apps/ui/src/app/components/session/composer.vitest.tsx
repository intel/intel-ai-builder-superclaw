import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Agent } from "@opencode-ai/sdk/v2/client";

import Composer from "./composer";
import { ComposerToast, TOAST_DISMISS_MS } from "./composer-toast";
import SessionComposer, { ComposerPickerAccessory } from "./session-composer";
import MentionPicker from "./composer.mention-picker";
import SlashPicker from "./composer.slash-picker";
import type { ComposerMentions } from "./composer.mentions";
import { withSlashChipFirst } from "./composer.slash";
import type { ComposerSlash } from "./composer.slash";
import { buildPartsFromEditor, createMentionSpan, createSlashSpan } from "./composer.editor";
import type { ComposerProps, ComposerQuestionMode, MentionOption } from "./composer.types";
import type { ComposerDraft, ModelOption, SlashCommandOption } from "../../types";
import { t } from "../../../i18n";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The SDK's Agent carries a large config surface the composer never reads; it
// renders `agent.name` only.
const agent = (name: string) => ({ name }) as unknown as Agent;
const model = (modelID: string, title: string, footer?: string): ModelOption => ({
  providerID: "llmrouter",
  modelID,
  title,
  footer,
  isConnected: true,
  isFree: true,
  isLocal: modelID === "local-model",
});

function baseProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    prompt: "",
    developerMode: false,
    busy: false,
    isStreaming: false,
    onSend: () => undefined,
    onStop: () => undefined,
    onDraftChange: () => undefined,
    selectedModelLabel: "qwen3.5-0.8b",
    selectedModel: { providerID: "llmrouter", modelID: "auto" },
    selectedModelIsLocal: false,
    modelOptions: [
      model("auto", "Auto"),
      model("local-model", "Local model", "Qwen3.5 4B"),
      model("cloud-model", "Cloud model", "openai/gpt-5"),
    ],
    onSelectModel: () => undefined,
    onManageModels: () => undefined,
    agentLabel: "General",
    selectedAgent: null,
    agentPickerOpen: false,
    agentPickerBusy: false,
    agentPickerReady: true,
    agentPickerError: null,
    agentOptions: [],
    onToggleAgentPicker: () => undefined,
    onRetryAgentLoad: () => undefined,
    onSelectAgent: () => undefined,
    setAgentPickerRef: () => undefined,
    toast: null,
    onToast: () => undefined,
    loadAgentOptions: async () => [],
    recentFiles: [],
    searchFiles: async () => [],
    isRemoteWorkspace: false,
    isSandboxWorkspace: false,
    attachmentsEnabled: true,
    attachmentsDisabledReason: null,
    listCommands: async () => [],
    ttsNarration: "off",
    ttsAvailable: false,
    ttsSpeaking: false,
    toggleTtsNarration: () => undefined,
    ...overrides,
  };
}

beforeAll(() => {
  // `createVoiceInput` reads this once at setup, so the mic button only renders
  // when a constructor exists before the composer mounts.
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
    class {};
});

afterEach(() => cleanup());

describe("Composer DOM contract", () => {
  test("renders the selectors tests/e2e keys on", () => {
    render(() => <Composer {...baseProps()} />);

    const editor = screen.getByTestId("task-input");
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(editor.getAttribute("role")).toBe("textbox");
    expect(editor.getAttribute("aria-multiline")).toBe("true");

    expect(screen.getByTestId("send-btn")).toBeTruthy();
    expect(screen.getByTestId("model-picker-btn")).toBeTruthy();
    expect(screen.getByTestId("agent-picker-toggle")).toBeTruthy();
    expect(screen.getByTestId("voice-btn")).toBeTruthy();
    expect(screen.queryByTestId("stop-btn")).toBeNull();
    expect(screen.queryByTestId("composer-toast")).toBeNull();

    expect(document.querySelector('[data-tour-id="composer-agent"]')).toBeTruthy();
    expect(document.querySelector('[data-tour-id="composer-model"]')).toBeTruthy();
  });

  test("hides model selection for Hybrid Deep Research", () => {
    render(() => (
      <Composer
        {...baseProps({ selectedAgent: "hybrid-deep-research" })}
      />
    ));

    expect(screen.queryByTestId("model-picker-btn")).toBeNull();
    expect(document.querySelector('[data-tour-id="composer-model"]')).toBeNull();
    expect(screen.getByTestId("agent-picker-toggle")).toBeTruthy();
  });

  test("send is disabled on an empty draft and swaps for stop while streaming", () => {
    const { unmount } = render(() => <Composer {...baseProps()} />);
    expect(screen.getByTestId<HTMLButtonElement>("send-btn").disabled).toBe(true);
    unmount();

    render(() => <Composer {...baseProps({ isStreaming: true })} />);
    expect(screen.queryByTestId("send-btn")).toBeNull();
    expect(screen.getByTestId("stop-btn")).toBeTruthy();
  });

  test("renders the toast bubble only when the session supplies one", () => {
    render(() => <Composer {...baseProps({ toast: "Upload failed" })} />);
    expect(screen.getByTestId("composer-toast").textContent).toContain(
      "Upload failed",
    );
  });

  test("lists one option per agent when the picker is open", () => {
    render(() => (
      <Composer
        {...baseProps({
          agentPickerOpen: true,
          agentOptions: [agent("build"), agent("plan")],
          agentDisplayNames: { build: "Builder" },
        })}
      />
    ));

    const options = screen.getAllByTestId("agent-picker-option");
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      "@Builder",
      "@plan",
    ]);
  });

  test("the picker's default row reads General (default)", () => {
    render(() => <Composer {...baseProps({ agentPickerOpen: true })} />);

    expect(screen.getByText("General (default)").closest("button")).toBeTruthy();
  });

  test("exposes agent ids on the picker for e2e selection", () => {
    render(() => (
      <Composer
        {...baseProps({
          agentPickerOpen: true,
          selectedAgent: "build",
          agentOptions: [agent("build"), agent("plan")],
          agentDisplayNames: { build: "Builder" },
        })}
      />
    ));

    expect(screen.getByTestId("agent-picker-toggle").getAttribute("data-agent")).toBe("build");
    expect(
      screen.getAllByTestId("agent-picker-option").map((option) => option.getAttribute("data-agent")),
    ).toEqual(["build", "plan"]);
  });

  test("picker rows select on click, so Enter and Space pick an agent", () => {
    const picked: Array<string | null> = [];
    render(() => (
      <Composer
        {...baseProps({
          agentPickerOpen: true,
          selectedAgent: "build",
          agentOptions: [agent("build"), agent("email-agent")],
          onSelectAgent: (next) => picked.push(next),
        })}
      />
    ));

    screen.getAllByTestId("agent-picker-option")[1]?.click();
    screen.getByText("General (default)").closest("button")?.click();

    expect(picked).toEqual(["email-agent", null]);
  });

  test("gives the selected agent label enough line height", () => {
    render(() => (
      <Composer {...baseProps({ agentLabel: "@ Hybrid Coding Agent" })} />
    ));

    expect(
      screen
        .getByTestId("agent-picker-toggle")
        .querySelector("span")?.classList.contains("leading-5"),
    ).toBe(true);
  });

  test("only lists agents actually returned by the backend", () => {
    render(() => (
      <Composer
        {...baseProps({
          agentPickerOpen: true,
          agentOptions: [agent("plan")],
        })}
      />
    ));

    expect(
      screen
        .getAllByTestId("agent-picker-option")
        .map((option) => option.textContent?.trim()),
    ).toEqual(["@plan"]);
  });

  test("opens an anchored model picker with quick routes and manage action", () => {
    let manageCalls = 0;
    render(() => (
      <Composer
        {...baseProps({ onManageModels: () => { manageCalls += 1; } })}
      />
    ));

    screen.getByTestId("model-picker-btn").click();
    expect(screen.getByTestId("model-quick-picker")).toBeTruthy();
    expect(screen.queryByTestId("model-picker-modal")).toBeNull();
    expect(
      screen.getAllByTestId("model-picker-option").map((option) =>
        option.querySelector("span")?.textContent?.trim(),
      ),
    ).toEqual(["Auto", "Local", "Cloud"]);
    expect(screen.getByText("Routes between Local/Cloud")).toBeTruthy();
    expect(screen.getByText("Qwen3.5 4B")).toBeTruthy();
    expect(screen.getByText("openai/gpt-5")).toBeTruthy();

    screen.getByTestId("model-picker-manage").click();
    expect(manageCalls).toBe(1);
  });

  test("closes the quick picker on Escape", () => {
    render(() => <Composer {...baseProps()} />);

    screen.getByTestId("model-picker-btn").click();
    fireEvent.keyDown(screen.getByTestId("model-quick-picker"), { key: "Escape" });

    expect(screen.queryByTestId("model-quick-picker")).toBeNull();
  });

  test("uses provider-aware locality for the model trigger", () => {
    render(() => (
      <Composer
        {...baseProps({
          selectedModelLabel: "qwen3.5-0.8b",
          selectedModel: { providerID: "local-llm", modelID: "qwen3.5-0.8b" },
          selectedModelIsLocal: true,
        })}
      />
    ));

    expect(
      screen.getByTestId("model-picker-btn").querySelector(".text-dls-model-local-text"),
    ).toBeTruthy();
  });

  test("hides the TTS toggle unless the backend exposes TTS", () => {
    const { unmount } = render(() => <Composer {...baseProps()} />);
    expect(screen.queryByLabelText(/narration|speak/i)).toBeNull();
    unmount();

    render(() => <Composer {...baseProps({ ttsAvailable: true })} />);
    expect(screen.getByRole("button", { pressed: false })).toBeTruthy();
  });
});

describe("ComposerToast dismissal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("dismisses a plain notice after the short timeout", () => {
    let dismissed = 0;
    render(() => <ComposerToast message="Saved" onDismiss={() => (dismissed += 1)} />);

    vi.advanceTimersByTime(TOAST_DISMISS_MS - 1);
    expect(dismissed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(dismissed).toBe(1);
  });

  test("stays open while hovered and restarts the timeout on leave", () => {
    let dismissed = 0;
    render(() => <ComposerToast message="Saved" onDismiss={() => (dismissed += 1)} />);
    const toast = screen.getByTestId("composer-toast");

    vi.advanceTimersByTime(TOAST_DISMISS_MS - 100);
    fireEvent.mouseEnter(toast);
    vi.advanceTimersByTime(TOAST_DISMISS_MS * 4);
    expect(dismissed).toBe(0);

    fireEvent.mouseLeave(toast);
    vi.advanceTimersByTime(TOAST_DISMISS_MS - 1);
    expect(dismissed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(dismissed).toBe(1);
  });

  test("a newer message gets its own full timeout", () => {
    let dismissed = 0;
    const [message, setMessage] = createSignal("First");
    render(() => <ComposerToast message={message()} onDismiss={() => (dismissed += 1)} />);

    vi.advanceTimersByTime(TOAST_DISMISS_MS - 100);
    setMessage("Second");
    vi.advanceTimersByTime(TOAST_DISMISS_MS - 1);
    expect(dismissed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(dismissed).toBe(1);
  });
});

describe("SessionComposer on a subagent transcript", () => {
  test("hides the composer and keeps the narration toggle", () => {
    let toggles = 0;
    render(() => (
      <SessionComposer
        {...baseProps({
          ttsAvailable: true,
          toggleTtsNarration: () => {
            toggles += 1;
          },
        })}
        readOnly="subagent"
      />
    ));

    const draft = screen.getByTestId("session-composer-draft");
    expect(draft.classList.contains("hidden")).toBe(true);
    expect(draft.getAttribute("aria-hidden")).toBe("true");
    // Composer stays mounted so draft state survives Parent task.
    expect(screen.getByTestId("task-input")).toBeTruthy();
    const speak = screen.getByRole("button", {
      name: "Speak responses aloud (real-time TTS)",
    });
    expect(screen.getByTestId("subagent-narration-bar").querySelector(".h-10")).toBeTruthy();
    expect(speak.className).toContain("rounded-pill");
    speak.click();
    expect(toggles).toBe(1);
  });

  test("renders no narration control when TTS is unavailable", () => {
    render(() => <SessionComposer {...baseProps()} readOnly="subagent" />);

    expect(screen.getByTestId("session-composer-draft").classList.contains("hidden")).toBe(
      true,
    );
    expect(
      screen.queryByRole("button", {
        name: "Speak responses aloud (real-time TTS)",
      }),
    ).toBeNull();
  });

  test("shows the composer for a question the child session is waiting on, without enabling Send", () => {
    const questionMode: ComposerQuestionMode = {
      placeholder: "Type your own answer",
      inputDisabled: false,
      text: () => "",
      onTextChange: () => undefined,
      onSubmit: () => undefined,
      actions: <button data-testid="question-next-btn">Next</button>,
    };
    render(() => <SessionComposer {...baseProps()} readOnly="subagent" questionMode={questionMode} />);

    expect(screen.getByTestId("session-composer-draft").classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("question-next-btn")).toBeTruthy();
    expect(screen.queryByTestId("send-btn")).toBeNull();
  });

  test("keeps workspace toasts visible without TTS, beside the empty row", () => {
    render(() => (
      <SessionComposer
        {...baseProps({ toast: "Failed to delete report.md" })}
        readOnly="subagent"
      />
    ));

    expect(
      screen.queryByRole("button", {
        name: "Speak responses aloud (real-time TTS)",
      }),
    ).toBeNull();
    expect(screen.getByTestId("composer-toast").textContent).toContain(
      "Failed to delete report.md",
    );
  });

  test("keeps a disabled composer while session metadata is loading", () => {
    render(() => (
      <SessionComposer
        {...baseProps({ prompt: "still typing a follow-up" })}
        readOnly="loading"
      />
    ));

    expect(screen.getByTestId("task-input")).toBeTruthy();
    expect(screen.getByTestId<HTMLButtonElement>("send-btn").disabled).toBe(true);
  });

  test("keeps the composer on a writable session", () => {
    render(() => <SessionComposer {...baseProps()} readOnly={null} />);

    expect(screen.getByTestId("task-input")).toBeTruthy();
    expect(screen.getByTestId("send-btn")).toBeTruthy();
    expect(
      screen.getByTestId("session-composer-draft").classList.contains("hidden"),
    ).toBe(false);
  });

  test("preserves the draft editor across parent → child → parent", () => {
    const [readOnly, setReadOnly] = createSignal<
      "subagent" | "loading" | null
    >(null);
    render(() => (
      <SessionComposer {...baseProps({ prompt: "draft with attachment" })} readOnly={readOnly()} />
    ));

    const editor = screen.getByTestId("task-input");
    expect(editor.textContent).toContain("draft with attachment");

    setReadOnly("subagent");
    expect(screen.getByTestId("session-composer-draft").classList.contains("hidden")).toBe(
      true,
    );
    expect(screen.getByTestId("task-input")).toBe(editor);

    setReadOnly(null);
    expect(
      screen.getByTestId("session-composer-draft").classList.contains("hidden"),
    ).toBe(false);
    expect(screen.getByTestId("task-input")).toBe(editor);
    expect(screen.getByTestId("task-input").textContent).toContain(
      "draft with attachment",
    );
  });

  test("aborts an active recording when the session becomes a read-only child", async () => {
    // Full-stack check for the wiring Copilot flagged on this PR:
    // SessionComposer.readOnly -> Composer.readOnly -> `enabled: () =>
    // !props.readOnly` -> createVoiceController. A unit test on the controller
    // alone cannot catch a future break in that chain (e.g. a renamed prop).
    //
    // The `beforeAll` stub constructor has no `start()`, so `toggle()` would
    // just fail silently; swap in one that actually "records" for this test,
    // and restore it after so later tests still see the bare stub.
    const realCtor = (window as unknown as { SpeechRecognition: unknown })
      .SpeechRecognition;
    class FakeRecognition {
      start() {}
      stop() {}
      abort() {}
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;

    try {
      const [readOnly, setReadOnly] = createSignal<
        "subagent" | "loading" | null
      >(null);
      render(() => <SessionComposer {...baseProps()} readOnly={readOnly()} />);

      const micButton = screen.getByTestId<HTMLButtonElement>("voice-btn");
      micButton.click();
      await flush();
      expect(micButton.getAttribute("aria-label")).toBe(
        t("composer.voice_stop_listening"),
      );

      setReadOnly("subagent");
      await flush();
      expect(micButton.getAttribute("aria-label")).toBe(t("composer.voice_start"));
    } finally {
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = realCtor;
    }
  });
});

const mentionOption = (value: string, kind: MentionOption["kind"]) => ({
  id: `${kind}:${value}`,
  kind,
  label: value,
  value,
  display: value,
});

function mentionsStub(options: MentionOption[], open = true): ComposerMentions {
  const [index, setIndex] = createSignal(0);
  return {
    open: () => open,
    index,
    setIndex,
    options: () => options,
    visible: () => options,
    updateQuery: () => undefined,
    insert: () => undefined,
    close: () => undefined,
    setPickerRef: () => undefined,
  };
}

function slashStub(
  commands: SlashCommandOption[],
  overrides: { open?: boolean; loading?: boolean } = {},
): ComposerSlash {
  const [index, setIndex] = createSignal(0);
  return {
    open: () => overrides.open ?? true,
    query: () => "",
    index,
    setIndex,
    commands: () => commands,
    loading: () => overrides.loading ?? false,
    filtered: () => commands,
    updateQuery: () => undefined,
    acceptsEnter: () => true,
    select: () => undefined,
    close: () => undefined,
  };
}

describe("SessionComposer picker accessory", () => {
  test("renders what the session page provides right after the model picker", () => {
    render(() => (
      <ComposerPickerAccessory value={() => <span data-testid="picker-accessory" />}>
        <SessionComposer {...baseProps()} readOnly={null} />
      </ComposerPickerAccessory>
    ));

    const accessory = screen.getByTestId("picker-accessory");
    expect(document.querySelector('[data-tour-id="composer-model"]')?.nextElementSibling).toBe(accessory);
  });

  test("renders nothing there without a provider", () => {
    render(() => <SessionComposer {...baseProps()} readOnly={null} />);

    expect(screen.queryByTestId("picker-accessory")).toBeNull();
  });
});

describe("MentionPicker", () => {
  test("renders agents with an @ and files split into directory and name", () => {
    render(() => (
      <MentionPicker
        mentions={mentionsStub([
          mentionOption("build", "agent"),
          mentionOption("src/app.tsx", "file"),
        ])}
      />
    ));

    expect(screen.getByText("@build")).toBeTruthy();
    expect(screen.getByText("src/")).toBeTruthy();
    expect(screen.getByText("app.tsx")).toBeTruthy();
  });

  test("shows the empty state when nothing matches", () => {
    render(() => <MentionPicker mentions={mentionsStub([])} />);
    expect(screen.getByText(/no matches/i)).toBeTruthy();
  });

  test("renders nothing while closed", () => {
    const { container } = render(() => (
      <MentionPicker
        mentions={mentionsStub([mentionOption("build", "agent")], false)}
      />
    ));
    expect(container.textContent).toBe("");
  });
});

describe("SlashPicker", () => {
  test("renders each command with its description and source badge", () => {
    render(() => (
      <SlashPicker
        slash={slashStub([
          { id: "init", name: "init", description: "set up", source: "skill" },
        ])}
      />
    ));

    expect(screen.getByText("/init")).toBeTruthy();
    expect(screen.getByText("set up")).toBeTruthy();
    expect(screen.getByText("Skill")).toBeTruthy();
  });

  test("distinguishes loading from no matches", () => {
    const { unmount } = render(() => (
      <SlashPicker slash={slashStub([], { loading: true })} />
    ));
    expect(screen.getByText(/loading/i)).toBeTruthy();
    unmount();

    render(() => <SlashPicker slash={slashStub([])} />);
    expect(screen.getByText(/no commands/i)).toBeTruthy();
  });
});

describe("Composer slash commands mid-text", () => {
  const typeAtEnd = (editor: HTMLElement, text: string, data: string) => {
    editor.focus();
    editor.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(
      editor,
      new InputEvent("input", { data, inputType: "insertText", bubbles: true }),
    );
  };

  const renderComposer = (
    sent: ComposerDraft[] = [],
    overrides: Partial<ComposerProps> = {},
  ) => {
    render(() => (
      <Composer
        {...baseProps({
          listCommands: async () => [
            { id: "builtin:compact", name: "compact", source: "command", dispatch: "command" },
            { id: "skill-finder", name: "skill-finder", source: "skill", dispatch: "command" },
          ],
          onSend: (draft) => {
            sent.push(draft);
          },
          ...overrides,
        })}
      />
    ));
    return screen.getByTestId("task-input");
  };
  const pickerOption = () => screen.queryByRole("button", { name: /\/skill-finder/ });

  test("chips a mid-sentence command only when Tab accepts it, then sends it as that command", async () => {
    const sent: ComposerDraft[] = [];
    const editor = renderComposer(sent);

    typeAtEnd(editor, "find a skill for resumes /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    expect(editor.querySelector("[data-slash-command]")).toBeNull();

    fireEvent.keyDown(editor, { key: "Tab" });
    const chip = editor.querySelector('[data-slash-command="skill-finder"]');
    expect(chip).toBeTruthy();
    expect(editor.textContent).toContain("find a skill for resumes");
    // A plain trailing space collapses in Chromium and the next keystroke lands before it.
    const spacer = chip?.nextSibling;
    expect(spacer?.textContent).toBe("\u00a0");
    const selection = window.getSelection();
    expect(selection?.anchorNode).toBe(spacer);
    expect(selection?.anchorOffset).toBe(1);

    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.command?.name).toBe("skill-finder");
    expect(sent[0]?.command?.arguments.trim()).toBe("find a skill for resumes");
    expect(sent[0]?.text.startsWith("/skill-finder ")).toBe(true);
  });

  test("sends a mid-sentence name as plain text when Enter is pressed", async () => {
    const sent: ComposerDraft[] = [];
    const editor = renderComposer(sent);

    typeAtEnd(editor, "find me my folder named /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());

    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.command).toBeUndefined();
    expect(sent[0]?.text).toBe("find me my folder named /skill-finder");
  });

  test("Enter still accepts a command that leads the message", async () => {
    const sent: ComposerDraft[] = [];
    const editor = renderComposer(sent);

    typeAtEnd(editor, "/skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    expect(editor.querySelector("[data-slash-command]")).toBeNull();

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(sent).toHaveLength(0);
    expect(editor.querySelector('[data-slash-command="skill-finder"]')).toBeTruthy();
  });

  test("does not open the picker for a slash inside a path", async () => {
    const editor = renderComposer();

    typeAtEnd(editor, "open src/skill-finder", "/");
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(pickerOption()).toBeNull();
    expect(editor.querySelector("[data-slash-command]")).toBeNull();
  });

  const caretTo = (editor: HTMLElement, atEnd: boolean) => {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(!atEnd);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  };

  test("moves the chipped occurrence, not an earlier plain mention of the same name", async () => {
    const sent: ComposerDraft[] = [];
    const editor = renderComposer(sent);

    typeAtEnd(editor, "compare /skill-finder docs then run /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.querySelectorAll("[data-slash-command]")).toHaveLength(1);

    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.command?.name).toBe("skill-finder");
    expect(sent[0]?.command?.arguments.trim()).toBe(
      "compare /skill-finder docs then run",
    );
  });

  test("keeps a mid-message chip through history Up then Down", async () => {
    const sent: ComposerDraft[] = [];
    const editor = renderComposer(sent);

    typeAtEnd(editor, "hello", "o");
    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(1));

    typeAtEnd(editor, "compare /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });
    fireEvent.keyDown(editor, { key: "ArrowUp" });
    expect(editor.textContent).toBe("hello");
    caretTo(editor, true);
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    expect(editor.querySelector('[data-slash-command="skill-finder"]')).toBeTruthy();

    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.command?.name).toBe("skill-finder");
    expect(sent[1]?.command?.arguments.trim()).toBe("compare");
  });

  test("keeps the draft when the caret has left the /query before Tab", async () => {
    const editor = renderComposer();

    typeAtEnd(editor, "help /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    caretTo(editor, false);
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.textContent).toBe("help /skill-finder");
    expect(editor.querySelector("[data-slash-command]")).toBeNull();
  });

  test("keeps the next line when accepting a command that ends the first line", async () => {
    const editor = renderComposer();

    editor.focus();
    const command = document.createTextNode("/skill-finder");
    editor.replaceChildren(command, document.createElement("br"), document.createTextNode("notes"));
    // Focusing queues a caret move to the end; place the caret after it runs.
    await Promise.resolve();
    const range = document.createRange();
    range.setStart(command, command.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(editor, new InputEvent("input", { data: "/", inputType: "insertText", bubbles: true }));
    await waitFor(() => expect(pickerOption()).toBeTruthy());

    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.querySelector('[data-slash-command="skill-finder"]')).toBeTruthy();
    expect(editor.textContent).toContain("notes");
  });

  test("text typed before a /compact chip sends as a message, not a compaction", async () => {
    const sent: ComposerDraft[] = [];
    const editor = renderComposer(sent);

    typeAtEnd(editor, "/compact", "/");
    await waitFor(() => expect(screen.queryByRole("button", { name: /\/compact/ })).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.querySelector('[data-slash-command="compact"]')).toBeTruthy();
    editor.prepend(document.createTextNode("what does "));

    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.command).toBeUndefined();
    expect(sent[0]?.text.trim()).toBe("what does /compact");
  });

  test("a collapsed paste before a skill chip reaches the command as its full text", async () => {
    const sent: ComposerDraft[] = [];
    const editor = renderComposer(sent);
    const pasted = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

    editor.focus();
    await Promise.resolve();
    fireEvent.paste(editor, {
      clipboardData: { items: [], files: [], getData: (type: string) => (type === "text/plain" ? pasted : "") },
    });
    expect(editor.querySelector("[data-paste-id]")).toBeTruthy();
    editor.append(document.createTextNode(" /skill-finder"));
    caretTo(editor, true);
    fireEvent(editor, new InputEvent("input", { data: "/", inputType: "insertText", bubbles: true }));
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });

    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.command?.name).toBe("skill-finder");
    expect(sent[0]?.command?.arguments).toContain("line 12");
  });

  test("closes the picker when the caret leaves the /query, so Enter sends as written", async () => {
    const sent: ComposerDraft[] = [];
    const editor = renderComposer(sent);

    typeAtEnd(editor, "help /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    caretTo(editor, false);
    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(pickerOption()).toBeNull());

    caretTo(editor, true);
    document.dispatchEvent(new Event("selectionchange"));
    expect(pickerOption()).toBeNull();
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.command).toBeUndefined();
    expect(sent[0]?.text).toBe("help /skill-finder");
  });

  test("Backspace before the chip's spacer removes the chip and the spacer", async () => {
    const editor = renderComposer();

    typeAtEnd(editor, "/skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });
    const spacer = editor.querySelector("[data-slash-command]")?.nextSibling;
    expect(spacer?.textContent).toBe("\u00a0");

    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const range = document.createRange();
    range.setStart(spacer as Node, 0);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.keyDown(editor, { key: "Backspace" });

    expect(editor.querySelector("[data-slash-command]")).toBeNull();
    expect(editor.textContent).toBe("");
  });

  test("selecting text outside the composer closes the picker without chipping", async () => {
    const editor = renderComposer();
    const transcript = document.createElement("p");
    transcript.textContent = "some transcript text";
    document.body.appendChild(transcript);

    typeAtEnd(editor, "/skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    const range = document.createRange();
    range.selectNodeContents(transcript);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(pickerOption()).toBeNull());

    expect(editor.querySelector("[data-slash-command]")).toBeNull();
    expect(window.getSelection()?.toString()).toBe("some transcript text");
    transcript.remove();
  });

  test("a leading chip has the caret after its spacer immediately", async () => {
    const editor = renderComposer();

    typeAtEnd(editor, "/skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });

    const spacer = editor.querySelector("[data-slash-command]")?.nextSibling;
    expect(window.getSelection()?.anchorNode).toBe(spacer);
    expect(window.getSelection()?.anchorOffset).toBe(1);
  });

  test("a chipped draft switched to shell mode runs as typed", async () => {
    const sent: ComposerDraft[] = [];
    const drafts: ComposerDraft[] = [];
    const editor = renderComposer(sent, { onDraftChange: (draft) => drafts.push(draft) });

    typeAtEnd(editor, "echo /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });
    caretTo(editor, false);
    fireEvent.keyDown(editor, { key: "!" });
    await waitFor(() => expect(drafts.at(-1)?.mode).toBe("shell"));
    expect(drafts.at(-1)?.text.trim()).toBe("echo /skill-finder");

    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.mode).toBe("shell");
    expect(sent[0]?.text.trim()).toBe("echo /skill-finder");
  });

  test("history Up then Down republishes a mid-text chip draft chip-first", async () => {
    const sent: ComposerDraft[] = [];
    const drafts: ComposerDraft[] = [];
    const editor = renderComposer(sent, { onDraftChange: (draft) => drafts.push(draft) });

    typeAtEnd(editor, "hello", "o");
    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(1));

    typeAtEnd(editor, "help /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });
    await waitFor(() => expect(drafts.at(-1)?.text.trim()).toBe("/skill-finder help"));
    fireEvent.keyDown(editor, { key: "ArrowUp" });
    caretTo(editor, true);
    fireEvent.keyDown(editor, { key: "ArrowDown" });

    expect(drafts.at(-1)?.text.trim()).toBe("/skill-finder help");
    expect(editor.querySelector('[data-slash-command="skill-finder"]')).toBeTruthy();
  });

  test("voice-correction tracking sees the draft in the editor's order", async () => {
    const changed: string[] = [];
    const voiceInput = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) =>
        key === "noteDraftChanged" ? (text: string) => changed.push(text) : () => undefined,
    }) as unknown as ComposerProps["voiceInput"];
    const editor = renderComposer([], { voiceInput });

    typeAtEnd(editor, "help /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });

    await waitFor(() => expect(changed.at(-1)?.trim()).toBe("help /skill-finder"));
  });

  test("one Enter accepts and sends a leading /compact", async () => {
    const sent: ComposerDraft[] = [];
    const editor = renderComposer(sent);

    typeAtEnd(editor, "/comp", "/");
    await waitFor(() => expect(screen.queryByRole("button", { name: /\/compact/ })).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.command?.name).toBe("compact");
  });

  test("offers /compact only when it leads the message", async () => {
    const compactOption = () => screen.queryByRole("button", { name: /\/compact/ });
    const editor = renderComposer();

    typeAtEnd(editor, "summarize this /", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    expect(compactOption()).toBeNull();

    typeAtEnd(editor, "/", "/");
    await waitFor(() => expect(compactOption()).toBeTruthy());
    expect(pickerOption()).toBeTruthy();
  });

  test("saves a mid-text chip leading, so a restored draft still runs the command", async () => {
    const drafts: ComposerDraft[] = [];
    const editor = renderComposer([], { onDraftChange: (draft) => drafts.push(draft) });

    typeAtEnd(editor, "help /skill-finder", "/");
    await waitFor(() => expect(pickerOption()).toBeTruthy());
    fireEvent.keyDown(editor, { key: "Tab" });
    await waitFor(() => expect(drafts.at(-1)?.text).toBe("/skill-finder help "));
    cleanup();

    const sent: ComposerDraft[] = [];
    renderComposer(sent, { prompt: drafts.at(-1)?.text ?? "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.command?.name).toBe("skill-finder");
    expect(sent[0]?.command?.arguments.trim()).toBe("help");
  });
});

describe("withSlashChipFirst", () => {
  const chip = (name: string) =>
    createSlashSpan({ id: name, name, source: "skill" });
  const editorWith = (...nodes: (string | Node)[]) => {
    const editor = document.createElement("div");
    editor.append(...nodes);
    return editor;
  };
  const textOf = (editor: HTMLElement | null) =>
    editor ? buildPartsFromEditor(editor) : null;

  test("moves a mid-text chip to the front and keeps the rest as arguments", () => {
    expect(
      textOf(withSlashChipFirst(editorWith("help me with my CV ", chip("resume-builder"), "\u00a0please"))),
    ).toEqual([{ type: "text", text: "/resume-builder help me with my CV please" }]);
  });

  test("handles a chip at the end and one that already leads", () => {
    expect(
      textOf(withSlashChipFirst(editorWith("find a skill for resumes ", chip("skill-finder"), "\u00a0"))),
    ).toEqual([{ type: "text", text: "/skill-finder find a skill for resumes " }]);
    expect(
      textOf(withSlashChipFirst(editorWith(chip("skill-finder"), "\u00a0resumes"))),
    ).toEqual([{ type: "text", text: "/skill-finder resumes" }]);
  });

  test("leaves plain text spelling the same name where it is", () => {
    expect(
      textOf(withSlashChipFirst(editorWith("compare /skill-finder docs then run ", chip("skill-finder"), "\u00a0now"))),
    ).toEqual([{ type: "text", text: "/skill-finder compare /skill-finder docs then run now" }]);
  });

  test("keeps mention chips in place", () => {
    const parts = textOf(
      withSlashChipFirst(
        editorWith(createMentionSpan({ type: "file", path: "cv.docx" }), " review this ", chip("resume-builder")),
      ),
    );
    expect(parts?.map((part) => part.type)).toEqual(["text", "file", "text"]);
    expect(parts?.[0]).toEqual({ type: "text", text: "/resume-builder " });
  });

  test("returns null without a chip and never touches the live editor", () => {
    expect(withSlashChipFirst(editorWith("see /skill-finder"))).toBeNull();
    const editor = editorWith("run ", chip("skill-finder"));
    withSlashChipFirst(editor);
    expect(editor.textContent).toBe("run /skill-finder");
  });
});

describe("Composer live draft", () => {
  test("prepares the editor text before send while the draft flush is still waiting", async () => {
    const order: string[] = [];
    render(() => (
      <Composer
        {...baseProps({
          onPrepareSend: (text) => {
            order.push(`prepare:${text}`);
          },
          onDraftChange: (draft) => {
            order.push(`draft:${draft.text}`);
          },
          onSend: () => {
            order.push("send");
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.textContent = "@build fix the parser";
    fireEvent(editor, new InputEvent("input", { data: "r", inputType: "insertText", bubbles: true }));
    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(order).toContain("send"));
    expect(order[0]).toBe("prepare:@build fix the parser");
    expect(order.some((entry) => entry.startsWith("draft:"))).toBe(false);
  });

  test("cancels send when preparing the draft rejects it", async () => {
    let sent = false;
    render(() => (
      <Composer
        {...baseProps({
          onPrepareSend: () => false,
          onSend: () => {
            sent = true;
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.textContent = "@email-agent check my inbox";
    fireEvent(editor, new InputEvent("input", { data: "l", inputType: "insertText", bubbles: true }));
    screen.getByTestId("send-btn").click();
    await flush();
    expect(sent).toBe(false);
  });

  test("leaving shell republishes the same text as a prompt", async () => {
    const drafts: ComposerDraft[] = [];
    render(() => (
      <Composer
        {...baseProps({
          onDraftChange: (draft) => {
            drafts.push({ ...draft });
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.keyDown(editor, { key: "!" });
    editor.textContent = "research the market";
    fireEvent(editor, new InputEvent("input", { data: "t", inputType: "insertText", bubbles: true }));
    await waitFor(
      () => expect(drafts.some((draft) => draft.mode === "shell" && draft.text.includes("research"))).toBe(true),
      { timeout: 2_000 },
    );
    const published = drafts.length;
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(
      () =>
        expect(
          drafts.slice(published).some((draft) => draft.mode === "prompt" && draft.text.includes("research")),
        ).toBe(true),
      { timeout: 2_000 },
    );
  });

  test("republishes an identical draft after an accepted send", async () => {
    const drafts: string[] = [];
    let sent = 0;
    render(() => (
      <Composer
        {...baseProps({
          onDraftChange: (draft) => {
            drafts.push(draft.text);
          },
          onSend: () => {
            sent += 1;
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.textContent = "research the market";
    fireEvent(editor, new InputEvent("input", { data: "t", inputType: "insertText", bubbles: true }));
    await waitFor(() => expect(drafts).toContain("research the market"), { timeout: 2_000 });
    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toBe(1));
    await waitFor(() => expect(editor.textContent).toBe(""));
    const published = drafts.length;
    editor.textContent = "research the market";
    fireEvent(editor, new InputEvent("input", { data: "t", inputType: "insertText", bubbles: true }));
    await waitFor(
      () => expect(drafts.slice(published)).toContain("research the market"),
      { timeout: 2_000 },
    );
  });

  test("does not prepare a shell command", async () => {
    const prepared: string[] = [];
    let sent = false;
    render(() => (
      <Composer
        {...baseProps({
          onPrepareSend: (text) => {
            prepared.push(text);
          },
          onSend: () => {
            sent = true;
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.keyDown(editor, { key: "!" });
    editor.textContent = "echo email";
    fireEvent(editor, new InputEvent("input", { data: "l", inputType: "insertText", bubbles: true }));
    screen.getByTestId("send-btn").click();
    await flush();
    expect(prepared).toEqual([]);
    expect(sent).toBe(true);
  });

  test("waits for an unresolved gmail status before the credentials guard", async () => {
    const [status, setStatus] = createSignal<"none" | "no_credentials" | "ready">("none");
    const [agent, setAgent] = createSignal<string | null>(null);
    let sent = false;
    let opened = false;
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(() => (
      <Composer
        {...baseProps({
          selectedAgent: agent(),
          gmailConnectionStatus: status(),
          onPrepareSend: () => {
            setAgent("email-agent");
          },
          ensureGmailCredentials: async () => {
            await pending;
            setStatus("no_credentials");
          },
          onGmailStatusClick: () => {
            opened = true;
          },
          onSend: () => {
            sent = true;
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.textContent = "@email-agent summarize my inbox";
    fireEvent(editor, new InputEvent("input", { data: "y", inputType: "insertText", bubbles: true }));
    screen.getByTestId("send-btn").click();
    await flush();
    expect(sent).toBe(false);
    expect(opened).toBe(false);
    release();
    await waitFor(() => expect(opened).toBe(true));
    expect(sent).toBe(false);
  });

  test("drops the send when the draft changes during the gmail status wait", async () => {
    const [status, setStatus] = createSignal<"none" | "ready">("none");
    const [agent, setAgent] = createSignal<string | null>(null);
    let sent = false;
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(() => (
      <Composer
        {...baseProps({
          selectedSessionId: "chat-a",
          selectedAgent: agent(),
          gmailConnectionStatus: status(),
          onPrepareSend: () => {
            setAgent("email-agent");
          },
          ensureGmailCredentials: async () => {
            await pending;
            setStatus("ready");
          },
          onSend: () => {
            sent = true;
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.textContent = "@email-agent summarize my inbox";
    fireEvent(editor, new InputEvent("input", { data: "y", inputType: "insertText", bubbles: true }));
    screen.getByTestId("send-btn").click();
    await flush();
    expect(sent).toBe(false);
    editor.textContent = "research the market";
    release();
    await flush();
    await flush();
    expect(sent).toBe(false);
  });

  test("drops the send when the chat changes during the gmail status wait", async () => {
    const [status, setStatus] = createSignal<"none" | "ready">("none");
    const [agent, setAgent] = createSignal<string | null>(null);
    const [sessionId, setSessionId] = createSignal<string | null>("chat-a");
    let sent = false;
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(() => (
      <Composer
        {...baseProps({
          selectedSessionId: sessionId(),
          selectedAgent: agent(),
          gmailConnectionStatus: status(),
          onPrepareSend: () => {
            setAgent("email-agent");
          },
          ensureGmailCredentials: async () => {
            await pending;
            setStatus("ready");
          },
          onSend: () => {
            sent = true;
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.textContent = "@email-agent summarize my inbox";
    fireEvent(editor, new InputEvent("input", { data: "y", inputType: "insertText", bubbles: true }));
    screen.getByTestId("send-btn").click();
    await flush();
    expect(sent).toBe(false);
    setSessionId("chat-b");
    release();
    await flush();
    await flush();
    expect(sent).toBe(false);
  });

  test("sends the same draft after the gmail status resolves", async () => {
    const [status, setStatus] = createSignal<"none" | "ready">("none");
    const [agent, setAgent] = createSignal<string | null>(null);
    let sent = "";
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(() => (
      <Composer
        {...baseProps({
          selectedSessionId: "chat-a",
          selectedAgent: agent(),
          gmailConnectionStatus: status(),
          onPrepareSend: () => {
            setAgent("email-agent");
          },
          ensureGmailCredentials: async () => {
            await pending;
            setStatus("ready");
          },
          onSend: (draft) => {
            sent = draft.text;
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.textContent = "@email-agent summarize my inbox";
    fireEvent(editor, new InputEvent("input", { data: "y", inputType: "insertText", bubbles: true }));
    screen.getByTestId("send-btn").click();
    await flush();
    expect(sent).toBe("");
    release();
    await waitFor(() => expect(sent).toBe("@email-agent summarize my inbox"));
  });

  test("continues send when the gmail status check does not answer", async () => {
    const [agent, setAgent] = createSignal<string | null>(null);
    let sent = false;
    render(() => (
      <Composer
        {...baseProps({
          selectedAgent: agent(),
          gmailConnectionStatus: "none",
          onPrepareSend: () => {
            setAgent("email-agent");
          },
          ensureGmailCredentials: () => new Promise(() => undefined),
          onSend: () => {
            sent = true;
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.textContent = "@email-agent summarize my inbox";
    fireEvent(editor, new InputEvent("input", { data: "y", inputType: "insertText", bubbles: true }));
    screen.getByTestId("send-btn").click();
    await flush();
    expect(sent).toBe(false);
    await waitFor(() => expect(sent).toBe(true), { timeout: 3_000 });
  });

  test("prepares a collapsed paste from its body", async () => {
    const prepared: string[] = [];
    render(() => (
      <Composer
        {...baseProps({
          onPrepareSend: (text) => {
            prepared.push(text);
          },
          onSend: () => undefined,
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.focus();
    await Promise.resolve();
    const pasted = ["@build", ...Array.from({ length: 11 }, (_, index) => `line ${index + 1}`)].join("\n");
    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        files: [],
        getData: (type: string) => (type === "text/plain" ? pasted : ""),
      },
    });
    expect(editor.querySelector("[data-paste-id]")).toBeTruthy();
    editor.append(document.createTextNode(" then research the result"));
    fireEvent(editor, new InputEvent("input", { data: "t", inputType: "insertText", bubbles: true }));
    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(prepared).toHaveLength(1));
    expect(prepared[0]?.startsWith("@build")).toBe(true);
    expect(prepared[0]).toContain("then research the result");
  });

  test("history recall keeps a collapsed paste collapsed", async () => {
    const [prompt, setPrompt] = createSignal("");
    const sent: ComposerDraft[] = [];
    render(() => (
      <Composer
        {...baseProps({
          prompt: prompt(),
          onDraftChange: (draft) => {
            setPrompt(draft.resolvedText ?? draft.text);
          },
          onSend: (draft) => {
            sent.push(draft);
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    editor.focus();
    await Promise.resolve();
    const pasted = ["@build", ...Array.from({ length: 11 }, (_, index) => `line ${index + 1}`)].join("\n");
    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        files: [],
        getData: (type: string) => (type === "text/plain" ? pasted : ""),
      },
    });
    expect(editor.querySelector("[data-paste-id]")).toBeTruthy();
    screen.getByTestId("send-btn").click();
    await waitFor(() => expect(sent).toHaveLength(1));
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.keyDown(editor, { key: "ArrowUp" });
    expect(editor.querySelector("[data-paste-id]")).toBeTruthy();
    expect(editor.textContent ?? "").toContain("[pasted text");
    expect(editor.textContent ?? "").not.toContain("line 11");
  });
});

describe("Composer while the agent asks a question", () => {
  const questionMode = (overrides: Partial<ComposerQuestionMode> = {}): ComposerQuestionMode => ({
    placeholder: "Type your own answer",
    inputDisabled: false,
    text: () => "",
    onTextChange: () => undefined,
    onSubmit: () => undefined,
    actions: <button data-testid="question-next-btn">Next</button>,
    ...overrides,
  });

  const type = (editor: HTMLElement, text: string) => {
    editor.textContent = text;
    fireEvent.input(editor);
  };

  test("shows the question's placeholder and buttons where Send is, and keeps Stop", () => {
    render(() => <Composer {...baseProps({ isStreaming: true, questionMode: questionMode() })} />);

    expect(screen.getByText("Type your own answer")).toBeTruthy();
    expect(screen.getByTestId("question-next-btn")).toBeTruthy();
    expect(screen.queryByTestId("send-btn")).toBeNull();
    expect(screen.getByTestId("stop-btn")).toBeTruthy();
  });

  test("has no Send button even when the agent is not streaming", () => {
    render(() => <Composer {...baseProps({ questionMode: questionMode() })} />);

    expect(screen.queryByTestId("send-btn")).toBeNull();
  });

  test("reports typed text at once, not after the draft debounce", () => {
    const onTextChange = vi.fn();
    render(() => <Composer {...baseProps({ questionMode: questionMode({ onTextChange }) })} />);

    type(screen.getByTestId("task-input"), "my own answer");

    expect(onTextChange).toHaveBeenLastCalledWith("my own answer");
  });

  test("an answer is not saved as the draft message", () => {
    vi.useFakeTimers();
    const onDraftChange = vi.fn();
    render(() => <Composer {...baseProps({ onDraftChange, questionMode: questionMode() })} />);

    type(screen.getByTestId("task-input"), "my own answer");
    vi.advanceTimersByTime(2000);
    vi.useRealTimers();

    expect(onDraftChange).not.toHaveBeenCalled();
  });

  test("Enter goes to the question, not to the agent", () => {
    const onSubmit = vi.fn();
    const onSend = vi.fn();
    render(() => <Composer {...baseProps({ isStreaming: true, onSend, questionMode: questionMode({ onSubmit }) })} />);
    const editor = screen.getByTestId("task-input");
    type(editor, "answer");

    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  test("Enter during IME composition does not go to the question", () => {
    const onSubmit = vi.fn();
    render(() => <Composer {...baseProps({ questionMode: questionMode({ onSubmit }) })} />);
    const editor = screen.getByTestId("task-input");

    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("the editor follows the question's text, so picking an option can clear it", () => {
    const [text, setText] = createSignal("typed");
    render(() => <Composer {...baseProps({ questionMode: questionMode({ text }) })} />);
    const editor = screen.getByTestId("task-input");
    expect(editor.textContent).toBe("typed");

    setText("");

    expect(editor.textContent).toBe("");
  });

  test("the draft message comes back when the question is over", () => {
    const [mode, setMode] = createSignal<ComposerQuestionMode | undefined>(questionMode({ text: () => "answer" }));
    render(() => <Composer {...baseProps({ prompt: "my draft", get questionMode() { return mode(); } })} />);
    const editor = screen.getByTestId("task-input");
    expect(editor.textContent).toBe("answer");

    setMode(undefined);

    expect(editor.textContent).toBe("my draft");
  });

  test("a draft typed just before the question arrives is kept and comes back", () => {
    const [mode, setMode] = createSignal<ComposerQuestionMode | undefined>();
    const [prompt, setPrompt] = createSignal("");
    render(() => (
      <Composer
        {...baseProps({
          get prompt() {
            return prompt();
          },
          onDraftChange: (draft) => setPrompt(draft.text),
          get questionMode() {
            return mode();
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    type(editor, "half a mess");

    setMode(questionMode());
    expect(prompt()).toBe("half a mess");
    expect(editor.textContent).toBe("");
    setMode(undefined);

    expect(editor.textContent).toBe("half a mess");
  });

  test("an empty editor stays empty after the question, even if the prompt state still holds the sent text", () => {
    const [mode, setMode] = createSignal<ComposerQuestionMode | undefined>();
    // The parent never clears `prompt` (a sent draft is not echoed back), as in the app after Send.
    render(() => (
      <Composer
        {...baseProps({
          prompt: "text that was already sent",
          get questionMode() {
            return mode();
          },
        })}
      />
    ));
    const editor = screen.getByTestId("task-input");
    type(editor, "");

    setMode(questionMode({ text: () => "answer" }));
    setMode(undefined);

    expect(editor.textContent).toBe("");
  });

  test("Enter submits an answer that starts with a slash, instead of picking a command", () => {
    const onSubmit = vi.fn();
    render(() => <Composer {...baseProps({ questionMode: questionMode({ onSubmit }) })} />);
    const editor = screen.getByTestId("task-input");
    fireEvent.input(Object.assign(editor, { textContent: "/tmp/output" }), { data: "/" });

    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("a leading ! stays part of the answer instead of switching to shell mode", () => {
    render(() => <Composer {...baseProps({ questionMode: questionMode() })} />);
    const editor = screen.getByTestId("task-input");

    const proceeded = fireEvent.keyDown(editor, { key: "!" });

    expect(proceeded).toBe(true);
  });

  test("a pasted image is not attached while a question waits", () => {
    const onToast = vi.fn();
    render(() => (
      <Composer {...baseProps({ attachmentsEnabled: true, onToast, questionMode: questionMode() })} />
    ));
    const file = new File(["x"], "shot.png", { type: "image/png" });

    fireEvent.paste(screen.getByTestId("task-input"), {
      clipboardData: { items: [], files: [file], getData: () => "" },
    });

    expect(onToast).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("shot.png")).toBeNull();
  });

  test("a question that takes no typed answer makes the editor read-only", () => {
    render(() => (
      <Composer {...baseProps({ questionMode: questionMode({ inputDisabled: true, placeholder: "Choose an option above" }) })} />
    ));

    expect(screen.getByTestId("task-input").getAttribute("contenteditable")).toBe("false");
    expect(screen.getByText("Choose an option above")).toBeTruthy();
  });
});
