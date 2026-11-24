import fs from "node:fs";
import path from "node:path";

// The opencode engine's file endpoints, as the router's MCP gate uses them
// (src/mcp-tool-gate.ts engineWorkspaceFiles), with the semantics measured on
// opencode 1.18.25: GET /file lists a directory (500 when it does not exist),
// including gitignored entries, flagged `ignored: true`; GET /file/content
// answers a missing file with 200 and empty text, and a directory or
// unreadable path with 500. Returns null for any other request.
// Ignore matching here is by root-relative path/prefix from the root
// .gitignore only, which is all the channel tests need.
function ignoredPatterns(root) {
  try {
    return fs
      .readFileSync(path.join(root, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, "").replace(/\/$/, ""))
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

export function engineFileApi(request, url) {
  if (request.method !== "GET" || (url.pathname !== "/file" && url.pathname !== "/file/content")) return null;
  const directory = url.searchParams.get("directory") ?? request.headers.get("x-opencode-directory");
  if (!directory) return Response.json({ name: "BadRequest" }, { status: 400 });
  const root = directory;
  const target = path.join(root, url.searchParams.get("path") ?? "");
  const failure = () => Response.json({ name: "UnknownError" }, { status: 500 });

  if (url.pathname === "/file") {
    let entries;
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return failure();
    }
    const patterns = ignoredPatterns(root);
    return Response.json(
      entries.map((entry) => {
        const relative = path.relative(root, path.join(target, entry.name)).split(path.sep).join("/");
        return {
          name: entry.name,
          path: path.relative(root, path.join(target, entry.name)),
          absolute: path.join(target, entry.name),
          type: entry.isDirectory() ? "directory" : "file",
          ignored: patterns.some((pattern) => relative === pattern || relative.startsWith(`${pattern}/`)),
        };
      }),
    );
  }

  if (!fs.existsSync(target)) return Response.json({ type: "text", content: "" });
  try {
    return Response.json({ type: "text", content: fs.readFileSync(target, "utf8") });
  } catch {
    return failure();
  }
}
