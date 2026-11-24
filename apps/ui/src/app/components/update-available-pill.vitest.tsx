import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { otaUpdateStore } from "../lib/ota-update-store";
import UpdateAvailablePill from "./update-available-pill";

const ota = otaUpdateStore();
let checks = 0;

beforeEach(() => {
  vi.useFakeTimers();
  checks = 0;
  ota.setShown(true);
  ota.setDecision(null);
  ota.setInstallerStatus({ state: "idle", lastCheckedAt: null });
  ota.setCheckHandler(() => {
    checks += 1;
    ota.setInstallerStatus({ state: "error", lastCheckedAt: null, message: "offline", context: "check" });
  });
});

afterEach(() => {
  cleanup();
  ota.setCheckHandler(null);
  ota.setShown(false);
  vi.useRealTimers();
});

describe("UpdateAvailablePill manual check", () => {
  test("hidden when the updater is not shown", () => {
    ota.setShown(false);
    render(() => <UpdateAvailablePill />);
    expect(screen.queryByTestId("ota-update-button")).toBeNull();
  });

  test("a failed initial quiet check offers a retry, not an up-to-date checkmark", () => {
    ota.setInstallerStatus({ state: "idle", lastCheckedAt: 5 });
    render(() => <UpdateAvailablePill />);
    const button = screen.getByTestId("ota-update-button");
    expect(button.dataset.state).toBe("idle");
    expect(button.title).toBe("Check for SuperClaw updates");
    expect(button.querySelector(".lucide-refresh-ccw")?.getAttribute("width")).toBe("14");
  });

  test("shows a circular check when SuperClaw is up to date", () => {
    ota.setInstallerStatus({ state: "idle", lastCheckedAt: 5, lastSuccessfulNoUpdateAt: 5 });
    render(() => <UpdateAvailablePill />);
    const button = screen.getByTestId("ota-update-button");

    expect(button.dataset.state).toBe("upToDate");
    expect(button.querySelector(".lucide-circle-check")?.getAttribute("width")).toBe("14");
  });

  test("a check that fails at once still spins before showing the failure", () => {
    render(() => <UpdateAvailablePill />);
    const button = screen.getByTestId("ota-update-button");
    expect(button.dataset.state).toBe("idle");

    fireEvent.click(button);
    expect(checks).toBe(1);
    expect(button.dataset.state).toBe("checking");
    expect(button.querySelector(".animate-spin")).not.toBeNull();

    fireEvent.click(button);
    expect(checks).toBe(1);

    vi.advanceTimersByTime(950);
    expect(button.dataset.state).toBe("checkFailed");
    expect(button.querySelector(".animate-spin")).toBeNull();

    fireEvent.click(button);
    expect(checks).toBe(2);
  });
});
