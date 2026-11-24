import type { JSX } from "solid-js";
import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileType2,
  Folder,
  Hash,
  Presentation,
} from "lucide-solid";
import { t } from "../../../i18n";
import { FOLDER_MIME } from "./message-attachments";

export type AttachmentKind =
  | "folder"
  | "image"
  | "pdf"
  | "word"
  | "spreadsheet"
  | "presentation"
  | "markdown"
  | "text"
  | "code"
  | "archive"
  | "file";

const KIND_BY_EXTENSION: Record<string, AttachmentKind> = {
  pdf: "pdf",
  doc: "word",
  docx: "word",
  odt: "word",
  rtf: "word",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ods: "spreadsheet",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  ppt: "presentation",
  pptx: "presentation",
  odp: "presentation",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  log: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  "7z": "archive",
  rar: "archive",
  json: "code",
  js: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  py: "code",
  rs: "code",
  go: "code",
  java: "code",
  c: "code",
  cpp: "code",
  h: "code",
  cs: "code",
  html: "code",
  css: "code",
  xml: "code",
  yaml: "code",
  yml: "code",
  toml: "code",
  sh: "code",
  ps1: "code",
};

export const attachmentKind = (filename: string, mime = ""): AttachmentKind => {
  if (mime === FOLDER_MIME) return "folder";
  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return KIND_BY_EXTENSION[extension] ?? (mime.startsWith("image/") ? "image" : "file");
};

export const attachmentKindLabel = (kind: AttachmentKind) =>
  kind === "image"
    ? t("composer.attachment_image")
    : kind === "file"
      ? t("composer.attachment_file")
      : t(`composer.attachment_kind_${kind}`);

type IconComponent = (props: { size?: number; class?: string }) => JSX.Element;

export const ATTACHMENT_KIND_ICON: Record<AttachmentKind, IconComponent> = {
  folder: Folder,
  image: FileImage,
  pdf: FileType2,
  word: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  markdown: Hash,
  text: FileType,
  code: FileCode,
  archive: FileArchive,
  file: File,
};
