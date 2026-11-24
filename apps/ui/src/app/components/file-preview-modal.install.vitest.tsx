/**
 * The LibreOffice install offer inside the preview modal: one panel that
 * explains, shows progress, and reports the outcome. Needs a DOM, so it runs in
 * the vitest lane.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

import { t } from "../../i18n";
import { OpenworkServerError } from "../lib/openwork-server";
import type { OpenworkServerClient } from "../lib/openwork-server";
import { createFilePreview } from "../pages/session.file-preview";
import type { OfficeInstallState } from "../lib/office-preview-install";
import { PlatformProvider, type Platform } from "../context/platform";
import FilePreviewModal from "./file-preview-modal";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderModal(install: OfficeInstallState, error: string | null = t("session.office_preview_unavailable")) {
  const openLink = vi.fn();
  const onInstall = vi.fn();
  const onInstallOffer = vi.fn();
  const onInstallRecheck = vi.fn();
  const onInstallDecline = vi.fn();
  render(() => (
    <PlatformProvider value={{ platform: "desktop", openLink } as unknown as Platform}>
      <FilePreviewModal
        open
        title="q3.docx"
        content={null}
        error={error}
        install={install}
        onInstall={onInstall}
        onInstallOffer={onInstallOffer}
        onInstallRecheck={onInstallRecheck}
        onInstallDecline={onInstallDecline}
        onClose={() => undefined}
      />
    </PlatformProvider>
  ));
  return { openLink, onInstall, onInstallOffer, onInstallRecheck, onInstallDecline };
}

describe("FilePreviewModal install offer", () => {
  test("says that winget installs it, shows the license, and has Install with winget and Not now", () => {
    const { onInstall, onInstallDecline, openLink } = renderModal({ step: "offer" });
    const panel = screen.getByTestId("office-install-panel").textContent ?? "";
    expect(panel).toContain("winget");
    expect(panel).toContain("administrator permission");
    expect(panel).toContain("MPL-2.0");
    expect(screen.getByTestId("office-install-confirm").textContent).toBe(t("session.office_preview_install_confirm"));

    fireEvent.click(screen.getByTestId("office-install-license-link"));
    expect(openLink).toHaveBeenCalledWith("https://www.libreoffice.org/licenses/");

    fireEvent.click(screen.getByTestId("office-install-decline"));
    expect(onInstallDecline).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("office-install-confirm"));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  test("without winget it says how to install by hand, with the download link and Try again", () => {
    const { onInstall, onInstallRecheck, openLink } = renderModal({ step: "manual" });
    expect(screen.getByTestId("office-install-panel").textContent).toContain(
      t("session.office_preview_install_manual"),
    );
    expect(screen.queryByTestId("office-install-confirm")).toBeNull();

    fireEvent.click(screen.getByTestId("office-install-download-link"));
    expect(openLink).toHaveBeenCalledWith("https://www.libreoffice.org/download/");

    fireEvent.click(screen.getByTestId("office-install-recheck"));
    expect(onInstallRecheck).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });

  test("when the services cannot be reached it says so, not that winget is missing, and has only Try again", () => {
    const { onInstall, onInstallRecheck } = renderModal({ step: "unreachable" });
    const panel = screen.getByTestId("office-install-panel").textContent ?? "";
    expect(panel).toContain(t("session.office_preview_install_unreachable"));
    expect(panel).not.toContain("winget");
    expect(screen.queryByTestId("office-install-confirm")).toBeNull();
    expect(screen.queryByTestId("office-install-download-link")).toBeNull();

    fireEvent.click(screen.getByTestId("office-install-recheck"));
    expect(onInstallRecheck).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });

  test("LibreOffice installed in another folder: says to reinstall it in the default place, Try again only reloads", () => {
    const { onInstall, onInstallRecheck } = renderModal({ step: "installed_elsewhere" });
    expect(screen.getByTestId("office-install-panel").textContent).toContain(
      t("session.office_preview_install_elsewhere"),
    );
    expect(screen.queryByTestId("office-install-retry")).toBeNull();

    fireEvent.click(screen.getByTestId("office-install-recheck"));
    expect(onInstallRecheck).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });

  test("after Not now shows the not-installed message with an Install button", () => {
    const { onInstallOffer } = renderModal({ step: "declined" });
    expect(screen.getByTestId("office-install-panel").textContent).toContain(
      t("session.office_preview_unavailable"),
    );
    fireEvent.click(screen.getByTestId("office-install-offer"));
    expect(onInstallOffer).toHaveBeenCalledTimes(1);
  });

  test("while installing it says what winget is doing, and the install prompt hint comes with the install", () => {
    const phases = [
      [undefined, "session.office_preview_install_starting"],
      ["downloading", "session.office_preview_install_downloading"],
      ["installing", "session.office_preview_install_installing"],
    ] as const;
    for (const [phase, key] of phases) {
      renderModal({ step: "installing", phase });
      expect(screen.getByTestId("office-install-progress").textContent).toBe(t(key));
      cleanup();
    }
    expect(t("session.office_preview_install_installing")).toContain("permission prompt");
    expect(t("session.office_preview_install_installing")).toContain("taskbar");
  });

  test("while installing it counts the time elapsed, so a long wait still shows it is alive", () => {
    vi.useFakeTimers();
    renderModal({ step: "installing" });
    const elapsed = () => screen.getByTestId("office-install-elapsed").textContent;
    expect(elapsed()).toBe(`${t("session.office_preview_install_elapsed")} 0:00`);

    vi.advanceTimersByTime(65_000);
    expect(elapsed()).toBe(`${t("session.office_preview_install_elapsed")} 1:05`);
  });

  test("counts from when the install began, so a preview opened halfway through does not start from zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T23:03:00Z"));
    renderModal({ step: "installing", startedAt: Date.parse("2026-10-26T23:01:06Z") });

    vi.advanceTimersByTime(1_000);

    expect(screen.getByTestId("office-install-elapsed").textContent).toBe(
      `${t("session.office_preview_install_elapsed")} 1:55`,
    );
  });

  test("following an install that is already running shows the install and nothing else", () => {
    renderModal({ step: "installing" }, null);
    expect(screen.getByTestId("office-install-progress")).toBeTruthy();
    expect(screen.queryByText("No content available.")).toBeNull();
  });

  test("a failed install gives the reason, a link to download LibreOffice, and Try again", () => {
    const { onInstall, openLink } = renderModal({ step: "failed" });
    expect(screen.getByTestId("office-install-panel").textContent).toContain(
      t("session.office_preview_install_failed"),
    );
    fireEvent.click(screen.getByTestId("office-install-download-link"));
    expect(openLink).toHaveBeenCalledWith("https://www.libreoffice.org/download/");
    fireEvent.click(screen.getByTestId("office-install-retry"));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });
});

describe("FilePreviewModal driven by the preview controller", () => {
  test("goes from the offer to Not now to the installing panel without a second dialog", async () => {
    let finishInstall: () => void = () => undefined;
    const readProjectPreviewPdf = vi.fn(async () => {
      throw new OpenworkServerError(409, "office_preview_not_installed", "LibreOffice is not installed");
    });
    const preview = createFilePreview({
      workspaceType: () => "local",
      activeWorkspaceRoot: () => "",
      serverClient: () => ({ readProjectPreviewPdf }) as unknown as OpenworkServerClient,
      serverWorkspaceId: () => "ws-1",
      runLocalFileAction: async () => ({ ok: false, reason: "missing-root" }),
      readFileViaServer: async () => null,
      readFileBase64ViaServer: async () => null,
      officeInstaller: () => ({
        install: () =>
          new Promise<void>((resolve) => {
            finishInstall = resolve;
          }),
        status: async () => ({ operationId: null, canInstall: true }),
      }),
    });
    render(() => (
      <PlatformProvider value={{ platform: "desktop", openLink: vi.fn() } as unknown as Platform}>
        <FilePreviewModal {...preview.modalProps()} />
      </PlatformProvider>
    ));

    await preview.previewFile("q3.docx");
    expect(screen.getByTestId("office-install-confirm")).toBeTruthy();

    fireEvent.click(screen.getByTestId("office-install-decline"));
    expect(screen.getByTestId("office-install-offer")).toBeTruthy();

    fireEvent.click(screen.getByTestId("office-install-offer"));
    fireEvent.click(screen.getByTestId("office-install-confirm"));
    expect(screen.getByTestId("office-install-progress").textContent).toBe(
      t("session.office_preview_install_starting"),
    );
    finishInstall();
  });

  test("without winget the panel is the by-hand one, and Try again loads the preview again", async () => {
    const readProjectPreviewPdf = vi.fn(async () => {
      throw new OpenworkServerError(409, "office_preview_not_installed", "LibreOffice is not installed");
    });
    const preview = createFilePreview({
      workspaceType: () => "local",
      activeWorkspaceRoot: () => "",
      serverClient: () => ({ readProjectPreviewPdf }) as unknown as OpenworkServerClient,
      serverWorkspaceId: () => "ws-1",
      runLocalFileAction: async () => ({ ok: false, reason: "missing-root" }),
      readFileViaServer: async () => null,
      readFileBase64ViaServer: async () => null,
      officeInstaller: () => ({
        install: async () => undefined,
        status: async () => ({ operationId: null, canInstall: false }),
      }),
    });
    render(() => (
      <PlatformProvider value={{ platform: "desktop", openLink: vi.fn() } as unknown as Platform}>
        <FilePreviewModal {...preview.modalProps()} />
      </PlatformProvider>
    ));

    await preview.previewFile("q3.docx");
    expect(screen.queryByTestId("office-install-confirm")).toBeNull();
    expect(readProjectPreviewPdf).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("office-install-recheck"));
    await vi.waitFor(() => expect(readProjectPreviewPdf).toHaveBeenCalledTimes(2));
  });
});
