import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type { QuestionInfo } from "@opencode-ai/sdk/v2/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createQuestionAnswerState } from "./question-answer-state";
import QuestionPanel, { QuestionActions } from "./question-panel";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const question = (overrides: Partial<QuestionInfo> = {}): QuestionInfo => ({
  header: "Source",
  question: "Which data source?",
  options: [
    { label: "Docs", description: "Use the docs" },
    { label: "Web", description: "Search the web" },
  ],
  ...overrides,
});

function renderPanel(questions: QuestionInfo[], busy = false) {
  vi.useFakeTimers();
  dispose?.();
  document.body.innerHTML = "";
  const replies: string[][][] = [];
  const closed = { count: 0 };
  const [questionList, setQuestions] = createSignal(questions);
  const [requestId, setRequestId] = createSignal("req-1");
  const [open, setOpen] = createSignal(true);
  const host = document.createElement("div");
  document.body.append(host);
  // The panel, plus a stand-in for the composer's editor and button row
  // (the real composer is covered in session/composer.vitest.tsx).
  function Harness() {
    const state = createQuestionAnswerState({
      get open() {
        return open();
      },
      get requestId() {
        return requestId();
      },
      get questions() {
        return questionList();
      },
      busy,
      onClose: () => (closed.count += 1),
      onReply: (answers) => replies.push(answers),
    });
    return (
      <>
        <QuestionPanel state={state} />
        <textarea
          data-testid="editor"
          disabled={!state.customAllowed()}
          value={state.text()}
          onInput={(e) => state.setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              state.next();
            }
          }}
        />
        <QuestionActions state={state} />
      </>
    );
  }
  dispose = render(() => <Harness />, host);
  const get = (id: string) => host.querySelector<HTMLElement>(`[data-testid=${id}]`);
  const click = (id: string) => get(id)!.click();
  const options = () => [...host.querySelectorAll<HTMLElement>("[data-testid=question-option]")];
  const input = () => get("editor") as HTMLTextAreaElement;
  const type = (text: string) => {
    const el = input();
    el.value = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  };
  const key = (target: EventTarget, name: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  const tick = (ms = 300) => vi.advanceTimersByTime(ms);
  const focusPanel = () => get("question-modal")!.focus();
  return { host, focusPanel, get, click, options, input, type, key, tick, replies, closed, setQuestions, setRequestId, setOpen };
}

describe("QuestionPanel: placement", () => {
  test("is an inline block, not a full-window overlay", () => {
    const { get } = renderPanel([question()]);

    const panel = get("question-modal")!;
    expect(panel.closest(".fixed")).toBeNull();
    expect(panel.className).not.toContain("inset-0");
  });

  test("collapses to the question text and expands again", () => {
    const { host, get, click } = renderPanel([question()]);

    expect(get("question-option")).not.toBeNull();
    click("question-collapse-btn");
    expect(get("question-option")).toBeNull();
    expect(host.textContent).toContain("Which data source?");
    click("question-collapse-btn");
    expect(get("question-option")).not.toBeNull();
  });
});

describe("QuestionPanel: typed answers", () => {
  test("the editor takes a typed answer when custom is unset or true, and is off for custom: false", () => {
    expect(renderPanel([question()]).input().disabled).toBe(false);
    expect(renderPanel([question({ custom: true })]).input().disabled).toBe(false);
    expect(renderPanel([question({ custom: false })]).input().disabled).toBe(true);
  });

  test("the panel itself has no text box", () => {
    const { get } = renderPanel([question()]);

    expect(get("question-modal")!.querySelector("input, textarea")).toBeNull();
  });

  test("Enter in the text box submits the typed text with no option selected", () => {
    const { input, type, key, replies } = renderPanel([question()]);

    type("something else");
    key(input(), "Enter");

    expect(replies).toEqual([[["something else"]]]);
  });

  test("a typed answer overrides a single-select pick made earlier", () => {
    const { options, input, type, key, tick, replies } = renderPanel([question()]);

    options()[0].click();
    type("mine");
    tick(500);
    key(input(), "Enter");

    expect(replies).toEqual([[["mine"]]]);
  });

  test("picking an option after typing drops the typed text", () => {
    const { options, input, type, click, replies } = renderPanel([question()]);

    type("mine");
    options()[1].click();
    expect(input().value).toBe("");
    click("question-next-btn");

    expect(replies).toEqual([[["Web"]]]);
  });

  test("Enter with only blank text does not submit", () => {
    const { input, type, key, replies } = renderPanel([question()]);

    type("   ");
    key(input(), "Enter");

    expect(replies).toEqual([]);
  });

  test("arrow keys and number keys belong to the editor while it has focus", () => {
    const { options, input, key, tick, replies } = renderPanel([question()]);

    input().focus();
    key(input(), "ArrowDown");
    key(input(), "2");
    tick(500);

    expect(options()[1].className).not.toContain("ring-2");
    expect(options()[1].className).not.toContain("bg-dls-accent/10");
    expect(replies).toEqual([]);
  });

  test("Enter in the editor is Next: it moves on, and on the last question it sends", () => {
    const { host, input, type, key, replies } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
    ]);

    type("one");
    key(input(), "Enter");
    expect(host.textContent).toContain("Second?");
    expect(input().value).toBe("");
    type("two");
    key(input(), "Enter");

    expect(replies).toEqual([[["one"], ["two"]]]);
  });
});

describe("QuestionPanel: picking an option", () => {
  test("the last question waits for Submit: a click selects, it does not send", () => {
    const { options, click, tick, replies } = renderPanel([question()]);

    options()[1].click();
    tick(1000);
    expect(replies).toEqual([]);
    click("question-next-btn");

    expect(replies).toEqual([[["Web"]]]);
  });

  test("an earlier single-select question moves on by itself after a short pause", () => {
    const { host, options, tick, replies } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
    ]);

    options()[0].click();
    expect(host.textContent).toContain("First?");
    tick();

    expect(host.textContent).toContain("Second?");
    expect(replies).toEqual([]);
  });

  test("Next moves on without sending, and is off until there is an answer", () => {
    const { host, get, options, click, replies } = renderPanel([
      question({ question: "First?", multiple: true }),
      question({ question: "Second?" }),
    ]);

    expect((get("question-next-btn") as HTMLButtonElement).disabled).toBe(true);
    options()[0].click();
    click("question-next-btn");

    expect(host.textContent).toContain("Second?");
    expect(replies).toEqual([]);
  });

  test("a multi-select question combines picks with typed text on Submit", () => {
    const { options, type, tick, click, replies } = renderPanel([question({ multiple: true })]);

    options()[0].click();
    options()[1].click();
    type("and more");
    tick(500);
    expect(replies).toEqual([]);
    click("question-next-btn");

    expect(replies).toEqual([[["Docs", "Web", "and more"]]]);
  });
});

describe("QuestionPanel: going back", () => {
  test("Back shows the previous question with its answer, and it can be changed", () => {
    const { host, get, options, click, tick, replies } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
    ]);

    expect(get("question-back-btn")).toBeNull();
    options()[0].click();
    tick();
    expect(host.textContent).toContain("Second?");
    click("question-back-btn");
    expect(host.textContent).toContain("First?");
    expect(options()[0].className).toContain("bg-dls-accent/10");

    options()[1].click();
    tick();
    options()[0].click();
    click("question-next-btn");

    expect(replies).toEqual([[["Web"], ["Docs"]]]);
  });

  test("Back puts the highlight on the picked option, not on option 1", () => {
    const { options, click, tick } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
    ]);

    options()[1].click();
    tick();
    click("question-back-btn");

    expect(options()[1].className).toContain("ring-2");
    expect(options()[0].className).not.toContain("ring-2");
  });

  test("Back keeps typed text and multi-select picks", () => {
    const { get, options, input, type, click, tick } = renderPanel([
      question({ multiple: true }),
      question(),
    ]);

    options()[1].click();
    type("note");
    click("question-next-btn");
    click("question-back-btn");

    expect(input().value).toBe("note");
    expect(options()[1].className).toContain("bg-dls-accent/10");
    expect(get("question-back-btn")).toBeNull();
    tick();
  });

  test("a pending auto-advance does not fire after Back", () => {
    const { host, options, click, tick } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
      question({ question: "Third?" }),
    ]);

    options()[0].click();
    tick();
    options()[0].click();
    click("question-back-btn");
    tick(500);

    expect(host.textContent).toContain("First?");
  });
});

describe("QuestionPanel: Skip", () => {
  test("skipping the only question sends an empty answer", () => {
    const { click, replies } = renderPanel([question()]);

    click("question-skip-btn");

    expect(replies).toEqual([[[]]]);
  });

  test("skipping moves on, and the other answers are kept", () => {
    const { host, options, click, tick, replies } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
      question({ question: "Third?" }),
    ]);

    options()[0].click();
    tick();
    expect(host.textContent).toContain("Second?");
    click("question-skip-btn");
    expect(host.textContent).toContain("Third?");
    options()[1].click();
    click("question-next-btn");

    expect(replies).toEqual([[["Docs"], [], ["Web"]]]);
  });

  test("skipping a question that was answered earlier clears that answer", () => {
    const { options, click, tick, replies } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
    ]);

    options()[0].click();
    tick();
    click("question-back-btn");
    click("question-skip-btn");
    click("question-skip-btn");

    expect(replies).toEqual([[[], []]]);
  });

  test("a click on an option right before Skip does not answer the next question", () => {
    const { host, options, click, tick, replies } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
      question({ question: "Third?" }),
    ]);

    options()[0].click();
    click("question-skip-btn");
    tick(500);

    expect(host.textContent).toContain("Second?");
    expect(replies).toEqual([]);
  });
});

describe("QuestionPanel: dismissing", () => {
  test("the close button dismisses the whole request without replying", () => {
    const { click, replies, closed } = renderPanel([question(), question()]);

    click("question-dismiss-btn");

    expect(closed.count).toBe(1);
    expect(replies).toEqual([]);
  });

  test("Esc dismisses the request when focus is in the panel", () => {
    const { focusPanel, key, options, closed } = renderPanel([question()]);

    focusPanel();
    key(window, "Escape");
    options()[0].focus();
    key(options()[0], "Escape");

    expect(closed.count).toBe(2);
  });

  test("Esc meant for another dialog does not dismiss the request", () => {
    const { host, focusPanel, key, closed } = renderPanel([question()]);
    const other = document.createElement("div");
    other.tabIndex = -1;
    host.append(other);

    key(window, "Escape");
    other.focus();
    key(other, "Escape");
    // Already handled by something else, e.g. a dialog that took the key.
    focusPanel();
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);

    expect(closed.count).toBe(0);
  });

  test("Esc in the editor is the editor's, not the panel's", () => {
    const { input, key, closed } = renderPanel([question()]);

    input().focus();
    key(input(), "Escape");

    expect(closed.count).toBe(0);
  });

  test("Esc during IME composition does not dismiss", () => {
    const { focusPanel, key, closed } = renderPanel([question()]);

    focusPanel();
    key(window, "Escape", { isComposing: true });

    expect(closed.count).toBe(0);
  });

  test("a pending pick does not move on after the panel closed", () => {
    const { host, options, click, tick, replies } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
    ]);

    options()[0].click();
    click("question-dismiss-btn");
    tick(500);

    expect(host.textContent).toContain("First?");
    expect(replies).toEqual([]);
  });

  test("Skip, close and Esc do nothing while a reply is in flight", () => {
    const { focusPanel, click, key, replies, closed } = renderPanel([question()], true);

    focusPanel();
    click("question-skip-btn");
    click("question-dismiss-btn");
    key(window, "Escape");

    expect(replies).toEqual([]);
    expect(closed.count).toBe(0);
  });
});

describe("QuestionPanel: staying put", () => {
  test("a refreshed list for the same request keeps the question and the typed text", () => {
    const { host, get, options, input, type, tick, setQuestions } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
    ]);

    options()[0].click();
    tick();
    type("half a sentence");
    setQuestions([question({ question: "First?" }), question({ question: "Second?" })]);

    expect(host.textContent).toContain("Second?");
    expect(input().value).toBe("half a sentence");
    expect(get("question-modal")).not.toBeNull();
  });

  test("a different request starts over at the first question", () => {
    const { host, click, type, setQuestions, setRequestId } = renderPanel([
      question({ question: "First?" }),
      question({ question: "Second?" }),
    ]);

    click("question-skip-btn");
    type("old text");
    setQuestions([question({ question: "Other?" })]);
    setRequestId("req-2");

    expect(host.textContent).toContain("Other?");
    expect(host.querySelector<HTMLTextAreaElement>("[data-testid=editor]")!.value).toBe("");
  });
});

describe("QuestionPanel: keyboard flow", () => {
  test("down arrow moves the focus ring and Enter picks the focused option", () => {
    const { focusPanel, options, click, key, replies } = renderPanel([question()]);

    focusPanel();
    key(window, "ArrowDown");
    key(window, "Enter");
    expect(options()[1].className).toContain("bg-dls-accent/10");
    click("question-next-btn");

    expect(replies).toEqual([[["Web"]]]);
  });

  test("number keys pick the matching option", () => {
    const { focusPanel, options, key } = renderPanel([question()]);

    focusPanel();
    key(window, "2");

    expect(options()[1].className).toContain("bg-dls-accent/10");
  });

  test("Enter picks the option that has focus after Tab, not the one that had the ring", () => {
    const { options, click, key, replies } = renderPanel([question()]);

    options()[1].focus();
    key(options()[1], "Enter");
    click("question-next-btn");

    expect(replies).toEqual([[["Web"]]]);
  });

  test("arrow keys scroll the chat as usual when focus is outside the panel", () => {
    const { host, key } = renderPanel([question()]);
    const outside = document.createElement("button");
    host.append(outside);
    outside.focus();

    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    outside.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    key(outside, "3");
  });

  test("keys work on the next question after Next was clicked", async () => {
    const { get, options, click, key } = renderPanel([
      question({ multiple: true }),
      question({ question: "Second?" }),
    ]);

    options()[0].click();
    get("question-next-btn")!.focus();
    click("question-next-btn");
    await Promise.resolve();
    key(window, "2");

    expect(options()[1].className).toContain("bg-dls-accent/10");
  });

  test("options expose whether they are selected", () => {
    const { options } = renderPanel([question()]);

    expect(options()[0].getAttribute("aria-pressed")).toBe("false");
    options()[0].click();
    expect(options()[0].getAttribute("aria-pressed")).toBe("true");
  });

  test("the panel takes focus when a question arrives, so the keys work at once", () => {
    const { get } = renderPanel([question()]);

    return Promise.resolve().then(() => expect(document.activeElement).toBe(get("question-modal")));
  });
});

describe("QuestionPanel: who is asking", () => {
  const renderWith = (fromSubagent: boolean) => {
    dispose?.();
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => {
      const state = createQuestionAnswerState({
        open: true,
        requestId: "req-1",
        questions: [question()],
        busy: false,
        fromSubagent,
        onClose: () => undefined,
        onReply: () => undefined,
      });
      return <QuestionPanel state={state} />;
    }, host);
    return host;
  };

  test("says so when the question comes from a subagent", () => {
    expect(renderWith(true).textContent).toContain("Asked by a subagent");
  });

  test("says nothing for the session's own question", () => {
    expect(renderWith(false).textContent).not.toContain("Asked by a subagent");
  });
});
