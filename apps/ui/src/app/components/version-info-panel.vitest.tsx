import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { CapabilityGate } from "~/shared/platform/capability/capability-gate";
import { VersionInfoPanel } from "./version-info-panel";

let productProfileId: "lite" | "standard" | "pro" | null = null;

vi.mock("~/shared/platform/capability/capability-gate", () => ({
  useCapabilityGate: () =>
    ({
      productProfileId: () => productProfileId,
    }) as unknown as CapabilityGate,
}));

afterEach(() => {
  productProfileId = null;
  cleanup();
});

function renderPanel() {
  return render(() => (
    <VersionInfoPanel
      versionLabel="1.3.0.918"
      debugBuildCommit={null}
      debugBuildCommitLabel={null}
      commitCopied={false}
      onCopyCommit={() => undefined}
    />
  ));
}

describe("VersionInfoPanel", () => {
  test.each(["lite", "standard", "pro"] as const)("shows active %s product profile inline", (profileId) => {
    productProfileId = profileId;

    renderPanel();

    expect(screen.getByText("1.3.0.918")).toBeTruthy();
    expect(screen.getByText(`(${profileId})`)).toBeTruthy();
  });

  test("hides the version word and keeps the profile on the same line", () => {
    productProfileId = "standard";

    renderPanel();

    const word = screen.getByText("Version:");
    const number = screen.getByText("1.3.0.918");
    const profile = screen.getByText("(standard)");
    const shortLabel = number.parentElement?.querySelector("[aria-hidden='true']");

    const pill = number.parentElement?.parentElement?.parentElement;

    expect(word.classList.contains("sr-only")).toBe(true);
    expect(shortLabel?.textContent).toBe("v.");
    expect(shortLabel?.getAttribute("aria-hidden")).toBe("true");
    expect(shortLabel?.classList.contains("shrink-0")).toBe(true);
    expect(number.classList.contains("truncate")).toBe(true);
    expect(profile.classList.contains("shrink-0")).toBe(true);
    expect(number.parentElement).toBe(profile.parentElement);
    expect(number.parentElement).toBe(shortLabel?.parentElement);
    expect(pill?.classList.contains("inline-flex")).toBe(true);
    expect(pill?.classList.contains("w-fit")).toBe(true);
    expect(pill?.classList.contains("max-w-full")).toBe(true);
    expect(pill?.classList.contains("w-full")).toBe(false);
  });

  test("omits profile text when no profile is active", () => {
    const { container } = renderPanel();

    expect(screen.getByText("1.3.0.918")).toBeTruthy();
    expect(screen.queryByText(/\((lite|standard|pro)\)/)).toBeNull();
    expect(screen.queryByText(/null/)).toBeNull();
    expect(container.firstElementChild?.className).toMatch(/min-h-\[(54|44)px\]/);
  });
});