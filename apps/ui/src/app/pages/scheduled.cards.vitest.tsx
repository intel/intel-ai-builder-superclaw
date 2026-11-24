import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { For, createSignal } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";

import { AutomationJobCard } from "./scheduled.cards";
import type { ScheduledJob } from "../types";
import { setLocale, t } from "../../i18n";
import { PlatformProvider } from "../context/platform";
import ScheduledTasksView, { type ScheduledTasksViewProps } from "./scheduled";

afterEach(() => {
  cleanup();
  setLocale("en");
});

function renderSchedulerAvailability(legacySchedulerSupported: boolean | null) {
  const props: ScheduledTasksViewProps = {
    jobs: [], source: "remote", sourceReady: true, status: null, busy: false,
    lastUpdatedAt: null, refreshJobs: () => {}, deleteJob: () => {}, isWindows: true,
    activeWorkspaceRoot: "/workspace", openNewTask: () => {}, setPrompt: () => {},
    newTaskDisabled: false, schedulerInstalled: false, canEditPlugins: false,
    addPlugin: () => {}, reloadWorkspaceEngine: async () => {}, reloadBusy: false,
    canReloadWorkspace: false, openworkServerClient: null, openworkServerWorkspaceId: null,
    selectedModel: null, modelOptions: [], openProviderAuthModal: async () => {},
    providerAuthModalOpen: false, legacySchedulerSupported,
  };
  render(() => (
    <PlatformProvider value={{ platform: "web", openLink: () => {}, restart: async () => {}, notify: async () => {} }}>
      <ScheduledTasksView {...props} />
    </PlatformProvider>
  ));
}

describe("Scheduler legacy availability", () => {
  test("shows a scoped notice without disabling automation creation", () => {
    renderSchedulerAvailability(false);
    expect(screen.getByText(t("scheduled.legacy_unsupported"))).toBeTruthy();
    const create = screen.getByRole("button", { name: "New Scheduler" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(screen.getByPlaceholderText("e.g. Daily bug scan")).toBeTruthy();
    expect(screen.queryByText("Scheduler is supported only on macOS and Linux.")).toBeNull();
  });

  test.each([true, null])("does not infer unsupported scheduling from a Windows client when support is %s", (supported) => {
    renderSchedulerAvailability(supported);
    expect(screen.queryByText(t("scheduled.legacy_unsupported"))).toBeNull();
  });

  test("localizes the unsupported notice", () => {
    setLocale("zh");
    renderSchedulerAvailability(false);
    expect(screen.getByText(t("scheduled.legacy_unsupported"))).toBeTruthy();
    expect(t("scheduled.legacy_unsupported")).toContain("在这里创建的日程");
  });
});

const makeJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  slug: "nightly-report",
  name: "Nightly report",
  schedule: "0 2 * * *",
  createdAt: "2024-01-01T00:00:00.000Z",
  source: "agentlab",
  ...overrides,
});

// Regression test for a reviewer-caught bug: agentLabAsJobs() in scheduled.tsx
// rebuilds every AgentLab job into a brand-new object on each poll/toggle, and
// <For> keys by object identity, so a row-local `expanded` signal inside
// AutomationJobCard got reset on every background poll even when that row's
// own data was unchanged. Expansion state now lives in the parent, keyed by
// slug, and is passed in as a prop -- this harness mimics that <For> re-key
// by swapping in a fresh job object (same slug) and asserting the row stays
// expanded because the *parent's* keyed state, not the row's own identity,
// drives it.
function Harness() {
  const [job, setJob] = createSignal(makeJob());
  const [expandedSlugs, setExpandedSlugs] = createSignal<ReadonlySet<string>>(new Set());
  const toggleExpanded = (slug: string) => {
    setExpandedSlugs((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };
  return (
    <>
      <button type="button" onClick={() => setJob(makeJob({ lastRunAt: new Date().toISOString() }))}>
        simulate poll
      </button>
      <For each={[job()]}>
        {(j) => (
          <AutomationJobCard
            job={j}
            supported={true}
            busy={false}
            running={false}
            enabled={true}
            expanded={expandedSlugs().has(j.slug)}
            onToggleExpanded={() => toggleExpanded(j.slug)}
            onDelete={() => {}}
            onRun={() => {}}
            onEdit={() => {}}
            onToggleEnabled={() => {}}
          />
        )}
      </For>
    </>
  );
}

describe("AutomationJobCard expansion state", () => {
  test("stays expanded across a <For> re-key with a new job object for the same slug", () => {
    render(() => <Harness />);

    fireEvent.click(screen.getByText("Nightly report"));
    expect(screen.getByText("No prompt or command found.")).toBeTruthy();

    fireEvent.click(screen.getByText("simulate poll"));

    expect(screen.getByText("No prompt or command found.")).toBeTruthy();
  });
});

function renderCard(overrides: { running?: boolean; onToggleEnabled?: () => void } = {}) {
  render(() => (
    <AutomationJobCard
      job={makeJob()}
      supported={true}
      busy={false}
      running={overrides.running ?? false}
      enabled={true}
      expanded={false}
      onToggleExpanded={() => {}}
      onDelete={() => {}}
      onRun={() => {}}
      onEdit={() => {}}
      onToggleEnabled={overrides.onToggleEnabled ?? (() => {})}
    />
  ));
}

describe("AutomationJobCard actions", () => {
  test("the overflow menu closes on Escape and on an outside click", () => {
    renderCard();
    const trigger = screen.getByLabelText("More actions");

    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("a live run blocks Run but still allows pausing", () => {
    let toggled = false;
    renderCard({ running: true, onToggleEnabled: () => (toggled = true) });

    expect((screen.getByLabelText("Running") as HTMLButtonElement).disabled).toBe(true);
    const toggle = screen.getByRole("switch") as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(toggled).toBe(true);
  });

  test("shows a review badge only for a record flagged needsDayReview", () => {
    render(() => (
      <AutomationJobCard
        job={makeJob({ needsDayReview: true })}
        supported={true}
        busy={false}
        running={false}
        enabled={true}
        expanded={false}
        onToggleExpanded={() => {}}
        onDelete={() => {}}
        onRun={() => {}}
        onEdit={() => {}}
        onToggleEnabled={() => {}}
      />
    ));
      const reviewBadge = screen.getByText("Check days").parentElement;
      expect(reviewBadge?.querySelector("svg")).toBeTruthy();
    cleanup();

    renderCard();
    expect(screen.queryByText("Check days")).toBeNull();
  });

  test("shows why a failed run was refused, and no reason once a run went through", () => {
    const reason = "Switch the automation's model to Auto or a local model.";
    const card = (job: ScheduledJob) => (
      <AutomationJobCard
        job={job}
        supported={true}
        busy={false}
        running={false}
        enabled={true}
        expanded={false}
        onToggleExpanded={() => {}}
        onDelete={() => {}}
        onRun={() => {}}
        onEdit={() => {}}
        onToggleEnabled={() => {}}
      />
    );
    render(() => card(makeJob({ lastRunStatus: "failed", lastRunError: reason })));
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    cleanup();

    render(() => card(makeJob({ lastRunStatus: "ran" })));
    expect(screen.queryByText(reason)).toBeNull();
  });
});

describe("AutomationJobCard details panel", () => {
  function renderWithPanel(
    job: ScheduledJob = makeJob(),
    onEdit: () => void = () => {},
    modelLabel?: string,
  ) {
    const [open, setOpen] = createSignal(false);
    render(() => (
      <AutomationJobCard
        job={job}
        supported={true}
        busy={false}
        running={false}
        enabled={true}
        modelLabel={modelLabel}
        expanded={open()}
        onToggleExpanded={() => setOpen((v) => !v)}
        onDelete={() => {}}
        onRun={() => {}}
        onEdit={onEdit}
        onToggleEnabled={() => {}}
      />
    ));
  }

  test("opens as a layered dialog and closes on Escape or an outside click", () => {
    renderWithPanel();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByText("Nightly report"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByText("Nightly report"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Edit from the panel closes it and opens the editor", () => {
    let edited = false;
    renderWithPanel(makeJob(), () => (edited = true));

    fireEvent.click(screen.getByText("Nightly report"));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText("Edit"));

    expect(edited).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("shows the selected agent and model in the details panel", () => {
    renderWithPanel(makeJob({ run: { agent: "email-agent", model: "llmrouter/model-id" } }), () => {}, "Friendly model title");
    fireEvent.click(screen.getByText("Nightly report"));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Agent Email")).toBeTruthy();
    expect(within(dialog).getByText("Model Friendly model title")).toBeTruthy();
  });

  test("shows Default when an AgentLab automation has no explicit agent", () => {
    renderWithPanel(makeJob());
    fireEvent.click(screen.getByText("Nightly report"));

    expect(within(screen.getByRole("dialog")).getByText("Agent Default")).toBeTruthy();
  });

  test("moves focus into the panel on open and restores it to the trigger on close", async () => {
    renderWithPanel();
    const trigger = screen.getByText("Nightly report").closest("button") as HTMLButtonElement;

    fireEvent.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Close")));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  test("does not fight focus when Edit takes over from the panel", () => {
    let edited = false;
    renderWithPanel(makeJob(), () => (edited = true));
    const trigger = screen.getByText("Nightly report").closest("button") as HTMLButtonElement;

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Edit"));

    expect(edited).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
  });
});
