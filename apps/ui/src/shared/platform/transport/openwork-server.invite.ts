import { normalizeOpenworkServerUrl } from "./openwork-server.url";

export const DEFAULT_OPENWORK_CONNECT_APP_URL = "https://app.openwork.software";

const OPENWORK_INVITE_PARAM_URL = "ow_url";

const OPENWORK_INVITE_PARAM_TOKEN = "ow_token";

const OPENWORK_INVITE_PARAM_STARTUP = "ow_startup";

const OPENWORK_INVITE_PARAM_BUNDLE = "ow_bundle";

const OPENWORK_INVITE_PARAM_BUNDLE_INTENT = "ow_intent";

const OPENWORK_INVITE_PARAM_BUNDLE_SOURCE = "ow_source";

const OPENWORK_INVITE_PARAM_BUNDLE_ORG = "ow_org";

const OPENWORK_INVITE_PARAM_BUNDLE_LABEL = "ow_label";

export type OpenworkConnectInvite = {
  url: string;
  token?: string;
  startup?: "server";
};

export type OpenworkBundleInviteIntent = "new_worker" | "import_current";

export type OpenworkBundleInvite = {
  bundleUrl: string;
  intent: OpenworkBundleInviteIntent;
  source?: string;
  orgId?: string;
  label?: string;
};

function normalizeOpenworkBundleInviteIntent(value: string | null | undefined): OpenworkBundleInviteIntent {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "new_worker" || normalized === "new-worker" || normalized === "newworker") {
    return "new_worker";
  }
  return "import_current";
}

export function buildOpenworkConnectInviteUrl(input: {
  workspaceUrl: string;
  token?: string | null;
  appUrl?: string | null;
  startup?: "server";
}) {
  const workspaceUrl = normalizeOpenworkServerUrl(input.workspaceUrl ?? "") ?? "";
  if (!workspaceUrl) return "";

  const base = normalizeOpenworkServerUrl(input.appUrl ?? "") ?? DEFAULT_OPENWORK_CONNECT_APP_URL;

  try {
    const url = new URL(base);
    const search = new URLSearchParams(url.search);
    search.set(OPENWORK_INVITE_PARAM_URL, workspaceUrl);

    const token = input.token?.trim() ?? "";
    if (token) {
      search.set(OPENWORK_INVITE_PARAM_TOKEN, token);
    }

    const startup = input.startup ?? "server";
    search.set(OPENWORK_INVITE_PARAM_STARTUP, startup);

    url.search = search.toString();
    return url.toString();
  } catch {
    const search = new URLSearchParams();
    search.set(OPENWORK_INVITE_PARAM_URL, workspaceUrl);
    const token = input.token?.trim() ?? "";
    if (token) {
      search.set(OPENWORK_INVITE_PARAM_TOKEN, token);
    }
    search.set(OPENWORK_INVITE_PARAM_STARTUP, input.startup ?? "server");
    return `${DEFAULT_OPENWORK_CONNECT_APP_URL}?${search.toString()}`;
  }
}

export function readOpenworkConnectInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawUrl = search.get(OPENWORK_INVITE_PARAM_URL)?.trim() ?? "";
  const url = normalizeOpenworkServerUrl(rawUrl);
  if (!url) return null;

  const token = search.get(OPENWORK_INVITE_PARAM_TOKEN)?.trim() ?? "";
  const startupRaw = search.get(OPENWORK_INVITE_PARAM_STARTUP)?.trim() ?? "";
  const startup = startupRaw === "server" ? "server" : undefined;

  return {
    url,
    token: token || undefined,
    startup,
  } satisfies OpenworkConnectInvite;
}

export function buildOpenworkBundleInviteUrl(input: {
  bundleUrl: string;
  appUrl?: string | null;
  intent?: OpenworkBundleInviteIntent;
  source?: string | null;
  orgId?: string | null;
  label?: string | null;
}) {
  const rawBundleUrl = input.bundleUrl?.trim() ?? "";
  if (!rawBundleUrl) return "";

  let bundleUrl: string;
  try {
    bundleUrl = new URL(rawBundleUrl).toString();
  } catch {
    return "";
  }

  const base = normalizeOpenworkServerUrl(input.appUrl ?? "") ?? DEFAULT_OPENWORK_CONNECT_APP_URL;

  try {
    const url = new URL(base);
    const search = new URLSearchParams(url.search);
    const intent = normalizeOpenworkBundleInviteIntent(input.intent);
    search.set(OPENWORK_INVITE_PARAM_BUNDLE, bundleUrl);
    search.set(OPENWORK_INVITE_PARAM_BUNDLE_INTENT, intent);

    const source = input.source?.trim() ?? "";
    if (source) {
      search.set(OPENWORK_INVITE_PARAM_BUNDLE_SOURCE, source);
    }

    const orgId = input.orgId?.trim() ?? "";
    if (orgId) {
      search.set(OPENWORK_INVITE_PARAM_BUNDLE_ORG, orgId);
    }

    const label = input.label?.trim() ?? "";
    if (label) {
      search.set(OPENWORK_INVITE_PARAM_BUNDLE_LABEL, label);
    }

    url.search = search.toString();
    return url.toString();
  } catch {
    const search = new URLSearchParams();
    const intent = normalizeOpenworkBundleInviteIntent(input.intent);
    search.set(OPENWORK_INVITE_PARAM_BUNDLE, bundleUrl);
    search.set(OPENWORK_INVITE_PARAM_BUNDLE_INTENT, intent);

    const source = input.source?.trim() ?? "";
    if (source) {
      search.set(OPENWORK_INVITE_PARAM_BUNDLE_SOURCE, source);
    }

    const orgId = input.orgId?.trim() ?? "";
    if (orgId) {
      search.set(OPENWORK_INVITE_PARAM_BUNDLE_ORG, orgId);
    }

    const label = input.label?.trim() ?? "";
    if (label) {
      search.set(OPENWORK_INVITE_PARAM_BUNDLE_LABEL, label);
    }

    return `${DEFAULT_OPENWORK_CONNECT_APP_URL}?${search.toString()}`;
  }
}

export function readOpenworkBundleInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawBundleUrl = search.get(OPENWORK_INVITE_PARAM_BUNDLE)?.trim() ?? "";
  if (!rawBundleUrl) return null;

  let bundleUrl: string;
  try {
    const parsed = new URL(rawBundleUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    bundleUrl = parsed.toString();
  } catch {
    return null;
  }

  const intent = normalizeOpenworkBundleInviteIntent(search.get(OPENWORK_INVITE_PARAM_BUNDLE_INTENT));
  const source = search.get(OPENWORK_INVITE_PARAM_BUNDLE_SOURCE)?.trim() ?? "";
  const orgId = search.get(OPENWORK_INVITE_PARAM_BUNDLE_ORG)?.trim() ?? "";
  const label = search.get(OPENWORK_INVITE_PARAM_BUNDLE_LABEL)?.trim() ?? "";

  return {
    bundleUrl,
    intent,
    source: source || undefined,
    orgId: orgId || undefined,
    label: label || undefined,
  } satisfies OpenworkBundleInvite;
}

export function stripOpenworkConnectInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_URL);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_TOKEN);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_STARTUP);
    return url.toString();
  } catch {
    return input;
  }
}

export function stripOpenworkBundleInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_BUNDLE);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_BUNDLE_INTENT);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_BUNDLE_SOURCE);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_BUNDLE_ORG);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_BUNDLE_LABEL);
    return url.toString();
  } catch {
    return input;
  }
}
