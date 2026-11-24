// Not `bun test`: these paths need a DOM (`window.__TAURI_INTERNALS__` is what
// `isTauriRuntime()` reads, and the item-id encoder uses `btoa`) plus a module
// mock for the Tauri file readers, neither of which the bun lane provides.
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRoot } from "solid-js";
import { t } from "../../i18n";
import { classifyPreviewFailure } from "../lib/preview-failure";
import { OpenworkServerError } from "../lib/openwork-server";
import { OfficeInstallError } from "../lib/office-preview-install";
import type { OfficeInstaller } from "../lib/office-preview-install";
import type { OpenworkServerClient } from "../lib/openwork-server";
import { createFilePreview } from "./session.file-preview";

const tauriFs = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(),
  readWorkspaceFileBase64: vi.fn(),
}));

// Spread the original so the rest of the module (imported transitively by the
// server and hub clients) keeps working; only the two readers are replaced.
vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  readWorkspaceFile: tauriFs.readWorkspaceFile,
  readWorkspaceFileBase64: tauriFs.readWorkspaceFileBase64,
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "C:/Users/me",
  join: async (...parts: string[]) => parts.join("/"),
}));

type Deps = Parameters<typeof createFilePreview>[0];
type LocalFileAction = Deps["runLocalFileAction"];

const makeDeps = (over: Partial<Deps> = {}): Deps => ({
  workspaceType: () => "local",
  activeWorkspaceRoot: () => "",
  serverClient: () => null,
  serverWorkspaceId: () => null,
  runLocalFileAction: async () => ({ ok: false, reason: "missing-root" }),
  readFileViaServer: async () => null,
  readFileBase64ViaServer: async () => null,
  officeInstaller: () => null,
  ...over,
});

const serverStub = (over: Partial<OpenworkServerClient> = {}) =>
  over as unknown as OpenworkServerClient;

/** Stands in for the real helper: runs the action against a single candidate. */
const localActionSucceeds =
  (path = "resolved/path"): LocalFileAction =>
  async (_file, _mode, action) => {
    await action(path);
    return { ok: true, path };
  };

const localActionFails =
  (reason: string): LocalFileAction =>
  async () => ({ ok: false, reason });

const withTauri = (present: boolean) => {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (present) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
};

/** Reverses `toProjectItemId` so a test can assert which path was requested. */
const decodeItemId = (itemId: string): string => {
  const b64 = itemId.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return new TextDecoder().decode(
    Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0)),
  );
};

/** The shape every read endpoint on the server client returns. */
const fileResponse = (contentBase64: string, path = "file") => ({
  ok: true,
  path,
  contentBase64,
});

const utf8Base64 = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)));

const notInstalled = () =>
  new OpenworkServerError(
    409,
    "office_preview_not_installed",
    "LibreOffice is not installed",
  );

const notFound = () =>
  new OpenworkServerError(404, "project_item_not_found", "no such item");

afterEach(() => {
  withTauri(false);
  tauriFs.readWorkspaceFile.mockReset();
  tauriFs.readWorkspaceFileBase64.mockReset();
});

const run = (deps: Deps, body: (p: ReturnType<typeof createFilePreview>) => Promise<void>) =>
  createRoot(async (dispose) => {
    await body(createFilePreview(deps));
    dispose();
  });

describe("previewFile classification", () => {
  test("ignores a file type that has no preview", async () => {
    await run(makeDeps(), async (preview) => {
      await preview.previewFile("notes/scan.bmp");
      expect(preview.open()).toBe(false);
      expect(preview.title()).toBe("");
    });
  });

  test("names the modal after the basename, not the whole path", async () => {
    await run(
      makeDeps({
        serverClient: () => serverStub(),
        readFileViaServer: async () => "# hi",
      }),
      async (preview) => {
        await preview.previewFile("deep\\nested/report.md");
        expect(preview.title()).toBe("report.md");
        expect(preview.contentType()).toBe("markdown");
      },
    );
  });
});

describe("previewFile images", () => {
  test("uses the mime for the file's own extension", async () => {
    for (const [file, mime] of [
      ["shot.png", "image/png"],
      ["shot.jpg", "image/jpeg"],
      ["shot.svg", "image/svg+xml"],
    ] as const) {
      await run(
        makeDeps({
          serverClient: () => serverStub(),
          readFileBase64ViaServer: async () => "QUJD",
        }),
        async (preview) => {
          await preview.previewFile(file);
          expect(preview.content()).toBe(`data:${mime};base64,QUJD`);
          expect(preview.error()).toBeNull();
          expect(preview.open()).toBe(true);
          expect(preview.loading()).toBe(false);
        },
      );
    }
  });

  test("reports an image it cannot reach", async () => {
    await run(makeDeps(), async (preview) => {
      await preview.previewFile("shot.png");
      expect(preview.content()).toBeNull();
      expect(preview.error()).toMatch(/Could not load image/);
      expect(preview.open()).toBe(true);
    });
  });

  test("reads the image off the host when the desktop runtime is present", async () => {
    withTauri(true);
    tauriFs.readWorkspaceFileBase64.mockResolvedValue({
      ok: true,
      content: "TE9DQUw=",
    });

    await run(
      makeDeps({
        activeWorkspaceRoot: () => "C:/ws",
        runLocalFileAction: localActionSucceeds("shot.png"),
      }),
      async (preview) => {
        await preview.previewFile("shot.png");
        expect(tauriFs.readWorkspaceFileBase64).toHaveBeenCalledWith(
          "shot.png",
          "C:/ws",
        );
        expect(preview.content()).toBe("data:image/png;base64,TE9DQUw=");
      },
    );
  });

  test("falls back to the server when the host read fails", async () => {
    withTauri(true);

    await run(
      makeDeps({
        activeWorkspaceRoot: () => "C:/ws",
        runLocalFileAction: localActionFails("not-found"),
        serverClient: () => serverStub(),
        readFileBase64ViaServer: async () => "UkVNT1RF",
      }),
      async (preview) => {
        await preview.previewFile("shot.png");
        expect(preview.content()).toBe("data:image/png;base64,UkVNT1RF");
      },
    );
  });
});

describe("previewFile text and pdf", () => {
  test("reads through the server outside the desktop runtime", async () => {
    await run(
      makeDeps({
        serverClient: () => serverStub(),
        readFileViaServer: async () => "hello",
      }),
      async (preview) => {
        await preview.previewFile("notes.md");
        expect(preview.content()).toBe("hello");
        expect(preview.error()).toBeNull();
        expect(preview.loading()).toBe(false);
      },
    );
  });

  test("says preview is unavailable with neither a host nor a server", async () => {
    await run(makeDeps(), async (preview) => {
      await preview.previewFile("notes.md");
      expect(preview.error()).toBe("File preview is unavailable in this mode.");
      expect(preview.loading()).toBe(false);
    });
  });

  test("distinguishes a missing pdf from a missing server", async () => {
    await run(makeDeps(), async (preview) => {
      await preview.previewFile("paper.pdf");
      expect(preview.error()).toBe("PDF preview requires a server connection.");
    });

    await run(
      makeDeps({ serverClient: () => serverStub() }),
      async (preview) => {
        await preview.previewFile("paper.pdf");
        expect(preview.error()).toMatch(/Could not read PDF/);
      },
    );
  });

  test("falls back to the server when the host read fails", async () => {
    withTauri(true);

    await run(
      makeDeps({
        activeWorkspaceRoot: () => "C:/ws",
        runLocalFileAction: localActionFails("not-found"),
        serverClient: () => serverStub(),
        readFileViaServer: async () => "from server",
      }),
      async (preview) => {
        await preview.previewFile("notes.md");
        expect(preview.content()).toBe("from server");
        expect(preview.error()).toBeNull();
      },
    );
  });

  test("asks for a worker when the host read failed for want of a root", async () => {
    withTauri(true);

    await run(
      makeDeps({
        activeWorkspaceRoot: () => "C:/ws",
        runLocalFileAction: localActionFails("missing-root"),
      }),
      async (preview) => {
        await preview.previewFile("notes.md");
        expect(preview.error()).toBe("Pick a worker to preview files.");
      },
    );
  });

  test("surfaces any other host failure reason as given", async () => {
    withTauri(true);

    await run(
      makeDeps({
        activeWorkspaceRoot: () => "C:/ws",
        runLocalFileAction: localActionFails("permission denied"),
      }),
      async (preview) => {
        await preview.previewFile("notes.md");
        expect(preview.error()).toBe("permission denied");
      },
    );
  });
});

describe("previewFile office documents", () => {
  test("requires a server connection", async () => {
    await run(makeDeps(), async (preview) => {
      await preview.previewFile("q3.docx");
      expect(preview.error()).toBe(
        "Office preview requires a server connection.",
      );
      expect(preview.loading()).toBe(false);
    });
  });

  test("walks the read candidates past not-found until one has the document", async () => {
    const asked: string[] = [];
    const readProjectPreviewPdf = vi.fn(
      async (_workspaceId: string, itemId: string) => {
        asked.push(decodeItemId(itemId));
        if (asked.length < 3) throw notFound();
        return fileResponse("UERG");
      },
    );

    await run(
      makeDeps({
        serverClient: () => serverStub({ readProjectPreviewPdf }),
        serverWorkspaceId: () => "ws-1",
      }),
      async (preview) => {
        await preview.previewFile("reports/q3.docx");
        expect(asked).toEqual([
          "reports/q3.docx",
          ".opencode/openwork/outbox/reports/q3.docx",
          "workspace/reports/q3.docx",
        ]);
        expect(preview.content()).toBe("UERG");
        expect(preview.error()).toBeNull();
      },
    );
  });

  test("errors when no candidate holds the document", async () => {
    await run(
      makeDeps({
        serverClient: () =>
          serverStub({
            readProjectPreviewPdf: vi.fn(async () => {
              throw notFound();
            }),
          }),
        serverWorkspaceId: () => "ws-1",
      }),
      async (preview) => {
        await preview.previewFile("reports/q3.docx");
        expect(preview.error()).toMatch(/Could not read Office document/);
        expect(preview.loading()).toBe(false);
      },
    );
  });

  test("stops on an error that is not a missing item", async () => {
    const readProjectPreviewPdf = vi.fn(async () => {
      throw new OpenworkServerError(500, "internal", "boom");
    });

    await run(
      makeDeps({
        serverClient: () => serverStub({ readProjectPreviewPdf }),
        serverWorkspaceId: () => "ws-1",
      }),
      async (preview) => {
        await preview.previewFile("reports/q3.docx");
        expect(readProjectPreviewPdf).toHaveBeenCalledTimes(1);
        expect(preview.error()).toBe(
          classifyPreviewFailure(new OpenworkServerError(500, "internal", "boom"))
            .message,
        );
      },
    );
  });
});

describe("office preview without a converter", () => {
  let preview: ReturnType<typeof createFilePreview>;

  /** A server that has no converter until `installed` flips. */
  const converter = () => {
    const state = { installed: false };
    const readProjectPreviewPdf = vi.fn(async () => {
      if (!state.installed) throw notInstalled();
      return fileResponse("UERG");
    });
    return { state, readProjectPreviewPdf };
  };

  const canInstall: OfficeInstaller["status"] = async () => ({ operationId: null, canInstall: true });

  const withInstaller = (
    server: ReturnType<typeof converter>,
    install: OfficeInstaller["install"] | null,
    status: OfficeInstaller["status"] = canInstall,
  ) =>
    makeDeps({
      serverClient: () =>
        serverStub({ readProjectPreviewPdf: server.readProjectPreviewPdf }),
      serverWorkspaceId: () => "ws-1",
      officeInstaller: () => (install ? { install, status } : null),
    });

  test("only reports the converter as unavailable when there is nothing to install it with", async () => {
    const server = converter();
    await run(withInstaller(server, null), async (preview) => {
      await preview.previewFile("q3.docx");

      expect(server.readProjectPreviewPdf).toHaveBeenCalledTimes(1);
      expect(preview.error()).toBe(t("session.office_preview_unavailable"));
      expect(preview.install()).toBeNull();
      expect(preview.loading()).toBe(false);
    });
  });

  test("does not offer the install when the preview server is on another machine", async () => {
    const server = converter();
    const installer = vi.fn(async () => {});
    await run(
      {
        ...withInstaller(server, installer),
        serverClient: () =>
          serverStub({
            baseUrl: "http://10.0.0.5:8787",
            readProjectPreviewPdf: server.readProjectPreviewPdf,
          }),
      },
      async (preview) => {
        await preview.previewFile("q3.docx");

        expect(preview.install()).toBeNull();
        expect(preview.error()).toBe(t("session.office_preview_unavailable_remote"));
        expect(installer).not.toHaveBeenCalled();
      },
    );
  });

  test("offers the install instead of installing on its own", async () => {
    const server = converter();
    const installer = vi.fn(async () => {});
    await run(withInstaller(server, installer), async (preview) => {
      await preview.previewFile("q3.docx");

      expect(preview.install()).toEqual({ step: "offer" });
      expect(installer).not.toHaveBeenCalled();
    });
  });

  test("without winget it says how to install by hand, and Try again loads the preview once it is installed", async () => {
    const server = converter();
    const installer = vi.fn(async () => {});
    await run(
      withInstaller(server, installer, async () => ({ operationId: null, canInstall: false })),
      async (preview) => {
        await preview.previewFile("q3.docx");

        expect(preview.install()).toEqual({ step: "manual" });
        expect(installer).not.toHaveBeenCalled();

        await preview.recheckPreview();
        expect(preview.install()).toEqual({ step: "manual" }); // still not installed

        server.state.installed = true;
        await preview.recheckPreview();
        expect(preview.install()).toBeNull();
        expect(preview.content()).toBe("UERG");
        expect(installer).not.toHaveBeenCalled();
      },
    );
  });

  test("when the sandbox manager cannot be asked it does not claim winget is missing, and Try again asks again", async () => {
    const server = converter();
    const installer = vi.fn(async () => {});
    let answering = false;
    const status = vi.fn<OfficeInstaller["status"]>(async () =>
      answering ? { operationId: null, canInstall: true } : { unreachable: true },
    );
    await run(withInstaller(server, installer, status), async (preview) => {
      await preview.previewFile("q3.docx");

      expect(preview.install()).toEqual({ step: "unreachable" });
      expect(installer).not.toHaveBeenCalled();

      await preview.recheckPreview();
      expect(status).toHaveBeenCalledTimes(2);
      expect(preview.install()).toEqual({ step: "unreachable" }); // still not answering

      answering = true;
      await preview.recheckPreview();
      expect(preview.install()).toEqual({ step: "offer" });
    });
  });

  test("loads the preview again when the install finished after it failed, instead of offering one", async () => {
    const server = converter();
    const installer = vi.fn(async () => {});
    const status = vi.fn<OfficeInstaller["status"]>(async () => {
      server.state.installed = true; // the install ended between the failed preview and this question
      return { operationId: null, canInstall: false, installed: true };
    });
    await run(withInstaller(server, installer, status), async (preview) => {
      await preview.previewFile("q3.docx");

      expect(preview.install()).toBeNull();
      expect(preview.content()).toBe("UERG");
      expect(preview.loading()).toBe(false);
      expect(server.readProjectPreviewPdf).toHaveBeenCalledTimes(2);
      expect(installer).not.toHaveBeenCalled();
    });
  });

  test("reloads for an install that finished only once, so a server that still cannot see LibreOffice does not loop", async () => {
    const server = converter(); // never becomes installed
    const status = vi.fn<OfficeInstaller["status"]>(async () => ({ operationId: null, canInstall: false, installed: true }));
    await run(withInstaller(server, async () => {}, status), async (preview) => {
      await preview.previewFile("q3.docx");

      expect(server.readProjectPreviewPdf).toHaveBeenCalledTimes(2);
      expect(status).toHaveBeenCalledTimes(2);
      expect(preview.install()).toEqual({ step: "manual" });
      expect(preview.loading()).toBe(false);
    });
  });

  test("installs after the confirm, shows the install, then reloads the preview", async () => {
    const server = converter();
    const seen: unknown[] = [];
    await run(
      withInstaller(server, async () => {
        seen.push(preview.install());
        server.state.installed = true;
      }),
      async (p) => {
        preview = p;
        await preview.previewFile("reports/q3.docx");
        await preview.startInstall();

        expect(seen).toEqual([{ step: "installing" }]);
        expect(preview.install()).toBeNull();
        expect(preview.error()).toBeNull();
        expect(preview.content()).toBe("UERG");
        expect(server.readProjectPreviewPdf).toHaveBeenCalledTimes(2);
      },
    );
  });

  test("shows the phase winget is in and when the install began, and only when they change", async () => {
    const server = converter();
    const seen: unknown[] = [];
    await run(
      withInstaller(server, async (onProgress) => {
        for (const phase of [undefined, "downloading", "downloading", "installing"] as const) {
          onProgress({ phase, startedAt: 1_000 });
          seen.push(preview.install());
        }
        server.state.installed = true;
      }),
      async (p) => {
        preview = p;
        await p.previewFile("q3.docx");
        await p.startInstall();

        expect(seen).toEqual([
          { step: "installing", startedAt: 1_000 },
          { step: "installing", phase: "downloading", startedAt: 1_000 },
          { step: "installing", phase: "downloading", startedAt: 1_000 },
          { step: "installing", phase: "installing", startedAt: 1_000 },
        ]);
      },
    );
  });

  test("shows a failed install with Try again, and Try again finishes the install", async () => {
    const server = converter();
    let attempts = 0;
    await run(
      withInstaller(server, async () => {
        attempts += 1;
        if (attempts === 1) throw new OfficeInstallError("install_failed");
        server.state.installed = true;
      }),
      async (preview) => {
        await preview.previewFile("q3.docx");
        await preview.startInstall();
        expect(preview.install()).toEqual({ step: "failed" });
        expect(server.readProjectPreviewPdf).toHaveBeenCalledTimes(1);

        await preview.startInstall();
        expect(preview.install()).toBeNull();
        expect(preview.content()).toBe("UERG");
      },
    );
  });

  test("falls back to the by-hand panel when winget is gone by the time of the install", async () => {
    const server = converter();
    await run(
      withInstaller(server, async () => {
        throw new OfficeInstallError("winget_unavailable");
      }),
      async (preview) => {
        await preview.previewFile("q3.docx");
        await preview.startInstall();

        expect(preview.install()).toEqual({ step: "manual" });
      },
    );
  });

  test("says LibreOffice is installed elsewhere when winget finds it, and Try again loads the preview", async () => {
    const server = converter();
    const install = vi.fn(async () => {
      throw new OfficeInstallError("already_installed_elsewhere");
    });
    await run(withInstaller(server, install), async (preview) => {
      await preview.previewFile("q3.docx");
      await preview.startInstall();

      expect(preview.install()).toEqual({ step: "installed_elsewhere" });

      server.state.installed = true; // reinstalled in the default place
      await preview.recheckPreview();
      expect(preview.install()).toBeNull();
      expect(preview.content()).toBe("UERG");
      expect(install).toHaveBeenCalledTimes(1);
    });
  });

  test("does not ask again after Not now, and Install brings the offer back", async () => {
    const server = converter();
    await run(withInstaller(server, async () => {}), async (preview) => {
      await preview.previewFile("q3.docx");
      preview.declineInstall();
      expect(preview.install()).toEqual({ step: "declined" });

      preview.close();
      await preview.previewFile("q3.docx");
      expect(preview.install()).toEqual({ step: "declined" });
      expect(preview.error()).toBe(t("session.office_preview_unavailable"));

      preview.offerInstall();
      expect(preview.install()).toEqual({ step: "offer" });
    });
  });

  test("does not reload a preview the user has closed during the install", async () => {
    const server = converter();
    await run(
      withInstaller(server, async () => {
        preview.close();
        server.state.installed = true;
      }),
      async (p) => {
        preview = p;
        await preview.previewFile("q3.docx");
        await preview.startInstall();

        expect(preview.open()).toBe(false);
        expect(server.readProjectPreviewPdf).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("follows an install that is already running instead of offering a second one", async () => {
    const server = converter();
    const install = vi.fn(async () => {
      server.state.installed = true;
    });
    await run(
      withInstaller(server, install, async () => ({ operationId: "sm:run_7", canInstall: true })),
      async (preview) => {
        await preview.previewFile("q3.docx");

        await vi.waitFor(() => expect(preview.content()).toBe("UERG"));
        expect(install).toHaveBeenCalledTimes(1);
        expect(install).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), "sm:run_7");
        expect(preview.install()).toBeNull();
        expect(preview.error()).toBeNull();
      },
    );
  });

  test("follows a running install when the half-installed converter fails, and reloads after it", async () => {
    const server = converter();
    server.readProjectPreviewPdf.mockImplementation(async () => {
      if (!server.state.installed) {
        throw new OpenworkServerError(500, "office_conversion_failed", "soffice exited with 53");
      }
      return fileResponse("UERG");
    });
    let finish: () => void = () => undefined;
    const install = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            server.state.installed = true;
            resolve();
          };
        }),
    );
    await run(
      withInstaller(server, install, async () => ({ operationId: "sm:run_7", canInstall: true })),
      async (preview) => {
        await preview.previewFile("q3.docx");
        await vi.waitFor(() => expect(preview.install()).toEqual({ step: "installing" }));
        expect(preview.loading()).toBe(false);

        finish();
        await vi.waitFor(() => expect(preview.content()).toBe("UERG"));
        expect(preview.install()).toBeNull();
      },
    );
  });

  test("says the conversion failed, as before, when no install is running", async () => {
    const server = converter();
    server.readProjectPreviewPdf.mockImplementation(async () => {
      throw new OpenworkServerError(500, "office_conversion_failed", "broken file");
    });
    const install = vi.fn(async () => {});
    await run(withInstaller(server, install), async (preview) => {
      await preview.previewFile("q3.docx");

      expect(preview.error()).toBe("This document could not be converted for preview.");
      expect(preview.install()).toBeNull();
      expect(install).not.toHaveBeenCalled();
    });
  });

  test("does not follow the install for a preview closed while it asked", async () => {
    const server = converter();
    const install = vi.fn(async () => {});
    await run(
      withInstaller(server, install, async () => {
        preview.close();
        return { operationId: "sm:run_7", canInstall: true };
      }),
      async (p) => {
        preview = p;
        await preview.previewFile("q3.docx");

        expect(install).not.toHaveBeenCalled();
        expect(preview.install()).toBeNull();
        expect(preview.error()).toBeNull();
      },
    );
  });

  test("when the install it followed ends without LibreOffice, only Try again starts a new one", async () => {
    const server = converter();
    const install = vi.fn(async (_onPhase: unknown, _isStale: unknown, operationId?: string) => {
      if (operationId) throw new OfficeInstallError("install_failed");
      server.state.installed = true;
    });
    await run(
      withInstaller(server, install, async () => ({ operationId: "sm:run_7", canInstall: true })),
      async (preview) => {
        await preview.previewFile("q3.docx");
        await vi.waitFor(() => expect(preview.install()).toEqual({ step: "failed" }));
        expect(install).toHaveBeenCalledTimes(1);

        await preview.startInstall();

        expect(install).toHaveBeenCalledTimes(2);
        expect(install.mock.calls[1]?.[2]).toBeUndefined();
        expect(preview.content()).toBe("UERG");
      },
    );
  });

  test("drops a failure that arrives after the preview was closed", async () => {
    const server = converter();
    const status = vi.fn(canInstall);
    const install = vi.fn(async () => {});
    server.readProjectPreviewPdf.mockImplementation(async () => {
      preview.close(); // the user closes the modal while the conversion is pending
      throw notInstalled();
    });
    await run(withInstaller(server, install, status), async (p) => {
      preview = p;
      await preview.previewFile("q3.docx");

      expect(status).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      expect(preview.install()).toBeNull();
      expect(preview.error()).toBeNull();
    });
  });

  test("drops a failure that arrives after another file was opened", async () => {
    const server = converter();
    const status = vi.fn(canInstall);
    server.readProjectPreviewPdf.mockImplementationOnce(async () => {
      server.state.installed = true;
      await preview.previewFile("q4.docx"); // opened while q3 is still converting
      throw notInstalled();
    });
    await run(withInstaller(server, async () => {}, status), async (p) => {
      preview = p;
      await preview.previewFile("q3.docx");

      expect(preview.title()).toBe("q4.docx");
      expect(preview.content()).toBe("UERG");
      expect(preview.error()).toBeNull();
      expect(preview.install()).toBeNull();
      expect(status).not.toHaveBeenCalled();
    });
  });

  test("reloads a file picked in the workspace panel the same way", async () => {
    const server = converter();
    await run(
      withInstaller(server, async () => {
        server.state.installed = true;
      }),
      async (preview) => {
        await preview.previewWorkspaceFile("item-1", "q3.docx", "projects");
        expect(preview.install()).toEqual({ step: "offer" });

        await preview.startInstall();
        expect(preview.content()).toBe("UERG");
        expect(preview.install()).toBeNull();
      },
    );
  });
});

describe("previewWorkspaceFile", () => {
  test("refuses host-only sources outside the desktop app", async () => {
    for (const [source, message] of [
      ["sensitive", "Sensitive files can only be previewed in the desktop app."],
      [
        "mask_registries",
        "Mask registries can only be previewed in the desktop app.",
      ],
    ] as const) {
      await run(makeDeps(), async (preview) => {
        await preview.previewWorkspaceFile("item-1", "secret.txt", source);
        expect(preview.error()).toBe(message);
        expect(preview.loading()).toBe(false);
      });
    }
  });

  test("needs a server connection for every other source", async () => {
    await run(makeDeps(), async (preview) => {
      await preview.previewWorkspaceFile("item-1", "notes.md", "projects");
      expect(preview.error()).toBe("Server connection unavailable.");
    });
  });

  test("routes office documents to the preview-pdf endpoint for its source", async () => {
    const readProjectPreviewPdf = vi.fn(async () => fileResponse("UFJK"));
    const readInboxPreviewPdf = vi.fn(async () => fileResponse("SU5CWA=="));
    const deps = makeDeps({
      serverClient: () =>
        serverStub({ readProjectPreviewPdf, readInboxPreviewPdf }),
      serverWorkspaceId: () => "ws-1",
    });

    await run(deps, async (preview) => {
      await preview.previewWorkspaceFile("item-1", "q3.docx", "projects");
      expect(readProjectPreviewPdf).toHaveBeenCalledWith("ws-1", "item-1");
      expect(preview.content()).toBe("UFJK");
    });

    await run(deps, async (preview) => {
      await preview.previewWorkspaceFile("item-2", "q3.xlsx", "inbox");
      expect(readInboxPreviewPdf).toHaveBeenCalledWith("ws-1", "item-2");
      expect(preview.content()).toBe("SU5CWA==");
    });
  });

  test("decodes text and wraps images in a data url", async () => {
    const readProjectContent = vi.fn(async (_w: string, itemId: string) =>
      fileResponse(itemId === "text" ? utf8Base64("héllo wörld") : "SU1H"),
    );
    const deps = makeDeps({
      serverClient: () => serverStub({ readProjectContent }),
      serverWorkspaceId: () => "ws-1",
    });

    await run(deps, async (preview) => {
      await preview.previewWorkspaceFile("text", "notes.md", "projects");
      expect(preview.content()).toBe("héllo wörld");
    });

    await run(deps, async (preview) => {
      await preview.previewWorkspaceFile("img", "shot.jpg", "projects");
      expect(preview.content()).toBe("data:image/jpeg;base64,SU1H");
    });
  });

  test("reports content it cannot decode instead of rendering mojibake", async () => {
    // The decoder prefers `Buffer` where it exists, and `Buffer.from(s,
    // "base64")` drops invalid characters silently rather than throwing. The
    // shipped app runs in a webview with no Buffer, so it takes the `atob`
    // path, which does throw - hide Buffer to exercise what users actually hit.
    const realBuffer = globalThis.Buffer;
    // @ts-expect-error - deleting a global for the duration of one assertion
    delete globalThis.Buffer;
    try {
      await run(
        makeDeps({
          serverClient: () =>
            serverStub({
              readProjectContent: vi.fn(async () =>
                fileResponse("!!!not base64!!!"),
              ),
            }),
          serverWorkspaceId: () => "ws-1",
        }),
        async (preview) => {
          await preview.previewWorkspaceFile("item-1", "notes.md", "projects");
          expect(preview.error()).toBe("Unable to decode file content.");
        },
      );
    } finally {
      globalThis.Buffer = realBuffer;
    }
  });

  test("reports an empty response", async () => {
    await run(
      makeDeps({
        serverClient: () =>
          serverStub({
            readProjectContent: vi.fn(async () => fileResponse("")),
          }),
        serverWorkspaceId: () => "ws-1",
      }),
      async (preview) => {
        await preview.previewWorkspaceFile("item-1", "notes.md", "projects");
        expect(preview.error()).toBe("No content returned.");
      },
    );
  });
});

describe("markdown that links images beside it", () => {
  const report = "# Report\n\n![chart](img/chart.png)\n\n![gone](gone.png)";

  test("reads each linked image next to an artifact through the server", async () => {
    const reads: string[] = [];
    await run(
      makeDeps({
        serverClient: () => serverStub(),
        readFileViaServer: async () => report,
        readFileBase64ViaServer: async (file) => {
          reads.push(file);
          return file.endsWith("chart.png") ? "UE5H" : null;
        },
      }),
      async (preview) => {
        await preview.previewFile("reports/r.md");
        expect(reads).toEqual(["reports/img/chart.png", "reports/gone.png"]);
        const images = preview.modalProps().images;
        expect(images?.get("img/chart.png")).toBe("data:image/png;base64,UE5H");
        expect(images?.has("gone.png")).toBe(false);
        expect(preview.content()).toBe(report);
        expect(preview.loading()).toBe(false);
      },
    );
  });

  test("on the host, reads the image through the workspace-bounded reader", async () => {
    withTauri(true);
    tauriFs.readWorkspaceFile.mockResolvedValue({ ok: true, content: report });
    tauriFs.readWorkspaceFileBase64.mockResolvedValue({ ok: true, content: "SE9TVA==" });
    const onHost: LocalFileAction = async (file, _mode, action) => {
      const path = `C:/ws/${file}`;
      await action(path);
      return { ok: true, path };
    };

    await run(
      makeDeps({ activeWorkspaceRoot: () => "C:/ws", runLocalFileAction: onHost }),
      async (preview) => {
        await preview.previewFile("reports/r.md");
        expect(tauriFs.readWorkspaceFileBase64).toHaveBeenCalledWith("C:/ws/reports/img/chart.png", "C:/ws");
        expect(preview.modalProps().images?.get("img/chart.png")).toBe("data:image/png;base64,SE9TVA==");
      },
    );
  });

  test("on the host, reads the images beside the copy it found, not a same-named file in the root", async () => {
    withTauri(true);
    const rootThenOutbox: LocalFileAction = async (file, _mode, action) => {
      for (const path of [`C:/ws/${file}`, `C:/ws/.opencode/openwork/outbox/${file}`]) {
        try {
          await action(path);
          return { ok: true, path };
        } catch {
          // try the next candidate, as the real helper does
        }
      }
      return { ok: false, reason: "not found" };
    };
    tauriFs.readWorkspaceFile.mockImplementation(async (path: string) =>
      path === "C:/ws/.opencode/openwork/outbox/r.md"
        ? { ok: true, content: "![](chart.png)" }
        : { ok: false, error: "missing" },
    );
    tauriFs.readWorkspaceFileBase64.mockImplementation(async (path: string) => ({
      ok: true,
      content: path === "C:/ws/chart.png" ? "Uk9PVA==" : "T1VU",
    }));

    await run(
      makeDeps({ activeWorkspaceRoot: () => "C:/ws", runLocalFileAction: rootThenOutbox }),
      async (preview) => {
        await preview.previewFile("r.md");
        expect(tauriFs.readWorkspaceFileBase64.mock.calls).toEqual([
          ["C:/ws/.opencode/openwork/outbox/chart.png", "C:/ws"],
        ]);
        expect(preview.modalProps().images?.get("chart.png")).toBe("data:image/png;base64,T1VU");
      },
    );
  });

  test("a report finishing after another file started loading leaves that file's spinner on", async () => {
    let preview: ReturnType<typeof createFilePreview>;
    let finishB: (value: string) => void = () => {};
    let bStarted: Promise<void> = Promise.resolve();
    await run(
      makeDeps({
        serverClient: () => serverStub(),
        readFileViaServer: (file) =>
          file === "a.md"
            ? Promise.resolve("![](a.png)")
            : new Promise<string>((resolve) => {
                finishB = resolve;
              }),
        readFileBase64ViaServer: async () => {
          bStarted = preview.previewFile("b.md"); // opened while a.md's image is loading; b.md is slow
          return "UE5H";
        },
      }),
      async (p) => {
        preview = p;
        await preview.previewFile("a.md");
        expect(preview.title()).toBe("b.md");
        expect(preview.loading()).toBe(true);
        finishB("second");
        await bStarted;
        expect(preview.content()).toBe("second");
        expect(preview.loading()).toBe(false);
      },
    );
  });

  test("a markdown file shown without reading its images does not keep the previous report's", async () => {
    withTauri(true);
    tauriFs.readWorkspaceFileBase64.mockResolvedValue({ ok: true, content: utf8Base64("![chart](img/chart.png)") });
    await run(
      makeDeps({
        serverClient: () => serverStub(),
        readFileViaServer: async () => report,
        readFileBase64ViaServer: async () => "UE5H",
      }),
      async (preview) => {
        await preview.previewFile("reports/r.md");
        expect(preview.modalProps().images?.get("img/chart.png")).toBe("data:image/png;base64,UE5H");
        await preview.previewWorkspaceFile("notes.md", "notes.md", "mask_registries");
        expect(preview.content()).toBe("![chart](img/chart.png)");
        expect(preview.modalProps().images?.size).toBe(0);
      },
    );
  });

  test("a file picked in the panel reads its images by their own item ids", async () => {
    const asked: string[] = [];
    const readProjectContent = vi.fn(async (_w: string, itemId: string) => {
      const path = decodeItemId(itemId);
      asked.push(path);
      if (path === "reports/r.md") return fileResponse(utf8Base64(report));
      if (path === "reports/img/chart.png") return fileResponse("UE5H");
      throw notFound();
    });
    const toItemId = (path: string) => btoa(path).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    await run(
      makeDeps({ serverClient: () => serverStub({ readProjectContent }), serverWorkspaceId: () => "ws-1" }),
      async (preview) => {
        await preview.previewWorkspaceFile(toItemId("reports/r.md"), "r.md", "projects");
        expect(asked).toEqual(["reports/r.md", "reports/img/chart.png", "reports/gone.png"]);
        expect(preview.modalProps().images?.get("img/chart.png")).toBe("data:image/png;base64,UE5H");
        expect(preview.content()).toBe(report);
        expect(preview.error()).toBeNull();
      },
    );
  });

  test("a plain text file reads no images", async () => {
    const readFileBase64ViaServer = vi.fn(async () => "UE5H");
    await run(
      makeDeps({
        serverClient: () => serverStub(),
        readFileViaServer: async () => "![chart](chart.png)",
        readFileBase64ViaServer,
      }),
      async (preview) => {
        await preview.previewFile("notes.txt");
        expect(readFileBase64ViaServer).not.toHaveBeenCalled();
        expect(preview.modalProps().images?.size).toBe(0);
      },
    );
  });

  test("a report whose images finish after another file opened does not replace it", async () => {
    let preview: ReturnType<typeof createFilePreview>;
    await run(
      makeDeps({
        serverClient: () => serverStub(),
        readFileViaServer: async (file) => (file === "a.md" ? "![](a.png)" : "second"),
        readFileBase64ViaServer: async () => {
          await preview.previewFile("b.md"); // opened while a.md's image is still loading
          return "UE5H";
        },
      }),
      async (p) => {
        preview = p;
        await preview.previewFile("a.md");
        expect(preview.title()).toBe("b.md");
        expect(preview.content()).toBe("second");
        expect(preview.modalProps().images?.size).toBe(0);
      },
    );
  });

  test("a report whose text arrives after another file opened neither replaces it nor reads its images", async () => {
    let finishA: (value: string) => void = () => {};
    const imageReads: string[] = [];
    await run(
      makeDeps({
        serverClient: () => serverStub(),
        readFileViaServer: (file) =>
          file === "a.md"
            ? new Promise<string>((resolve) => {
                finishA = resolve;
              })
            : Promise.resolve("second"),
        readFileBase64ViaServer: async (file) => {
          imageReads.push(file);
          return "UE5H";
        },
      }),
      async (preview) => {
        const loadingA = preview.previewFile("a.md");
        await preview.previewFile("b.md");
        finishA("![](a.png)");
        await loadingA;
        expect(preview.title()).toBe("b.md");
        expect(preview.content()).toBe("second");
        expect(preview.modalProps().images?.size).toBe(0);
        expect(imageReads).toEqual([]);
      },
    );
  });
});

describe("close", () => {
  test("clears the content and error but leaves the title", async () => {
    await run(
      makeDeps({
        serverClient: () => serverStub(),
        readFileViaServer: async () => "hello",
      }),
      async (preview) => {
        await preview.previewFile("notes.md");
        expect(preview.open()).toBe(true);

        preview.close();

        expect(preview.open()).toBe(false);
        expect(preview.content()).toBeNull();
        expect(preview.error()).toBeNull();
      },
    );
  });
});
