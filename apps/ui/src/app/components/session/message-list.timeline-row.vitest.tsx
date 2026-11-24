import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TimelineRow } from "./message-list.timeline-row";

afterEach(() => cleanup());

describe("TimelineRow", () => {
  test("keeps a trailing action outside the row toggle", () => {
    const onToggle = vi.fn();
    const onOpenSession = vi.fn();

    render(() => (
      <TimelineRow
        tone="done"
        icon={<span>icon</span>}
        primary="Searched the web"
        secondary="Beijing weather today"
        expandable={true}
        expanded={false}
        onToggle={onToggle}
        controlsId="search-output"
        meta={[
          { text: "2 steps" },
          { text: "3.8s" },
          {
            text: "Open session",
            kind: "action",
            ariaLabel: "Open sub-agent session",
            onClick: onOpenSession,
          },
        ]}
        rowKind="group"
      />
    ));

    const toggle = screen.getByTestId("tool-step-button");
    const action = screen.getByRole("button", {
      name: "Open sub-agent session",
    });

    expect(toggle.getAttribute("aria-controls")).toBe("search-output");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.contains(action)).toBe(false);
    expect(screen.getByTestId("tool-headline").textContent).toBe(
      "Searched the web",
    );
    expect(screen.getByTestId("tool-detail").textContent).toBe(
      "Beijing weather today",
    );
    expect(screen.getByTestId("tool-status-dot").getAttribute("data-status")).toBe(
      "done",
    );
    expect(screen.getByTestId("activity-meta").textContent).toContain("2 steps");
    expect(
      screen.getByTestId("tool-step-row").getAttribute("data-row-kind"),
    ).toBe("group");

    fireEvent.click(toggle);
    fireEvent.click(action);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
  });

  test("renders non-expandable rows as display elements instead of disabled buttons", () => {
    render(() => (
      <TimelineRow
        as="div"
        tone="idle"
        icon={<span>icon</span>}
        primary="Thinking"
        secondary="Comparing two approaches"
        expandable={false}
        rowKind="reasoning"
        density="child"
      />
    ));

    expect(screen.queryByTestId("tool-step-button")).toBeNull();
    expect(screen.getByTestId("tool-step-row").tagName).toBe("DIV");
    expect(screen.getByTestId("tool-headline").closest("button")).toBeNull();
    expect(
      screen.getByTestId("tool-step-row").getAttribute("data-row-kind"),
    ).toBe("reasoning");
  });

  test("renders model source before duration outside the expandable button", () => {
    render(() => (
      <TimelineRow
        tone="done"
        icon={<span>icon</span>}
        primary="Ran command"
        expandable={true}
        expanded={false}
        onToggle={() => undefined}
        meta={[
          {
            text: "Cloud",
            kind: "model-source",
            source: "cloud",
            title: "Cloud model: anthropic/claude",
          },
          { text: "823ms" },
        ]}
        rowKind="tool"
      />
    ));

    const source = screen.getByTestId("activity-model-source");
    const meta = screen.getByTestId("activity-meta");
    expect(source.textContent).toBe("Cloud");
    expect(source.getAttribute("data-model-source")).toBe("cloud");
    expect(source.getAttribute("title")).toBeNull();
    const tooltipTrigger = source.closest("[tabindex='0']");
    if (!tooltipTrigger) throw new Error("Model-source tooltip trigger is not focusable");
    fireEvent.focusIn(tooltipTrigger);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Cloud model: anthropic/claude",
    );
    fireEvent.focusOut(tooltipTrigger);
    fireEvent.mouseEnter(tooltipTrigger);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Cloud model: anthropic/claude",
    );
    expect(meta.textContent?.indexOf("Cloud")).toBeLessThan(
      meta.textContent?.indexOf("823ms") ?? -1,
    );
    expect(screen.getByTestId("tool-step-button").contains(source)).toBe(false);
  });

  test("preserves native titles on non-model metadata items", () => {
    render(() => (
      <TimelineRow
        tone="done"
        icon={<span>icon</span>}
        primary="Protected file"
        expandable={false}
        meta={[{ text: "Masked on-device", title: "Masked locally before analysis" }]}
        rowKind="tool"
      />
    ));

    expect(screen.getByText("Masked on-device").getAttribute("title")).toBe(
      "Masked locally before analysis",
    );
  });
});
