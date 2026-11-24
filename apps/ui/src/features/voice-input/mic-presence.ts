import { createSignal, onCleanup } from "solid-js";

/**
 * Whether a capture attempt has proved this machine has no microphone.
 *
 * Chromium, including WebView2, withholds `audioinput` entries from
 * `enumerateDevices()` until microphone permission has been granted. An empty
 * list on a fresh profile is an ungranted permission, not absent hardware.
 * Treating it as absence mutes the composer button, and that button is the
 * only control that calls `getUserMedia`, so the permission is never requested
 * and the mute never clears. The cloud provider in
 * `shared/platform/voice-input.ts` already refuses that inference; this latch
 * follows the same rule.
 *
 * `micMissing` starts false. `noteAbsent()` runs only after `getUserMedia`
 * reports no capture device on a request that was not pinned to a saved
 * device id. `NotAllowedError` must not call it: the button has to stay
 * enabled so the user can answer the prompt. A `devicechange` clears the
 * latch, so plugging a microphone in is enough for the next press to ask.
 *
 * `listMicrophones()` still enumerates, for the Settings picker only. It does
 * not decide whether the composer button is enabled.
 */
export function createMicPresence() {
  const [micMissing, setMicMissing] = createSignal(false);
  // Bumped on every proved absence, including one that was already latched.
  // The note above the button keys off this so a later press can show it again.
  const [absenceTick, setAbsenceTick] = createSignal(0);
  // Bumped on `devicechange`. A failure describes the hardware that existed
  // when it was asked; the caller drops it when this has moved on. A success
  // is still applied: granting permission itself fires `devicechange`.
  let deviceEpoch = 0;

  const noteAbsent = () => {
    console.warn(
      "[voice-input] no capture device: getUserMedia reported the microphone missing",
    );
    setMicMissing(true);
    setAbsenceTick((tick) => tick + 1);
  };

  const notePresent = () => {
    setMicMissing(false);
  };

  if (navigator?.mediaDevices) {
    const onDeviceChange = () => {
      deviceEpoch += 1;
      notePresent();
    };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    onCleanup(() => {
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
    });
  }

  return { micMissing, absenceTick, noteAbsent, notePresent, deviceEpoch: () => deviceEpoch };
}

/** Capture devices for the Settings picker. Empty when the list cannot be read. */
export async function listMicrophones(): Promise<
  Array<{ deviceId: string; label: string }>
> {
  if (!navigator?.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        // Labels are blank until the page has held a capture permission once;
        // a positional name beats an empty row in the dropdown.
        label: device.label || `Microphone ${index + 1}`,
      }));
  } catch (error) {
    console.warn("[voice-input] could not enumerate microphones:", error);
    return [];
  }
}
