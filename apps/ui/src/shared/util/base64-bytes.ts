/**
 * Decode a base64 string into bytes.
 *
 * The obvious implementation — `atob` followed by a per-character
 * `charCodeAt` loop — costs one JS-level iteration per byte. For the office
 * previews this matters: a 380 KB spreadsheet that expands to a 236-page PDF
 * arrives as ~740 KB of base64, so the loop runs ~550k times on the UI thread
 * while the preview modal is already open and showing a spinner.
 *
 * `Uint8Array.from(str, cb)` has the same problem (the callback is invoked per
 * character), so this decodes in chunks and lets the engine do the per-byte
 * work inside `charCodeAt` over a bounded window instead. Where the runtime
 * exposes `Buffer` (Bun/Node, i.e. tests) that native path is used directly.
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  // Through `unknown`: when Node's types are in the program (they are in the test
  // project, via happy-dom and vite) `globalThis.Buffer` is Node's overloaded
  // `Buffer`, which a direct cast to this narrower shape rejects (TS2352).
  const nodeBuffer = (
    globalThis as unknown as {
      Buffer?: {
        from: (input: string, encoding: string) => Uint8Array;
      };
    }
  ).Buffer;
  if (nodeBuffer) {
    const buf = nodeBuffer.from(base64, "base64");
    // Copy into a plain ArrayBuffer-backed Uint8Array so callers never observe
    // a Buffer's extra prototype surface, and so the result is a valid BlobPart
    // (a SharedArrayBuffer-backed view would not be).
    const copy = new Uint8Array(new ArrayBuffer(buf.byteLength));
    copy.set(buf);
    return copy;
  }

  if (typeof atob !== "function") {
    throw new Error("Base64 decoder is unavailable");
  }

  const binary = atob(base64);
  const length = binary.length;
  const bytes = new Uint8Array(new ArrayBuffer(length));
  // 8 KB windows keep the inner loop's working set small without adding
  // meaningful per-chunk overhead.
  const CHUNK = 8192;
  for (let offset = 0; offset < length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, length);
    for (let i = offset; i < end; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
  }
  return bytes;
}

/**
 * Encode raw bytes as base64 (standard alphabet, padded).
 *
 * Chunked for the same reason `base64ToBytes` is: voice input hands this up to
 * 3.84 MB of PCM (120 s at 16 kHz mono 16-bit), and building one giant
 * intermediate string with a per-byte `+=` stalls the UI thread. `Buffer` is
 * used where it exists (Bun/Node, i.e. tests) because it is native.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const nodeBuffer = (
    globalThis as {
      Buffer?: {
        from: (input: Uint8Array) => { toString: (encoding: string) => string };
      };
    }
  ).Buffer;
  if (nodeBuffer) {
    return nodeBuffer.from(bytes).toString("base64");
  }

  if (typeof btoa !== "function") {
    throw new Error("Base64 encoder is unavailable");
  }

  // 3 KB windows: a multiple of 3, so every chunk encodes to a whole number of
  // base64 quads and the pieces can simply be concatenated.
  const CHUNK = 3072;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.length);
    let binary = "";
    for (let i = offset; i < end; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    parts.push(btoa(binary));
  }
  return parts.join("");
}

/** Decode a base64 string of UTF-8 text. Shares `base64ToBytes`' chunked
 * decoder, so a large file preview does not pay a per-character callback. */
export function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

/** Encode a string as base64 of its UTF-8 bytes. */
export function utf8ToBase64(value: string): string {
  if (typeof btoa !== "function") {
    const nodeBuffer = (
      globalThis as {
        Buffer?: {
          from: (
            input: string,
            encoding: string,
          ) => { toString: (encoding: string) => string };
        };
      }
    ).Buffer;
    if (!nodeBuffer) {
      throw new Error("Base64 encoder is unavailable");
    }
    return nodeBuffer.from(value, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
