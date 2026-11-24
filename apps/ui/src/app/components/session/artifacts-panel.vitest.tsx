import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test } from "vitest";

import ArtifactsPanel from "./artifacts-panel";

const artifacts = ["notes.md", "config.jsonc", "recording.mp3", "archive.zip"];

function previewButtonFor(fileName: string): HTMLButtonElement | null {
  const label = screen.getByText(fileName);
  const row = label.closest(".group");
  return row?.querySelector<HTMLButtonElement>('button[aria-label="Preview"]') ?? null;
}

afterEach(() => cleanup());

describe("ArtifactsPanel preview buttons", () => {
  test("only offers Preview for files supported by the shared workspace classifier", () => {
    render(() => <ArtifactsPanel files={artifacts} onPreview={() => undefined} />);

    expect(previewButtonFor("notes.md")).not.toBeNull();
    expect(previewButtonFor("config.jsonc")).not.toBeNull();
    expect(previewButtonFor("recording.mp3")).toBeNull();
    expect(previewButtonFor("archive.zip")).toBeNull();
  });
});