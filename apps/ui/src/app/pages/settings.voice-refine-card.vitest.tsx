/**
 * Settings → Voice input → LLM clean-up card.
 *
 * Needs a DOM (a switch, a radio group, two disabled-with-a-reason states), so
 * it runs in the vitest lane rather than under `bun test`. The pure decision this
 * card's preference feeds is covered in
 * `features/voice-input/dictation-refine-policy.test.ts`.
 *
 * What is actually asserted here is the explained-never-hidden rule, in each of
 * the ways this card can be unusable. Hiding a control would make a setting the
 * user already chose look lost, and would give them nothing to act on — so each
 * one stays on screen with its reason next to it. The on-device option goes
 * further and stays *selectable* under its reason; that asymmetry has its own
 * test, since it is the thing a later "tidy-up" would most plausibly undo.
 */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, test } from "vitest";

import type { LlmRouterProviderModel } from "~/app/lib/llmrouter-client";
import type {
  DictationRefineMode,
  ReasoningHintAction,
  VoiceInputController,
  VoiceInputMode,
} from "~/features/voice-input";

import { t } from "../../i18n";

import VoiceRefineCard from "./settings.voice-refine-card";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

/**
 * Signal-backed, because every behaviour worth testing here is a reaction:
 * flipping the switch enables the modes, and choosing a mode moves the radio.
 */
function renderCard(options?: {
  mode?: VoiceInputMode;
  localAvailable?: boolean;
  refineAvailable?: boolean;
  enabled?: boolean;
  refineMode?: DictationRefineMode;
  openRouterReady?: boolean;
  openRouterChecked?: boolean;
  localReady?: boolean;
  localChecked?: boolean;
  /**
   * The reasoning reminder's verdict, already decided. The gating itself is a
   * pure function covered under `bun test`; this lane only has to render each
   * arm of it, so the decision is injected rather than re-derived here.
   */
  reasoningHint?: ReasoningHintAction;
  agentModelId?: string;
  /** The model already chosen for `preset` mode; defaults to the shipped default. */
  chosenModel?: string;
  /** What the host reports as its default clean-up model; "" means it has not answered. */
  hostDefaultModel?: string;
  /** The OpenRouter catalog the picker is populated from. */
  models?: LlmRouterProviderModel[];
  modelsLoading?: boolean;
  modelsFailed?: boolean;
}) {
  const [enabled, setEnabled] = createSignal(options?.enabled ?? false);
  const [refineMode, setRefineMode] = createSignal<DictationRefineMode>(
    options?.refineMode ?? "agent",
  );
  const [refineModel, setRefineModel] = createSignal(
    options?.chosenModel ?? "minimax/minimax-m3",
  );
  const [dismissedFor, setDismissedFor] = createSignal<string | null>(null);
  const reasoningHint = options?.reasoningHint;
  const agentModelId = options?.agentModelId ?? "google/gemini-2.5-pro";
  const refreshes: number[] = [];
  const catalogRequests: number[] = [];

  const voice = {
    mode: () => options?.mode ?? "local",
    localAvailable: () => options?.localAvailable ?? true,
    refineAvailable: () => options?.refineAvailable ?? true,
    refineEnabled: enabled,
    refineMode,
    refineOpenRouterReady: () => options?.openRouterReady ?? true,
    refineOpenRouterChecked: () => options?.openRouterChecked ?? true,
    refineLocalReady: () => options?.localReady ?? true,
    refineLocalChecked: () => options?.localChecked ?? true,
    // Recorded, not ignored: "did the card re-ask?" is the whole subject of the
    // stale-probe test below.
    refreshRefineProbes: () => {
      refreshes.push(1);
    },
    refineModel,
    refineDefaultModel: () => options?.hostDefaultModel ?? "minimax/minimax-m3",
    refineModelOptions: () => options?.models ?? [],
    refineModelsLoading: () => options?.modelsLoading ?? false,
    refineModelsFailed: () => options?.modelsFailed ?? false,
    // Also recorded: "did the card avoid fetching 389 models?" is the subject of
    // the lazy-load tests below.
    ensureRefineModels: () => {
      catalogRequests.push(1);
    },
    // Honours the dismissal locally, so the test can assert that one click
    // actually retires the reminder rather than only that a callback fired.
    refineReasoningHint: () =>
      reasoningHint && !dismissedFor()
        ? ({
            show: true,
            action: reasoningHint,
            modelId: agentModelId,
          } as const)
        : ({ show: false } as const),
    setRefineEnabled: setEnabled,
    setRefineMode: (next: DictationRefineMode) => setRefineMode(next),
    setRefineModel: (next: string) => setRefineModel(next),
    useRecommendedRefineModel: () => {
      setRefineMode("preset");
      setRefineModel("minimax/minimax-m3");
    },
    dismissRefineReasoningHint: () =>
      setDismissedFor(agentModelId),
  } as unknown as VoiceInputController;

  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <VoiceRefineCard voice={voice} />, host);

  const find = <T extends HTMLElement>(testId: string): T | null =>
    host.querySelector<T>(`[data-testid=${testId}]`);
  const need = <T extends HTMLElement>(testId: string): T => {
    const node = find<T>(testId);
    // Throwing beats a `!` assertion: a missing node is the failure this test
    // would otherwise report as "cannot read property of null" three lines later.
    if (!node) throw new Error(`missing [data-testid=${testId}]`);
    return node;
  };

  return {
    host,
    enabled,
    refineMode,
    refineModel,
    dismissedFor,
    refreshes,
    catalogRequests,
    find,
    toggle: () => need<HTMLButtonElement>("voice-refine-toggle"),
    agent: () => need<HTMLInputElement>("voice-refine-mode-agent"),
    local: () => need<HTMLInputElement>("voice-refine-mode-local"),
    preset: () => need<HTMLInputElement>("voice-refine-mode-preset"),
    modelInput: () => need<HTMLInputElement>("voice-refine-model-input"),
    modelOptions: () =>
      [...host.querySelectorAll<HTMLElement>("[data-testid=voice-refine-model-option]")].map(
        (node) => node.textContent?.trim() ?? "",
      ),
  };
}

const CATALOG: LlmRouterProviderModel[] = [
  { id: "minimax/minimax-m3", name: "MiniMax M3", release_date: "" },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", release_date: "" },
  { id: "qwen/qwen3-max", name: "Qwen3 Max", release_date: "" },
];

describe("a probe that went stale while the user was elsewhere", () => {
  test("the card re-asks on mount", () => {
    // THE REGRESSION. Both probes are keyed on the hub, and the OpenRouter key
    // and the agent's cloud model are set on the Model Routing page, which emits
    // nothing this card could subscribe to. Without a re-ask, connecting
    // OpenRouter left the second option disabled under a message telling the
    // user to do what they had just done, with an app restart as the only way
    // out -- reproduced on the installed build while GET /cloud/providers was
    // already returning api_key_set: true.
    const card = renderCard();

    expect(card.refreshes.length).toBe(1);
  });

  test("a configured key enables the option, which is what the re-ask buys", () => {
    const ready = renderCard({ enabled: true, openRouterReady: true });
    expect(ready.preset().disabled).toBe(false);
    expect(ready.find("voice-refine-mode-preset-blocked")).toBeNull();

    const notReady = renderCard({ enabled: true, openRouterReady: false });
    expect(notReady.preset().disabled).toBe(true);
    expect(notReady.find("voice-refine-mode-preset-blocked")?.textContent).toContain(
      t("voice.refine_mode_preset_blocked"),
    );
  });
});

describe("the default state", () => {
  test("clean-up is off, and the modes are disabled rather than gone", () => {
    const card = renderCard();

    expect(card.toggle().getAttribute("aria-checked")).toBe("false");
    expect(card.agent().disabled).toBe(true);
    expect(card.local().disabled).toBe(true);
    expect(card.preset().disabled).toBe(true);
    // Every option is still readable, so the user can see what they would get.
    expect(card.host.textContent).toContain(t("voice.refine_mode_agent_title"));
    expect(card.host.textContent).toContain(t("voice.refine_mode_local_title"));
    expect(card.host.textContent).toContain(t("voice.refine_mode_preset_title"));
  });

  test("the tradeoff is on the card, not only in a dialog", () => {
    // What leaves the machine and the extra second per dictation are the two
    // facts that decide whether turning this on is right.
    const card = renderCard();

    expect(card.host.textContent).toContain(t("voice.refine_desc"));
    expect(card.find("voice-refine-failure-note")?.textContent).toContain(
      t("voice.refine_failure_note"),
    );
  });
});

describe("turning clean-up on", () => {
  test("writes the preference and releases the modes", () => {
    const card = renderCard();

    card.toggle().click();

    expect(card.enabled()).toBe(true);
    expect(card.agent().disabled).toBe(false);
    expect(card.local().disabled).toBe(false);
    expect(card.preset().disabled).toBe(false);
  });

  test("choosing the OpenRouter option records it", () => {
    const card = renderCard({ enabled: true });

    card.preset().click();

    expect(card.refineMode()).toBe("preset");
  });
});

describe("no OpenRouter key", () => {
  test("the option is disabled with its reason, and the agent one still works", () => {
    const card = renderCard({ enabled: true, openRouterReady: false });

    expect(card.preset().disabled).toBe(true);
    expect(card.find("voice-refine-mode-preset-blocked")?.textContent).toContain(
      t("voice.refine_mode_preset_blocked"),
    );
    // The feature itself is not blocked — only the one mode that needs a key.
    expect(card.agent().disabled).toBe(false);
    expect(card.find("voice-refine-unavailable")).toBeNull();
  });

  test("no reason is shown while the probe has not answered yet", () => {
    // A reason that appears and then withdraws itself a second after the page
    // opens reads as a bug.
    const card = renderCard({ enabled: true, openRouterReady: false, openRouterChecked: false });

    expect(card.find("voice-refine-mode-preset-blocked")).toBeNull();
    expect(card.preset().disabled).toBe(false);
  });
});

describe("the on-device option", () => {
  test("it sits between the default and the bring-your-own-key option", () => {
    // The group reads top-to-bottom as "how much setup does this need". Asserted
    // on DOM order rather than left to the eye, because the order is the
    // argument: `local` first would read as a recommendation the default does not
    // back up, and `local` last would bury the only option that keeps a dictation
    // off the network under the one that needs a credential.
    const card = renderCard({ enabled: true });
    const radios = [...card.host.querySelectorAll<HTMLInputElement>("input[type=radio]")];

    expect(radios.map((node) => node.value)).toEqual(["agent", "local", "preset"]);
  });

  test("choosing it records it", () => {
    const card = renderCard({ enabled: true });

    card.local().click();

    expect(card.refineMode()).toBe("local");
  });

  test("it carries no model picker, because there is nothing to pick", () => {
    // Which local model exists is the hardware -> bundle -> Binding chain's
    // decision (AGENTS.md §5c). A chooser here would imply this card can
    // override a decision it must not even read.
    //
    // Scoped to each option's own box rather than asserted against the whole
    // card: the picker is always MOUNTED (disabled when its option is not
    // selected), so a card-wide "is it absent?" would be testing the wrong
    // thing — it would pass today and keep passing if the picker were moved
    // into the local box tomorrow.
    const card = renderCard({ enabled: true, refineMode: "local", models: CATALOG });
    const box = (radio: HTMLInputElement) => radio.closest("div.rounded-inset");

    expect(box(card.local())?.querySelector("[data-testid=voice-refine-model-input]")).toBeNull();
    // ...and it is where it belongs, so this is a placement assertion rather
    // than a "nothing renders" one.
    expect(
      box(card.preset())?.querySelector("[data-testid=voice-refine-model-input]"),
    ).not.toBeNull();
  });

  test("with no local model it is EXPLAINED but still selectable", () => {
    // THE DIFFERENCE FROM THE OPENROUTER OPTION, and it is deliberate. This is
    // the only mode that keeps a dictation off the network, and LLMRouter can
    // report a null primary bundle during a startup or model-switch window -- so
    // a probe that is briefly wrong must not be able to take the private choice
    // away. The user gets the reason and keeps the option; a dictation that
    // genuinely cannot be served fails to the raw transcript.
    const card = renderCard({ enabled: true, localReady: false });

    expect(card.find("voice-refine-mode-local-blocked")?.textContent).toContain(
      t("voice.refine_mode_local_blocked"),
    );
    expect(card.local().disabled).toBe(false);
    // And the feature as a whole is not implicated by one unavailable mode.
    expect(card.find("voice-refine-unavailable")).toBeNull();
  });

  test("no reason is shown while the probe has not answered yet", () => {
    const card = renderCard({ enabled: true, localReady: false, localChecked: false });

    expect(card.find("voice-refine-mode-local-blocked")).toBeNull();
  });

  test("the copy promises no quality penalty it cannot evidence", () => {
    // On the reference measurements the 4B's clean-up is competitive with the
    // cloud preset (F1 90.5 vs 91.3; LLM-judge 95.8 vs 92.5). Copy apologising
    // for it would invent a tradeoff the numbers do not show, so the description
    // names the real variable -- speed follows the machine, not the network.
    const card = renderCard({ enabled: true });

    expect(card.host.textContent).toContain(t("voice.refine_mode_local_title"));
    expect(card.host.textContent).toContain(t("voice.refine_mode_local_desc"));
  });
});

describe("the clean-up model picker", () => {
  test("defaults to MiniMax M3, which is what the user asked for", () => {
    const card = renderCard({ enabled: true, refineMode: "preset", models: CATALOG });

    expect(card.modelInput().value).toBe("MiniMax M3");
  });

  test("it sits inside the option it configures, not at card level", () => {
    // A model picker floating under the heading "Which model cleans it up" reads
    // as configuring the user's AGENTS, which is the one misreading this card
    // spends most of its copy preventing.
    const card = renderCard({ enabled: true, refineMode: "preset", models: CATALOG });
    // The option's box is the radio label's parent; the picker has to be inside
    // it, so the two read as one setting.
    const optionBox = card.preset().closest("label")?.parentElement;

    expect(optionBox).not.toBeNull();
    expect(optionBox?.contains(card.modelInput())).toBe(true);
  });

  test("the picker is NOT inside the radio's label", () => {
    // THE REGRESSION. A `<label>` forwards every click inside it to its control,
    // so a combobox nested in one would re-select the radio on every option row
    // pressed in its popover.
    const card = renderCard({ enabled: true, refineMode: "preset", models: CATALOG });

    expect(card.modelInput().closest("label")).toBeNull();
  });

  test("typing filters the catalog and picking records the choice", () => {
    const card = renderCard({ enabled: true, refineMode: "preset", models: CATALOG });

    const input = card.modelInput();
    input.value = "gemini";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(card.modelOptions()).toEqual(["Gemini 2.5 Pro"]);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(card.refineModel()).toBe("google/gemini-2.5-pro");
  });

  test("it is disabled, not hidden, while the agent option is the chosen one", () => {
    // Disabled with no reason line of its own: the radio immediately above IS
    // the reason, and a sentence repeating it would be noise.
    const card = renderCard({ enabled: true, refineMode: "agent", models: CATALOG });

    expect(card.modelInput().disabled).toBe(true);
    expect(card.find("voice-refine-model-input")).not.toBeNull();
  });

  test("it is disabled while clean-up is off", () => {
    expect(renderCard({ refineMode: "preset", models: CATALOG }).modelInput().disabled).toBe(true);
  });

  test("it is disabled when there is no OpenRouter key", () => {
    const card = renderCard({ enabled: true, refineMode: "preset", openRouterReady: false });

    expect(card.modelInput().disabled).toBe(true);
  });
});

describe("the 389-model catalog", () => {
  test("is not fetched on a Settings open the user does not spend here", () => {
    // THE COST THIS GUARDS. A live OpenRouter key returns ~389 models. Fetching
    // them whenever the Dictation page opens — including the overwhelming
    // majority of visits, where clean-up is off or the agent model is chosen —
    // is a round trip spent on a list nobody is about to read.
    expect(renderCard().catalogRequests).toEqual([]);
    expect(renderCard({ enabled: true, refineMode: "agent" }).catalogRequests).toEqual([]);
    expect(
      renderCard({ enabled: true, refineMode: "preset", openRouterReady: false })
        .catalogRequests,
    ).toEqual([]);
  });

  test("is fetched once the picker can actually be used", () => {
    expect(
      renderCard({ enabled: true, refineMode: "preset" }).catalogRequests.length,
    ).toBeGreaterThan(0);
  });

  test("is fetched when the user selects the OpenRouter option, not before", () => {
    const card = renderCard({ enabled: true, refineMode: "agent" });
    expect(card.catalogRequests).toEqual([]);

    card.preset().click();

    expect(card.catalogRequests.length).toBeGreaterThan(0);
  });

  test("a catalog that will not load says the chosen model still works", () => {
    // Not "type an id instead": the combobox only commits a model from the list,
    // so promising a typed-id escape hatch would be copy for a control that is
    // not there.
    const card = renderCard({ enabled: true, refineMode: "preset", modelsFailed: true });

    expect(card.find("voice-refine-model-failed")?.textContent).toContain(
      t("voice.refine_model_failed"),
    );
    // The feature is not blocked by it — only browsing the catalog is.
    expect(card.find("voice-refine-unavailable")).toBeNull();
    expect(card.modelInput().value).toBe("minimax/minimax-m3");
  });

  test("while it loads, the card says so instead of looking empty", () => {
    const card = renderCard({ enabled: true, refineMode: "preset", modelsLoading: true });

    expect(card.find("voice-refine-model-loading")?.textContent).toContain(
      t("voice.refine_model_loading"),
    );
  });
});

describe("the reasoning-model reminder", () => {
  test("is absent when the gate said nothing to warn about", () => {
    expect(renderCard({ enabled: true }).find("voice-refine-reasoning-hint")).toBeNull();
  });

  test("names the model and stays out of the way", () => {
    const card = renderCard({ enabled: true, reasoningHint: "switch" });
    const hint = card.find("voice-refine-reasoning-hint");

    expect(hint?.textContent).toContain(t("voice.refine_reasoning_hint_title"));
    expect(hint?.textContent).toContain("google/gemini-2.5-pro");
    // A hint, not a dialog: it announces itself to a screen reader and traps
    // nothing. A `role="dialog"` here would block the page it sits on.
    expect(hint?.getAttribute("role")).toBe("status");
    // The controls it describes stay usable underneath it.
    expect(card.agent().disabled).toBe(false);
    expect(card.preset().disabled).toBe(false);
  });

  test("says it only repoints clean-up, and the one click proves it", () => {
    // The destructive surprise this guards against: changing the model the
    // user's agents run on from a dictation setting. The card must promise it
    // does not, and must not do it.
    //
    // The stub starts on a NON-default chosen model on purpose: the button's
    // copy is "Use MiniMax M3 for clean-up", so switching the mode without also
    // pinning the model would make the button lie about what it did.
    const card = renderCard({
      enabled: true,
      reasoningHint: "switch",
      chosenModel: "qwen/qwen3-max",
    });

    expect(card.find("voice-refine-reasoning-hint")?.textContent).toContain(
      t("voice.refine_reasoning_hint_scope"),
    );

    card.find<HTMLButtonElement>("voice-refine-reasoning-hint-switch")?.click();

    expect(card.refineMode()).toBe("preset");
    expect(card.refineModel()).toBe("minimax/minimax-m3");
    // And it retires itself, or the button would read as having failed.
    expect(card.find("voice-refine-reasoning-hint")).toBeNull();
  });

  test("one click on the dismiss control retires it", () => {
    const card = renderCard({ enabled: true, reasoningHint: "switch" });

    card.find<HTMLButtonElement>("voice-refine-reasoning-hint-dismiss")?.click();

    // Recorded against the model it was about, not as a blanket "never again".
    expect(card.dismissedFor()).toBe("google/gemini-2.5-pro");
    expect(card.find("voice-refine-reasoning-hint")).toBeNull();
    // Dismissing advice must not silently change the setting it was about.
    expect(card.refineMode()).toBe("agent");
  });

  test("a model the USER chose is named, and no button overwrites their choice", () => {
    // In `preset` mode the warning is about the pick, which sits in the field a
    // few lines above. A one-click "fix" that silently replaced it would be the
    // destructive surprise the scope line promises not to spring.
    const card = renderCard({
      enabled: true,
      refineMode: "preset",
      models: CATALOG,
      agentModelId: "google/gemini-2.5-pro",
      reasoningHint: "pick_other",
    });

    expect(card.find("voice-refine-reasoning-hint")?.textContent).toContain(
      "google/gemini-2.5-pro",
    );
    expect(card.find("voice-refine-reasoning-hint-pick-other")?.textContent).toContain(
      t("voice.refine_reasoning_hint_pick_other"),
    );
    expect(card.find("voice-refine-reasoning-hint-switch")).toBeNull();
    // Still dismissible, and dismissing it must not move the user's pick.
    card.find<HTMLButtonElement>("voice-refine-reasoning-hint-dismiss")?.click();
    expect(card.refineModel()).toBe("minimax/minimax-m3");
  });

  test("with no OpenRouter key it explains instead of offering a dead button", () => {
    const card = renderCard({
      enabled: true,
      openRouterReady: false,
      reasoningHint: "needs_key",
    });

    expect(card.find("voice-refine-reasoning-hint-switch")).toBeNull();
    expect(card.find("voice-refine-reasoning-hint-needs-key")?.textContent).toContain(
      t("voice.refine_reasoning_hint_needs_key"),
    );
    // Still dismissible — a warning the user cannot act on must at least be
    // closable, or it is permanent furniture.
    expect(card.find("voice-refine-reasoning-hint-dismiss")).not.toBeNull();
  });

  test("an install with no clean-up at all shows no advice about it", () => {
    // The probe runs regardless of whether this card can act on the answer.
    const card = renderCard({
      enabled: true,
      refineAvailable: false,
      reasoningHint: "switch",
    });

    expect(card.find("voice-refine-reasoning-hint")).toBeNull();
  });
});

describe("an install with no clean-up behind it", () => {
  test("the card says why and the switch is disabled, not hidden", () => {
    const card = renderCard({ refineAvailable: false });

    expect(card.find("voice-refine-card")).not.toBeNull();
    expect(card.find("voice-refine-unavailable")?.textContent).toContain(
      t("voice.refine_unavailable"),
    );
    expect(card.toggle().disabled).toBe(true);
  });

  test("cloud recognition gets its OWN reason, naming the engine chooser", () => {
    const card = renderCard({ mode: "cloud" });

    expect(card.toggle().disabled).toBe(true);
    // The distinction is the point, not a nicety. Nothing is missing on this
    // install, and the fix is one click on the engine chooser above — telling the
    // user that clean-up "is not set up on this installation" would send them
    // hunting for a fault that does not exist.
    expect(card.find("voice-refine-unavailable")?.textContent).toContain(
      t("voice.refine_local_mode_only"),
    );
    expect(card.find("voice-refine-unavailable")?.textContent).not.toContain(
      t("voice.refine_unavailable"),
    );
  });

  test("and so does the window before the catalog probe answers", () => {
    const card = renderCard({ localAvailable: false });

    expect(card.find("voice-refine-unavailable")).not.toBeNull();
    expect(card.toggle().disabled).toBe(true);
  });
});

describe("the Default badge on the clean-up model", () => {
  test("it marks the shipped default model", () => {
    const card = renderCard({ refineMode: "preset" });

    expect(card.find("voice-refine-model-default")?.textContent).toContain(
      t("voice.refine_model_default_badge"),
    );
  });

  test("it follows the host's default, not a constant in the UI", () => {
    const card = renderCard({
      refineMode: "preset",
      chosenModel: "google/gemini-2.5-pro",
      hostDefaultModel: "google/gemini-2.5-pro",
    });

    expect(card.find("voice-refine-model-default")).not.toBeNull();
  });

  test("it is absent until the host has reported a default", () => {
    // The picker is seeded with the shipped default before the preference read
    // answers; "Default" over that seed would be unconfirmed.
    const card = renderCard({ refineMode: "preset", hostDefaultModel: "" });

    expect(card.find("voice-refine-model-default")).toBeNull();
  });

  test("it is gone once another model is chosen", () => {
    const card = renderCard({ refineMode: "preset", chosenModel: "google/gemini-2.5-pro" });

    expect(card.find("voice-refine-model-default")).toBeNull();
  });
});
