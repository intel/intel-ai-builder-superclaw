/**
 * Multi-call entry for the merged sandbox runtime binary: one embedded Bun runtime serving the
 * orchestrator, openwork-server, and opencode-router roles instead of three ~95 MB copies of it.
 *
 * Role comes from `basename(process.execPath)` first, so a hardlink named `openwork-server` or
 * `opencode-router` is a drop-in replacement for the standalone binary with argv untouched. This
 * requires a hardlink: a symlink resolves to the link target and loses the invoked name. The first
 * positional argument is accepted as a fallback for callers that cannot install links.
 */
import { basename } from "node:path";

const DELEGATED_ROLES = ["openwork-server", "opencode-router"] as const;
type DelegatedRole = (typeof DELEGATED_ROLES)[number];

const asRole = (value: string | undefined): DelegatedRole | null =>
  DELEGATED_ROLES.find((role) => role === value) ?? null;

let role = asRole(basename(process.execPath).replace(/\.exe$/i, ""));
if (!role) {
  role = asRole(process.argv[2]);
  if (role) process.argv.splice(2, 1);
}

if (role === "openwork-server") {
  await import("openwork-server/src/cli.js");
} else if (role === "opencode-router") {
  await import("opencode-router/src/cli.js");
} else {
  await import("./cli.js");
}
