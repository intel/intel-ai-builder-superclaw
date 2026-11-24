import { marked } from "marked";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const extensionOf = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";

/**
 * Every caller passes a name whose extension is a key above: the previews reach
 * it through `classifyWorkspaceFilePreview`, whose IMAGE_EXTENSIONS match these
 * keys, and `loadRelativeImages` only through `isRelativeImageLink`. So
 * `fallback` is defensive rather than reachable.
 */
export function imageMime(fileName: string, fallback: string): string {
  return IMAGE_MIME_BY_EXTENSION[extensionOf(fileName)] ?? fallback;
}

/** The link's path part, without a query or fragment, percent-decoded. */
function linkPath(href: string): string {
  const path = href.split(/[?#]/)[0] ?? "";
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A link with no scheme and no leading slash, to a file type the image preview shows. */
function isRelativeImageLink(href: string): boolean {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || /^[\\/#]/.test(href)) return false;
  return extensionOf(linkPath(href)) in IMAGE_MIME_BY_EXTENSION;
}

/** Each relative image link in `markdown`, once, as the renderer will see its `href`. */
function relativeImageLinks(markdown: string): string[] {
  const hrefs = new Set<string>();
  marked.walkTokens(marked.lexer(markdown, { gfm: true, breaks: true }), (token) => {
    if (token.type === "image" && isRelativeImageLink(token.href)) hrefs.add(token.href);
  });
  return [...hrefs];
}

/**
 * Resolves `href` against the folder that holds `file`, keeping `file`'s style
 * (relative, `/workspace/...` or `C:/...`). Null when the link climbs above the
 * top of that path: no reader would serve it.
 */
function resolveImagePath(file: string, href: string): string | null {
  const folder = file.replace(/\\/g, "/").split("/");
  folder.pop();
  const floor = folder[0] === "" || folder[0]?.endsWith(":") ? 1 : 0;
  const parts = folder.slice(0, floor);
  const link = linkPath(href).replace(/\\/g, "/").split("/").filter((segment) => segment !== "");
  for (const segment of [...folder.slice(floor), ...link]) {
    if (segment === ".") continue;
    if (segment !== "..") {
      parts.push(segment);
    } else if (parts.length > floor) {
      parts.pop();
    } else {
      return null;
    }
  }
  return parts.join("/");
}

/**
 * The base64 one preview keeps, about 12 MB of images. Each image is held again
 * as a data URI, in the rendered HTML and in the DOM, and the readers have no
 * size limit of their own.
 */
export const MAX_IMAGE_BASE64_CHARS = 16 * 1024 * 1024;
/** Reads stop once this much has come back, kept or not, so links to oversized files cannot keep a preview reading. */
export const MAX_READ_BASE64_CHARS = 2 * MAX_IMAGE_BASE64_CHARS;
/** Failed reads return no bytes, so only a count bounds how long broken links keep the text waiting. */
export const MAX_IMAGE_LINKS = 64;
const PARALLEL_READS = 4;

/**
 * Reads the relative images `markdown` links to, through `read` (which returns
 * base64, or null), and maps each link to a data URI. A link that cannot be
 * resolved or read, or that no longer fits in MAX_IMAGE_BASE64_CHARS, is left
 * out, so the renderer shows its alt text. The budget goes to images in the
 * order the document shows them, and links after the first MAX_IMAGE_LINKS
 * are not read.
 */
export async function loadRelativeImages(
  markdown: string,
  file: string,
  read: (path: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const readOne = async (path: string | null) => {
    if (!path) return null;
    try {
      return await read(path);
    } catch {
      return null;
    }
  };
  const links = relativeImageLinks(markdown).slice(0, MAX_IMAGE_LINKS);
  const loaded = new Map<string, string>();
  let budget = MAX_IMAGE_BASE64_CHARS;
  let readTotal = 0;
  for (
    let start = 0;
    start < links.length && budget > 0 && readTotal < MAX_READ_BASE64_CHARS;
    start += PARALLEL_READS
  ) {
    const batch = links.slice(start, start + PARALLEL_READS).map((href) => ({ href, path: resolveImagePath(file, href) }));
    const results = await Promise.all(batch.map(({ path }) => readOne(path)));
    batch.forEach(({ href, path }, i) => {
      const base64 = results[i];
      readTotal += base64?.length ?? 0;
      if (!path || !base64 || base64.length > budget) return;
      budget -= base64.length;
      loaded.set(href, `data:${imageMime(path, "image/png")};base64,${base64}`);
    });
  }
  return loaded;
}
