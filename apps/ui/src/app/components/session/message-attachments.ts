import type { Part } from "@opencode-ai/sdk/v2/client";
import {
  parseComposerInboxUploadPath,
  parseLegacyComposerInboxUploadPath,
  sanitizeInboxUploadName,
} from "./composer.attachments";

/** Mime given to a `[Selected folder: …]` chip; no transport carries it. */
export const FOLDER_MIME = "inode/directory";

export type MessageAttachment = {
  url: string;
  filename: string;
  mime: string;
  /** Workspace path of an inline upload, once its uploaded copy is matched. */
  path?: string;
};

const attachmentDedupKey = (filename: string) =>
  sanitizeInboxUploadName(filename).toLowerCase();

const uploadDedupKeys = (filename: string) => {
  const exact = attachmentDedupKey(filename);
  const extensionIndex = filename.lastIndexOf(".");
  const stem = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : "";
  const withoutCollisionSuffix = stem.replace(/ \(\d+\)$/, "") + extension;
  const base = attachmentDedupKey(withoutCollisionSuffix);
  return exact === base ? [exact] : [exact, base];
};

const consumeMatch = (matches: Map<string, number>, filename: string) => {
  const key = uploadDedupKeys(filename).find(
    (candidate) => (matches.get(candidate) ?? 0) > 0,
  );
  if (!key) return false;
  matches.set(key, (matches.get(key) ?? 0) - 1);
  return true;
};

const isReconciledPendingPart = (part: Part) =>
  typeof part.id === "string" && part.id.includes(":reconciled-pending:");

// Selection annotations carry native, relative or legacy container paths.
const SELECTED_ANNOTATION_RE = /\[Selected (file|folder): ([^\r\n]+?)\](?=\s|$)/g;

// Prompt parts build `file://` URLs from raw paths, so `#` and `%` are filename characters.
const stripFileScheme = (path: string) =>
  path.trim().replace(/^file:\/\//i, "").replace(/^\/(?=[a-z]:[\\/])/i, "");

/** One chip per file: a Files-panel selection and an @-mention can name the same path. */
const uniqueByPath = (attachments: MessageAttachment[]) => {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const path = attachment.url.replace(/\\/g, "/");
    const key = /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const isWorkspaceRootFile = (path: string, workspaceRoot: string) => {
  const normalized = stripFileScheme(path).replace(/\\/g, "/");
  if (!normalized.includes("/")) return true;
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const caseInsensitive = /^[a-z]:\//i.test(root) || root.startsWith("//");
  const candidate = caseInsensitive ? normalized.toLowerCase() : normalized;
  const roots = ["/workspace", caseInsensitive ? root.toLowerCase() : root];
  return roots.some((prefix) =>
    prefix && candidate.startsWith(`${prefix}/`) &&
    !candidate.slice(prefix.length + 1).includes("/"),
  );
};

export const stripSelectedFileAnnotations = (text: string) =>
  text
    .replace(SELECTED_ANNOTATION_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const isInlineAttachmentUrl = (url: string) => /^(?:blob|data|https?):/i.test(url);

/** The path a preview or reveal can resolve, or null for an unmatched inline upload. */
export const attachmentLocalPath = (attachment: MessageAttachment) =>
  attachment.path ?? (isInlineAttachmentUrl(attachment.url) ? null : attachment.url);

const comparablePath = (path: string) =>
  /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;

// The composer sends `@` and the picked path: workspace-relative, or absolute outside the
// workspace. Only those count, so a file named like an agent leaves `@agent` alone.
const mentionCandidates = (attachments: MessageAttachment[], workspaceRoot: string) => {
  const roots = ["/workspace", workspaceRoot]
    .map((root) => root.trim().replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter(Boolean);
  const candidates = new Set<string>();
  for (const attachment of attachments) {
    // Folders are sent as `[Selected folder: …]`; their names would only collide with `@agent`.
    if (attachment.mime === FOLDER_MIME) continue;
    const path = attachmentLocalPath(attachment);
    if (!path) continue;
    const full = stripFileScheme(path).replace(/\\/g, "/");
    candidates.add(full);
    for (const root of roots) {
      if (comparablePath(full).startsWith(`${comparablePath(root)}/`)) candidates.add(full.slice(root.length + 1));
    }
  }
  return [...candidates].filter(Boolean).sort((a, b) => b.length - a.length);
};

const MENTION_START_RE = /[\s(（]/;
const MENTION_END_RE = /^(?:$|[\s,;:!?)，。；：！？）、]|\.(?:$|\s))/;

/** Hides the `@path` the composer sends for a file the message already shows as a chip. */
export const stripAttachmentMentions = (
  text: string,
  attachments: MessageAttachment[],
  workspaceRoot = "",
) => {
  if (!attachments.length || !text.includes("@")) return text;
  const candidates = mentionCandidates(attachments, workspaceRoot);
  const normalized = text.replace(/\\/g, "/");
  let out = "";
  let index = 0;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at < index || (at > 0 && !MENTION_START_RE.test(text[at - 1]))) continue;
    const match = candidates.find(
      (candidate) =>
        normalized.startsWith(candidate, at + 1) &&
        MENTION_END_RE.test(text.slice(at + 1 + candidate.length)),
    );
    if (!match) continue;
    out += text.slice(index, at);
    index = at + 1 + match.length;
    if (text[index] === " " && (out === "" || /\s$/.test(out))) index += 1;
    else if (index < text.length && !/\s/.test(text[index])) out = out.replace(/[ \t]+$/, "");
  }
  return (out + text.slice(index)).replace(/[ \t]+\n/g, "\n").trim();
};

/**
 * The path of the `@` mention in `text` ending in `filename`, joined to the workspace root if
 * relative. Null when mentions of that name point at different files, since the inline copy
 * cannot say which one it is.
 */
const mentionedPath = (text: string, filename: string, workspaceRoot: string) => {
  const normalized = text.replace(/\\/g, "/");
  const root = workspaceRoot.trim().replace(/[\\/]+$/, "");
  const separator = root.includes("\\") ? "\\" : "/";
  const paths = new Set<string>();
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && !MENTION_START_RE.test(text[at - 1])) continue;
    for (let end = normalized.indexOf(filename, at + 1); end >= 0; end = normalized.indexOf(filename, end + 1)) {
      const path = text.slice(at + 1, end + filename.length);
      if (/[\r\n@]/.test(path)) break;
      const bounded = end === at + 1 || normalized[end - 1] === "/";
      if (!bounded || !MENTION_END_RE.test(text.slice(end + filename.length))) continue;
      paths.add(
        !root || /^(?:[a-z]:[\\/]|[\\/])/i.test(path)
          ? path
          : `${root}${separator}${path.replace(/[\\/]/g, separator)}`,
      );
      break;
    }
  }
  return paths.size === 1 ? [...paths][0] : null;
};

const attachmentFromFolderPath = (path: string): MessageAttachment => {
  const trimmed = path.replace(/[\\/]+$/, "");
  return {
    url: trimmed,
    filename: trimmed.split(/[\\/]/).pop() || trimmed,
    mime: FOLDER_MIME,
  };
};

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const attachmentFromWorkspacePath = (path: string): MessageAttachment => {
  const normalized = path.replace(/\\/g, "/");
  const filename =
    parseComposerInboxUploadPath(normalized)?.filename ??
    (normalized.split("/").pop() || "attachment");
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const mime =
    extension === "pdf"
      ? "application/pdf"
      : extension === "txt" || extension === "md"
        ? "text/plain"
        : (IMAGE_MIME_BY_EXTENSION[extension] ?? "application/octet-stream");
  return { url: path, filename, mime };
};

export const isMessageAttachmentPart = (part: Part) => {
  if (part.type !== "file") return false;
  const url = (part as { url?: string }).url;
  return typeof url === "string" && !url.startsWith("file://");
};

export const selectedFileAttachment = (
  part: Part,
): MessageAttachment | null => {
  if (part.type === "text") {
    const text = String((part as { text?: string }).text ?? "").trim();
    const match = text.match(/^\[Selected (file|folder): ([^\r\n]+)\]$/);
    // `[Selected …] prose [Selected …]` also fits the anchors; its prose must still render.
    if (!match || stripSelectedFileAnnotations(text)) return null;
    const path = stripFileScheme(match[2]);
    return match[1] === "folder"
      ? attachmentFromFolderPath(path)
      : attachmentFromWorkspacePath(path);
  }
  if (part.type === "file") {
    const url = String((part as { url?: string }).url ?? "");
    if (!/^file:\/\//i.test(url)) return null;
    const attachment = attachmentFromWorkspacePath(stripFileScheme(url));
    // An @-mention part names its file; an inbox upload's name is in its path.
    const filename = (part as { filename?: string }).filename;
    return filename && !parseComposerInboxUploadPath(attachment.url.replace(/\\/g, "/"))
      ? { ...attachment, filename }
      : attachment;
  }
  return null;
};

const selectedFileAttachments = (part: Part): MessageAttachment[] => {
  if (part.type !== "text") {
    const attachment = selectedFileAttachment(part);
    return attachment ? [attachment] : [];
  }

  const text = String((part as { text?: string }).text ?? "");
  return Array.from(text.matchAll(SELECTED_ANNOTATION_RE), (match) => {
    const path = stripFileScheme(match[2]);
    return match[1] === "folder"
      ? attachmentFromFolderPath(path)
      : attachmentFromWorkspacePath(path);
  });
};

/**
 * Inline images among `allParts` that the transcript hides (`synthetic`) and no visible
 * chip already names. When the engine stores a read image only as such a part, it is
 * the only record of the attachment left in the message.
 */
export const hiddenImageParts = (allParts: Part[], visibleParts: Part[]): Part[] => {
  const visible = new Set(visibleParts);
  const named = new Set(
    [
      ...visibleParts.flatMap(selectedFileAttachments).map((a) => a.filename),
      ...visibleParts
        .filter(isMessageAttachmentPart)
        .map((part) => (part as { filename?: string }).filename ?? ""),
    ].map((filename) => filename.toLowerCase()),
  );
  return allParts.filter((part) => {
    if (visible.has(part) || part.type !== "file") return false;
    const record = part as { synthetic?: boolean; url?: string; filename?: string };
    return (
      record.synthetic === true &&
      /^data:image\//i.test(record.url ?? "") &&
      !named.has((record.filename ?? "").toLowerCase())
    );
  });
};

/** Leaf display adapter: preserve selected paths; use the workspace root only
 * to reconcile root-level uploads with their temporary preview cards. */
export const attachmentsForParts = (
  parts: Part[],
  workspaceRoot = "",
): MessageAttachment[] => {
  const inlineAttachments: MessageAttachment[] = parts
    .filter(isMessageAttachmentPart)
    .map((part) => {
      const record = part as {
        url?: string;
        filename?: string;
        mime?: string;
      };
      return {
        url: record.url ?? "",
        filename: record.filename ?? "attachment",
        mime: record.mime ?? "application/octet-stream",
      };
    })
    .filter((attachment) => !!attachment.url);
  const unmatchedInlineImages = new Map<string, number>();
  const unmatchedInlineFiles = new Map<string, number>();
  const unmatchedPendingImages = new Map<string, number>();
  const unmatchedPendingFiles = new Map<string, number>();
  // Each preview belongs to exactly one pool across both matching passes.
  for (const part of parts.filter(isMessageAttachmentPart)) {
    if (part.type !== "file" || !part.url) continue;
    const key = attachmentDedupKey(part.filename ?? "attachment");
    const pending = isReconciledPendingPart(part);
    const target = part.mime.startsWith("image/")
      ? pending ? unmatchedPendingImages : unmatchedInlineImages
      : pending ? unmatchedPendingFiles : unmatchedInlineFiles;
    target.set(key, (target.get(key) ?? 0) + 1);
  }
  const selectedCandidates = uniqueByPath(parts.flatMap(selectedFileAttachments));
  const suppressedSelectedIndexes = new Set<number>();
  // The card that stays keeps the folded-in upload's path for size, preview and reveal.
  const claimPath = (filename: string, path: string) => {
    const unclaimed = inlineAttachments.filter((inline) => !inline.path);
    const exact = attachmentDedupKey(filename);
    const keys = uploadDedupKeys(filename);
    const card =
      unclaimed.find((inline) => attachmentDedupKey(inline.filename) === exact) ??
      unclaimed.find((inline) => keys.some((key) => uploadDedupKeys(inline.filename).includes(key)));
    if (card) card.path = path;
  };

  for (const [index, attachment] of selectedCandidates.entries()) {
      const upload = parseComposerInboxUploadPath(attachment.url.replace(/\\/g, "/"));
      const legacyFilename = parseLegacyComposerInboxUploadPath(
        attachment.url,
      );
      if (!upload && !legacyFilename) continue;
      const key = attachmentDedupKey(
        upload?.filename ?? legacyFilename ?? attachment.filename,
      );
      const pools = upload?.kind === "file"
        ? [unmatchedPendingFiles, unmatchedInlineFiles]
        : [unmatchedPendingImages, unmatchedInlineImages];
      for (const matches of pools) {
        const remaining = matches.get(key) ?? 0;
        if (remaining === 0) continue;
        matches.set(key, remaining - 1);
        suppressedSelectedIndexes.add(index);
        claimPath(upload?.filename ?? legacyFilename ?? attachment.filename, attachment.url);
        break;
      }
  }

  // A collision-renamed upload is stronger evidence than an unchanged basename.
  const readableCandidates = [...selectedCandidates.entries()].sort(
    ([, left], [, right]) =>
      uploadDedupKeys(right.filename).length - uploadDedupKeys(left.filename).length,
  );
  for (const [index, attachment] of readableCandidates) {
    if (suppressedSelectedIndexes.has(index)) continue;
    const upload = parseComposerInboxUploadPath(attachment.url.replace(/\\/g, "/"));
    const legacyFilename = parseLegacyComposerInboxUploadPath(attachment.url);
    if (upload || legacyFilename) continue;
    if (!isWorkspaceRootFile(attachment.url, workspaceRoot)) continue;
    const pendingMatches = [unmatchedPendingFiles, unmatchedPendingImages];
    if (
      pendingMatches.some((matches) =>
        consumeMatch(matches, attachment.filename),
      ) || consumeMatch(unmatchedInlineImages, attachment.filename)
    ) {
      suppressedSelectedIndexes.add(index);
      claimPath(attachment.filename, attachment.url);
    }
  }

  const selectedAttachments = selectedCandidates.filter(
    (_, index) => !suppressedSelectedIndexes.has(index),
  );

  // An image the engine kept only inline has no path; the `@` mention that sent it names one.
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  for (const inline of inlineAttachments) {
    if (inline.path || !inline.mime.startsWith("image/")) continue;
    inline.path = mentionedPath(text, inline.filename, workspaceRoot) ?? undefined;
  }

  return [...inlineAttachments, ...selectedAttachments];
};