/**
 * `createLocalVoiceInput`'s abort-vs-pending-start race.
 *
 * THE REGRESSION. `abort()` only tore down a `recorder`/`inFlight` that had
 * already been assigned. `begin()` awaits `ensureModelReady()` and then
 * `startPcmRecording()` before either exists, so a composer hidden mid-await
 * (SessionComposer calling `enabled: false` → `abort()` on a child transcript)
 * saw nothing to stop — and the deferred `begin()` finished afterward anyway,
 * opening the microphone and setting `listening(true)` with no visible stop
 * control. The fix is a generation counter `abort()` bumps and `begin()`
 * re-checks after each await.
 *
 * A separate vitest lane, not `local-voice-input.test.ts` (which is
 * `bun:test`): the race needs `startPcmRecording` suspended and resolved under
 * the test's own control, which needs `vi.mock`.
 */
import { createRoot } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";

let recorderCancelCalls = 0;
let resolveStartPcmRecording: ((handle: { stop: () => Promise<never>; cancel: () => void }) => void) | null =
  null;

vi.mock("./pcm-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pcm-capture")>();
  return {
    ...actual,
    startPcmRecording: () =>
      new Promise((resolve) => {
        resolveStartPcmRecording = resolve;
      }),
  };
});

const { createLocalVoiceInput } = await import("./local-voice-input");

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(ensureModelReady: () => Promise<boolean>) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: () => Promise.resolve([{ kind: "audioinput" }]),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    },
  });

  let dispose = () => {};
  const provider = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createLocalVoiceInput({
      ensureModelReady,
      transcribe: null,
      deviceId: () => "",
      dictionary: () => [],
      onTranscript: () => {},
      onToast: () => {},
      onFailure: () => {},
      onNeedsConsent: () => {},
      onServiceMissing: () => {},
    });
  });

  return { provider, dispose };
}

afterEach(() => {
  recorderCancelCalls = 0;
  resolveStartPcmRecording = null;
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("abort while a start is still pending", () => {
  test("abort during ensureModelReady stops the start from opening the mic", async () => {
    // Definite-assignment style rather than `let x = null` reassigned inside the
    // executor: TypeScript narrows the latter to `never` at the call site below.
    let resolveReady!: (ready: boolean) => void;
    const harness = mount(
      () =>
        new Promise<boolean>((resolve) => {
          resolveReady = resolve;
        }),
    );
    await flush();

    harness.provider.toggle(); // press: begin() is now awaiting ensureModelReady
    await flush();

    harness.provider.abort(); // composer hidden mid-start (enabled → false)
    resolveReady(true);
    await flush();

    expect(harness.provider.listening()).toBe(false);
    // Without the generation check, `startPcmRecording` would still be in
    // flight here and `listening()` would stay false for the wrong reason —
    // the mock's promise never settles on its own. Assert it was never even
    // called, so this fails if that check is removed.
    expect(resolveStartPcmRecording).toBeNull();
    harness.dispose();
  });

  test("abort during startPcmRecording cancels the recorder once it resolves", async () => {
    const harness = mount(() => Promise.resolve(true));
    await flush();

    harness.provider.toggle(); // press: begin() is now awaiting startPcmRecording
    await flush();

    harness.provider.abort(); // composer hidden mid-start (enabled → false)
    resolveStartPcmRecording?.({
      stop: () => Promise.reject(new Error("must not be reached: capture was aborted")),
      cancel: () => {
        recorderCancelCalls += 1;
      },
    });
    await flush();

    expect(harness.provider.listening()).toBe(false);
    expect(recorderCancelCalls).toBe(1);
    harness.dispose();
  });
});
