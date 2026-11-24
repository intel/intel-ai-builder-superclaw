/**
 * Pure parsers behind the Add MCP form: classify what the user typed, split a command
 * line into argv and suggest a server name. Nothing here throws.
 */

export type McpInputMode = "remote" | "stdio";

export type KeyValueRow = { key: string; value: string };

const URL_PATTERN = /^https?:\/\//i;
// `localhost:3000/mcp`, `127.0.0.1:8080`, `[::1]:9000`, `mcp.example.com:443/sse`: a host and port
// with no scheme. A dotless name other than localhost is not matched, so `python:3` stays a command.
const SCHEMELESS_HOST_PORT =
  /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|[a-z0-9-]+(\.[a-z0-9-]+)+):\d{1,5}([/?#]\S*)?$/i;

export function detectMode(input: string): McpInputMode {
  const trimmed = input.trim();
  return URL_PATTERN.test(trimmed) || SCHEMELESS_HOST_PORT.test(trimmed) ? "remote" : "stdio";
}

/** The URL to save for a Remote URL input: a scheme-less host:port gets `http://`. */
export function toServerUrl(input: string): string {
  const trimmed = input.trim();
  return SCHEMELESS_HOST_PORT.test(trimmed) ? `http://${trimmed}` : trimmed;
}

/**
 * Splits a command line on whitespace, honouring single and double quotes. A backslash
 * only escapes a quote character, so unquoted or quoted Windows paths keep their
 * backslashes. An unterminated quote runs to the end of the line.
 */
export function splitCommand(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\\" && (next === '"' || next === "'")) {
      current += next;
      hasToken = true;
      index += 1;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) args.push(current);
      current = "";
      hasToken = false;
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (hasToken) args.push(current);
  return args;
}

/**
 * Inverse of `splitCommand`: quotes only the arguments that need it. Trailing backslashes
 * go after the closing quote, since `splitCommand` would read `\"` as an escaped quote.
 */
export function joinCommand(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg && !/[\s"']/.test(arg)) return arg;
      const escaped = arg.replace(/["']/g, "\\$&");
      const body = escaped.replace(/\\+$/, "");
      return `"${body}"${escaped.slice(body.length)}`;
    })
    .join(" ");
}

export function rowsToRecord(rows: readonly KeyValueRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) record[key] = row.value;
  }
  return record;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const HOST_PREFIXES = new Set(["www", "mcp", "api"]);
const RUNNERS = new Set([
  "npx", "pnpx", "bunx", "uvx", "pipx", "uv", "bun", "deno", "node", "python", "python3", "py",
]);
const RUNNER_SUBCOMMANDS = new Set(["run", "x", "exec", "dlx"]);
const VALUE_FLAGS = new Set(["--with", "--from", "-p", "--package"]);
const ENTRY_FILE_NAMES = new Set(["index", "main", "server", "cli"]);
const GENERIC_PACKAGE_NAMES = new Set(["mcp", "server", "mcp-server"]);
const FALLBACK_NAME = "mcp-server";

function toName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function nameFromUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return toName(`localhost-${url.port}`);

  const labels = host.split(".");
  if (labels.length > 1) labels.pop();
  while (labels.length > 1 && HOST_PREFIXES.has(labels[0])) labels.shift();
  return toName(labels.join("-"));
}

function nameFromPackage(token: string): string {
  const pathParts = token.split(/[\\/]/).filter(Boolean);
  if (/[\\/]/.test(token) && !token.startsWith("@")) {
    const file = (pathParts.pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
    const parent = pathParts.pop() ?? "";
    return toName(ENTRY_FILE_NAMES.has(file.toLowerCase()) && parent ? parent : file);
  }

  const scope = token.startsWith("@") ? (pathParts[0] ?? "").slice(1) : "";
  const bare = (token.startsWith("@") ? pathParts.slice(1).join("-") : token)
    .replace(/(@|==|>=|<=|~=|<|>).*$/, "");
  const name = toName(bare);
  if (GENERIC_PACKAGE_NAMES.has(name)) return toName(scope);
  return name
    .replace(/^(mcp-server-|server-|mcp-)/, "")
    .replace(/(-mcp-server|-server|-mcp)$/, "");
}

function nameFromCommand(args: readonly string[]): string {
  let index = 0;
  if (RUNNERS.has((args[0] ?? "").toLowerCase())) {
    index = 1;
    if (RUNNER_SUBCOMMANDS.has((args[1] ?? "").toLowerCase())) index = 2;
  }
  for (; index < args.length; index += 1) {
    const token = args[index];
    if (VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return nameFromPackage(token);
  }
  return "";
}

/** A stable lowercase server name derived from a URL host or a command's package. */
export function suggestName(input: string): string {
  const trimmed = input.trim();
  const name = detectMode(trimmed) === "remote"
    ? nameFromUrl(toServerUrl(trimmed))
    : nameFromCommand(splitCommand(trimmed));
  return name || FALLBACK_NAME;
}
