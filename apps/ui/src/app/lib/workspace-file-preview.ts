export type WorkspaceFilePreviewSource =
  | "inbox"
  | "projects"
  | "sensitive"
  | "mask_registries";

export type WorkspaceFilePreviewKind =
  | "markdown"
  | "html"
  | "pdf"
  | "image"
  | "text"
  | "spreadsheet";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const OFFICE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".odt",
  ".xls",
  ".xlsx",
  ".ods",
  ".ppt",
  ".pptx",
  ".odp",
]);
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".sql",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".java",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
  ".cs",
  ".fs",
  ".fsx",
  ".vue",
  ".svelte",
  ".r",
  ".lua",
  ".pl",
  ".pm",
  ".jsonc",
  ".rst",
  ".tex",
  ".diff",
  ".patch",
  ".proto",
  ".graphql",
  ".gql",
  ".gradle",
  ".tf",
  ".dart",
  ".scala",
  ".ipynb",
]);
const TEXT_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "gemfile",
  "rakefile",
  "readme",
  "license",
  "procfile",
  "changelog",
  ".editorconfig",
  ".env",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".prettierrc",
]);

function normalizeFileName(fileName: string): string {
  return fileName.trim().toLowerCase();
}

function extensionOf(fileName: string): string {
  const normalized = normalizeFileName(fileName);
  const index = normalized.lastIndexOf(".");
  return index > 0 ? normalized.slice(index) : "";
}

function isTextPreviewFile(fileName: string): boolean {
  const normalized = normalizeFileName(fileName);
  return (
    TEXT_EXTENSIONS.has(extensionOf(normalized)) ||
    TEXT_FILENAMES.has(normalized) ||
    normalized.startsWith("dockerfile.") ||
    normalized.startsWith(".env.")
  );
}

/**
 * Returns the renderer that can display a workspace file without treating
 * arbitrary binary bytes as UTF-8 text. Source-specific branches reflect the
 * available read paths in the session page.
 */
export function classifyWorkspaceFilePreview(
  fileName: string,
  source: WorkspaceFilePreviewSource,
): WorkspaceFilePreviewKind | null {
  const extension = extensionOf(fileName);

  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (extension === ".pdf" && source !== "mask_registries") return "pdf";
  if (IMAGE_EXTENSIONS.has(extension) && source !== "mask_registries") return "image";

  if (source === "sensitive") {
    return extension === ".xlsx" ? "spreadsheet" : isTextPreviewFile(fileName) ? "text" : null;
  }

  if (source !== "mask_registries" && OFFICE_EXTENSIONS.has(extension)) return "pdf";

  return isTextPreviewFile(fileName) ? "text" : null;
}

export function isWorkspaceFilePreviewable(
  fileName: string,
  source: WorkspaceFilePreviewSource,
): boolean {
  return classifyWorkspaceFilePreview(fileName, source) !== null;
}