import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";
import type { ModelBadgeDescriptor } from "~/shared/util/model-ref";
import { setLocale } from "../../../i18n";
import { MessageModelBadge } from "./message-model-badge";

afterEach(() => {
  cleanup();
  setLocale("en");
});

describe("MessageModelBadge", () => {
  test("renders a served model when attribution arrives after mount", () => {
    const [label, setLabel] = createSignal<ModelBadgeDescriptor | null>(null);
    render(() => <MessageModelBadge label={label()} />);

    expect(screen.queryByText("Claude Sonnet 4.5")).toBeNull();
    setLabel({ kind: "model", value: "Claude Sonnet 4.5", source: "cloud" });

    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("Cloud")).toBeTruthy();
  });

  test("replaces a route badge when served-model attribution arrives", () => {
    const [label, setLabel] = createSignal<ModelBadgeDescriptor | null>({
      kind: "route",
      alias: "auto",
    });
    render(() => <MessageModelBadge label={label()} />);

    expect(screen.getByText("Auto")).toBeTruthy();
    const trigger = document.querySelector<HTMLElement>("[tabindex='0']");
    if (!trigger) throw new Error("Model badge tooltip trigger is not focusable");
    trigger.focus();
    expect(screen.getByRole("tooltip").textContent).toContain("Auto is the routing mode");

    setLabel({ kind: "source", source: "hybrid" });

    expect(screen.queryByText("Auto")).toBeNull();
    expect(screen.getByText("Hybrid")).toBeTruthy();
    expect(document.querySelector("[tabindex='0']")).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("tooltip").textContent).toContain("Hybrid means");
  });

  test("updates label, source, and tooltip when locale changes while mounted", () => {
    setLocale("en");
    const [label] = createSignal<ModelBadgeDescriptor>({
      kind: "model",
      value: "Qwen 3.5",
      source: "local",
    });
    const [routeLabel] = createSignal<ModelBadgeDescriptor>({
      kind: "route",
      alias: "auto",
    });
    const view = render(() => (
      <>
        <MessageModelBadge label={label()} />
        <MessageModelBadge label={routeLabel()} />
      </>
    ));

    expect(view.getByText("Qwen 3.5")).toBeTruthy();
    expect(view.getByText("Local")).toBeTruthy();
    expect(view.getByText("Auto")).toBeTruthy();
    const trigger = view.container.querySelector("[tabindex='0']");
    if (!trigger) throw new Error("Model badge tooltip trigger is not focusable");
    fireEvent.focusIn(trigger);
    expect(screen.getByRole("tooltip").textContent).toContain("Local means");

    setLocale("zh");

    expect(view.getByText("Qwen 3.5")).toBeTruthy();
    expect(view.getByText("本地")).toBeTruthy();
    expect(view.getByText("自动")).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toContain("本地表示");
  });
});