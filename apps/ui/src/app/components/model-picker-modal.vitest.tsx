/**
 * The Manage models window. Local and Cloud rows carry a pencil that opens
 * their card in Settings → Model; picking a row still only picks the route.
 *
 * Needs a DOM (Portal and click handlers), so it runs in the vitest lane.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

import ModelPickerModal, { type ModelPickerModalProps } from "./model-picker-modal";
import type { ModelOption } from "../types";

afterEach(cleanup);

const option = (modelID: string, title: string): ModelOption => ({
  providerID: "llmrouter",
  modelID,
  title,
  isConnected: true,
  isFree: true,
  isLocal: modelID === "local-model",
});
const OPTIONS = [option("auto", "Auto"), option("local-model", "Local model"), option("cloud-model", "Cloud model")];

function renderModal(options: { withEdit?: boolean } = {}) {
  const onSelect = vi.fn();
  const onEditSettings = vi.fn();
  const editProps: Partial<ModelPickerModalProps> = options.withEdit === false ? {} : { onEditSettings };
  render(() => (
    <ModelPickerModal
      open
      options={OPTIONS}
      filteredOptions={OPTIONS}
      query=""
      setQuery={() => undefined}
      target="session"
      current={{ providerID: "llmrouter", modelID: "auto" }}
      onSelect={onSelect}
      onClose={() => undefined}
      {...editProps}
    />
  ));
  return { onSelect, onEditSettings };
}

describe("ModelPickerModal edit pencil", () => {
  test("Local and Cloud have a pencil that opens their settings, and Auto has none", () => {
    const { onSelect, onEditSettings } = renderModal();
    expect(screen.queryByTestId("model-picker-edit-auto")).toBeNull();

    fireEvent.click(screen.getByTestId("model-picker-edit-cloud"));
    fireEvent.click(screen.getByTestId("model-picker-edit-local"));

    expect(onEditSettings.mock.calls).toEqual([["cloud"], ["local"]]);
    // The pencil only opens settings; it does not pick the route.
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("Enter or Space on a focused pencil opens its settings and picks no route", () => {
    const { onSelect, onEditSettings } = renderModal();
    const pencil = screen.getByTestId("model-picker-edit-cloud");
    pencil.focus();

    // The modal listens on window in the capture phase, so it sees the key before the button.
    for (const key of ["Enter", " "]) {
      const notCancelled = fireEvent.keyDown(pencil, { key });
      // Not cancelled, so the browser's own activation turns it into a click.
      expect(notCancelled).toBe(true);
      fireEvent.click(pencil);
    }

    expect(onEditSettings.mock.calls).toEqual([["cloud"], ["cloud"]]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("Enter with focus on a model row still picks the highlighted row", () => {
    const { onSelect } = renderModal();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ providerID: "llmrouter", modelID: "auto" });
  });

  test("with no edit handler, as in Scheduled, no pencil shows", () => {
    renderModal({ withEdit: false });
    expect(screen.queryByTestId("model-picker-edit-local")).toBeNull();
    expect(screen.queryByTestId("model-picker-edit-cloud")).toBeNull();
  });
});
