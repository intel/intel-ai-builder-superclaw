/**
 * Settings → Voice input: the section-level layout.
 *
 * The speech model's download and failure states live in the consent dialog the
 * composer's microphone opens, not on this page; these cases pin that the page
 * no longer renders a model card, and when the microphone note shows.
 *
 * Needs a DOM, so it runs in the vitest lane rather than under `bun test`.
 */
import { render } from "solid-js/web";
import { afterEach, describe, expect, test } from "vitest";

import type {
  ReasoningHintDecision,
  VoiceInputController,
  VoiceInputMode,
} from "~/features/voice-input";

import { t } from "../../i18n";

import VoiceInputSettingsSection from "./settings.voice-input-section";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

type Stub = {
  mode?: VoiceInputMode;
  localAvailable?: boolean;
  devices?: Array<{ deviceId: string; label: string }>;
  deviceId?: string;
};

/** Renders the section against a stub controller. */
function renderSection(stub: Stub = {}) {
  const calls = { confirmDownload: 0, refreshStatus: 0, setDeviceId: [] as string[] };
  const voice = {
    mode: () => stub.mode ?? "local",
    localAvailable: () => stub.localAvailable ?? true,
    serviceDetected: () => true,
    snapshot: () => null,
    modelState: () => "unknown",
    downloadPercent: () => null,
    consentOpen: () => false,
    downloadPhase: () => "consent",
    downloadError: () => null,
    redownloadHelps: () => false,
    failure: () => null,
    // The Shortcut card renders from these. Covered on its own in
    // `settings.selectors.test.ts` and the hotkey unit suite; here they only have
    // to exist, or the assertions below die in an unrelated card.
    hotkeys: () => [{ type: "key" as const, codes: ["AltRight"] }],
    hotkeyRejection: () => null,
    hotkeyLabel: () => "Right Alt",
    devices: () => stub.devices ?? [],
    deviceId: () => stub.deviceId ?? "",
    // The section renders the Dictionary card, which reads these. Covered on its
    // own in `settings.voice-dictionary-card.vitest.tsx`; here they only have to
    // exist, or every assertion below dies in an unrelated component.
    dictionary: () => [],
    dictionaryRejection: () => null,
    correctionProgress: () => [],
    originOf: () => "manual" as const,
    addDictionaryEntry: () => false,
    removeDictionaryEntry: () => {},
    clearDictionaryRejection: () => {},
    // The section also renders the LLM clean-up card, which reads these. Covered
    // on its own in `settings.voice-refine-card.vitest.tsx`; here they only have
    // to exist, or every assertion below dies in an unrelated component.
    refineEnabled: () => false,
    refineAvailable: () => true,
    refineMode: () => "agent" as const,
    refineOpenRouterReady: () => false,
    refineOpenRouterChecked: () => true,
    refineLocalReady: () => false,
    refineLocalChecked: () => true,
    refreshRefineProbes: () => {},
    refineModel: () => "minimax/minimax-m3",
    refineDefaultModel: () => "minimax/minimax-m3",
    refineModelOptions: () => [],
    refineModelsLoading: () => false,
    refineModelsFailed: () => false,
    ensureRefineModels: () => {},
    refineReasoningHint: () => ({ show: false }) as ReasoningHintDecision,
    setRefineEnabled: () => {},
    setRefineMode: () => {},
    setRefineModel: () => {},
    useRecommendedRefineModel: () => {},
    dismissRefineReasoningHint: () => {},
    hintVisible: () => false,
    startRequest: () => 0,
    setMode: () => {},
    confirmDownload: async () => {
      calls.confirmDownload += 1;
    },
    dismissConsent: () => {},
    useCloudInstead: () => {},
    retryDownload: () => {},
    clearFailure: () => {},
    addHotkey: () => true,
    removeHotkey: () => {},
    resetHotkeys: () => {},
    clearHotkeyRejection: () => {},
    setDeviceId: (deviceId: string) => calls.setDeviceId.push(deviceId),
    refreshDevices: async () => {},
    refreshStatus: async () => {
      calls.refreshStatus += 1;
      return null;
    },
    ensureModelReady: async () => false,
    noteRecordingStarted: () => {},
    dismissHint: () => {},
    hideHint: () => {},
    createLocalProvider: (() => {
      throw new Error("not used here");
    }) as unknown as VoiceInputController["createLocalProvider"],
  } as unknown as VoiceInputController;

  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <VoiceInputSettingsSection voice={voice} />, host);
  return { host, calls };
}

describe("the speech model", () => {
  test("has no card on this page; the microphone's consent dialog owns it", () => {
    const { host, calls } = renderSection();

    expect(host.querySelector("[data-testid=voice-model-state]")).toBeNull();
    expect(host.querySelector("[data-testid=voice-model-download]")).toBeNull();
    expect(host.textContent).not.toContain(t("voice.download_confirm"));
    // Opening Settings must not kick off a status probe or a download either.
    expect(calls.refreshStatus).toBe(0);
    expect(calls.confirmDownload).toBe(0);
  });
});

describe("the microphone note", () => {
  test("is absent in Local mode, where the picker works", () => {
    const { host } = renderSection({ mode: "local" });

    expect(host.querySelector("[data-testid=voice-device-local-only]")).toBeNull();
    expect(
      host.querySelector<HTMLSelectElement>("[data-testid=voice-device-select]")!.disabled,
    ).toBe(false);
  });

  test("explains the disabled picker in Cloud mode", () => {
    const { host } = renderSection({ mode: "cloud" });

    expect(host.querySelector("[data-testid=voice-device-local-only]")?.textContent).toBe(
      t("voice.device_local_only"),
    );
    expect(
      host.querySelector<HTMLSelectElement>("[data-testid=voice-device-select]")!.disabled,
    ).toBe(true);
  });

  test("also shows while on-device recognition is unavailable", () => {
    const { host } = renderSection({ mode: "local", localAvailable: false });

    expect(host.querySelector("[data-testid=voice-device-local-only]")).not.toBeNull();
  });
});

describe("the microphone device picker", () => {
  test("uses the shared dropdown and commits the selected device", () => {
    const { host, calls } = renderSection({
      devices: [{ deviceId: "mic-1", label: "USB microphone" }],
    });

    const trigger = host.querySelector<HTMLButtonElement>(
      '[data-testid="voice-device-select"]',
    );
    expect(trigger).not.toBeNull();
    if (!trigger) throw new Error("Microphone device dropdown was not rendered");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");

    trigger.click();
    expect(
      Array.from(host.querySelectorAll('[role="option"]')).map((option) => option.textContent?.trim()),
    ).toEqual([t("voice.device_system_default"), "USB microphone"]);

    const deviceOption = host.querySelectorAll<HTMLElement>('[role="option"]')[1];
    expect(deviceOption).not.toBeNull();
    deviceOption?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(calls.setDeviceId).toEqual(["mic-1"]);
  });
});
