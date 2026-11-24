/**
 * Image links in the file preview's markdown renderer. Parses the output into
 * a DOM, so it runs in the vitest lane.
 */
import { marked } from "marked";
import { describe, expect, test } from "vitest";

import { MAX_IMAGE_BASE64_CHARS } from "../pages/session.file-preview.images";
import { createPreviewRenderer } from "./file-preview-modal";

const renderToDom = (source: string, images?: ReadonlyMap<string, string>) => {
  const root = document.createElement("div");
  root.innerHTML = String(
    marked.parse(source, { breaks: true, gfm: true, renderer: createPreviewRenderer("light", { images }), async: false }),
  );
  return root;
};

describe("file preview image links", () => {
  test("draws a relative link from the loaded images", () => {
    const root = renderToDom("![chart](img/chart.png)", new Map([["img/chart.png", "data:image/png;base64,UE5H"]]));
    const img = root.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,UE5H");
    expect(img?.getAttribute("alt")).toBe("chart");
  });

  test("shows the alt text, not an empty image, for a link that was not loaded or is refused", () => {
    for (const source of ["![the chart](chart.png)", "![the chart](http://127.0.0.1:8080/chart.png)"]) {
      const root = renderToDom(source, new Map());
      expect(root.querySelector("img")).toBeNull();
      expect(root.textContent?.trim()).toBe("the chart");
    }
  });

  test("still draws https and data image links without a lookup", () => {
    const root = renderToDom("![a](https://example.com/a.png) ![b](data:image/png;base64,AAAA)");
    expect([...root.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "https://example.com/a.png",
      "data:image/png;base64,AAAA",
    ]);
  });

  test("copies loaded images into the page only up to the loader's budget, however often a link repeats", () => {
    const uri = `data:image/png;base64,${"A".repeat(Math.floor(MAX_IMAGE_BASE64_CHARS * 0.4))}`;
    const root = renderToDom(
      "![one](big.png) ![two](big.png) ![three](big.png) ![inline](data:image/png;base64,AAAA)",
      new Map([["big.png", uri]]),
    );
    expect([...root.querySelectorAll("img")].map((img) => img.getAttribute("alt"))).toEqual(["one", "two", "inline"]);
    expect(root.textContent).toContain("three");
  });
});
