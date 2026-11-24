// Parser + version-selection for the XML upgrade manifest.
//
// The manifest (SuperClawManifest.xml, an asset of the latest GitHub Release) lists one
// <UpgradePackage> per release:
//
//   <UpgradePackages>
//     <UpgradePackage Platform="x64" Version="1.0.1" Date="..." ForceUpdate="no">
//       <InstallURL><Link Language="en">https://github.com/<owner>/<name>/releases/download/v1.0.1/SuperClaw-Setup-1.0.1.exe</Link></InstallURL>
//       <InstallParameters />
//       <ReleaseNotes><![CDATA[ ... ]]></ReleaseNotes>
//       <ReleaseNotesURL />
//       <Homepage>https://github.com/<owner>/<name>/releases/tag/v1.0.1</Homepage>
//     </UpgradePackage>
//     ...
//   </UpgradePackages>
//
// Records are newest-first in practice, but selection is by highest semver, not
// document order. The raw XML is fetched by the Rust `check_app_update` command.

export type UpgradePackage = {
  platform: string;
  version: string;
  date: string | null;
  forceUpdate: boolean;
  installUrl: string | null;
  installParameters: string | null;
  releaseNotes: string | null;
  releaseNotesUrl: string | null;
  homepage: string | null;
};

export type AvailableUpdate = {
  version: string;
  installUrl: string | null;
  /** The manifest named an installer URL that is not trusted, so the offer is download-page only. */
  installUrlRefused: boolean;
  installParameters: string | null;
  releaseNotes: string | null;
  releaseNotesUrl: string | null;
  /** Where the user can download the update by hand; null when the source has no Releases page. */
  homepage: string | null;
  forceUpdate: boolean;
};

export type UpdateUrlOptions = {
  /** `owner/name` whose Releases the update comes from (`check_app_update`); null for a loopback test server. */
  releasesRepo?: string | null;
  /** Debug and OTA test-channel builds only: also accept `http://localhost` / `http://127.0.0.1`. */
  allowLocalhost?: boolean;
};

const GITHUB_HOST = "github.com";

const DOTTED_VERSION = /^\d+(?:\.\d+){0,3}$/;

const LOCAL_UPDATE_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** The page offered when a record names no trusted <Homepage>. */
export function releasesPageUrl(releasesRepo: string): string {
  return `https://${GITHUB_HOST}/${releasesRepo}/releases/latest`;
}

/** HTTPS on github.com, under `pathPrefix` (case-insensitive, as GitHub names are) when one is given. */
function isGitHubUrl(url: URL, pathPrefix: string | null): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === GITHUB_HOST &&
    url.port === "" &&
    (pathPrefix === null || url.pathname.toLowerCase().startsWith(pathPrefix.toLowerCase()))
  );
}

function isAllowedLoopbackUrl(url: URL, options: UpdateUrlOptions): boolean {
  return (
    options.allowLocalhost === true &&
    url.protocol === "http:" &&
    LOCAL_UPDATE_HOSTS.has(url.hostname.toLowerCase())
  );
}

/**
 * Manifest <InstallURL> must be HTTPS under `https://github.com/<releasesRepo>/releases/`, or a
 * loopback URL when `allowLocalhost`. The shell applies the same rule before downloading.
 * Returns null if missing or untrusted (no download).
 */
export function normalizeInstallUrl(
  value: string | null | undefined,
  options: UpdateUrlOptions = {},
): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const repo = options.releasesRepo;
    const trusted =
      (repo ? isGitHubUrl(url, `/${repo}/releases/`) : false) || isAllowedLoopbackUrl(url, options);
    if (!trusted) return null;
    const path = url.pathname.toLowerCase();
    if (!path.endsWith(".exe")) return null;
    return url.toString();
  } catch {
    return null;
  }
}
/** Pass through manifest text; Rust accepts it only as an allowlisted msiexec UI level and logs a refusal. */
export function normalizeInstallParameters(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Restrict manifest-driven external navigation to HTTPS github.com: under `/<releasesRepo>/` when
 * a repository is given, or a loopback URL when `allowLocalhost`. Returns null if untrusted.
 */
export function normalizeUpdateExternalUrl(
  value: string | null | undefined,
  options: UpdateUrlOptions = {},
): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const repo = options.releasesRepo;
    const trusted = isGitHubUrl(url, repo ? `/${repo}/` : null) || isAllowedLoopbackUrl(url, options);
    return trusted ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Parse a dotted version into numeric parts; null if it doesn't look like one. */
function parseVersionParts(value: string): number[] | null {
  const trimmed = value.trim();
  if (!DOTTED_VERSION.test(trimmed)) return null;
  return trimmed.split(".").map((part) => Number(part));
}

/** Compare two dotted versions. Returns >0 if a>b, <0 if a<b, 0 if equal/uncomparable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function textOf(parent: Element, tag: string): string | null {
  const el = parent.getElementsByTagName(tag)[0];
  if (!el) return null;
  const text = el.textContent;
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
}

function installUrlOf(pkg: Element): string | null {
  const links = Array.from(pkg.getElementsByTagName("Link"));
  if (!links.length) return null;
  // Prefer the English link; fall back to the first one.
  const en = links.find((link) => link.getAttribute("Language")?.toLowerCase() === "en");
  const chosen = en ?? links[0];
  const text = chosen.textContent?.trim();
  return text && text.length ? text : null;
}

/** Parse the raw manifest XML into typed records. Returns [] on parse failure. */
export function parseUpgradeManifest(xml: string): UpgradePackage[] {
  if (typeof DOMParser === "undefined") return [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return [];
  }
  // A parse error yields a <parsererror> element instead of <UpgradePackages>.
  if (doc.getElementsByTagName("parsererror").length) return [];

  return Array.from(doc.getElementsByTagName("UpgradePackage")).map((pkg) => ({
    platform: pkg.getAttribute("Platform")?.trim() ?? "",
    version: pkg.getAttribute("Version")?.trim() ?? "",
    date: pkg.getAttribute("Date")?.trim() || null,
    forceUpdate: (pkg.getAttribute("ForceUpdate")?.trim().toLowerCase() ?? "no") === "yes",
    installUrl: installUrlOf(pkg),
    installParameters: textOf(pkg, "InstallParameters"),
    releaseNotes: textOf(pkg, "ReleaseNotes"),
    releaseNotesUrl: textOf(pkg, "ReleaseNotesURL"),
    homepage: textOf(pkg, "Homepage"),
  }));
}

/**
 * Pure version-selection: given parsed records and the running version, return
 * the highest applicable update, or null if up to date / no applicable record.
 *
 * @param platform target platform attribute to match (default "x64").
 */
export function selectUpdateFromPackages(
  packages: UpgradePackage[],
  currentVersion: string,
  platform = "x64",
  options: UpdateUrlOptions = {},
): AvailableUpdate | null {
  const applicable = packages.filter(
    (pkg) =>
      pkg.platform.toLowerCase() === platform.toLowerCase() &&
      parseVersionParts(pkg.version) !== null,
  );
  if (!applicable.length) return null;

  const newest = applicable.reduce((best, pkg) =>
    compareVersions(pkg.version, best.version) > 0 ? pkg : best,
  );

  if (compareVersions(newest.version, currentVersion) <= 0) return null;

  const installUrl = normalizeInstallUrl(newest.installUrl, options);
  return {
    version: newest.version,
    releaseNotes: newest.releaseNotes,
    releaseNotesUrl: newest.releaseNotesUrl,
    homepage:
      normalizeUpdateExternalUrl(newest.homepage, options) ??
      (options.releasesRepo ? releasesPageUrl(options.releasesRepo) : null),
    forceUpdate: newest.forceUpdate,
    installUrl,
    installUrlRefused: installUrl === null && Boolean(newest.installUrl?.trim()),
    installParameters: normalizeInstallParameters(newest.installParameters),
  };
}

/**
 * Given the raw manifest XML and the running app version, return the highest
 * applicable update, or null if the app is up to date / nothing parseable.
 */
export function selectAvailableUpdate(
  xml: string,
  currentVersion: string,
  options: UpdateUrlOptions = {},
): AvailableUpdate | null {
  return selectUpdateFromPackages(parseUpgradeManifest(xml), currentVersion, "x64", options);
}
