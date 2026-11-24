// The pending-user-message placeholder and its attachment previews: marking the
// parts seeded from a placeholder, deciding when a real part supersedes one, and
// revoking the blob URLs the app owns. Pure; extracted from `session.ts`
// unchanged.

import type { Part } from "@opencode-ai/sdk/v2/client";

import type { MessageWithParts } from "~/shared/types/session";
import { partsWithIds } from "./session-store-collections";

export const RECONCILED_PENDING_PART_MARKER = ":reconciled-pending:";

export const isReconciledPendingPart = (part: Part) =>
  typeof part.id === "string" &&
  part.id.includes(RECONCILED_PENDING_PART_MARKER);

export const remapPendingPartsToMessage = (
  pending: MessageWithParts,
  messageID: string,
) =>
  partsWithIds(pending.parts).map(
    (part, index) =>
      ({
        ...part,
        id: `${messageID}${RECONCILED_PENDING_PART_MARKER}${index}`,
        messageID,
        sessionID: pending.info.sessionID,
      }) as Part,
  );

export const blobUrlsForParts = (parts: Part[]): string[] =>
  parts.flatMap((part) => {
    const url = (part as { url?: string }).url;
    return typeof url === "string" && url.startsWith("blob:") ? [url] : [];
  });

export const shouldDropReconciledPendingPart = (
  pendingPart: Part,
  realPart: Part,
) => {
  if (!isReconciledPendingPart(pendingPart)) return false;
  if (pendingPart.type !== realPart.type) return false;
  if (realPart.type !== "file") return true;
  const pendingFilename = (pendingPart as { filename?: string }).filename;
  const realFilename = (realPart as { filename?: string }).filename;
  return !pendingFilename || !realFilename || pendingFilename === realFilename;
};

export const pendingAttachmentUrls = (
  pending: MessageWithParts | null | undefined,
): string[] => {
  if (!pending) return [];
  return pending.parts.flatMap((part) => {
    const url = (part as { url?: string }).url;
    return typeof url === "string" && url.startsWith("blob:") ? [url] : [];
  });
};

// Revoke app-owned preview URLs after their pending message leaves the store.
export const revokePendingAttachmentUrls = (urls: string[]): void => {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
};
