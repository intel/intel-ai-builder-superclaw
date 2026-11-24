import { DEFAULT_DEN_BASE_URL } from "~/shared/platform/transport/den";
import { normalizeOpenworkServerUrl } from "~/shared/platform/transport/openwork-server";

export type SharedBundleImportIntent = "new_worker" | "import_current";

export type SharedBundleDeepLink = {
  bundleUrl: string;
  intent: SharedBundleImportIntent;
  source?: string;
  orgId?: string;
  label?: string;
};

export type RemoteWorkspaceDefaults = {
  openworkHostUrl: string;
  openworkToken: string;
  directory: string | null;
  displayName: string | null;
};

export type DenAuthDeepLink = {
  grant: string;
  denBaseUrl: string;
};

export function normalizeSharedBundleImportIntent(
  value: string | null | undefined,
): SharedBundleImportIntent {
  const normalized = (value ?? "").trim().toLowerCase();
  if (
    normalized === "new_worker" ||
    normalized === "new-worker" ||
    normalized === "newworker"
  ) {
    return "new_worker";
  }
  return "import_current";
}

export function parseSharedBundleDeepLink(
  rawUrl: string,
): SharedBundleDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (
    protocol !== "openwork:" &&
    protocol !== "openwork-dev:" &&
    protocol !== "https:" &&
    protocol !== "http:"
  ) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  const looksLikeImportRoute =
    routeHost === "import-bundle" ||
    routePath === "import-bundle" ||
    routeTail === "import-bundle";

  const rawBundleUrl =
    url.searchParams.get("ow_bundle") ??
    url.searchParams.get("bundleUrl") ??
    "";

  if (!looksLikeImportRoute && !rawBundleUrl.trim()) {
    return null;
  }

  try {
    if (
      (protocol === "https:" || protocol === "http:") &&
      !rawBundleUrl.trim()
    ) {
      const host = url.hostname.toLowerCase();
      const path = url.pathname.replace(/^\/+/, "");
      const segments = path.split("/").filter(Boolean);
      if (
        (host === "share.openwork.software" ||
          host.endsWith(".openwork.software")) &&
        segments[0] === "b" &&
        segments[1]
      ) {
        const intent = normalizeSharedBundleImportIntent(
          url.searchParams.get("ow_intent") ?? url.searchParams.get("intent"),
        );
        const source =
          url.searchParams.get("ow_source")?.trim() ??
          url.searchParams.get("source")?.trim() ??
          "";
        const orgId = url.searchParams.get("ow_org")?.trim() ?? "";
        const label =
          url.searchParams.get("ow_label")?.trim() ??
          url.searchParams.get("label")?.trim() ??
          "";
        return {
          bundleUrl: url.toString(),
          intent,
          source: source || undefined,
          orgId: orgId || undefined,
          label: label || undefined,
        };
      }
    }

    const parsedBundleUrl = new URL(rawBundleUrl.trim());
    if (
      parsedBundleUrl.protocol !== "https:" &&
      parsedBundleUrl.protocol !== "http:"
    ) {
      return null;
    }

    const intent = normalizeSharedBundleImportIntent(
      url.searchParams.get("ow_intent") ?? url.searchParams.get("intent"),
    );
    const source =
      url.searchParams.get("ow_source")?.trim() ??
      url.searchParams.get("source")?.trim() ??
      "";
    const orgId = url.searchParams.get("ow_org")?.trim() ?? "";
    const label = url.searchParams.get("ow_label")?.trim() ?? "";
    return {
      bundleUrl: parsedBundleUrl.toString(),
      intent,
      source: source || undefined,
      orgId: orgId || undefined,
      label: label || undefined,
    };
  } catch {
    return null;
  }
}

export function parseRemoteConnectDeepLink(
  rawUrl: string,
): RemoteWorkspaceDefaults | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (
    protocol !== "openwork:" &&
    protocol !== "openwork-dev:" &&
    protocol !== "https:" &&
    protocol !== "http:"
  ) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (
    routeHost !== "connect-remote" &&
    routePath !== "connect-remote" &&
    routeTail !== "connect-remote"
  ) {
    return null;
  }

  const hostUrlRaw =
    url.searchParams.get("openworkHostUrl") ??
    url.searchParams.get("openworkUrl") ??
    "";
  const tokenRaw =
    url.searchParams.get("openworkToken") ??
    url.searchParams.get("accessToken") ??
    "";
  const normalizedHostUrl = normalizeOpenworkServerUrl(hostUrlRaw);
  const token = tokenRaw.trim();
  if (!normalizedHostUrl || !token) {
    return null;
  }

  const workerName = url.searchParams.get("workerName")?.trim() ?? "";
  const workerId = url.searchParams.get("workerId")?.trim() ?? "";
  const displayName =
    workerName || (workerId ? `Worker ${workerId.slice(0, 8)}` : "");

  return {
    openworkHostUrl: normalizedHostUrl,
    openworkToken: token,
    directory: null,
    displayName: displayName || null,
  };
}

export function parseDenAuthDeepLink(rawUrl: string): DenAuthDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (
    protocol !== "openwork:" &&
    protocol !== "openwork-dev:" &&
    protocol !== "https:" &&
    protocol !== "http:"
  ) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (
    routeHost !== "den-auth" &&
    routePath !== "den-auth" &&
    routeTail !== "den-auth"
  ) {
    return null;
  }

  const grant = url.searchParams.get("grant")?.trim() ?? "";
  const denBaseUrl =
    normalizeOpenworkServerUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ??
    DEFAULT_DEN_BASE_URL;
  if (!grant) {
    return null;
  }

  return { grant, denBaseUrl };
}

export function stripSharedBundleQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of [
    "ow_bundle",
    "bundleUrl",
    "ow_intent",
    "intent",
    "ow_source",
    "source",
    "ow_org",
    "ow_label",
  ]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export function stripRemoteConnectQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of [
    "openworkHostUrl",
    "openworkUrl",
    "openworkToken",
    "accessToken",
    "workerId",
    "workerName",
    "source",
  ]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}
