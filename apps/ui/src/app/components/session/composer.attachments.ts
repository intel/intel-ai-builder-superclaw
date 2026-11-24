export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export const MAX_IMAGE_ATTACHMENTS = 5;

export const IMAGE_COMPRESS_MAX_PX = 2048;

export const IMAGE_COMPRESS_QUALITY = 0.82;

export const IMAGE_COMPRESS_TARGET_BYTES = 1_500_000;

export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES];

export const FILE_URL_RE = /^file:\/\//i;

export const HTTP_URL_RE = /^https?:\/\//i;

export const WINDOWS_PATH_RE = /^[a-zA-Z]:\\/;

export const UNC_PATH_RE = /^\\\\/;

export const isImageMime = (mime: string) => ACCEPTED_IMAGE_TYPES.includes(mime);

/** Image MIME type for a dropped file path, or null when it is not an image. */
export const droppedImageMime = (path: string): string | null => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
};

export const isSupportedAttachmentType = (mime: string) =>
  ACCEPTED_FILE_TYPES.includes(mime);

export const remainingImageAttachmentSlots = (occupiedImageSlots: number) =>
  Math.max(0, MAX_IMAGE_ATTACHMENTS - occupiedImageSlots);

export const limitImageAttachments = (
  files: File[],
  occupiedImageSlots: number,
) => {
  let remainingImageSlots = remainingImageAttachmentSlots(occupiedImageSlots);
  let omittedImageCount = 0;
  const acceptedFiles: File[] = [];

  for (const file of files) {
    if (!isImageMime(file.type)) {
      acceptedFiles.push(file);
      continue;
    }
    if (remainingImageSlots === 0) {
      omittedImageCount += 1;
      continue;
    }
    acceptedFiles.push(file);
    remainingImageSlots -= 1;
  }

  return { acceptedFiles, omittedImageCount };
};

const MAX_INBOX_UPLOAD_NAME_BYTES = 180;

const truncateUtf8 = (value: string, maxBytes: number) => {
  const encoder = new TextEncoder();
  let result = "";
  let byteLength = 0;
  for (const char of value) {
    const charBytes = encoder.encode(char).length;
    if (byteLength + charBytes > maxBytes) break;
    result += char;
    byteLength += charBytes;
  }
  return result;
};

export const sanitizeInboxUploadName = (name: string) => {
  const basename = name.split(/[\\/]/).pop() ?? "";
  const sanitized = basename
    .normalize("NFC")
    .replace(/^\.+/, "")
    .replace(/[\u0000-\u001f\u007f<>:"|?*\[\]]/g, "-")
    .replace(/[. ]+$/, "");
  if (!sanitized) return "attachment";

  const extensionIndex = sanitized.lastIndexOf(".");
  const extension =
    extensionIndex > 0 && sanitized.length - extensionIndex <= 16
      ? sanitized.slice(extensionIndex)
      : "";
  const stem = extension ? sanitized.slice(0, extensionIndex) : sanitized;
  const extensionBytes = new TextEncoder().encode(extension).length;
  return `${truncateUtf8(stem, MAX_INBOX_UPLOAD_NAME_BYTES - extensionBytes)}${extension}`;
};

export const composerInboxUploadPath = (
  uploadId: string,
  kind: "image" | "file",
  name: string,
) => `composer-${kind}-${uploadId}-${sanitizeInboxUploadName(name)}`;

export const parseComposerInboxUploadPath = (path: string) => {
  const filename = path.split("/").pop() ?? "";
  const match = filename.match(/^composer-(image|file)-[a-z\d]{8}-(.+)$/i);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() as "image" | "file",
    filename: match[2],
  };
};

export const parseLegacyComposerInboxUploadPath = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(
    /^\/workspace\/(?:[a-f\d]{8}|\d{13}-[a-z\d]{8})-([^/]+)$/i,
  );
  return match?.[1] ?? null;
};

export const encodeInboxItemId = (path: string) => {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const escapeMarkdownLabel = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");

export const normalizeLinkTarget = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (FILE_URL_RE.test(trimmed) || HTTP_URL_RE.test(trimmed)) {
    return encodeURI(trimmed);
  }
  if (WINDOWS_PATH_RE.test(trimmed)) {
    return `file:///${encodeURI(trimmed.replace(/\\/g, "/"))}`;
  }
  if (UNC_PATH_RE.test(trimmed)) {
    const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
    return `file://${encodeURI(normalized)}`;
  }
  if (trimmed.startsWith("/")) {
    return `file://${encodeURI(trimmed)}`;
  }
  return "";
};

export const parseClipboardLinks = (clipboard: DataTransfer) => {
  const values = [
    clipboard.getData("text/uri-list") ?? "",
    clipboard.getData("text/plain") ?? "",
    clipboard.getData("text") ?? "",
  ];
  const links: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const line of lines) {
      const target = normalizeLinkTarget(line);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      links.push(target);
    }
  }
  return links;
};

export const inboxPathToLink = (path: string) => {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  if (!normalized) return "";
  if (normalized.startsWith(".opencode/openwork/inbox/")) {
    return `/workspace/${normalized.slice(".opencode/openwork/inbox/".length)}`;
  }
  if (normalized.startsWith("workspace/inbox/")) {
    return `/workspace/${normalized.slice("workspace/inbox/".length)}`;
  }
  if (normalized.startsWith("inbox/")) {
    return `/workspace/${normalized.slice("inbox/".length)}`;
  }
  return `/workspace/${normalized}`;
};

export const formatLinks = (links: Array<{ name: string; target: string }>) =>
  links
    .filter((entry) => entry.target)
    .map(
      (entry) =>
        `[${escapeMarkdownLabel(entry.name || "file")}](${entry.target})`,
    )
    .join("\n");

export const estimateInlineAttachmentBytes = (file: Blob) => {
  const mimeType = file.type || "application/octet-stream";
  const prefixBytes = `data:${mimeType};base64,`.length;
  const base64Bytes = Math.ceil(file.size / 3) * 4;
  return prefixBytes + base64Bytes + 512;
};

export const attachmentSizeLimit = (file: File) => {
  if (file.size > MAX_ATTACHMENT_BYTES) return "raw" as const;
  if (
    isImageMime(file.type) &&
    estimateInlineAttachmentBytes(file) > MAX_ATTACHMENT_BYTES
  ) {
    return "encoded" as const;
  }
  return null;
};

/**
 * Compress an image file to JPEG using OffscreenCanvas (off main thread when possible).
 * Falls back to regular canvas if OffscreenCanvas is unavailable.
 * Returns a new File with compressed data, or the original if compression isn't beneficial.
 */
export const compressImageFile = async (file: File): Promise<File> => {
  // Skip GIFs (animated) and already-small images
  if (file.type === "image/gif" || file.size <= IMAGE_COMPRESS_TARGET_BYTES) {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  // Calculate scaled dimensions
  const maxDim = Math.max(width, height);
  const scale =
    maxDim > IMAGE_COMPRESS_MAX_PX ? IMAGE_COMPRESS_MAX_PX / maxDim : 1;
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  let blob: Blob | null = null;

  if (typeof OffscreenCanvas !== "undefined") {
    const offscreen = new OffscreenCanvas(targetW, targetH);
    const ctx = offscreen.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await offscreen.convertToBlob({
        type: "image/jpeg",
        quality: IMAGE_COMPRESS_QUALITY,
      });
    }
  }

  if (!blob) {
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", IMAGE_COMPRESS_QUALITY),
    );
  }

  bitmap.close();

  if (!blob || blob.size >= file.size) {
    return file; // Compression didn't help
  }

  const ext = file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${ext || "image"}.jpg`, { type: "image/jpeg" });
};
