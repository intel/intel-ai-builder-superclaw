// Outbound delivery: resolving media parts against the workspace, then getting
// them onto a channel adapter part by part.
//
// Extracted from `startBridge`. The adapter is reached through an injected
// resolver rather than the adapter map, so this module does not need to know how
// adapters are keyed.

import { constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ChannelName } from "./config.js";
import { classifyDeliveryError } from "./delivery.js";
import type { MessageDeliveryResult, OutboundMessage, OutboundMessagePart } from "./media.js";
import { normalizeOutboundParts } from "./media.js";
import type { MediaStore } from "./media-store.js";
import { chunkText, stripModelPrefix, truncateText } from "./text.js";

export type OutboundKind = "reply" | "system" | "tool";

/**
 * The slice of a channel adapter delivery needs. Narrower than the bridge's full
 * `Adapter` on purpose: a delivery failure should never be caused by lifecycle
 * methods this module has no business calling.
 */
export type DeliveryAdapter = {
  maxTextLength: number;
  sendMessage?: (peerId: string, message: OutboundMessage) => Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
  sendFile?: (peerId: string, filePath: string, caption?: string, data?: Uint8Array) => Promise<void>;
};

export type OutboundDeliveryDeps = {
  resolveAdapter: (channel: ChannelName, identityId: string) => DeliveryAdapter | undefined;
  reportOutbound?: (event: {
    channel: ChannelName;
    identityId: string;
    peerId: string;
    text: string;
    kind: OutboundKind;
  }) => void;
  recordOutboundActivity: (now: number) => void;
  mediaStore: MediaStore;
  workspaceRoot: string;
  /** Where the host drops files for delivery. When set, outbound files must live here, not in the workspace. */
  outboundRoot?: string;
  outboundMediaMaxBytes: number;
  /** Test seam: runs between the containment check and the open of an outbox file. */
  beforeOpen?: (resolvedPath: string) => Promise<void>;
};

const isOutside = (rel: string): boolean =>
  rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

// lstat every component from the root down: none may be a symlink or junction (reparse point).
const hasNoLinkComponents = async (root: string, rel: string): Promise<boolean> => {
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return false;
  }
  return true;
};

// Reads exactly `size` bytes; a file that grew or shrank after the fstat is refused.
const readBounded = async (handle: FileHandle, size: number): Promise<Uint8Array | undefined> => {
  const buffer = Buffer.alloc(size + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total === size ? buffer.subarray(0, size) : undefined;
};

const REFUSED_FILE_MESSAGE = "File not sent: only files staged in the delivery outbox can be sent.";

export const createOutboundDelivery = (deps: OutboundDeliveryDeps) => {
  // The common boundary for every path (API sends, FILE: replies): with an outbox, a file part must
  // resolve inside it, so no adapter opens a path the model chose. Without an outbox (the non-native
  // layout, where the router shares the workspace account) parts were already workspace-checked by
  // resolveOutboundParts and FILE: replies keep their historical unrestricted behaviour.
  const confineToOutbox = async (part: OutboundMessagePart): Promise<OutboundMessagePart | undefined> => {
    if (part.type === "text" || !deps.outboundRoot) return part;
    try {
      const root = await realpath(deps.outboundRoot);
      const raw = part.filePath.trim();
      const resolved = await realpath(isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
      const rel = relative(root, resolved);
      if (isOutside(rel)) return undefined;
      if (!(await hasNoLinkComponents(root, rel))) return undefined;

      await deps.beforeOpen?.(resolved);
      // O_NOFOLLOW is 0 on Windows; the post-open identity and containment checks cover it there.
      const handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.size > BigInt(deps.outboundMediaMaxBytes)) return undefined;

        // A swap between the check and the open leaves the handle on the swapped target: the path
        // then no longer resolves to it, or no longer resolves inside the outbox.
        const after = await realpath(resolved);
        if (after !== resolved || isOutside(relative(root, after))) return undefined;
        if (!(await hasNoLinkComponents(root, rel))) return undefined;
        const current = await stat(after, { bigint: true });
        if (current.dev !== opened.dev || current.ino !== opened.ino) return undefined;

        const data = await readBounded(handle, Number(opened.size));
        if (!data) return undefined;
        return { ...part, filePath: resolved, data, ...(part.filename ? {} : { filename: basename(resolved) }) };
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  };

  const resolveOutboundParts = async (
    baseDirectory: string,
    input: { text?: string; parts?: unknown },
  ): Promise<OutboundMessagePart[]> => {
    const normalized = normalizeOutboundParts(input);
    if (normalized.length === 0) {
      const error = new Error("text or parts is required") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const resolved: OutboundMessagePart[] = [];
    for (const part of normalized) {
      if (part.type === "text") {
        resolved.push(part);
        continue;
      }

      const file = await deps.mediaStore.resolveOutboundFile({
        filePath: part.filePath,
        baseDirectory: deps.outboundRoot ?? baseDirectory,
        allowedRoot: deps.outboundRoot ?? deps.workspaceRoot,
        maxBytes: deps.outboundMediaMaxBytes,
      });
      resolved.push({
        ...part,
        filePath: file.filePath,
        ...(file.data ? { data: file.data } : {}),
        ...(part.filename ? {} : { filename: file.filename }),
      });
    }

    return resolved;
  };

  const deliverAllowedParts = async (
    channel: ChannelName,
    identityId: string,
    peerId: string,
    parts: OutboundMessagePart[],
    options: { kind?: OutboundKind; display?: boolean } = {},
    meta?: { model?: string },
  ): Promise<MessageDeliveryResult> => {
    const adapter = deps.resolveAdapter(channel, identityId);
    if (!adapter) {
      return {
        attemptedParts: parts.length,
        sentParts: 0,
        partResults: parts.map((part, index) => ({
          index,
          type: part.type,
          sent: false,
          error: "Adapter not running",
          code: "not_found",
          retryable: false,
        })),
      };
    }

    const kind = options.kind ?? "system";
    // Sanitize outbound text ONCE here — all adapters trust this cleaning.
    const outboundParts: OutboundMessagePart[] = parts.map((part) =>
      part.type === "text" ? { ...part, text: stripModelPrefix(part.text) } : part,
    );
    if (options.display !== false) {
      for (const part of outboundParts) {
        const preview =
          part.type === "text"
            ? truncateText(part.text, 240)
            : `[${part.type}] ${part.filename || part.filePath}`;
        deps.reportOutbound?.({ channel, identityId, peerId, text: preview, kind });
      }
    }

    deps.recordOutboundActivity(Date.now());

    if (adapter.sendMessage) {
      try {
        return await adapter.sendMessage(peerId, { parts: outboundParts, ...(meta ? { meta } : {}) });
      } catch (error) {
        const classified = classifyDeliveryError(error);
        return {
          attemptedParts: outboundParts.length,
          sentParts: 0,
          partResults: outboundParts.map((part, index) => ({
            index,
            type: part.type,
            sent: false,
            error: classified.message,
            code: classified.code,
            retryable: classified.retryable,
          })),
        };
      }
    }

    const partResults: MessageDeliveryResult["partResults"] = [];
    let sentParts = 0;
    for (let index = 0; index < outboundParts.length; index += 1) {
      const part = outboundParts[index];
      try {
        if (part.type === "text") {
          const chunks = chunkText(part.text, adapter.maxTextLength);
          for (const chunk of chunks) {
            await adapter.sendText(peerId, chunk);
          }
        } else if (adapter.sendFile) {
          await adapter.sendFile(peerId, part.filePath, part.caption, part.data);
        } else {
          throw new Error(`Adapter does not support ${part.type} media`);
        }

        sentParts += 1;
        partResults.push({ index, type: part.type, sent: true });
      } catch (error) {
        const classified = classifyDeliveryError(error);
        partResults.push({
          index,
          type: part.type,
          sent: false,
          error: classified.message,
          code: classified.code,
          retryable: classified.retryable,
        });
      }
    }

    return {
      attemptedParts: outboundParts.length,
      sentParts,
      partResults,
    };
  };

  const deliverParts = async (
    channel: ChannelName,
    identityId: string,
    peerId: string,
    parts: OutboundMessagePart[],
    options: { kind?: OutboundKind; display?: boolean } = {},
    meta?: { model?: string },
  ): Promise<MessageDeliveryResult> => {
    const confined = await Promise.all(parts.map(confineToOutbox));
    if (confined.every((part) => part !== undefined)) {
      return deliverAllowedParts(channel, identityId, peerId, confined as OutboundMessagePart[], options, meta);
    }

    const allowedIndexes: number[] = [];
    const allowed: OutboundMessagePart[] = [];
    confined.forEach((part, index) => {
      if (part) {
        allowedIndexes.push(index);
        allowed.push(part);
      }
    });
    const refused = parts.length - allowed.length;
    console.warn(`[outbound] refused ${refused} file part(s) outside the delivery outbox channel=${channel}`);

    const inner: MessageDeliveryResult =
      allowed.length > 0
        ? await deliverAllowedParts(channel, identityId, peerId, allowed, options, meta)
        : { attemptedParts: 0, sentParts: 0, partResults: [] };
    const partResults: MessageDeliveryResult["partResults"] = parts.map((part, index) => ({
      index,
      type: part.type,
      sent: false,
      error: REFUSED_FILE_MESSAGE,
      code: "path_outside_outbox",
      retryable: false,
    }));
    allowedIndexes.forEach((original, innerIndex) => {
      const result = inner.partResults[innerIndex];
      if (result) partResults[original] = { ...result, index: original };
    });

    const adapter = deps.resolveAdapter(channel, identityId);
    if (adapter) {
      try {
        await adapter.sendText(peerId, REFUSED_FILE_MESSAGE);
      } catch {
        // The refusal is still reported in the delivery result.
      }
    }
    return { attemptedParts: parts.length, sentParts: inner.sentParts, partResults };
  };

  return { resolveOutboundParts, deliverParts };
};
