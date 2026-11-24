import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";

import { setLocale, t } from "../../i18n";
import { PlatformProvider } from "../context/platform";
import type { AgentLabSchedulePayload, OpenworkServerClient } from "../lib/openwork-server";
import ScheduledTasksView, { type ScheduledTasksViewProps } from "./scheduled";

afterEach(() => {
  cleanup();
  setLocale("en");
});

function renderScheduler(overrides: Partial<ScheduledTasksViewProps> = {}) {
  render(() => (
    <PlatformProvider value={{ platform: "web", openLink: () => {}, restart: async () => {}, notify: async () => {} }}>
      <ScheduledTasksView
        jobs={[]}
        source="remote"
        sourceReady={true}
        status={null}
        busy={false}
        lastUpdatedAt={null}
        refreshJobs={() => {}}
        deleteJob={() => {}}
        isWindows={false}
        activeWorkspaceRoot="/workspace"
        openNewTask={() => {}}
        setPrompt={() => {}}
        newTaskDisabled={false}
        schedulerInstalled={true}
        canEditPlugins={false}
        addPlugin={() => {}}
        reloadWorkspaceEngine={async () => {}}
        reloadBusy={false}
        canReloadWorkspace={false}
        openworkServerClient={null}
        openworkServerWorkspaceId={null}
        selectedModel={null}
        modelOptions={[]}
        openProviderAuthModal={async () => {}}
        providerAuthModalOpen={false}
        {...overrides}
      />
    </PlatformProvider>
  ));
}

test("localizes the empty weekday selection message", () => {
  expect(t("scheduled.select_at_least_one_day")).toBe("Select at least one day.");
  setLocale("zh");
  expect(t("scheduled.select_at_least_one_day")).toBe("请至少选择一天。");
});

test("saves Mon/Wed/Fri as a multi-day schedule", async () => {
  const submitted: AgentLabSchedulePayload[] = [];
  const client = {
    listAgentLabAutomations: async () => ({ items: [], updatedAt: 0 }),
    withAutoApproval: async (action: () => Promise<unknown>) => action(),
    createAgentLabAutomation: async (_workspaceId: string, payload: Parameters<OpenworkServerClient["createAgentLabAutomation"]>[1]) => {
      submitted.push(payload.schedule);
      return { items: [], updatedAt: 0 };
    },
  } as unknown as OpenworkServerClient;
  renderScheduler({ openworkServerClient: client, openworkServerWorkspaceId: "workspace-1" });

  fireEvent.click(screen.getByRole("button", { name: "New Scheduler" }));
  fireEvent.input(screen.getByPlaceholderText("e.g. Daily bug scan"), { target: { value: "Daily scan" } });
  fireEvent.input(screen.getByPlaceholderText("e.g. Scan recent commits and flag riskier diffs."), { target: { value: "Scan commits" } });
  fireEvent.click(screen.getByRole("button", { name: "Tu" }));
  fireEvent.click(screen.getByRole("button", { name: "Th" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => expect(submitted).toEqual([{ kind: "days", weekdays: [1, 3, 5], hour: 9, minute: 0 }]));
});

test("reports detail-panel state to the dashboard backdrop", () => {
  const openStates: boolean[] = [];
  renderScheduler({
    onDetailsOpenChange: (open) => openStates.push(open),
    jobs: [
      {
        slug: "first",
        name: "First scheduler",
        schedule: "0 9 * * *",
        createdAt: new Date(0).toISOString(),
        source: "legacy",
      },
      {
        slug: "second",
        name: "Second scheduler",
        schedule: "0 10 * * *",
        createdAt: new Date(0).toISOString(),
        source: "legacy",
      },
    ],
  });

  fireEvent.click(screen.getByText("First scheduler"));
  expect(screen.getByRole("dialog", { name: "First scheduler" })).toBeTruthy();
  expect(openStates.at(-1)).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(openStates.at(-1)).toBe(false);
});

test("clears dashboard backdrop when the open scheduler disappears", async () => {
  const openStates: boolean[] = [];
  const job = { slug: "first", name: "First scheduler", schedule: "0 9 * * *", createdAt: new Date(0).toISOString(), source: "legacy" };
  const [jobs, setJobs] = createSignal([job]);
  renderScheduler({
    onDetailsOpenChange: (open) => openStates.push(open),
    get jobs() {
      return jobs();
    },
  });

  fireEvent.click(screen.getByText("First scheduler"));
  expect(openStates.at(-1)).toBe(true);
  setJobs([]);
  await waitFor(() => expect(openStates.at(-1)).toBe(false));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("flags a legacy daily record for review and resaves it as a multi-day schedule", async () => {
  const submitted: AgentLabSchedulePayload[] = [];
  const client = {
    listAgentLabAutomations: async () => ({
      items: [
        {
          id: "legacy_daily",
          name: "Legacy daily",
          enabled: true,
          schedule: { kind: "daily", hour: 9, minute: 0 },
          prompt: "do stuff",
          createdAt: Date.now(),
        },
      ],
      updatedAt: 0,
    }),
    withAutoApproval: async (action: () => Promise<unknown>) => action(),
    createAgentLabAutomation: async (_workspaceId: string, payload: Parameters<OpenworkServerClient["createAgentLabAutomation"]>[1]) => {
      submitted.push(payload.schedule);
      return { items: [], updatedAt: 0 };
    },
  } as unknown as OpenworkServerClient;
  renderScheduler({ openworkServerClient: client, openworkServerWorkspaceId: "workspace-1" });

  await waitFor(() => expect(screen.getByText("Legacy daily")).toBeTruthy());
  // This record predates multi-day schedules; only the badge/notice flag it, nothing
  // rewrites it without the user opening Edit and saving.
  expect(screen.getByText(t("scheduled.needs_day_review_badge"))).toBeTruthy();

  fireEvent.click(screen.getByLabelText("More actions"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));

  expect(screen.getByRole("status").textContent).toBe(
    "This schedule runs every day. If you meant fewer days, select them and save.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(submitted).toEqual([{ kind: "days", weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 9, minute: 0 }]),
  );
});

describe("scheduler interval input", () => {
  test("rejects fractional minutes without silently changing the value", () => {
    const submitted: string[] = [];
    renderScheduler({ setPrompt: (value) => { submitted.push(value); } });

    fireEvent.click(screen.getByRole("button", { name: "New Scheduler" }));
    fireEvent.input(screen.getByPlaceholderText("e.g. Daily bug scan"), { target: { value: "Daily scan" } });
    fireEvent.input(screen.getByPlaceholderText("e.g. Scan recent commits and flag riskier diffs."), { target: { value: "Scan commits" } });
    for (const day of ["Mo", "Tu", "We", "Th", "Fr"]) {
      fireEvent.click(screen.getByRole("button", { name: day }));
    }
    expect(screen.getByRole("alert").textContent).toBe("Select at least one day.");
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Interval" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));
    expect(screen.getByRole("alert").textContent).toBe("Select at least one day.");
    fireEvent.click(screen.getByRole("button", { name: "Mo" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Interval" }));

    const input = screen.getByRole("textbox", { name: "Interval" }) as HTMLInputElement;
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    fireEvent.input(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(create.disabled).toBe(true);

    for (const value of ["0", "-1", "abc", "1."]) {
      fireEvent.focus(input);
      fireEvent.input(input, { target: { value } });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(create.disabled).toBe(true);
      fireEvent.blur(input);
      expect(screen.getByRole("alert").textContent).toContain("whole number");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toBe("scheduler-interval-error");
    }

    fireEvent.focus(input);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.input(input, { target: { value: "." } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(create.disabled).toBe(true);

    fireEvent.input(input, { target: { value: "1." } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(create.disabled).toBe(true);

    fireEvent.input(input, { target: { value: "1441" } });
    expect(screen.getByRole("alert").textContent).toContain("1440");
    expect(create.disabled).toBe(true);

    fireEvent.input(input, { target: { value: "1.5" } });
    expect(input.value).toBe("1.5");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("whole number");
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(submitted).toHaveLength(0);

    fireEvent.input(input, { target: { value: "2" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(submitted).toHaveLength(1);
  });
});