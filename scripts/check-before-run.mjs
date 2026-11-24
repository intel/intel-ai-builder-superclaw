#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const TSX = resolve(REPO_ROOT, "shared/contracts/node_modules/.bin/tsx.cmd");
const CHECK_SCRIPT = resolve(REPO_ROOT, "shared/contracts/scripts/check-product-profiles.mjs");

const check = spawnSync(TSX, [CHECK_SCRIPT], { stdio: "inherit", cwd: REPO_ROOT, shell: true });

if (check.status === 0) {
  const [, , ...args] = process.argv;
  if (args.length === 0) process.exit(0);
  const result = spawnSync(args[0], args.slice(1), { stdio: "inherit", cwd: REPO_ROOT, shell: true });
  process.exit(result.status ?? 0);
}

console.error("\n[product-profiles] Validation failed; command not started.\n");
process.exit(check.status ?? 1);
