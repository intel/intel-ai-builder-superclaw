import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test } from "vitest";

import SkillsView from "./skills";
import type { SkillsViewProps } from "./skills.types";
import { t } from "../../i18n";

afterEach(cleanup);

const PRESET_BODY = "# My Skill\n\nAdd usage instructions here.";

type SaveSkill = SkillsViewProps["saveSkill"];

function renderSkills(saveSkill: SaveSkill) {
  const noopResult = async () => ({ ok: true, message: "" });
  const props: SkillsViewProps = {
    workspaceName: "test",
    busy: false,
    canInstallSkillCreator: false,
    canUseDesktopTools: false,
    canImportLocalSkill: false,
    canUninstallSkill: false,
    canEditSkill: false,
    refreshSkills: () => {},
    refreshHubSkills: () => {},
    skills: [],
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
    readSkill: async () => null,
    saveSkill,
    openNewTask: () => {},
    setPrompt: () => {},
  };
  render(() => <SkillsView {...props} />);
}

const nameInput = () => screen.getByPlaceholderText("my-skill") as HTMLInputElement;
const bodyInput = () => {
  const el = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="# My Skill"]');
  if (!el) throw new Error("skill body textarea not found");
  return el;
};
const createButton = () => screen.getByText(t("skills.create_action"));

describe("SkillsView create form", () => {
  test("a create with no edits during the save resets the form to its preset text", async () => {
    renderSkills(async () => ({ ok: true, message: "" }));

    fireEvent.input(nameInput(), { target: { value: "my-skill" } });
    fireEvent.input(bodyInput(), { target: { value: "# Custom\n\nCustom body." } });
    fireEvent.click(createButton());

    const banner = await screen.findByTestId("skill-create-success");
    expect(banner.textContent).toContain(t("skills.create_success").replace("{name}", "my-skill"));
    expect(nameInput().value).toBe("");
    expect(bodyInput().value).toBe(PRESET_BODY);
  });

  test("text typed while the save is pending is kept", async () => {
    let finishSave: (result: { ok: boolean; message: string }) => void = () => {};
    renderSkills(() => new Promise((resolve) => (finishSave = resolve)));

    fireEvent.input(nameInput(), { target: { value: "my-skill" } });
    fireEvent.click(createButton());
    fireEvent.input(nameInput(), { target: { value: "next-skill" } });
    finishSave({ ok: true, message: "" });

    await screen.findByTestId("skill-create-success");
    expect(nameInput().value).toBe("next-skill");
  });
});
