import type { ComposerAttachment } from "../../types";
import type { ApprovalItem } from "~/shared/platform/transport/openwork-server.types";
import {
  encodeInboxItemId,
  sanitizeInboxUploadName,
} from "./composer.attachments";

// Strips the server's collision suffix (` (N)` before the extension) so an
// approval for `report (2).pdf` still matches a requested `report.pdf`.
const stripCollisionSuffix = (path: string) => {
  const slashIndex = path.lastIndexOf("/");
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const filename = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = filename.lastIndexOf(".");
  const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : "";
  return `${directory}${stem.replace(/ \(\d+\)$/, "")}${extension}`;
};

/** Auto-approvable operations for this flow: only its own workspace inbox
 * writes/deletes, never another session's pending command or file operation. */
export const isComposerInboxApproval = (
  workspaceId: string,
  expectedPaths: readonly string[],
  item: Pick<ApprovalItem, "workspaceId" | "action" | "paths">,
) => {
  if (
    item.workspaceId !== workspaceId ||
    (item.action !== "workspace.inbox.upload" &&
      item.action !== "workspace.inbox.delete")
  ) {
    return false;
  }

  const normalizedExpectedPaths = expectedPaths.map((path) =>
    path.replace(/\\/g, "/").replace(/^\/+/, ""),
  );
  const matchesExpected = (candidate: string) =>
    normalizedExpectedPaths.some(
      (expected) =>
        candidate === expected || candidate.endsWith(`/${expected}`),
    );
  return Boolean(
    item.paths?.some((path) => {
      const normalized = path.replace(/\\/g, "/");
      return (
        matchesExpected(normalized) ||
        matchesExpected(stripCollisionSuffix(normalized))
      );
    }),
  );
};

export const composerAttachmentModeError = (
  mode: "prompt" | "shell",
  attachmentCount: number,
  compactCommand = false,
) => {
  if (attachmentCount === 0) return null;
  if (mode === "shell") return "Attachments are not supported in shell mode.";
  if (compactCommand) return "Attachments are not supported with /compact.";
  return null;
};

export const workspaceSelectionForComposerUpload = (paths: readonly string[]) =>
  [...new Set(paths.filter(Boolean).map((path) => `projects/${path}`))];

type ComposerUploadClient = {
  uploadInbox: (
    workspaceId: string,
    file: File,
    options: { path: string },
  ) => Promise<{ path?: string }>;
  deleteInboxItem: (workspaceId: string, inboxId: string) => Promise<unknown>;
  withAutoApproval: <T>(
    operation: () => Promise<T>,
    options?: { shouldApprove?: (item: ApprovalItem) => boolean },
  ) => Promise<T>;
};

const isMissingInboxItem = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  error.status === 404 &&
  "code" in error &&
  error.code === "inbox_item_not_found";

const deleteUploadedPaths = async (
  client: ComposerUploadClient,
  workspaceId: string,
  paths: string[],
) => {
  const results = await Promise.allSettled(
    paths.map((path) =>
      client.deleteInboxItem(workspaceId, encodeInboxItemId(path)),
    ),
  );
  const failures = results.filter(
    (result) =>
      result.status === "rejected" && !isMissingInboxItem(result.reason),
  );
  if (failures.length > 0) {
    throw new Error(
      `Some uploaded attachments could not be removed (${failures.length}).`,
    );
  }
};

export const uploadComposerAttachments = async (
  client: ComposerUploadClient,
  workspaceId: string,
  attachments: ComposerAttachment[],
) => {
  const paths: string[] = [];
  const requestedPaths: string[] = [];
  const shouldApprove = (item: ApprovalItem) =>
    isComposerInboxApproval(workspaceId, [...requestedPaths, ...paths], item);

  await client.withAutoApproval(async () => {
    try {
      for (const attachment of attachments) {
        const requestedPath = sanitizeInboxUploadName(attachment.name);
        requestedPaths.push(requestedPath);
        const result = await client.uploadInbox(workspaceId, attachment.file, {
          path: requestedPath,
        });
        const path = result.path?.trim() ?? "";
        if (!path) throw new Error("Attachment upload returned no path.");
        paths.push(path);
      }
    } catch (uploadError) {
      try {
        await deleteUploadedPaths(client, workspaceId, paths);
      } catch (cleanupError) {
        console.error("Attachment upload rollback failed.", cleanupError);
        throw new Error(
          "Attachment upload failed, and some uploaded files could not be removed.",
        );
      }
      console.warn("Attachment upload failed.", uploadError);
      throw new Error("Attachment upload failed. Please try again.");
    }
  }, { shouldApprove });

  return {
    paths,
    rollback: () =>
      client.withAutoApproval(
        () => deleteUploadedPaths(client, workspaceId, paths),
        { shouldApprove },
      ),
  };
};