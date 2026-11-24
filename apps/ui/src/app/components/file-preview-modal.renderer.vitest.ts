/**
 * The file preview's markdown renderer. Parses the output into a DOM, so it
 * runs in the vitest lane.
 */
import { marked } from "marked";
import { describe, expect, test } from "vitest";

import { createPreviewRenderer } from "./file-preview-modal";

const renderToDom = (source: string) => {
  const html = String(
    marked.parse(source, { breaks: true, gfm: true, renderer: createPreviewRenderer("light"), async: false }),
  );
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe("file preview svg fences", () => {
  test("draws an svg fence as an image with its source in a collapsed toggle", () => {
    const root = renderToDom(fence("svg", svg));
    expect(root.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    );
    const details = root.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("code")?.textContent).toBe(svg);
    expect(root.querySelector("svg")).toBeNull();
  });

  test("an svg carrying script or handlers adds no live script or handler", () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';
    const root = renderToDom(fence("svg", hostile));
    expect(root.querySelector("script, svg")).toBeNull();
    for (const el of root.querySelectorAll("*")) {
      expect(el.getAttributeNames().filter((name) => name.startsWith("on"))).toEqual([]);
    }
    expect(root.querySelector("img")?.getAttribute("src")).toContain(encodeURIComponent(hostile));
  });

  test("a malformed svg fence falls back to the code card", () => {
    const root = renderToDom(fence("svg", "<svg viewBox"));
    expect(root.querySelector("img, details")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe("<svg viewBox");
  });

  test("an svg with malformed xml keeps its source readable", () => {
    const masked = '<svg xmlns="http://www.w3.org/2000/svg"><text><ORG_1></text></svg>';
    const root = renderToDom(fence("svg", masked));
    expect(root.querySelector("img, details")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe(masked);
  });

  test("other fences render as before", () => {
    const root = renderToDom(fence("ts", "const x = 1;"));
    expect(root.querySelector("img, details")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe("const x = 1;");
  });
});
