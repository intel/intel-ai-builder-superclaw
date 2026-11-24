/**
 * Auto-narration's streaming path in `useTtsNarration.ts`, which is an effect
 * over `activeMessages`. Effects are inert under `bun test` (solid resolves to
 * its SSR build there), so this can only be covered from this lane; the hook's
 * imperative functions stay in `useTtsNarration.test.ts`.
 */
import { describe, expect, test, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

import type { MessageWithParts } from "~/shared/types/session";

import { useTtsNarration } from "./useTtsNarration";

const { pushed } = vi.hoisted(() => ({ pushed: [] as string[] }));

vi.mock("~/shared/platform/tts-narrator", () => ({
  TtsNarrator: class {
    private enabled = false;
    setEnabled(on: boolean) {
      this.enabled = on;
    }
    isEnabled() {
      return this.enabled;
    }
    beginTurn() {}
    finishTurn() {}
    pushText(text: string) {
      pushed.push(text);
    }
    stop() {}
    speak() {
      return false;
    }
  },
}));

vi.mock("~/shared/platform/transport/servicehub", () => ({
  resolveServiceHubFetch: () => () => Promise.reject(new Error("no hub in this test")),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const user = (id: string) =>
  ({ info: { id, role: "user" }, parts: [] }) as unknown as MessageWithParts;

const streamingReply = (id: string, text: string) =>
  ({
    info: { id, role: "assistant", time: {} },
    parts: [{ id: `${id}-p`, type: "text", text }],
  }) as unknown as MessageWithParts;

function mount(options?: { narrationOn?: boolean }) {
  pushed.length = 0;
  const [messages, setMessages] = createSignal<MessageWithParts[]>([]);
  let dispose = () => {};
  const tts = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    const hook = useTtsNarration(
      () => "http://127.0.0.1:1",
      () => "token",
      messages,
    );
    hook.setNarrationOn(options?.narrationOn ?? true);
    return hook;
  });
  return { tts, setMessages, dispose };
}

describe("auto-narration of a streaming reply", () => {
  test("each streaming update of the current reply is pushed to the narrator", async () => {
    const { setMessages, dispose } = mount();
    await flush();

    setMessages([user("u1"), streamingReply("a1", "First sentence.")]);
    await flush();
    setMessages([user("u1"), streamingReply("a1", "First sentence. Second one.")]);
    await flush();

    expect(pushed).toEqual(["First sentence.", "First sentence. Second one."]);
    dispose();
  });

  test("after stopNarration, more text for the interrupted reply is not pushed again", async () => {
    const { tts, setMessages, dispose } = mount();
    await flush();

    setMessages([user("u1"), streamingReply("a1", "First sentence.")]);
    await flush();
    tts.stopNarration();
    setMessages([user("u1"), streamingReply("a1", "First sentence. Second one.")]);
    await flush();

    expect(pushed).toEqual(["First sentence."]);
    expect(tts.narrationOn()).toBe(true);
    dispose();
  });

  test("dictation while narration is still starting keeps the streaming reply silent once it is ready", async () => {
    // Narration off stands in for the toggle's cold start; setNarrationOn(true)
    // below is the delayed ready arriving after dictation began.
    const { tts, setMessages, dispose } = mount({ narrationOn: false });
    await flush();

    setMessages([user("u1"), streamingReply("a1", "First sentence.")]);
    await flush();
    tts.stopNarration();
    tts.setNarrationOn(true);
    await flush();
    setMessages([user("u1"), streamingReply("a1", "First sentence. Second one.")]);
    await flush();
    expect(pushed).toEqual([]);

    setMessages([
      user("u1"),
      streamingReply("a1", "First sentence. Second one."),
      user("u2"),
      streamingReply("a2", "A new reply."),
    ]);
    await flush();
    expect(pushed).toEqual(["A new reply."]);
    dispose();
  });

  test("a later assistant message in the interrupted turn stays silent", async () => {
    const { tts, setMessages, dispose } = mount();
    await flush();

    setMessages([user("u1"), streamingReply("a1", "First sentence.")]);
    await flush();
    tts.stopNarration();
    // A tool-using turn opens a second assistant message under the same user message.
    setMessages([
      user("u1"),
      streamingReply("a1", "First sentence."),
      streamingReply("a1b", "After the tool call."),
    ]);
    await flush();
    expect(pushed).toEqual(["First sentence."]);

    setMessages([
      user("u1"),
      streamingReply("a1", "First sentence."),
      streamingReply("a1b", "After the tool call."),
      user("u2"),
      streamingReply("a2", "A new reply."),
    ]);
    await flush();
    expect(pushed).toEqual(["First sentence.", "A new reply."]);
    dispose();
  });

  test("the next reply after an interruption is still narrated", async () => {
    const { tts, setMessages, dispose } = mount();
    await flush();

    setMessages([user("u1"), streamingReply("a1", "First sentence.")]);
    await flush();
    tts.stopNarration();
    setMessages([
      user("u1"),
      streamingReply("a1", "First sentence."),
      user("u2"),
      streamingReply("a2", "A new reply."),
    ]);
    await flush();

    expect(pushed).toEqual(["First sentence.", "A new reply."]);
    dispose();
  });
});
