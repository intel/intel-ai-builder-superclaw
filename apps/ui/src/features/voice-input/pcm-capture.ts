/**
 * Microphone capture for LOCAL voice input: 16 kHz mono `pcm_s16le`, base64.
 *
 * Normative decisions from the stage-0 contract, all of them load-bearing:
 *
 *  * `new AudioContext({ sampleRate: 16000 })` and then **assert** the context
 *    honoured it. `asr_manager` rejects any other rate instead of resampling,
 *    because the encoder's mel front-end is pinned to 16 kHz and silently
 *    resampling would turn a UI bug into "recognition got a bit worse" — an
 *    untraceable symptom. We do not resample in JS either; we fail loudly.
 *  * **No `MediaRecorder`.** It produces webm/opus and the service accepts no
 *    compressed container.
 *  * Float32 → Int16 via `max(-32768, min(32767, round(f * 32768)))`, little
 *    endian, because the host divides by `32768.0`.
 *  * Recording stops itself at 120 s. A user who instead hits the service's
 *    `413 audio_too_long` has already lost their audio.
 */
import { bytesToBase64 } from "~/shared/util/base64-bytes";

/** The only rate `asr_manager` accepts. */
export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Client-side recording cap. Chosen by the contract from the hub's hard-coded
 * 30 s upstream read timeout: 120 s of audio at a pessimistic RTF of 0.25 is
 * already 30 s of inference on a Lite-class machine.
 */
export const MAX_AUDIO_SECONDS = 120;

export const MAX_AUDIO_SAMPLES = TARGET_SAMPLE_RATE * MAX_AUDIO_SECONDS;

/** Why capture could not start (or had to stop). */
export type VoiceCaptureErrorKind =
  /** No `getUserMedia` / `AudioContext` in this runtime. */
  | "unsupported"
  /** The user (or Windows privacy settings) blocked microphone access. */
  | "permission_denied"
  /** No capture device, or the saved `deviceId` no longer exists. */
  | "no_device"
  /** The platform refused a 16 kHz context; we must not silently resample. */
  | "sample_rate_unsupported"
  | "start_failed";

export class VoiceCaptureError extends Error {
  readonly kind: VoiceCaptureErrorKind;
  /** DOMException name when this came from `getUserMedia`. */
  readonly mediaName: string | undefined;

  constructor(kind: VoiceCaptureErrorKind, message: string, mediaName?: string) {
    super(message);
    this.name = "VoiceCaptureError";
    this.kind = kind;
    this.mediaName = mediaName;
  }
}

/** One Float32 frame → clamped Int16 samples. */
export function floatFrameToInt16(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(frame[i]! * 32768)));
  }
  return out;
}

const LITTLE_ENDIAN = (() => {
  const probe = new Uint16Array([1]);
  return new Uint8Array(probe.buffer)[0] === 1;
})();

/**
 * Int16 samples → little-endian bytes.
 *
 * Every platform we ship on is little endian, so the typed-array buffer is
 * reused directly there; the explicit byte loop exists so a big-endian host
 * would still produce a correct `pcm_s16le` payload rather than a plausible one.
 */
export function int16ToLittleEndianBytes(samples: Int16Array): Uint8Array {
  if (LITTLE_ENDIAN) {
    return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  }
  const bytes = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]!;
    bytes[i * 2] = value & 0xff;
    bytes[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return bytes;
}

/** Concatenates captured Int16 chunks, keeping at most `maxSamples`. */
export function concatInt16(chunks: readonly Int16Array[], maxSamples = MAX_AUDIO_SAMPLES): Int16Array {
  const total = Math.min(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    maxSamples,
  );
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= total) break;
    const take = Math.min(chunk.length, total - offset);
    out.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/** Int16 PCM → the base64 string that goes into the request's `audio` field. */
export function encodeInt16ToBase64(samples: Int16Array): string {
  return bytesToBase64(int16ToLittleEndianBytes(samples));
}

export type PcmRecording = {
  /** base64 of headerless little-endian 16-bit PCM. */
  audio: string;
  sampleCount: number;
  seconds: number;
  /** True when the 120 s cap cut the recording short. */
  truncated: boolean;
};

export type PcmRecorderHandle = {
  /** Stops capture and returns the encoded audio. Safe to call once. */
  stop: () => Promise<PcmRecording>;
  /** Stops capture and discards everything (user cancelled, component unmounted). */
  cancel: () => void;
};

export type StartPcmRecordingOptions = {
  /** `MediaDeviceInfo.deviceId`; empty/undefined means the system default. */
  deviceId?: string;
  /** Called once the 120 s cap is hit; the caller should stop the recording. */
  onMaxDurationReached?: () => void;
};

/**
 * AudioWorklet body. Forwards a copy of every render quantum to the main
 * thread; the worklet itself stays allocation-light and does no conversion, so
 * a slow main thread cannot distort the captured audio.
 */
const WORKLET_SOURCE = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor("voice-capture-processor", VoiceCaptureProcessor);
`;

type AudioContextCtor = typeof AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function captureErrorFromGetUserMedia(error: unknown): VoiceCaptureError {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new VoiceCaptureError("permission_denied", "Microphone access was blocked.", name);
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return new VoiceCaptureError("no_device", "No microphone is available.", name);
  }
  return new VoiceCaptureError(
    "start_failed",
    error instanceof Error ? error.message : "Could not open the microphone.",
    name || undefined,
  );
}

/**
 * What the permission probe asks for. No `channelCount`: that constraint can
 * fail on a microphone that exists, and this call's only job is to separate
 * "no device" from "no permission". The recorder applies its own constraints.
 */
function presenceConstraints(deviceId: string | undefined): boolean | MediaTrackConstraints {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

/**
 * Asks for a capture device and releases it.
 *
 * This is the call that makes WebView2 record a microphone decision.
 * `enumerateDevices()` cannot: until permission is granted it omits every
 * `audioinput`, which is indistinguishable from a machine with no microphone.
 * Returns without throwing when this runtime has no `getUserMedia`; the
 * recorder reports that itself. A granted stream is stopped before return so
 * the permission prompt is not also an open microphone.
 */
export async function confirmMicrophone(deviceId?: string): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: presenceConstraints(deviceId),
    });
  } catch (error) {
    throw captureErrorFromGetUserMedia(error);
  }
  for (const track of stream.getTracks()) track.stop();
}

export async function startPcmRecording(
  options: StartPcmRecordingOptions = {},
): Promise<PcmRecorderHandle> {
  const AudioContextCtor = resolveAudioContextCtor();
  if (!AudioContextCtor || !navigator?.mediaDevices?.getUserMedia) {
    throw new VoiceCaptureError("unsupported", "Audio capture is not available.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Channel count is constrained; echoCancellation / noiseSuppression /
      // autoGainControl are deliberately left at the browser's defaults.
      audio: options.deviceId
        ? { deviceId: { exact: options.deviceId }, channelCount: 1 }
        : { channelCount: 1 },
    });
  } catch (error) {
    throw captureErrorFromGetUserMedia(error);
  }

  const stopStream = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  const context = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
  if (context.sampleRate !== TARGET_SAMPLE_RATE) {
    void context.close();
    stopStream();
    throw new VoiceCaptureError(
      "sample_rate_unsupported",
      `This device cannot capture at ${TARGET_SAMPLE_RATE} Hz (got ${context.sampleRate} Hz).`,
    );
  }

  const chunks: Int16Array[] = [];
  let sampleCount = 0;
  let truncated = false;
  let closed = false;

  const pushFrame = (frame: Float32Array) => {
    if (closed || sampleCount >= MAX_AUDIO_SAMPLES) return;
    const remaining = MAX_AUDIO_SAMPLES - sampleCount;
    const usable = frame.length <= remaining ? frame : frame.subarray(0, remaining);
    chunks.push(floatFrameToInt16(usable));
    sampleCount += usable.length;
    if (sampleCount >= MAX_AUDIO_SAMPLES) {
      truncated = true;
      options.onMaxDurationReached?.();
    }
  };

  const source = context.createMediaStreamSource(stream);
  let node: AudioNode;
  let detach: () => void;

  try {
    // AudioWorklet is the supported path; the module is injected as a blob URL
    // because the worklet loader takes a URL, not a source string.
    const blobUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    const worklet = new AudioWorkletNode(context, "voice-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => pushFrame(event.data);
    source.connect(worklet);
    node = worklet;
    detach = () => {
      worklet.port.onmessage = null;
      worklet.disconnect();
    };
  } catch {
    // ScriptProcessor fallback: deprecated, but it is the only capture path on
    // runtimes without AudioWorklet, and losing voice input entirely is worse.
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      pushFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    // ScriptProcessor only runs while connected to a destination; a zero-gain
    // node keeps the graph alive without echoing the mic to the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(context.destination);
    node = processor;
    detach = () => {
      processor.onaudioprocess = null;
      processor.disconnect();
      mute.disconnect();
    };
  }

  const teardown = () => {
    if (closed) return;
    closed = true;
    detach();
    source.disconnect();
    void context.close().catch(() => {});
    stopStream();
    void node;
  };

  return {
    async stop(): Promise<PcmRecording> {
      teardown();
      const samples = concatInt16(chunks);
      return {
        audio: encodeInt16ToBase64(samples),
        sampleCount: samples.length,
        seconds: samples.length / TARGET_SAMPLE_RATE,
        truncated,
      };
    },
    cancel() {
      teardown();
      chunks.length = 0;
      sampleCount = 0;
    },
  };
}
