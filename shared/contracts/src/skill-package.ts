export const SKILL_PACKAGE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const SKILL_PACKAGE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const SKILL_PACKAGE_MAX_FILES = 10_000;
export const SKILL_PACKAGE_CHUNK_BYTES = 4 * 1024 * 1024;

const SKILL_PACKAGE_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown", ".txt", ".text",
  ".py", ".sh", ".bash", ".zsh", ".ps1",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties",
  ".csv", ".tsv", ".xml", ".html", ".htm", ".css", ".scss",
  ".sql", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".r", ".lua", ".pl", ".php", ".swift", ".gitignore", ".example", ".lock", ".gradle", ".dockerfile",
  ".db", ".sqlite", ".sqlite3", ".duckdb", ".mdb", ".accdb",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".docx", ".xlsx", ".pptx",
  ".bin", ".dat", ".parquet", ".arrow", ".npy", ".npz",
  ".zip", ".gz", ".tar",
  ".ttf", ".otf", ".woff", ".woff2", ".wav", ".mp3",
]);

const SKILL_PACKAGE_FILENAMES = new Set(["license", "notice", "makefile", "dockerfile"]);
const SKILL_PACKAGE_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  ".ruff_cache",
  ".pytest_cache",
  ".mypy_cache",
]);

export type SkillPackageFilterReason = "unsupported_type" | "ignored_directory";

export function isSupportedSkillPackageFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  const filename = normalized.split("/").pop() ?? "";
  if (SKILL_PACKAGE_FILENAMES.has(filename)) return true;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return false;
  return SKILL_PACKAGE_EXTENSIONS.has(filename.slice(dot));
}

export function skillPackageIgnoredDirectory(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.find((part) => SKILL_PACKAGE_IGNORED_DIRECTORIES.has(part.toLowerCase())) ?? null;
}

export type SkillPackageManifestFile = {
  id: string;
  path: string;
  size: number;
};

export type SkillPackageFilteredFile = {
  path: string;
  reason: SkillPackageFilterReason;
};

export type SkillPackageImportLimits = {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  chunkBytes: number;
};

export const SKILL_PACKAGE_IMPORT_LIMITS: SkillPackageImportLimits = {
  maxFileBytes: SKILL_PACKAGE_MAX_FILE_BYTES,
  maxTotalBytes: SKILL_PACKAGE_MAX_TOTAL_BYTES,
  maxFiles: SKILL_PACKAGE_MAX_FILES,
  chunkBytes: SKILL_PACKAGE_CHUNK_BYTES,
};