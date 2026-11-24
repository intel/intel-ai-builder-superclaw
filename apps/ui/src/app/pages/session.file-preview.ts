import { createSignal } from "solid-js";
import { homeDir, join } from "@tauri-apps/api/path";
import { t } from "../../i18n";
import { uiLogError, uiLogInfo } from "../lib/log";
import { readWorkspaceFile, readWorkspaceFileBase64 } from "../lib/tauri";
import { OpenworkServerError } from "../lib/openwork-server";
import type { OpenworkServerClient } from "../lib/openwork-server";
import { base64ToBytes, base64ToUtf8, utf8ToBase64 } from "~/shared/util/base64-bytes";
import type { OptionalPackageInstallFailureCode } from "~/shared/platform/transport/servicehub";
import { classifyPreviewFailure } from "../lib/preview-failure";
import type { PreviewFailureKind } from "../lib/preview-failure";
import type { FilePreviewModalProps } from "../components/file-preview-modal";
import { isThisMachine, OfficeInstallError } from "../lib/office-preview-install";
import type { OfficeInstaller, OfficeInstallProgress, OfficeInstallState } from "../lib/office-preview-install";
import { classifyWorkspaceFilePreview } from "../lib/workspace-file-preview";
import type {
  WorkspaceFilePreviewKind,
  WorkspaceFilePreviewSource,
} from "../lib/workspace-file-preview";
import { isTauriRuntime } from "../utils";
import { buildReadCandidates } from "./session.artifact-paths";
import { imageMime, loadRelativeImages } from "./session.file-preview.images";
import type { LocalFileActionResult } from "./session.local-files";

/**
 * Everything the preview needs from the session page. Reactive values arrive as
 * thunks rather than plain values so the controller reads them in its caller's
 * tracking scope; the server readers stay behind because they close over the
 * remote file-sync session that session.tsx owns.
 */
type FilePreviewDeps = {
  workspaceType: () => string | undefined;
  activeWorkspaceRoot: () => string;
  serverClient: () => OpenworkServerClient | null | undefined;
  serverWorkspaceId: () => string | null | undefined;
  runLocalFileAction: (
    file: string,
    mode: "open" | "reveal" | "obsidian",
    action: (candidate: string) => Promise<void>,
  ) => Promise<LocalFileActionResult>;
  readFileViaServer: (file: string) => Promise<string | null>;
  readFileBase64ViaServer: (file: string) => Promise<string | null>;
  /**
   * Installs LibreOffice on this machine; null when there is no control plane to
   * ask. It stops polling once `isStale` is true, but the install carries on.
   */
  officeInstaller: () => OfficeInstaller | null;
};

type FilePreviewController = {
  open: () => boolean;
  title: () => string;
  content: () => string | null;
  contentType: () => WorkspaceFilePreviewKind;
  loading: () => boolean;
  error: () => string | null;
  /** Set while an Office file is waiting for LibreOffice to be installed. */
  install: () => OfficeInstallState | null;
  /** Show the full explanation again after "Not now". */
  offerInstall: () => void;
  declineInstall: () => void;
  /** Install LibreOffice, then reload the preview that needed it. */
  startInstall: () => Promise<void>;
  /** Load the preview again, once the user has installed LibreOffice themselves. */
  recheckPreview: () => Promise<void>;
  close: () => void;
  /** Everything `FilePreviewModal` needs, ready to spread onto it. */
  modalProps: () => FilePreviewModalProps;
  /** Preview an artifact/report path produced by the agent. */
  previewFile: (file: string) => Promise<void>;
  /** Preview a file picked in the workspace files panel. */
  previewWorkspaceFile: (
    itemId: string,
    fileName: string,
    source: WorkspaceFilePreviewSource,
  ) => Promise<void>;
};

/** Encode a candidate path as the base64url item id the project APIs expect. */
function toProjectItemId(candidate: string): string {
  return utf8ToBase64(candidate)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromProjectItemId(itemId: string): string {
  return base64ToUtf8(itemId.replace(/-/g, "+").replace(/_/g, "/"));
}

/** Reads host files as base64 through the reader that refuses paths outside `root`. */
const hostBase64Reader = (root: string) => async (path: string) => {
  const result = await readWorkspaceFileBase64(path, root);
  return result.ok ? result.content : null;
};

/**
 * Preview failures that an install still under way explains: the converter is
 * not there yet, or MSI has copied soffice.exe but not finished, so it starts
 * and fails.
 */
const INSTALL_CAN_CAUSE: ReadonlySet<PreviewFailureKind> = new Set([
  "package-required",
  "conversion-failed",
  "conversion-timeout",
]);

/**
 * Where a failed install leaves the panel. winget gone after the offer gets the same by-hand panel as
 * no winget at all; LibreOffice found in a folder the preview does not look in gets "reinstall it in
 * the default place", since another install cannot help.
 */
const STEP_AFTER_FAILURE: Record<OptionalPackageInstallFailureCode, "manual" | "installed_elsewhere" | "failed"> = {
  winget_unavailable: "manual",
  already_installed_elsewhere: "installed_elsewhere",
  install_failed: "failed",
};

export function createFilePreview(deps: FilePreviewDeps): FilePreviewController {
  const [open, setOpen] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal<string | null>(null);
  // Relative image links in the markdown being shown, mapped to data URIs.
  const [images, setImages] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [contentType, setContentType] =
    createSignal<WorkspaceFilePreviewKind>("markdown");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [install, setInstall] = createSignal<OfficeInstallState | null>(null);
  // Not now holds for as long as this controller lives: ask once, then only
  // show the message with an Install button.
  let installDeclined = false;
  // Reloads the preview that was refused for want of LibreOffice.
  let reloadPreview: (() => Promise<void>) | null = null;
  // Bumped whenever a preview opens or closes and whenever an install starts,
  // so a late failure or an install for a preview the user has since left
  // cannot change or reload what is on screen now.
  let installRun = 0;
  // Bumped whenever a preview starts loading, so an older load that finishes
  // late does not clear the spinner of the one now on screen. Separate from
  // `installRun`, which an install bumps while its load is still finishing.
  let loadRun = 0;
  // Set once a preview was reloaded because LibreOffice turned out to be installed after all.
  let reloadedForInstalled = false;

  const resetInstall = () => {
    installRun += 1;
    setInstall(null);
  };

  const close = () => {
    reloadedForInstalled = false;
    resetInstall();
    setOpen(false);
    setContent(null);
    setImages(new Map());
    setError(null);
  };

  /**
   * Shows `value`, first reading the images a markdown file links to beside
   * itself. `read` is the reader that loaded `file`, so the images stay inside
   * the same root it is bounded to. `run` is `installRun` from when the
   * preview started loading.
   */
  const showContent = async (
    value: string,
    file: string,
    read: (path: string) => Promise<string | null>,
    run: number,
  ) => {
    if (run !== installRun) return; // closed, or another file opened, while the file was read
    const readWhileShown = async (path: string) => (run === installRun ? read(path) : null);
    const loaded =
      contentType() === "markdown"
        ? await loadRelativeImages(value, file, readWhileShown)
        : new Map<string, string>();
    if (run !== installRun) return; // closed, or another file opened, while the images loaded
    setImages(loaded);
    setContent(value);
  };

  /**
   * Turns the failure into the modal's message, into the install offer, or,
   * while an install is already running, into that install's progress. `run`
   * is `installRun` from when the preview started loading.
   */
  const showPreviewFailure = async (err: unknown, run: number, reload: () => Promise<void>) => {
    const failure = classifyPreviewFailure(err);
    if (run !== installRun) return failure; // closed, or another file opened, while it loaded
    // The converter that is missing runs on the workspace's server. The
    // installer only reaches this machine, so it cannot fix another one.
    const local = isThisMachine(deps.serverClient()?.baseUrl);
    const installer = local ? deps.officeInstaller() : null;
    let canInstall = false;
    let unreachable = false;
    if (installer && INSTALL_CAN_CAUSE.has(failure.kind)) {
      const status = await installer.status();
      if (run !== installRun) return failure; // closed, or another file opened, while it asked
      if (status.unreachable) {
        unreachable = true;
      } else {
        if (status.operationId) {
          reloadPreview = reload;
          void runInstall(status.operationId);
          return failure;
        }
        // The install finished after the preview failed: load it again, once (if the server still
        // cannot see LibreOffice, a second try would only loop).
        if (status.installed && !reloadedForInstalled) {
          reloadedForInstalled = true;
          await reload();
          return failure;
        }
        canInstall = status.canInstall;
      }
    }
    let message = failure.message;
    if (failure.kind === "package-required") {
      if (!local) {
        message = t("session.office_preview_unavailable_remote");
      } else if (installer) {
        reloadPreview = reload;
        // Without winget there is nothing to offer: say how to install it by hand. Not asked: say so, and
        // let Try again ask again.
        setInstall({
          step: unreachable ? "unreachable" : !canInstall ? "manual" : installDeclined ? "declined" : "offer",
        });
      }
    }
    setError(message);
    return failure;
  };

  const offerInstall = () => setInstall({ step: "offer" });

  const declineInstall = () => {
    installDeclined = true;
    setInstall({ step: "declined" });
  };

  /** Starts an install, or follows the running one `operationId` names, then reloads the preview. */
  const runInstall = async (operationId?: string) => {
    const installer = deps.officeInstaller();
    const reload = reloadPreview;
    if (!installer || !reload) return;
    const run = ++installRun;
    setInstall({ step: "installing" });
    let shown: OfficeInstallProgress = {};
    const showProgress = (next: OfficeInstallProgress) => {
      if (run !== installRun || (next.phase === shown.phase && next.startedAt === shown.startedAt)) return;
      shown = next;
      setInstall({ step: "installing", ...next });
    };
    try {
      await installer.install(showProgress, () => run !== installRun, operationId);
    } catch (err) {
      if (run !== installRun) return;
      const code = err instanceof OfficeInstallError ? err.code : "install_failed";
      uiLogError("preview.office.install", "Office preview install failed", { code });
      setInstall({ step: STEP_AFTER_FAILURE[code] });
      return;
    }
    if (run !== installRun) return;
    uiLogInfo("preview.office.install", "Office preview installed; reloading the preview", {});
    await reload();
  };

  // Install and Try again: always a new install, never a run found earlier.
  const startInstall = () => runInstall();

  /** After the user installed LibreOffice by hand: load the preview again. */
  const recheckPreview = async () => {
    await reloadPreview?.();
  };

  const previewFile = async (file: string) => {
    const basename =
      file
        .replace(/[\\/]+/g, "/")
        .split("/")
        .pop() ?? file;
    const previewKind = classifyWorkspaceFilePreview(basename, "projects");
    if (!previewKind) return;
    const isPdfFile = previewKind === "pdf" && /\.pdf$/i.test(file);
    const isImageFile = previewKind === "image";
    const isOfficeFile = previewKind === "pdf" && !isPdfFile;
    const isRemoteWorkspace = deps.workspaceType() === "remote";
    resetInstall();
    const run = installRun;
    const load = ++loadRun;
    setTitle(basename);
    setImages(new Map());
    setContentType(previewKind);

    if (isImageFile) {
      const mime = imageMime(file, "image/png");
      let base64: string | null = null;

      if (!isRemoteWorkspace && isTauriRuntime()) {
        const root = deps.activeWorkspaceRoot().trim();
        if (root) {
          try {
            const result = await deps.runLocalFileAction(
              file,
              "open",
              async (candidate) => {
                const r = await readWorkspaceFileBase64(candidate, root);
                if (!r.ok) throw new Error(r.error ?? "Unable to read file");
                base64 = r.content;
              },
            );
            if (!result.ok && deps.serverClient()) {
              base64 = await deps.readFileBase64ViaServer(file);
            }
          } catch {
            base64 = null;
          }
        }
      } else if (deps.serverClient()) {
        base64 = await deps.readFileBase64ViaServer(file);
      }

      if (base64) {
        setContent(`data:${mime};base64,${base64}`);
        setError(null);
      } else {
        setError("Could not load image. The file may not be accessible.");
      }
      setLoading(false);
      setOpen(true);
      return;
    }
    setContent(null);
    setError(null);
    setLoading(true);
    setOpen(true);

    try {
      let fileContent: string | null = null;
      // Where the file was found and how to read beside it. The server read
      // does not say which candidate matched, so images search the same way.
      let foundAt = file;
      let readBeside = (path: string) => deps.readFileBase64ViaServer(path);

      if (isOfficeFile) {
        const client = deps.serverClient();
        const workspaceId = deps.serverWorkspaceId()?.trim() ?? "";
        if (!client || !workspaceId) {
          setError("Office preview requires a server connection.");
          setLoading(false);
          return;
        }

        for (const candidate of buildReadCandidates(
          file,
          deps.activeWorkspaceRoot(),
        )) {
          const itemId = toProjectItemId(candidate);
          try {
            const result = await client.readProjectPreviewPdf(
              workspaceId,
              itemId,
            );
            if (result.contentBase64) {
              fileContent = result.contentBase64;
              break;
            }
          } catch (err) {
            if (
              err instanceof OpenworkServerError &&
              err.code === "project_item_not_found"
            ) {
              continue;
            }
            throw err;
          }
        }

        if (!fileContent) {
          setError(
            "Could not read Office document. The file may not yet be accessible on the worker.",
          );
          setLoading(false);
          return;
        }
      } else if (isPdfFile) {
        // PDF is binary — always read as base64 via server
        fileContent = await deps.readFileBase64ViaServer(file);
        if (!fileContent) {
          setError(
            deps.serverClient()
              ? "Could not read PDF. The file may not yet be accessible on the worker."
              : "PDF preview requires a server connection.",
          );
          setLoading(false);
          return;
        }
      } else if (!isRemoteWorkspace && isTauriRuntime()) {
        // Local workspace: read file via Tauri command
        const result = await deps.runLocalFileAction(
          file,
          "open",
          async (candidate) => {
            const root = deps.activeWorkspaceRoot().trim();
            if (!root) throw new Error("Workspace root is unavailable");
            const readResult = await readWorkspaceFile(candidate, root);
            if (!readResult.ok) {
              throw new Error(readResult.error ?? "Unable to read file");
            }
            fileContent = readResult.content;
          },
        );
        if (result.ok) {
          foundAt = result.path;
          readBeside = hostBase64Reader(deps.activeWorkspaceRoot().trim());
        } else {
          // Fallback: try remote read if available
          if (deps.serverClient()) {
            fileContent = await deps.readFileViaServer(file);
          }
          if (!fileContent) {
            setError(
              result.reason === "missing-root"
                ? "Pick a worker to preview files."
                : typeof result.reason === "string"
                  ? result.reason
                  : "Unable to read file",
            );
            setLoading(false);
            return;
          }
        }
      } else if (deps.serverClient()) {
        // Remote workspace: read via server
        fileContent = await deps.readFileViaServer(file);
      } else {
        setError("File preview is unavailable in this mode.");
        setLoading(false);
        return;
      }

      if (fileContent !== null) {
        await showContent(fileContent, foundAt, readBeside, run);
      } else {
        setContent(null);
        setError(
          "Could not read file content. The file may not yet be accessible on the worker.",
        );
      }
    } catch (err) {
      // Classified by the server's structured error code, so a client-side
      // timeout is never reported as a fault in the document itself.
      await showPreviewFailure(err, run, () => previewFile(file));
    } finally {
      if (load === loadRun) setLoading(false);
    }
  };

  const previewWorkspaceFile = async (
    itemId: string,
    fileName: string,
    source: WorkspaceFilePreviewSource,
  ) => {
    const previewKind = classifyWorkspaceFilePreview(fileName, source);
    if (!previewKind) return;

    const isPdfFile = previewKind === "pdf";
    const isImageFile = previewKind === "image";
    const isOfficeFile = /\.(docx?|xlsx?|pptx?|od[tsp])$/i.test(fileName);
    const isSpreadsheetFile = previewKind === "spreadsheet";
    resetInstall();
    const run = installRun;
    const load = ++loadRun;
    setTitle(fileName);
    setImages(new Map());
    // Office documents are rendered to PDF on the backend (via headless
    // LibreOffice) and shown through the existing PDF viewer, preserving
    // images/layout instead of mojibake text.
    setContentType(previewKind);
    setContent(null);
    setError(null);
    setLoading(true);
    setOpen(true);
    // Paired with the server's office-preview.completed log so the two together
    // account for the whole observed latency.
    const previewStartedAt = performance.now();
    try {
      // Sensitive-folder files are tmpfs-shadowed to empty inside the sandbox,
      // so they're read directly off the Windows host via Tauri instead of the
      // openwork-server client used for everything else.
      if (source === "sensitive") {
        if (!isTauriRuntime()) {
          setError(
            "Sensitive files can only be previewed in the desktop app.",
          );
          return;
        }
        const sensitiveRoot = await join(
          await homeDir(),
          "SuperClawProjects",
          "sensitive",
        );
        const result = await readWorkspaceFileBase64(itemId, sensitiveRoot);
        if (!result.ok || !result.content) {
          setError(result.error ?? "No content returned.");
          return;
        }
        if (isSpreadsheetFile) {
          // Sandbox can't reach sensitive/, so the usual server-side
          // LibreOffice->PDF conversion is unavailable here; parse the workbook
          // directly in the UI instead and render it as a plain table.
          setContentType("spreadsheet");
          try {
            const ExcelJS = await import("exceljs");
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(
              base64ToBytes(result.content).buffer as ArrayBuffer,
            );
            const sheet = workbook.worksheets[0];
            if (!sheet) {
              setError("Workbook has no sheets.");
              return;
            }
            const rows: string[][] = [];
            sheet.eachRow((row) => {
              const cells: string[] = [];
              row.eachCell({ includeEmpty: true }, (cell) => {
                cells.push(cell.text ?? "");
              });
              rows.push(cells);
            });
            setContent(JSON.stringify(rows));
          } catch {
            setError("Unable to parse spreadsheet content.");
          }
          return;
        }
        if (isPdfFile) {
          setContent(result.content);
        } else if (isImageFile) {
          setContent(
            `data:${imageMime(fileName, "image/jpeg")};base64,${result.content}`,
          );
        } else {
          try {
            await showContent(base64ToUtf8(result.content), itemId, hostBase64Reader(sensitiveRoot), run);
          } catch {
            setError("Unable to decode file content.");
          }
        }
        return;
      }
      // Mask registries are tmpfs-shadowed to empty inside the sandbox too, so
      // they're read off the host the same way.
      if (source === "mask_registries") {
        if (!isTauriRuntime()) {
          setError(
            "Mask registries can only be previewed in the desktop app.",
          );
          return;
        }
        const maskRegistriesRoot = await join(
          await homeDir(),
          "SuperClawProjects",
          "data_protection_workspace",
          "mask_registries",
        );
        const result = await readWorkspaceFileBase64(
          itemId,
          maskRegistriesRoot,
        );
        if (!result.ok || !result.content) {
          setError(result.error ?? "No content returned.");
          return;
        }
        try {
          setContent(base64ToUtf8(result.content));
        } catch {
          setError("Unable to decode file content.");
        }
        return;
      }
      const client = deps.serverClient();
      const wid = deps.serverWorkspaceId() ?? "";
      if (!client || !wid) {
        setError("Server connection unavailable.");
        return;
      }
      if (isOfficeFile) {
        const result =
          source === "inbox"
            ? await client.readInboxPreviewPdf(wid, itemId)
            : await client.readProjectPreviewPdf(wid, itemId);
        uiLogInfo("preview.office.fetch", "Fetched office PDF preview", {
          fileName,
          source,
          base64Bytes: result.contentBase64?.length ?? 0,
          requestMs: Math.round(performance.now() - previewStartedAt),
        });
        if (!result.contentBase64) {
          setError("No content returned.");
          return;
        }
        setContent(result.contentBase64);
        return;
      }
      const result =
        source === "inbox"
          ? await client.readInboxContent(wid, itemId)
          : await client.readProjectContent(wid, itemId);
      if (!result.contentBase64) {
        setError("No content returned.");
        return;
      }
      if (isPdfFile) {
        setContent(result.contentBase64);
      } else if (isImageFile) {
        setContent(
          `data:${imageMime(fileName, "image/jpeg")};base64,${result.contentBase64}`,
        );
      } else {
        try {
          await showContent(base64ToUtf8(result.contentBase64), fromProjectItemId(itemId), async (path) => {
            const image =
              source === "inbox"
                ? await client.readInboxContent(wid, toProjectItemId(path))
                : await client.readProjectContent(wid, toProjectItemId(path));
            return image.contentBase64 || null;
          }, run);
        } catch {
          setError("Unable to decode file content.");
        }
      }
    } catch (err) {
      // Classified by the server's structured error code so a client-side
      // timeout is never surfaced as a problem with the document. Logged with
      // elapsed time so a slow preview can be split between server wait and
      // webview work.
      const failure = await showPreviewFailure(err, run, () =>
        previewWorkspaceFile(itemId, fileName, source),
      );
      uiLogError("preview.failed", "File preview failed", {
        fileName,
        source,
        kind: failure.kind,
        indeterminate: failure.indeterminate,
        elapsedMs: Math.round(performance.now() - previewStartedAt),
      });
    } finally {
      if (load === loadRun) setLoading(false);
    }
  };

  return {
    open,
    title,
    content,
    contentType,
    loading,
    error,
    install,
    offerInstall,
    declineInstall,
    startInstall,
    recheckPreview,
    close,
    modalProps: () => ({
      open: open(),
      title: title(),
      content: content(),
      images: images(),
      contentType: contentType(),
      loading: loading(),
      error: error(),
      install: install(),
      onInstallOffer: offerInstall,
      onInstall: () => void startInstall(),
      onInstallRecheck: () => void recheckPreview(),
      onInstallDecline: declineInstall,
      onClose: close,
    }),
    previewFile,
    previewWorkspaceFile,
  };
}
