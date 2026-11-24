/**
 * The catalog probe in `use-voice-input.ts`, which is an effect feeding a memo.
 *
 * Both are inert under `bun test` (solid's `node` export condition resolves to
 * the SSR build, where effects never run and a memo keeps its first value), so
 * `localAvailable()` — the gate that decides whether the on-device option exists
 * at all — can only be asserted from this lane. The rest of the hook's behaviour
 * is plain async functions and stays in `use-voice-input.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createRoot } from "solid-js";

import { VOICE_INPUT_MODE_PREF_KEY } from "~/shared/util/constants";

import { t } from "../../i18n";

import type { AsrClient } from "./asr-client";
import { useVoiceInput } from "./use-voice-input";

/** Lets the queued effect run and its promise settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(options: { catalog: () => Promise<boolean>; flagEnabled?: boolean }) {
  const client = {
    baseUrl: "http://127.0.0.1:1",
    hasAsrService: options.catalog,
    downloadStatus: () => Promise.reject(new Error("not used here")),
    startDownload: () => Promise.reject(new Error("not used here")),
    prepare: () => Promise.reject(new Error("not used here")),
    transcribe: () => Promise.reject(new Error("not used here")),
  } as unknown as AsrClient;

  /** Non-blocking notices the composer would have shown. */
  const toasts: string[] = [];

  let dispose = () => {};
  const voice = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    const controller = useVoiceInput(
      () => "http://127.0.0.1:1",
      () => "token",
      () => options.flagEnabled ?? true,
      { createClient: () => client },
    );
    // The composer builds the local provider during setup, which is what wires
    // the toast sink the hook's own notices go to.
    controller.createLocalProvider({
      onToast: (message) => toasts.push(message),
      onTranscript: () => {},
    });
    return controller;
  });
  return { voice, toasts, dispose };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("the local option's availability gate", () => {
  test("stays closed until the catalog confirms asr_manager", async () => {
    const harness = mount({ catalog: () => Promise.resolve(true) });

    // Fail-closed while the probe is in flight: a press in this window uses the
    // cloud engine rather than a service that may not exist.
    expect(harness.voice.localAvailable()).toBe(false);

    await flush();

    expect(harness.voice.serviceDetected()).toBe(true);
    expect(harness.voice.localAvailable()).toBe(true);
    harness.dispose();
  });

  test("an older build without the service keeps the cloud engine", async () => {
    const harness = mount({ catalog: () => Promise.resolve(false) });
    await flush();

    expect(harness.voice.serviceDetected()).toBe(false);
    expect(harness.voice.localAvailable()).toBe(false);
    harness.dispose();
  });

  test("a probe that throws is treated as absent, not as available", async () => {
    const harness = mount({ catalog: () => Promise.reject(new Error("hub down")) });
    await flush();

    expect(harness.voice.localAvailable()).toBe(false);
    harness.dispose();
  });

  test("an absent service announces the engine swap without waiting for a press", async () => {
    // The main case, and the one that used to be completely silent: the catalog
    // has no `asr_manager`, so `usingLocal()` is false and the local provider is
    // never consulted — nothing ever reached the old `service_not_found` notice,
    // and a user whose saved preference says on-device got the cloud engine with
    // no indication at all. (A 404 from the proxy *with* the service in the
    // catalog is the rare subcase; it was the only one covered before.)
    const harness = mount({ catalog: () => Promise.resolve(false) });
    await flush();

    expect(harness.voice.mode()).toBe("local");
    expect(harness.toasts).toEqual([t("composer.voice_local_service_missing")]);
    harness.dispose();
  });

  test("a probe that could not be read says so too", async () => {
    const harness = mount({ catalog: () => Promise.reject(new Error("hub down")) });
    await flush();

    expect(harness.toasts).toEqual([t("composer.voice_local_service_missing")]);
    harness.dispose();
  });

  test("cloud mode is not told about a service it was not going to use", async () => {
    window.localStorage.setItem(VOICE_INPUT_MODE_PREF_KEY, "cloud");
    const harness = mount({ catalog: () => Promise.resolve(false) });
    await flush();

    expect(harness.voice.mode()).toBe("cloud");
    expect(harness.toasts).toEqual([]);
    harness.dispose();
  });

  test("the Profile flag alone can withhold the option", async () => {
    // `voice_input` off: the service may be installed and running, and the
    // on-device radio still must not be selectable.
    const harness = mount({ catalog: () => Promise.resolve(true), flagEnabled: false });
    await flush();

    expect(harness.voice.serviceDetected()).toBe(true);
    expect(harness.voice.localAvailable()).toBe(false);
    harness.dispose();
  });
});
