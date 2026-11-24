import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { INBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS, type MediaKind } from "./media.js";

const DEFAULT_INBOUND_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_CONCURRENT = 4;
const DEFAULT_INBOUND_MAX_QUEUED = 8;

type InboundDownloadWaiter = {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
};

let activeInboundDownloads = 0;
const inboundDownloadQueue: InboundDownloadWaiter[] = [];

function acquireInboundDownloadSlot(signal: AbortSignal, maxConcurrent: number, maxQueued: number): Promise<() => void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (activeInboundDownloads < maxConcurrent) {
    activeInboundDownloads += 1;
    return Promise.resolve(createInboundDownloadRelease());
  }
  if (inboundDownloadQueue.length >= maxQueued) {
    return Promise.reject(new Error("Inbound media download capacity is exhausted"));
  }

  return new Promise((resolve, reject) => {
    const waiter: InboundDownloadWaiter = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = inboundDownloadQueue.indexOf(waiter);
        if (index >= 0) inboundDownloadQueue.splice(index, 1);
        reject(signal.reason);
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    inboundDownloadQueue.push(waiter);
  });
}

function createInboundDownloadRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;

    while (inboundDownloadQueue.length > 0) {
      const waiter = inboundDownloadQueue.shift();
      if (!waiter) break;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      waiter.resolve(createInboundDownloadRelease());
      return;
    }

    activeInboundDownloads -= 1;
  };
}

function mediaDownloadError(message: string, status?: number): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number };
  if (status !== undefined) error.status = status;
  return error;
}

function reportInboundCleanupFailure(operation: "close" | "unlink", error: unknown): void {
  const rawCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,32}$/.test(rawCode) ? rawCode : "UNKNOWN";
  console.warn("[media-store] inbound media cleanup failed", { operation, code });
}

async function declaredInboundLength(response: Response, maxBytes: number): Promise<number | undefined> {
  const contentLength = response.headers.get("content-length");
  const declaredBytes = contentLength === null ? undefined : Number(contentLength);
  if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) {
    throw mediaDownloadError("Invalid inbound media Content-Length", 400);
  }
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw mediaDownloadError(`Inbound media exceeds maximum allowed size (${maxBytes} bytes)`, 413);
  }
  return declaredBytes;
}

async function writeInboundResponse(
  response: Response,
  fileHandle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
  declaredBytes: number | undefined,
): Promise<number> {
  if (!response.body) throw mediaDownloadError("Inbound media response has no body", 400);

  const reader = response.body.getReader();
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - totalBytes) {
        throw mediaDownloadError(`Inbound media exceeds maximum allowed size (${maxBytes} bytes)`, 413);
      }

      let offset = 0;
      while (offset < value.byteLength) {
        const result = await fileHandle.write(value, offset, value.byteLength - offset);
        if (result.bytesWritten === 0) throw new Error("Inbound media file write made no progress");
        offset += result.bytesWritten;
      }
      totalBytes += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const contentEncoding = response.headers.get("content-encoding");
  if (declaredBytes !== undefined && (!contentEncoding || contentEncoding.toLowerCase() === "identity") && totalBytes !== declaredBytes) {
    throw mediaDownloadError("Inbound media size did not match Content-Length", 400);
  }
  return totalBytes;
}

export type MediaStoreOptions = {
  inboundMaxBytes?: number;
  inboundTimeoutMs?: number;
  inboundMaxConcurrent?: number;
  inboundMaxQueued?: number;
};

export type StoredMediaFile = {
  filePath: string;
  filename: string;
  sizeBytes: number;
  data?: Uint8Array;
  mimeType?: string;
};

function sanitizeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown";
}

function extensionFromMime(mimeType: string | undefined, kind: MediaKind): string {
  const value = (mimeType ?? "").toLowerCase();
  if (value === "image/jpeg") return ".jpg";
  if (value === "image/png") return ".png";
  if (value === "image/webp") return ".webp";
  if (value === "audio/ogg") return ".ogg";
  if (value === "audio/mpeg") return ".mp3";
  if (value === "audio/mp4") return ".m4a";
  if (value === "application/pdf") return ".pdf";
  if (kind === "image") return ".jpg";
  if (kind === "audio") return ".ogg";
  return ".bin";
}

function sanitizeFilename(filename: string, fallbackPrefix: string, fallbackExt: string): string {
  const trimmed = filename.trim();
  if (!trimmed) return `${fallbackPrefix}${fallbackExt}`;

  const base = basename(trimmed)
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!base) return `${fallbackPrefix}${fallbackExt}`;
  if (extname(base)) return base;
  return `${base}${fallbackExt}`;
}

export class MediaStore {
  constructor(private readonly rootDir: string, private readonly options: MediaStoreOptions = {}) {}

  private logExternalAccessIntent(url: string, kind: MediaKind): void {
    let host = "unknown";
    try {
      host = new URL(url).host || "unknown";
    } catch {
      host = "invalid-url";
    }
    console.info(`[media-store] external access intent kind=${kind} host=${host}`);
  }

  async ensureReady(): Promise<void> {
    // The inbox is a directory the host's ACL policy creates before the router starts, and on Windows a
    // recursive mkdir over an existing directory can fail with EEXIST under a tier account. A directory
    // that is already there is what this call is for.
    try {
      await mkdir(this.rootDir, { recursive: true });
    } catch (error) {
      if (!(await stat(this.rootDir).then((info) => info.isDirectory(), () => false))) throw error;
    }
  }

  private inboundDir(channel: string, identityId: string, peerId: string): string {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    return join(
      this.rootDir,
      "inbound",
      day,
      sanitizeSegment(channel),
      sanitizeSegment(identityId),
      sanitizeSegment(peerId),
    );
  }

  async downloadInbound(input: {
    channel: string;
    identityId: string;
    peerId: string;
    kind: MediaKind;
    url: string;
    headers?: Record<string, string>;
    filename?: string;
    mimeType?: string;
    signal?: AbortSignal;
  }): Promise<StoredMediaFile> {
    this.logExternalAccessIntent(input.url, input.kind);
    const maxBytes = this.options.inboundMaxBytes ?? DEFAULT_INBOUND_MAX_BYTES;
    const timeoutMs = this.options.inboundTimeoutMs ?? INBOUND_MEDIA_DOWNLOAD_TIMEOUT_MS;
    const maxConcurrent = this.options.inboundMaxConcurrent ?? DEFAULT_INBOUND_MAX_CONCURRENT;
    const maxQueued = this.options.inboundMaxQueued ?? DEFAULT_INBOUND_MAX_QUEUED;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0 || !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new Error("Invalid inbound media download limits");
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeoutError = mediaDownloadError(`Inbound media download exceeded ${timeoutMs} ms`, 408);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
    }, timeoutMs);
    const abortFromCaller = () => controller.abort(input.signal?.reason ?? timeoutError);
    if (input.signal?.aborted) abortFromCaller();
    else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    let releaseSlot: (() => void) | undefined;
    let response: Response | undefined;
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryPath: string | undefined;
    let promoted = false;

    try {
      releaseSlot = await acquireInboundDownloadSlot(controller.signal, maxConcurrent, maxQueued);
      // egress-surface: opencode_router_media_download
      response = await fetch(input.url, {
        headers: input.headers,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw controller.signal.reason ?? timeoutError;

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw mediaDownloadError(`Failed to download media (${response.status})`, response.status);
      }

      const declaredBytes = await declaredInboundLength(response, maxBytes);
      const mimeType = input.mimeType || response.headers.get("content-type") || undefined;
      const dir = this.inboundDir(input.channel, input.identityId, input.peerId);
      await mkdir(dir, { recursive: true });
      const id = randomUUID();
      const safeFilename = sanitizeFilename(
        input.filename ?? "",
        `${input.kind}-${Date.now()}-${id.slice(0, 8)}`,
        extensionFromMime(mimeType, input.kind),
      );
      const maxSafeNameBytes = 255 - Buffer.byteLength(id) - 1;
      const originalExtension = extname(safeFilename);
      const extension = Buffer.byteLength(originalExtension) <= maxSafeNameBytes
        ? originalExtension
        : extensionFromMime(mimeType, input.kind);
      const stem = safeFilename.slice(0, safeFilename.length - originalExtension.length);
      const filename = `${id}-${stem.slice(0, maxSafeNameBytes - Buffer.byteLength(extension))}${extension}`;
      const filePath = join(dir, filename);
      temporaryPath = join(dir, `.${id}.part`);
      fileHandle = await open(temporaryPath, "wx");
      const sizeBytes = await writeInboundResponse(response, fileHandle, maxBytes, declaredBytes);
      if (controller.signal.aborted) throw controller.signal.reason ?? timeoutError;
      await fileHandle.close();
      fileHandle = undefined;
      if (controller.signal.aborted) throw controller.signal.reason ?? timeoutError;
      await rename(temporaryPath, filePath);
      promoted = true;

      return {
        filePath,
        filename,
        sizeBytes,
        ...(mimeType ? { mimeType } : {}),
      };
    } catch (error) {
      controller.abort(error);
      await response?.body?.cancel().catch(() => undefined);
      if (timedOut) throw timeoutError;
      if (input.signal?.aborted) throw input.signal.reason ?? timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromCaller);
      try {
        if (fileHandle) {
          try {
            await fileHandle.close();
          } catch (error) {
            reportInboundCleanupFailure("close", error);
          }
        }
        if (!promoted && temporaryPath) {
          try {
            await unlink(temporaryPath);
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            if (code !== "ENOENT") reportInboundCleanupFailure("unlink", error);
          }
        }
      } finally {
        releaseSlot?.();
      }
    }
  }

  async resolveOutboundFile(input: {
    filePath: string;
    baseDirectory: string;
    allowedRoot?: string;
    maxBytes?: number;
  }): Promise<StoredMediaFile> {
    const raw = input.filePath.trim();
    if (!raw) {
      const error = new Error("filePath is required") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const baseDirectory = await realpath(input.baseDirectory);
    const root = input.allowedRoot ? await realpath(input.allowedRoot) : baseDirectory;
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(baseDirectory, raw);
    let resolved: string;
    let expectedInfo;
    try {
      resolved = await realpath(candidate);
      expectedInfo = await stat(resolved);
    } catch (error) {
      const wrapped = new Error(`File not found: ${candidate}`, { cause: error }) as Error & { status?: number };
      wrapped.status = 404;
      throw wrapped;
    }

    const relativePath = relative(root, resolved);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      const error = new Error(`File must stay within workspace root: ${resolved}`) as Error & {
        status?: number;
        code?: string;
      };
      error.status = 403;
      error.code = "path_outside_workspace";
      throw error;
    }

    if (!expectedInfo.isFile()) {
      const error = new Error(`Not a file: ${resolved}`) as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    if (typeof input.maxBytes === "number" && Number.isFinite(input.maxBytes) && expectedInfo.size > input.maxBytes) {
      const error = new Error(
        `File exceeds maximum allowed size (${expectedInfo.size} > ${Math.floor(input.maxBytes)} bytes): ${resolved}`,
      ) as Error & { status?: number };
      error.status = 413;
      throw error;
    }

    const handle = await open(resolved, "r");
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.dev !== expectedInfo.dev || openedInfo.ino !== expectedInfo.ino) {
        const error = new Error(`File changed while being validated: ${resolved}`) as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      const maxBytes = typeof input.maxBytes === "number" && Number.isFinite(input.maxBytes)
        ? Math.floor(input.maxBytes)
        : openedInfo.size;
      const data = Buffer.alloc(Math.min(openedInfo.size, maxBytes) + 1);
      let bytesRead = 0;
      while (bytesRead < data.length) {
        const result = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > maxBytes) {
        const error = new Error(`File exceeds maximum allowed size (${bytesRead} > ${maxBytes} bytes): ${resolved}`) as Error & { status?: number };
        error.status = 413;
        throw error;
      }
      return {
        filePath: resolved,
        filename: basename(resolved),
        sizeBytes: bytesRead,
        data: data.subarray(0, bytesRead),
      };
    } finally {
      await handle.close();
    }
  }
}
