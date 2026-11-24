import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, test } from "vitest";

import { PlatformProvider } from "../context/platform";
import SkillsView from "./skills";
import type { SkillsViewProps } from "./skills.types";

afterEach(cleanup);

const SKILL = { name: "demo", path: "/workspace/.opencode/skills/demo" };
const SKILL_MD = "---\nname: demo\ndescription: Does demo things\n---\n\n# Demo Skill\n\nUse **bold** here.\n";

function renderSkills(content = SKILL_MD) {
  const noopResult = async () => ({ ok: true, message: "" });
  const props: SkillsViewProps = {
    workspaceName: "test",
    busy: false,
    canInstallSkillCreator: false,
    canUseDesktopTools: false,
    canImportLocalSkill: false,
    canUninstallSkill: false,
    canEditSkill: true,
    refreshSkills: () => {},
    refreshHubSkills: () => {},
    skills: [SKILL],
    skillsStatus: null,
    skillsStatusTone: "info",
    hubSkills: [],
    hubSkillsStatus: null,
    hubRepo: null,
    hubRepos: [],
    importLocalSkill: async () => ({ ok: false }),
    importSkillFile: async () => ({ ok: false }),
    installSkillCreator: noopResult,
    installSkillFinder: noopResult,
    installHubSkill: noopResult,
    setHubRepo: () => {},
    addHubRepo: () => {},
    removeHubRepo: () => {},
    revealSkillsFolder: () => {},
    uninstallSkill: () => {},
    readSkill: async () => ({ ...SKILL, content }),
    saveSkill: noopResult,
    openNewTask: () => {},
    setPrompt: () => {},
  };
  render(() => (
    <PlatformProvider value={{ platform: "web", openLink: () => {}, restart: async () => {}, notify: async () => {} }}>
      <SkillsView {...props} />
    </PlatformProvider>
  ));
}

const editorBody = () =>
  Array.from(document.querySelectorAll("textarea")).find((el) => el.value.includes("# Demo Skill"));

describe("SkillsView skill preview", () => {
  test("clicking a skill card renders SKILL.md as Markdown, not the editor", async () => {
    renderSkills();
    fireEvent.click(screen.getByTestId("skill-card"));

    const heading = await screen.findByRole("heading", { name: "Demo Skill" });
    expect(heading.tagName).toBe("H1");
    expect(document.querySelector("strong")?.textContent).toBe("bold");
    const frontmatter = document.querySelector("pre code");
    expect(frontmatter?.textContent).toContain("description: Does demo things");
    expect(heading.compareDocumentPosition(frontmatter as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editorBody()).toBeUndefined();
  });

  test("HTML in a link label stays text, while Markdown in it still renders", async () => {
    renderSkills(
      "---\nname: demo\ndescription: d\n---\n\n# Demo Skill\n\n" +
        "[<img src=x onerror=alert(1)><style>*{display:none}</style>](https://a.example)\n\n" +
        "[**bold label**](https://b.example)\n\n" +
        "See [https://c.example/a] here.\n",
    );
    fireEvent.click(screen.getByTestId("skill-card"));
    await screen.findByRole("heading", { name: "Demo Skill" });

    const injected = document.querySelector('a[href="https://a.example"]');
    expect(injected?.textContent).toBe("<img src=x onerror=alert(1)><style>*{display:none}</style>");
    expect(injected?.querySelector("img, style")).toBeNull();
    expect(document.querySelector('a[href="https://b.example"] strong')?.textContent).toBe("bold label");
    const bracketed = document.querySelector('a[href="https://c.example/a"]');
    expect(bracketed?.textContent).toBe("https://c.example/a");
    expect(bracketed?.nextSibling?.textContent?.startsWith("]")).toBe(true);
  });

  test("images load only over https: or as data:image/", async () => {
    renderSkills(
      "---\nname: demo\ndescription: d\n---\n\n# Demo Skill\n\n" +
        "![local](http://127.0.0.1:8080/ping.png)\n\n" +
        "![remote](https://img.example/a.png)\n\n" +
        "![inline](data:image/png;base64,iVBORw0KGgo=)\n",
    );
    fireEvent.click(screen.getByTestId("skill-card"));
    await screen.findByRole("heading", { name: "Demo Skill" });

    const src = (alt: string) => document.querySelector(`img[alt="${alt}"]`)?.getAttribute("src");
    expect(document.querySelector('img[alt="local"]')).toBeNull();
    expect(src("remote")).toBe("https://img.example/a.png");
    expect(src("inline")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  test("Enter on a focused skill card opens the preview", async () => {
    renderSkills();
    fireEvent.keyDown(screen.getByTestId("skill-card"), { key: "Enter" });

    await screen.findByRole("heading", { name: "Demo Skill" });
  });

  test("the preview's Edit action switches to the editor", async () => {
    renderSkills();
    fireEvent.click(screen.getByTestId("skill-card"));
    await screen.findByRole("heading", { name: "Demo Skill" });

    fireEvent.click(screen.getByTestId("skill-preview-edit-btn"));

    expect(editorBody()).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Demo Skill" })).toBeNull();
  });

  test.each(["Enter", " "])("%j on the pencil is left to the button, not taken by the card", (key) => {
    renderSkills();
    fireEvent.keyDown(screen.getByTitle("Edit"), { key });

    expect(screen.queryByTestId("skill-preview-edit-btn")).toBeNull();
  });

  test("the pencil button still opens the editor directly", async () => {
    renderSkills();
    fireEvent.click(screen.getByTitle("Edit"));

    await waitFor(() => expect(editorBody()).toBeDefined());
    expect(screen.queryByTestId("skill-preview-edit-btn")).toBeNull();
  });
});
