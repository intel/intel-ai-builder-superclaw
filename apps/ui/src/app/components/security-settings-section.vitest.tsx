import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
  pickFile: vi.fn(),
  invoke: vi.fn(),
  requestServiceHubJson: vi.fn(),
  getPrivacyModelsHealth: vi.fn(),
  preparePrivacyModels: vi.fn(),
  onDragDropEvent: vi.fn(async () => () => {}),
}));

vi.mock("~/shared/platform/capability/capability-gate", () => ({
  useCapabilityGate: () => ({ productProfileId: () => null }),
}));
vi.mock("../utils", () => ({ isTauriRuntime: mocks.isTauriRuntime }));
vi.mock("../lib/openwork-server", () => ({
  readOpenworkServerSettings: () => ({
    hubUrl: "http://127.0.0.1:9",
    hubToken: "token",
  }),
}));
vi.mock("../lib/servicehub", () => ({
  requestServiceHubJson: (...args: unknown[]) => mocks.requestServiceHubJson(...args),
}));
vi.mock("~/shared/platform/transport/privacy-models", () => ({
  getPrivacyModelsHealth: (...args: unknown[]) => mocks.getPrivacyModelsHealth(...args),
  preparePrivacyModels: (...args: unknown[]) => mocks.preparePrivacyModels(...args),
}));
vi.mock("../../i18n", () => ({
  t: (key: string) =>
    key === "security.sensitive_folder_import_success" ? 'added "{name}"' : key,
}));
vi.mock("~/shared/platform/tauri/tauri.local-files", () => ({
  pickFile: (...args: unknown[]) => mocks.pickFile(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onDragDropEvent: mocks.onDragDropEvent }),
}));

const {
  default: SecuritySettingsSection,
  fileProtectionShown,
  prefetchFileProtection,
} = await import("./security-settings-section");

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauriRuntime.mockReturnValue(true);
  mocks.onDragDropEvent.mockResolvedValue(() => {});
  mocks.requestServiceHubJson.mockResolvedValue({
    mode: "hybrid",
    applied: "hybrid",
    source: "store",
    supported: true,
  });
  mocks.getPrivacyModelsHealth.mockResolvedValue({
    models_state: "ready",
    models_done_bytes: 0,
    models_total_bytes: 0,
    models_error: null,
    models_present: true,
  });
  mocks.preparePrivacyModels.mockResolvedValue({ state: "preparing" });
  mocks.invoke.mockImplementation(async (cmd: string, args?: { paths?: string[] }) => {
    if (cmd === "sensitive_files_list") return [];
    if (cmd === "sensitive_files_import") {
      return (args?.paths ?? []).map((path) => ({
        name: path.split(/[\\/]/).pop() ?? path,
        path,
        size: 1,
      }));
    }
    throw new Error(`unexpected command ${cmd}`);
  });
});

function chooseButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /security\.sensitive_folder_click/,
  }) as HTMLButtonElement;
}

describe("sensitive files browse", () => {
  test("Choose files opens the native dialog and imports the selection", async () => {
    mocks.pickFile.mockResolvedValue([
      "C:\\docs\\a.txt",
      "C:\\docs\\b.txt",
    ]);
    render(() => <SecuritySettingsSection />);

    fireEvent.click(chooseButton());

    await waitFor(() => {
      expect(mocks.pickFile).toHaveBeenCalledWith({
        title: "security.sensitive_folder_choose",
        multiple: true,
      });
    });
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("sensitive_files_import", {
        paths: ["C:\\docs\\a.txt", "C:\\docs\\b.txt"],
      });
    });
    const listed = [...document.querySelectorAll(".font-mono")].map((el) => el.textContent);
    expect(listed).toEqual(["a.txt", "b.txt"]);
    expect(screen.getByText('added "a.txt, b.txt"')).toBeTruthy();
  });

  test("a single dialog path is imported the same way", async () => {
    mocks.pickFile.mockResolvedValue("D:\\secret.pdf");
    render(() => <SecuritySettingsSection />);

    fireEvent.click(chooseButton());

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("sensitive_files_import", {
        paths: ["D:\\secret.pdf"],
      });
    });
    expect(screen.getByText('added "secret.pdf"')).toBeTruthy();
  });

  test("cancelling the dialog does not import", async () => {
    mocks.pickFile.mockResolvedValue(null);
    render(() => <SecuritySettingsSection />);

    fireEvent.click(chooseButton());

    await waitFor(() => {
      expect(mocks.pickFile).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "sensitive_files_import",
      expect.anything(),
    );
  });

  test("outside the desktop app, Choose files says import is unavailable", async () => {
    mocks.isTauriRuntime.mockReturnValue(false);
    render(() => <SecuritySettingsSection />);

    fireEvent.click(chooseButton());

    await waitFor(() => {
      expect(screen.getByText("security.sensitive_folder_desktop_only")).toBeTruthy();
    });
    expect(mocks.pickFile).not.toHaveBeenCalled();
  });
});

describe("file protection model consent", () => {
  test("disables the mode toggle while consent or download dialog is open", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce({
      mode: "none",
      applied: "none",
      source: "default",
      supported: true,
    });
    mocks.getPrivacyModelsHealth.mockResolvedValueOnce({
      models_state: "pending",
      models_done_bytes: 0,
      models_total_bytes: 545_000_000,
      models_error: null,
      models_present: false,
    });
    render(() => <SecuritySettingsSection />);

    const toggle = await screen.findByRole("switch", { name: "security.mode_title" });
    fireEvent.click(toggle);

    expect(await screen.findByRole("button", { name: "security.model_download_confirm" })).toBeTruthy();
    expect(toggle).toHaveProperty("disabled", true);
    fireEvent.click(toggle);
    expect(mocks.getPrivacyModelsHealth).toHaveBeenCalledTimes(1);
  });

  test("requires consent before enabling and displays live model progress", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce({
      mode: "none",
      applied: "none",
      source: "default",
      supported: true,
    });
    mocks.getPrivacyModelsHealth
      .mockResolvedValueOnce({
        models_state: "pending",
        models_done_bytes: 0,
        models_total_bytes: 0,
        models_error: null,
        models_present: false,
      })
      .mockRejectedValueOnce(new Error("temporary status failure"))
      .mockResolvedValueOnce({
        models_state: "downloading",
        models_done_bytes: 104_857_600,
        models_total_bytes: 419_430_400,
        models_error: null,
        models_present: false,
      });
    render(() => <SecuritySettingsSection />);

    fireEvent.click(await screen.findByRole("switch", { name: "security.mode_title" }));
    expect(await screen.findByTestId("privacy-model-download-dialog")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("privacy-model-download-title");
    expect(dialog.getAttribute("aria-describedby")).toBe("privacy-model-download-description");
    expect(screen.getByText("security.model_download_pii_model")).toBeTruthy();
    expect(screen.queryByText("security.model_download_finance_model")).toBeNull();
    expect(mocks.requestServiceHubJson).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "security.model_download_confirm" }));

    await waitFor(() => {
      expect(mocks.requestServiceHubJson).toHaveBeenCalledTimes(1);
      expect(mocks.preparePrivacyModels).toHaveBeenCalledWith("http://127.0.0.1:9", "token");
      expect(mocks.getPrivacyModelsHealth).toHaveBeenCalledTimes(3);
      expect(screen.getByText("104.9 MB / 419.4 MB")).toBeTruthy();
    }, { timeout: 5_000 });
  });

  test("canceling consent leaves File Protection disabled", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce({
      mode: "none",
      applied: "none",
      source: "default",
      supported: true,
    });
    mocks.getPrivacyModelsHealth.mockResolvedValueOnce({
      models_state: "pending",
      models_done_bytes: 0,
      models_total_bytes: 0,
      models_error: null,
      models_present: false,
    });
    render(() => <SecuritySettingsSection />);

    fireEvent.click(await screen.findByRole("switch", { name: "security.mode_title" }));
    fireEvent.click(await screen.findByRole("button", { name: "security.model_download_cancel" }));

    expect(screen.queryByTestId("privacy-model-download-dialog")).toBeNull();
    expect(mocks.requestServiceHubJson).toHaveBeenCalledTimes(1);
  });

  test("enables directly when all privacy models are already present", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce({
      mode: "none",
      applied: "none",
      source: "default",
      supported: true,
    });
    mocks.getPrivacyModelsHealth.mockResolvedValueOnce({
      models_state: "pending",
      models_done_bytes: 0,
      models_total_bytes: 0,
      models_error: null,
      models_present: true,
    });
    render(() => <SecuritySettingsSection />);

    fireEvent.click(await screen.findByRole("switch", { name: "security.mode_title" }));

    await waitFor(() => {
      expect(mocks.requestServiceHubJson).toHaveBeenCalledTimes(2);
      expect(mocks.requestServiceHubJson).toHaveBeenNthCalledWith(
        2,
        "http://127.0.0.1:9",
        "/llm-router/v1/data-protection/mode",
        "token",
        { method: "PUT", body: { mode: "hybrid" } },
      );
    });
    expect(screen.queryByTestId("privacy-model-download-dialog")).toBeNull();
  });

  test("enables File Protection only after verified models are ready", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce({
      mode: "none",
      applied: "none",
      source: "default",
      supported: true,
    });
    mocks.getPrivacyModelsHealth
      .mockResolvedValueOnce({
        models_state: "pending",
        models_done_bytes: 0,
        models_total_bytes: 0,
        models_error: null,
        models_present: false,
      })
      .mockResolvedValueOnce({
        models_state: "ready",
        models_done_bytes: 545_000_000,
        models_total_bytes: 545_000_000,
        models_error: null,
        models_present: true,
      });
    render(() => <SecuritySettingsSection />);

    fireEvent.click(await screen.findByRole("switch", { name: "security.mode_title" }));
    fireEvent.click(await screen.findByRole("button", { name: "security.model_download_confirm" }));

    await waitFor(() => {
      expect(mocks.requestServiceHubJson).toHaveBeenCalledTimes(2);
      expect(mocks.requestServiceHubJson).toHaveBeenNthCalledWith(
        2,
        "http://127.0.0.1:9",
        "/llm-router/v1/data-protection/mode",
        "token",
        { method: "PUT", body: { mode: "hybrid" } },
      );
      expect(screen.getByText("security.model_download_ready_hint")).toBeTruthy();
    });
  });

  test("a failed download tells the user to try again later", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce({
      mode: "none",
      applied: "none",
      source: "default",
      supported: true,
    });
    mocks.getPrivacyModelsHealth
      .mockResolvedValueOnce({
        models_state: "pending",
        models_done_bytes: 0,
        models_total_bytes: 0,
        models_error: null,
        models_present: false,
      })
      .mockResolvedValueOnce({
        models_state: "failed",
        models_done_bytes: 0,
        models_total_bytes: 545_000_000,
        models_error: "download failed",
        models_present: false,
      });
    render(() => <SecuritySettingsSection />);

    fireEvent.click(await screen.findByRole("switch", { name: "security.mode_title" }));
    fireEvent.click(await screen.findByRole("button", { name: "security.model_download_confirm" }));

    expect(await screen.findByText("security.model_download_try_later")).toBeTruthy();
    expect(mocks.requestServiceHubJson).toHaveBeenCalledTimes(1);
  });

  test("stops with an error when status is ready but configured models are absent", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce({
      mode: "none",
      applied: "none",
      source: "default",
      supported: true,
    });
    mocks.getPrivacyModelsHealth
      .mockResolvedValueOnce({
        models_state: "pending",
        models_done_bytes: 0,
        models_total_bytes: 0,
        models_error: null,
        models_present: false,
      })
      .mockResolvedValueOnce({
        models_state: "ready",
        models_done_bytes: 0,
        models_total_bytes: 0,
        models_error: null,
        models_present: false,
      });
    render(() => <SecuritySettingsSection />);

    fireEvent.click(await screen.findByRole("switch", { name: "security.mode_title" }));
    fireEvent.click(await screen.findByRole("button", { name: "security.model_download_confirm" }));

    expect(await screen.findByText("security.model_download_unverified_models")).toBeTruthy();
    expect(mocks.requestServiceHubJson).toHaveBeenCalledTimes(1);
  });

  test("stops with a readable error for unsupported model configuration", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce({
      mode: "none",
      applied: "none",
      source: "default",
      supported: true,
    });
    mocks.getPrivacyModelsHealth
      .mockResolvedValueOnce({
        models_state: "pending",
        models_done_bytes: 0,
        models_total_bytes: 0,
        models_error: null,
        models_present: false,
      })
      .mockResolvedValueOnce({
        models_state: "unsupported",
        models_done_bytes: 0,
        models_total_bytes: 0,
        models_error: "custom model path",
        models_present: false,
      });
    render(() => <SecuritySettingsSection />);

    fireEvent.click(await screen.findByRole("switch", { name: "security.mode_title" }));
    fireEvent.click(await screen.findByRole("button", { name: "security.model_download_confirm" }));

    expect(await screen.findByText("custom model path")).toBeTruthy();
    expect(mocks.requestServiceHubJson).toHaveBeenCalledTimes(1);
  });
});

describe("what the Settings search is told about the card", () => {
  const mode = (supported: boolean) => ({ mode: "hybrid", applied: "hybrid", source: "store", supported });

  test("an early read answers before Privacy is opened", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce(mode(false));
    prefetchFileProtection();
    await waitFor(() => expect(fileProtectionShown()).toBe(false));

    mocks.requestServiceHubJson.mockResolvedValueOnce(mode(true));
    prefetchFileProtection();
    await waitFor(() => expect(fileProtectionShown()).toBe(true));
  });

  test("a failed early read leaves the card counted as shown, as it draws", async () => {
    mocks.requestServiceHubJson.mockResolvedValueOnce(mode(true));
    prefetchFileProtection();
    await waitFor(() => expect(fileProtectionShown()).toBe(true));
    mocks.requestServiceHubJson.mockRejectedValueOnce(new Error("not ready"));
    prefetchFileProtection();
    await Promise.resolve();
    expect(fileProtectionShown()).toBe(true);
  });

  test("after a failed read, reopening Privacy counts the card as shown while it loads", async () => {
    mocks.requestServiceHubJson.mockRejectedValueOnce(new Error("not ready"));
    const first = render(() => <SecuritySettingsSection />);
    await waitFor(() => expect(fileProtectionShown()).toBe(false));
    first.unmount();

    mocks.requestServiceHubJson.mockReturnValueOnce(new Promise(() => {}));
    render(() => <SecuritySettingsSection />);
    expect(fileProtectionShown()).toBe(true);
  });

  test("an early read that lands after the card's own does not override it", async () => {
    let resolveEarly!: (value: unknown) => void;
    mocks.requestServiceHubJson.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEarly = resolve;
      }),
    );
    prefetchFileProtection();
    mocks.requestServiceHubJson.mockResolvedValueOnce(mode(true));
    render(() => <SecuritySettingsSection />);
    await screen.findByRole("switch", { name: "security.mode_title" });

    resolveEarly(mode(false));
    await Promise.resolve();
    await Promise.resolve();
    expect(fileProtectionShown()).toBe(true);
  });
});
