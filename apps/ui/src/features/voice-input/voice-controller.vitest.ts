/**
 * `createVoiceController`'s REACTIVE half: the three `createEffect`s that pick
 * the engine, announce the first recording and honour a `startRequest`.
 *
 * Deliberately not in `voice-controller.test.ts`. `bun test` resolves `solid-js`
 * to `dist/server.cjs` (the package's `node` export condition), where a
 * `createMemo` is frozen at its first value and a `createEffect` never runs at
 * all — so everything below would pass vacuously or be untestable there. This
 * lane goes through `vite-plugin-solid`, i.e. the same build the WebView ships.
 *
 * What that leaves to `voice-controller.test.ts`: the button strings and the
 * hotkey listener, neither of which is reactive.
 */
import { describe, expect, test } from "vitest";
import { createRoot, createSignal, type Accessor } from "solid-js";

import type { LocalVoiceInput } from "./local-voice-input";
import { createVoiceController } from "./voice-controller";
import type { VoiceInputMode } from "./voice-input-prefs";

/**
 * Stand-in for the on-device provider. Only the members the controller reads are
 * real; `toggle` flips `listening` the way press-to-record/press-to-stop does.
 */
function fakeLocal() {
  const [listening, setListening] = createSignal(false);
  let aborts = 0;
  let toggles = 0;
  const provider: LocalVoiceInput = {
    listening,
    transcribing: () => false,
    preparing: () => false,
    micMissing: () => false,
    micAbsenceTick: () => 0,
    abort: () => {
      aborts += 1;
      setListening(false);
    },
    toggle: () => {
      toggles += 1;
      setListening((was) => !was);
    },
    buttonLabel: () => "on-device label",
    maxSeconds: 120,
  };
  return { provider, aborts: () => aborts, toggles: () => toggles };
}

type Harness = {
  voice: ReturnType<typeof createVoiceController>;
  local: ReturnType<typeof fakeLocal>;
  setMode: (mode: VoiceInputMode) => void;
  setStartRequest: (n: number) => void;
  setEnabled: (value: boolean) => void;
  recordingStarts: () => number;
  dispose: () => void;
};

function mount(options?: {
  mode?: VoiceInputMode;
  localAvailable?: boolean;
  enabled?: boolean;
}): Harness {
  const local = fakeLocal();
  const [mode, setMode] = createSignal<VoiceInputMode>(options?.mode ?? "local");
  const [startRequest, setStartRequest] = createSignal(0);
  const [enabled, setEnabled] = createSignal(options?.enabled ?? true);
  const localAvailable: Accessor<boolean> = () => options?.localAvailable ?? true;
  let recordingStarts = 0;

  let dispose = () => {};
  const voice = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createVoiceController({
      onToast: () => {},
      onTranscript: () => {},
      mode,
      localAvailable,
      createLocal: () => local.provider,
      startRequest,
      enabled,
      onRecordingStarted: () => {
        recordingStarts += 1;
      },
    });
  });

  return {
    voice,
    local,
    setMode,
    setStartRequest,
    setEnabled,
    recordingStarts: () => recordingStarts,
    dispose,
  };
}

describe("engine selection", () => {
  test("the on-device provider answers the button when local mode is available", () => {
    const harness = mount();

    expect(harness.voice.activeMode()).toBe("local");
    expect(harness.voice.buttonLabel()).toBe("on-device label");

    harness.voice.toggle();
    expect(harness.local.toggles()).toBe(1);
    expect(harness.voice.listening()).toBe(true);
    harness.dispose();
  });

  test("the cloud engine wins when the local option is gated off", () => {
    // Profile flag off, or `asr_manager` missing from the catalog: the provider
    // exists but must not be reachable.
    const harness = mount({ localAvailable: false });

    expect(harness.voice.activeMode()).toBe("cloud");
    harness.voice.toggle();
    expect(harness.local.toggles()).toBe(0);
    harness.dispose();
  });

  test("switching engines mid-recording stops the one that holds the microphone", () => {
    // Otherwise the old provider keeps recording with no button left to stop it:
    // the composer's microphone now belongs to the other engine.
    const harness = mount();
    harness.voice.toggle();
    expect(harness.voice.listening()).toBe(true);

    harness.setMode("cloud");

    expect(harness.local.aborts()).toBe(1);
    expect(harness.local.provider.listening()).toBe(false);
    harness.dispose();
  });

  test("the mode being restored to its current value does not abort", () => {
    // The effect is `defer`red for exactly this reason: mounting the composer,
    // or any re-read that does not change the engine, must not cancel a
    // recording in progress.
    const harness = mount();
    harness.voice.toggle();

    harness.setMode("local");

    expect(harness.local.aborts()).toBe(0);
    expect(harness.voice.listening()).toBe(true);
    harness.dispose();
  });
});

describe("first-recording hint", () => {
  test("recording starting is announced once per start, for either engine", () => {
    const harness = mount();

    harness.voice.toggle();
    expect(harness.recordingStarts()).toBe(1);

    // Stopping is not a start, and must not re-trigger the bubble.
    harness.voice.toggle();
    expect(harness.recordingStarts()).toBe(1);

    harness.voice.toggle();
    expect(harness.recordingStarts()).toBe(2);
    harness.dispose();
  });
});

describe("startRequest", () => {
  test("an increment actually starts a recording", () => {
    // This is the plan's 「按『改用雲端』立刻開始錄音」: the button lives in a
    // dialog outside the composer and cannot reach the provider directly, so the
    // counter is the whole mechanism. Asserting the counter changed proves
    // nothing — this asserts the provider was toggled.
    const harness = mount();

    harness.setStartRequest(1);

    expect(harness.local.toggles()).toBe(1);
    expect(harness.voice.listening()).toBe(true);
    harness.dispose();
  });

  test("a request while already recording is ignored, not a stop", () => {
    const harness = mount();
    harness.voice.toggle();

    harness.setStartRequest(1);

    expect(harness.local.toggles()).toBe(1);
    expect(harness.voice.listening()).toBe(true);
    harness.dispose();
  });

  test("the initial value does not record: mounting the composer is not a press", () => {
    const harness = mount();

    expect(harness.local.toggles()).toBe(0);
    expect(harness.voice.listening()).toBe(false);
    harness.dispose();
  });
});

describe("enabled (hidden child composer)", () => {
  test("disabling aborts an in-flight recording", () => {
    const harness = mount();
    harness.voice.toggle();
    expect(harness.voice.listening()).toBe(true);
    const abortsBefore = harness.local.aborts();

    harness.setEnabled(false);

    expect(harness.local.aborts()).toBeGreaterThan(abortsBefore);
    expect(harness.voice.listening()).toBe(false);
    harness.dispose();
  });

  test("startRequest while disabled does not start capture", () => {
    const harness = mount({ enabled: false });

    harness.setStartRequest(1);

    expect(harness.local.toggles()).toBe(0);
    expect(harness.voice.listening()).toBe(false);
    harness.dispose();
  });

  test("toggle while disabled is a no-op", () => {
    const harness = mount({ enabled: false });

    harness.voice.toggle();

    expect(harness.local.toggles()).toBe(0);
    expect(harness.voice.listening()).toBe(false);
    harness.dispose();
  });
});
