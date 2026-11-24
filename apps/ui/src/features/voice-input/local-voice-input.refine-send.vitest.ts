/**
 * The local provider's SEND path with clean-up wired: which calls one dictation
 * actually makes, and what lands in the composer.
 *
 * WHY A NEW LANE RATHER THAN A CASE IN `dictation-refine-policy.test.ts`. That
 * file covers the two pure functions, and they were already right. The defect
 * this file exists for was in the WIRING between them — `createLocalVoiceInput`
 * built its `RefineContext` with `refineAvailable: Boolean(options.refine)`,
 * a callback `use-voice-input` always supplies, so the field was permanently
 * true and the `onRefineUnsupported` latch could never stop a thing. A test of
 * the pure predicate cannot see that; only driving a real dictation can.
 *
 * `./pcm-capture` is mocked because it is the one dependency that needs real
 * hardware. Everything downstream of it — the gate verdict, the decision to
 * call, the insert — is the production code path.
 */
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ServiceHubHttpError } from "~/shared/platform/transport/servicehub";

import { t } from "../../i18n";

import type { AsrRefineGate, AsrRefineRequest, AsrTranscribeResponse } from "./asr-client";

vi.mock("./pcm-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pcm-capture")>();
  return {
    ...actual,
    startPcmRecording: () =>
      Promise.resolve({
        stop: () =>
          Promise.resolve({ audio: "AAAA", sampleCount: 32_000, seconds: 2, truncated: false }),
        cancel: () => {},
      }),
  };
});

const { createLocalVoiceInput } = await import("./local-voice-input");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

type MountOptions = {
  /** `/transcribe`'s gate verdict for every recording in the test. */
  gate?: AsrRefineGate;
  /** What `/refine` does. Defaults to a successful clean-up. */
  refine?: (body: AsrRefineRequest) => Promise<{ text: string }>;
  enabled?: boolean;
  /**
   * Swap the ServiceHub connection while the dictation is in flight — i.e.
   * `/transcribe` resolves against one install and clean-up would run against
   * another. Absent leaves the connection stable.
   */
  swapConnectionDuringTranscribe?: boolean;
};

function mount(options: MountOptions = {}) {
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

  const inserted: string[] = [];
  const toasts: string[] = [];
  const refineCalls: AsrRefineRequest[] = [];
  /** The live availability latch, exactly as `useDictationRefine` keeps it. */
  let available = true;
  /** Identity of the install this dictation is addressed to. */
  let connection: object = { hub: "the one the user dictated into" };

  let dispose = () => {};
  const provider = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createLocalVoiceInput({
      ensureModelReady: () => Promise.resolve(true),
      // Stands in for `use-voice-input`'s `client` memo: a value whose identity
      // changes when the hub is repointed.
      connection: () => connection,
      transcribe: () => {
        // The swap lands BEFORE transcription resolves, which is the case under
        // review: the install the dictation started on is gone by the time
        // there is a transcript to clean up.
        if (options.swapConnectionDuringTranscribe) connection = { hub: "the replacement" };
        return Promise.resolve({
          text: "raw dictated words",
          ...(options.gate ? { refine_gate: options.gate } : {}),
        } as AsrTranscribeResponse);
      },
      refine: (body) => {
        refineCalls.push(body);
        const run = options.refine ?? (() => Promise.resolve({ text: "Cleaned up." }));
        return run(body) as ReturnType<NonNullable<Parameters<typeof createLocalVoiceInput>[0]["refine"]>>;
      },
      refineEnabled: () => options.enabled ?? true,
      refineAvailable: () => available,
      refineTarget: () => ({ mode: "agent" }),
      onRefineUnsupported: () => {
        available = false;
      },
      deviceId: () => "",
      dictionary: () => [],
      onTranscript: (text) => inserted.push(text),
      onToast: (message) => toasts.push(message),
      onFailure: () => {},
      onNeedsConsent: () => {},
      onServiceMissing: () => {},
    });
  });

  /** One whole dictation: press, release, let the round trips settle. */
  const dictate = async () => {
    provider.toggle();
    await flush();
    provider.toggle();
    await flush();
    await flush();
  };

  return { provider, inserted, toasts, refineCalls, dictate, dispose, isAvailable: () => available };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("an install that cannot clean up stops being asked", () => {
  test("a refine_not_configured on the first dictation ends the attempts", async () => {
    // THE REGRESSION. `noteRefineUnsupported` changed `refineAvailable()` in the
    // hook, but the provider derived availability from the mere presence of its
    // callback — which `use-voice-input` always passes. So the latch moved a
    // signal nothing read: every later dictation paid the same doomed round trip
    // and showed the same failure notice, for the life of the session.
    const harness = mount({
      refine: () =>
        Promise.reject(
          new ServiceHubHttpError("not configured", 424, "refine_not_configured"),
        ),
    });
    await flush();

    await harness.dictate();
    expect(harness.refineCalls.length).toBe(1);
    expect(harness.isAvailable()).toBe(false);
    // The dictation itself survived the failure — that is the other half of the
    // contract and it must not regress while fixing this one.
    expect(harness.inserted).toEqual(["raw dictated words"]);

    await harness.dictate();
    await harness.dictate();

    expect(harness.refineCalls.length).toBe(1);
    expect(harness.inserted).toEqual([
      "raw dictated words",
      "raw dictated words",
      "raw dictated words",
    ]);
    harness.dispose();
  });

  test("the saved preference is left alone by the latch", async () => {
    // The user's choice is not ours to rewrite: they may be on a machine that
    // cannot serve clean-up today and a working one tomorrow, and the card has
    // to keep showing what they picked.
    const harness = mount({
      // A 404 from a registered service: this build's `asr_manager` has no
      // `/refine` at all. Same remedy — stop asking.
      refine: () => Promise.reject(new ServiceHubHttpError("gone", 404, "not_found")),
    });
    await flush();

    await harness.dictate();

    expect(harness.provider.listening()).toBe(false);
    expect(harness.isAvailable()).toBe(false);
    harness.dispose();
  });
});

describe("what the gate verdict does to one dictation", () => {
  test("asr_only inserts the words and skips the model", async () => {
    // The duration rule returns `asr_only` now, and a one-second "yes" has to
    // reach the composer. Nothing is sent to a cloud model for it.
    const harness = mount({ gate: { action: "asr_only", reason: "audio 0.70s < 1.00s" } });
    await flush();

    await harness.dictate();

    expect(harness.refineCalls).toEqual([]);
    expect(harness.inserted).toEqual(["raw dictated words"]);
    expect(harness.toasts).toEqual([]);
    harness.dispose();
  });

  test("empty inserts nothing and says so", async () => {
    const harness = mount({ gate: { action: "empty", reason: "silent (peak 0.001 < 0.02)" } });
    await flush();

    await harness.dictate();

    expect(harness.refineCalls).toEqual([]);
    expect(harness.inserted).toEqual([]);
    expect(harness.toasts.length).toBe(1);
    harness.dispose();
  });

  test("refine replaces the text with the cleaned version", async () => {
    const harness = mount({ gate: { action: "refine", reason: "audio ok" } });
    await flush();

    await harness.dictate();

    expect(harness.refineCalls).toEqual([{ text: "raw dictated words", mode: "agent" }]);
    expect(harness.inserted).toEqual(["Cleaned up."]);
    harness.dispose();
  });
});

describe("a clean-up the user cancelled does not land", () => {
  test("a refine that resolves after a cancel inserts nothing", async () => {
    // The ServiceHub transport drops its caller-abort listener in the `finally`
    // that runs once headers arrive, and the body read happens outside that
    // scope — so cancelling mid-read cannot make the promise reject. It resolves
    // normally, and the only thing standing between that and text appearing in a
    // composer the user has moved on from is the abort check on the SUCCESS
    // path. Before it existed, only `catch` was guarded.
    let release: ((value: { text: string }) => void) | undefined;
    const harness = mount({
      gate: { action: "refine", reason: "audio ok" },
      refine: () => new Promise<{ text: string }>((resolve) => void (release = resolve)),
    });
    await flush();

    harness.provider.toggle();
    await flush();
    harness.provider.toggle();
    await flush();
    expect(harness.refineCalls.length).toBe(1);

    // The user presses the mic again / switches engine while the cloud call is
    // still open. `abort()` runs, then the clean-up answers anyway.
    harness.provider.abort();
    release?.({ text: "Cleaned up." });
    await flush();
    await flush();

    expect(harness.inserted).toEqual([]);
    harness.dispose();
  });
});

describe("a ServiceHub connection that changes mid-dictation", () => {
  test("the transcript is NOT sent to the replacement install", async () => {
    // THE REGRESSION. `/transcribe` and `/refine` are separate round trips and
    // `use-voice-input` resolved the client for each independently, so a
    // connection change in between handed install A's transcript to install B
    // for clean-up — a different install, and potentially a different cloud
    // provider, neither of which the user dictated into. Both reads were
    // individually correct, which is why nothing noticed.
    const harness = mount({ swapConnectionDuringTranscribe: true });
    await flush();

    await harness.dictate();

    expect(harness.refineCalls).toEqual([]);
    // And the words survive. A connection change degrades exactly as any other
    // clean-up failure does: the RAW transcript, with one notice.
    expect(harness.inserted).toEqual(["raw dictated words"]);
    expect(harness.toasts).toEqual([t("voice.refine_toast_failed")]);
    harness.dispose();
  });

  test("it does not latch clean-up off for later dictations", async () => {
    // A moved connection says nothing about whether this install can refine, so
    // `onRefineUnsupported` must stay unfired — otherwise one hub swap would
    // disable clean-up for the rest of the session.
    const harness = mount({ swapConnectionDuringTranscribe: true });
    await flush();

    await harness.dictate();

    expect(harness.isAvailable()).toBe(true);
    harness.dispose();
  });

  test("a stable connection still gets cleaned up", async () => {
    // The control. The guard must not reject when nothing moved, or it would
    // disable clean-up for everyone rather than closing a leak.
    const harness = mount({ swapConnectionDuringTranscribe: false });
    await flush();

    await harness.dictate();

    expect(harness.refineCalls.length).toBe(1);
    expect(harness.inserted).toEqual(["Cleaned up."]);
    harness.dispose();
  });
});
