import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";

import { setLocale } from "../../i18n";
import AutomationAgentSelect from "./scheduled.agent-select";

afterEach(() => {
  cleanup();
  setLocale("en");
});

function renderSelect(initial: { value: string; options: string[] }) {
  const [value, setValue] = createSignal(initial.value);
  const [options, setOptions] = createSignal<string[]>(initial.options);
  render(() => (
    <AutomationAgentSelect value={value()} options={options()} defaultLabel="Default agent" onChange={setValue} />
  ));
  const trigger = screen.getByTestId("scheduler-agent-select");
  const openDropdown = () => fireEvent.click(trigger);
  const listOptions = () => screen.getAllByTestId("scheduler-agent-option");
  return { trigger, value, setOptions, openDropdown, listOptions };
}

describe("AutomationAgentSelect", () => {
  // #2865: the editor opens with the stored agent before the roster loads. The
  // trigger used to fall back to "Default" when the roster replaced the
  // placeholder option, and the next save reset the automation to the default agent.
  test("keeps showing the stored agent after the roster loads", () => {
    const { trigger, value, setOptions, openDropdown, listOptions } = renderSelect({ value: "build", options: [] });
    expect(trigger.textContent).toContain("Build");

    setOptions(["SuperClaw_PM", "build"]);
    expect(trigger.textContent).toContain("Build");
    expect(value()).toBe("build");

    openDropdown();
    expect(listOptions().filter((option) => option.textContent?.includes("Build"))).toHaveLength(1);
  });

  test("shows the default option when no agent is stored", () => {
    const { setOptions, openDropdown, listOptions } = renderSelect({ value: "", options: [] });
    setOptions(["build"]);

    openDropdown();
    expect(listOptions()[0]?.textContent).toBe("Default agent");
  });

  test("keeps a stored agent that is missing from the roster", () => {
    const { trigger, openDropdown, listOptions } = renderSelect({ value: "retired-agent", options: ["build"] });
    expect(trigger.textContent).toContain("retired-agent");

    openDropdown();
    expect(listOptions().some((option) => option.textContent?.includes("retired-agent"))).toBe(true);
  });

  test("reports the user's choice", () => {
    const { trigger, value, openDropdown, listOptions } = renderSelect({ value: "", options: ["build", "SuperClaw_PM"] });
    openDropdown();
    const target = listOptions().find((option) => option.textContent?.includes("SuperClaw_PM"));
    expect(target).toBeTruthy();
    fireEvent.click(target!);

    expect(value()).toBe("SuperClaw_PM");
    expect(trigger.textContent).toContain("SuperClaw_PM");
  });

  test("humanizes known built-in agent ids, leaving unknown names unchanged", () => {
    const { openDropdown, listOptions } = renderSelect({
      value: "",
      options: ["build", "plan", "email-agent", "hybrid-deep-research", "SuperClaw_PM"],
    });
    openDropdown();
    const labels = listOptions().map((option) => option.textContent);
    expect(labels).toContain("Build");
    expect(labels).toContain("Plan");
    expect(labels).toContain("Email");
    expect(labels).toContain("Hybrid Deep Research");
    expect(labels).toContain("SuperClaw_PM");
  });

  test("localizes built-in agent names", () => {
    setLocale("zh");
    const { openDropdown, listOptions } = renderSelect({ value: "", options: ["email-agent", "SuperClaw_PM"] });
    openDropdown();
    const labels = listOptions().map((option) => option.textContent);
    expect(labels).toContain("邮件");
    expect(labels).toContain("SuperClaw_PM");
  });
});
