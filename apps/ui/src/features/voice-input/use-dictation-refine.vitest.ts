/**
 * `useDictationRefine`'s reactive half: the request target a dictation is sent
 * with, the two availability probes, the on-demand OpenRouter catalog, and which
 * model the reasoning probe asks about.
 *
 * WHY THIS LANE. Every one of those is an effect or depends on one, and effects
 * are inert under `bun test` (solid's `node` export condition resolves to the SSR
 * build). In particular the OpenRouter-key probe never runs there, so
 * `refineModeInUse` is permanently `agent` and the whole preset path — the one
 * this track added — is unreachable. The pure decision the hook feeds is covered
 * in `dictation-reasoning-hint.test.ts`.
 *
 * `globalThis.fetch` is stubbed rather than a client injected: outside Tauri
 * `resolveServiceHubFetch()` returns exactly that, so this exercises the real
 * request-building path in both clients instead of a seam invented for the test.
 */
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  VOICE_INPUT_REFINE_MODE_PREF_KEY,
  VOICE_INPUT_REFINE_PREF_KEY,
} from "~/shared/util/constants";

import { useDictationRefine } from "./use-dictation-refine";

const BASE = "http://127.0.0.1:1";

/** Lets the queued effects run and their promises settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const realFetch = globalThis.fetch;

type Harness = {
  refine: ReturnType<typeof useDictationRefine>;
  /** Every URL the hook asked for, in order. */
  urls: string[];
  /** Every model a preference PUT tried to store. */
  written: string[];
  /** What the fake host currently holds. */
  storedModel: () => string;
  dispose: () => void;
};

function mount(options?: {
  openRouterKey?: boolean;
  reasoning?: "yes" | "no" | "unknown";
  /** `false` is LLMRouter's "no local provider selected" — a null in the body. */
  localProvider?: boolean;
  /** Make the local-provider probe fail, which must leave `checked` false. */
  localProbeFails?: boolean;
  /** What the host already has stored for the clean-up model. */
  storedModel?: string;
  /** Make the preference PUT fail, so the picker must not adopt the value. */
  preferenceWriteFails?: boolean;
}): Harness {
  const urls: string[] = [];
  /** What the HOST holds. Seeded per test, mutated by a PUT. */
  let storedModel = options?.storedModel ?? "minimax/minimax-m3";
  /** Every model a PUT tried to store. */
  const written: string[] = [];
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/cloud/providers/openrouter/models")) {
      return json({
        data: [
          { id: "minimax/minimax-m3", name: "MiniMax M3", release_date: "" },
          { id: "qwen/qwen3-max", name: "Qwen3 Max", release_date: "" },
        ],
      });
    }
    if (url.includes("/cloud/providers")) {
      return json([{ id: "openrouter", api_key_set: options?.openRouterKey ?? true }]);
    }
    if (url.includes("/model-selections/local-provider")) {
      if (options?.localProbeFails) {
        return Promise.resolve(new Response("{}", { status: 500 }));
      }
      // `local_provider: null` is LLMRouter's own "local is not yet configured",
      // and is exactly what hides the `local-model` alias from the data plane.
      return json({
        available_providers: ["llamacpp", "edge"],
        local_provider: (options?.localProvider ?? true) ? "llamacpp" : null,
      });
    }
    if (url.includes("/cloud/model")) {
      return json({ provider: "openrouter", model: "openai/gpt-5" });
    }
    if (url.includes("/refine/preference")) {
      // The control plane that replaced the body field. A PUT records the write
      // and becomes what a later GET reports, so a test can assert "the picker
      // adopted what the HOST stored" rather than what it typed.
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        const asked = String(JSON.parse(String(init?.body ?? "{}")).model ?? "");
        written.push(asked);
        if (options?.preferenceWriteFails) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: "invalid_model" } }), { status: 400 }),
          );
        }
        // The host trims, so the echo is not necessarily what was sent.
        storedModel = asked.trim();
      }
      return json({ model: storedModel, default: "minimax/minimax-m3" });
    }
    if (url.includes("/refine/model")) {
      // Echoes the queried id back, exactly as the host does — which is what
      // lets the dismissal key on the model the warning named.
      const queried = new URL(url).searchParams.get("model") ?? "";
      return json({
        provider: "openrouter",
        model: queried,
        reasoning_support: options?.reasoning ?? "yes",
        recommended: { provider: "openrouter", model: "minimax/minimax-m3" },
      });
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof globalThis.fetch;

  let dispose = () => {};
  const refine = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return useDictationRefine(
      () => BASE,
      () => "token",
      () => true,
    );
  });
  return { refine, urls, written, storedModel: () => storedModel, dispose };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("the target one dictation is sent with", () => {
  test("agent mode omits the model entirely — it does not send an empty string", async () => {
    // THE CONTRACT WITH THE HOST. LRM's data plane accepts only its three
    // aliases, so a model id under `agent` mode is a 400 `invalid_model` and the
    // dictation degrades to raw ASR. An empty string is the same 400 from
    // asr_manager's own validator. Absent is the only correct shape.
    const harness = mount();
    await flush();

    expect(harness.refine.refineTarget()).toEqual({ mode: "agent" });
    expect("model" in harness.refine.refineTarget()).toBe(false);
    harness.dispose();
  });

  test("preset mode sends ONLY the mode — the model never travels", async () => {
    // THE SECURITY CHANGE, asserted at the request shape. `model` used to ride
    // along for `preset`. `/refine` sits on an unauthenticated port with
    // `LRM_HOST_API_KEY`, so that field was an arbitrary-model spend against the
    // user's key; the host refuses it now (400 `model_not_accepted`) and reads
    // the model from its own state instead.
    window.localStorage.setItem(VOICE_INPUT_REFINE_PREF_KEY, "on");
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "preset");
    const harness = mount({ storedModel: "qwen/qwen3-max" });
    await flush();

    expect(harness.refine.refineTarget()).toEqual({ mode: "preset" });
    expect("model" in harness.refine.refineTarget()).toBe(false);
    // The picker still shows the stored pick — it is read, just not sent.
    expect(harness.refine.refineModel()).toBe("qwen/qwen3-max");
    harness.dispose();
  });

  test("the picker shows what the HOST holds, not a renderer copy", async () => {
    // The value on screen has to be the value that will really be sent. A
    // `localStorage` copy could disagree with the file the service reads, and
    // the one on screen is the one the user would believe.
    const harness = mount({ storedModel: "google/gemini-2.5-pro" });
    await flush();

    expect(harness.refine.refineModel()).toBe("google/gemini-2.5-pro");
    expect(harness.urls.some((url) => url.includes("/refine/preference"))).toBe(true);
    harness.dispose();
  });

  test("the host's default is kept apart from the pick, and empty until it answers", async () => {
    const harness = mount({ storedModel: "google/gemini-2.5-pro" });
    // Before the preference read lands, the seeded model must not pass as a
    // confirmed default.
    expect(harness.refine.refineDefaultModel()).toBe("");
    await flush();

    expect(harness.refine.refineModel()).toBe("google/gemini-2.5-pro");
    expect(harness.refine.refineDefaultModel()).toBe("minimax/minimax-m3");
    harness.dispose();
  });

  test("with nothing stored the host's default is shown", async () => {
    const harness = mount();
    await flush();

    expect(harness.refine.refineModel()).toBe("minimax/minimax-m3");
    harness.dispose();
  });

  test("a stored preset with no OpenRouter key falls back to the agent model", async () => {
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "preset");
    const harness = mount({ openRouterKey: false, storedModel: "qwen/qwen3-max" });
    await flush();

    expect(harness.refine.refineTarget()).toEqual({ mode: "agent" });
    // The stored preference itself is untouched — the user may add the key later
    // and the card still shows what they chose. Untouched HOST-SIDE now: the
    // fallback changes which mode is sent, never what is stored.
    expect(harness.refine.refineModel()).toBe("qwen/qwen3-max");
    expect(harness.written).toEqual([]);
    harness.dispose();
  });

  test("local mode omits the model, because an alias IS the model", async () => {
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "local");
    // Deliberately with a stored OpenRouter pick on the host: it belongs to the
    // other mode, and no mode may carry a model on the wire any more.
    const harness = mount({ storedModel: "qwen/qwen3-max" });
    await flush();

    expect(harness.refine.refineTarget()).toEqual({ mode: "local" });
    expect("model" in harness.refine.refineTarget()).toBe(false);
    harness.dispose();
  });

  test("a stored local with NO local model still sends local — it never falls back", async () => {
    // THE ASYMMETRY WITH THE PRESET FALLBACK ABOVE, and the reason this test
    // exists. Falling back from `preset` to `agent` is safe because both are
    // cloud: the text was already leaving the machine and only the provider
    // changes. Falling back FROM `local` would change the answer from "nothing
    // leaves this machine" to "a cloud provider now has it" — the one property
    // the user picked the mode for — and it would do so on a probe that can be
    // transiently wrong during a startup or model-switch window. So the mode is
    // kept, the call is allowed to fail, and the raw transcript is inserted.
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "local");
    const harness = mount({ localProvider: false });
    await flush();

    expect(harness.refine.refineLocalChecked()).toBe(true);
    expect(harness.refine.refineLocalReady()).toBe(false);
    expect(harness.refine.refineTarget()).toEqual({ mode: "local" });
    harness.dispose();
  });

  test("choosing a model writes it through the control plane", async () => {
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "preset");
    const harness = mount();
    await flush();

    harness.refine.setRefineModel("qwen/qwen3-max");
    await flush();

    // It went to the HOST, not to localStorage.
    expect(harness.written).toEqual(["qwen/qwen3-max"]);
    expect(harness.storedModel()).toBe("qwen/qwen3-max");
    expect(harness.refine.refineModel()).toBe("qwen/qwen3-max");
    // And still nothing rides on the dictation request.
    expect(harness.refine.refineTarget()).toEqual({ mode: "preset" });
    harness.dispose();
  });

  test("the picker adopts the HOST's echo, not the typed string", async () => {
    // The host trims and validates. Showing the typed value would display a
    // model the dictation path would not actually send.
    const harness = mount();
    await flush();

    harness.refine.setRefineModel("  qwen/qwen3-max  ");
    await flush();

    expect(harness.refine.refineModel()).toBe("qwen/qwen3-max");
    harness.dispose();
  });

  test("a rejected write leaves the picker on what is really stored", async () => {
    // Otherwise the picker would show a choice that never landed, and the next
    // dictation would quietly use something else.
    const harness = mount({ storedModel: "minimax/minimax-m3", preferenceWriteFails: true });
    await flush();

    harness.refine.setRefineModel("not a model id");
    await flush();

    expect(harness.refine.refineModel()).toBe("minimax/minimax-m3");
    harness.dispose();
  });
});

describe("the local-provider probe", () => {
  test("a committed provider is a definitive yes", async () => {
    const harness = mount();
    await flush();

    expect(harness.refine.refineLocalChecked()).toBe(true);
    expect(harness.refine.refineLocalReady()).toBe(true);
    harness.dispose();
  });

  test("it mirrors the gate the DATA PLANE applies, not the hardware", async () => {
    // `/v1/models` advertises `local-model` when a local provider has been
    // SELECTED and hides it otherwise, "even if a backend happens to be
    // configured". So the probe has to be the selection endpoint: a
    // hardware- or capability-derived answer would disagree with the route that
    // actually serves the dictation — offering an option that 424s, or hiding
    // one that works.
    const harness = mount();
    await flush();

    expect(
      harness.urls.some((url) => url.includes("/model-selections/local-provider")),
    ).toBe(true);
    harness.dispose();
  });

  test("a failed probe is NOT read as 'you have no local model'", async () => {
    // Same rule as the OpenRouter probe: an unreachable LLMRouter is not
    // evidence about the user's configuration. Leaving `checked` false is what
    // keeps the card from printing "choose a local model" at someone whose only
    // problem is a transport fault.
    const harness = mount({ localProbeFails: true });
    await flush();

    expect(harness.refine.refineLocalChecked()).toBe(false);
    expect(harness.refine.refineLocalReady()).toBe(false);
    harness.dispose();
  });

  test("it is re-asked on refresh, since the user sets this on another page", async () => {
    const harness = mount();
    await flush();
    const before = harness.urls.filter((url) =>
      url.includes("/model-selections/local-provider"),
    ).length;

    harness.refine.refreshRefineProbes();
    await flush();

    expect(
      harness.urls.filter((url) => url.includes("/model-selections/local-provider")).length,
    ).toBe(before + 1);
    harness.dispose();
  });
});

describe("the OpenRouter catalog", () => {
  test("is not listed until something asks for it", async () => {
    // ~389 models on a live key. The only probe that runs on mount with clean-up
    // off is the LLMRouter provider list; the catalog is not one of them.
    const harness = mount();
    await flush();

    expect(harness.urls.some((url) => url.includes("/providers/openrouter/models"))).toBe(false);
    harness.dispose();
  });

  test("is listed once asked, and the result reaches the picker", async () => {
    const harness = mount();
    await flush();

    harness.refine.ensureRefineModels();
    await flush();

    expect(harness.urls.filter((url) => url.includes("/providers/openrouter/models")).length).toBe(
      1,
    );
    expect(harness.refine.refineModelOptions().map((model) => model.id)).toEqual([
      "minimax/minimax-m3",
      "qwen/qwen3-max",
    ]);
    expect(harness.refine.refineModelsLoading()).toBe(false);
    expect(harness.refine.refineModelsFailed()).toBe(false);
    harness.dispose();
  });

  test("asking twice does not fetch twice", async () => {
    const harness = mount();
    await flush();

    harness.refine.ensureRefineModels();
    harness.refine.ensureRefineModels();
    await flush();

    expect(harness.urls.filter((url) => url.includes("/providers/openrouter/models")).length).toBe(
      1,
    );
    harness.dispose();
  });
});

describe("the reasoning verdict on the chosen model", () => {
  test("is asked about the user's pick, not about the agent model", async () => {
    // Clean-up on, because the ASR probes are gated on it — see the "while
    // clean-up is off" test below for why.
    window.localStorage.setItem(VOICE_INPUT_REFINE_PREF_KEY, "on");
    const harness = mount({ storedModel: "qwen/qwen3-max" });
    await flush();
    // Two flushes: the pick is read from the host first, and the reasoning
    // probe for it can only be issued once that answer has landed.
    await flush();

    const asked = harness.urls.filter((url) => url.includes("/refine/model?"));
    expect(asked.some((url) => url.includes("model=qwen%2Fqwen3-max"))).toBe(true);
    harness.dispose();
  });

  test("a reasoning pick in preset mode produces the hint, keyed on that pick", async () => {
    // THE REGRESSION. A user can now choose a Gemini for clean-up in two clicks.
    // Before this, the gate returned early on any non-agent mode, so the warning
    // the whole feature exists for was silently unreachable from the picker.
    window.localStorage.setItem(VOICE_INPUT_REFINE_PREF_KEY, "on");
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "preset");
    const harness = mount({ reasoning: "no", storedModel: "google/gemini-2.5-pro" });
    await flush();
    await flush();

    expect(harness.refine.refineReasoningHint()).toEqual({
      show: true,
      action: "pick_other",
      modelId: "google/gemini-2.5-pro",
    });

    // And the dismissal is filed against that model, not the agent's.
    harness.refine.dismissRefineReasoningHint();
    expect(harness.refine.refineReasoningHint()).toEqual({ show: false });
    harness.dispose();
  });

  test("re-picking a healthy model clears the warning without a restart", async () => {
    window.localStorage.setItem(VOICE_INPUT_REFINE_PREF_KEY, "on");
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "preset");
    // The stub answers "no" for every model, so the clear has to come from the
    // re-probe being issued at all — which is the behaviour under test.
    const harness = mount({ reasoning: "no", storedModel: "google/gemini-2.5-pro" });
    await flush();
    await flush();
    expect(harness.refine.refineReasoningHint().show).toBe(true);

    harness.refine.setRefineModel("qwen/qwen3-max");
    // IN THE WINDOW BEFORE THE WRITE LANDS the hint still describes the OLD
    // model -- and that is now the correct answer rather than a lag. The pick
    // lives on the host, so until the PUT resolves the host still holds Gemini
    // and a dictation in this instant would use it. The hint and the path agree.
    //
    // It used to go blank here, because the signal moved synchronously with a
    // `localStorage` write. That was the less accurate of the two: it hid a
    // warning about the model that was still really in use.
    const midWrite = harness.refine.refineReasoningHint();
    expect(midWrite.show && midWrite.modelId).toBe("google/gemini-2.5-pro");

    await flush();
    await flush();
    const decision = harness.refine.refineReasoningHint();
    expect(decision.show && decision.modelId).toBe("qwen/qwen3-max");
    harness.dispose();
  });
});

describe("the dormant ASR service is not woken for a feature that is off", () => {
  test("no /refine/model is asked while clean-up is off", async () => {
    // `asr_manager` is `startup: "on_demand"`, and ServiceHub's proxy STARTS a
    // dormant child for any path that is not `/v1/health` or `/v1/version`. So
    // an ungated probe booted ASR and its NumPy/ONNX warmup at app start for a
    // default-off feature whose settings page may never be opened.
    const harness = mount();
    await flush();

    expect(harness.urls.some((url) => url.includes("/refine/model"))).toBe(false);
    // The LLMRouter probe still runs: it does not touch `asr_manager`, and the
    // card needs its answer to render the right reason next to the option.
    expect(harness.urls.some((url) => url.includes("/cloud/providers"))).toBe(true);
    harness.dispose();
  });

  test("flipping clean-up on asks immediately, with no restart", async () => {
    // The other half of the gate: the warning must not arrive a beat AFTER the
    // thing it warns about, which is why this is gated on the preference rather
    // than on the Settings page being open.
    const harness = mount();
    await flush();

    harness.refine.setRefineEnabled(true);
    await flush();

    expect(harness.urls.some((url) => url.includes("/refine/model"))).toBe(true);
    harness.dispose();
  });
});

/**
 * A harness that holds `/cloud/providers` open, so the pre-answer window and the
 * out-of-order window are both reachable. The shared `mount` answers everything
 * immediately, which is exactly what hides these two bugs.
 */
function mountWithHeldProviderProbe() {
  const urls: string[] = [];
  const pending: Array<(keySet: boolean) => void> = [];
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/cloud/providers/openrouter/models")) return json({ data: [] });
    if (url.includes("/cloud/providers")) {
      return new Promise<Response>((resolve) => {
        pending.push((keySet) =>
          resolve(new Response(JSON.stringify([{ id: "openrouter", api_key_set: keySet }]), {
            status: 200,
          })),
        );
      });
    }
    if (url.includes("/cloud/model")) return json({ provider: "openrouter", model: "openai/gpt-5" });
    if (url.includes("/refine/model")) {
      return json({
        provider: "openrouter",
        model: new URL(url).searchParams.get("model") ?? "",
        reasoning_support: "yes",
        recommended: { provider: "openrouter", model: "minimax/minimax-m3" },
      });
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof globalThis.fetch;

  let dispose = () => {};
  const refine = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return useDictationRefine(
      () => BASE,
      () => "token",
      () => true,
    );
  });
  return { refine, urls, pending, dispose };
}

describe("the recipient of the dictated text while readiness is unknown", () => {
  test("a stored preset is NOT rerouted to the agent model before the probe answers", async () => {
    // THE REGRESSION. `openRouterReady` is false in three situations and only
    // one of them is "you have no key" — it is also false in flight and false
    // after a failure. Keyed on readiness alone, dictating in the second after
    // startup sent the user's text to whatever provider the AGENT model sits
    // behind instead of to their own OpenRouter key. That is a change of
    // recipient for private text, made silently.
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "preset");
    const harness = mountWithHeldProviderProbe();
    await flush();

    // The probe is still open, so readiness is unknown.
    expect(harness.refine.refineOpenRouterChecked()).toBe(false);
    expect(harness.refine.refineOpenRouterReady()).toBe(false);
    expect(harness.refine.refineTarget()).toEqual({ mode: "preset" });

    // Once the answer is a confirmed "no key", the documented fallback applies.
    harness.pending[0]?.(false);
    await flush();
    expect(harness.refine.refineOpenRouterChecked()).toBe(true);
    expect(harness.refine.refineTarget()).toEqual({ mode: "agent" });
    harness.dispose();
  });

  test("a stale probe answering after a refresh does not undo the fresh result", async () => {
    // Two probes resolved in REVERSE order, which is the real sequence: the user
    // is on the card with no key, adds one on Model Routing, comes back (the
    // card refreshes the probes), the new probe answers "key" — and then the
    // slow original answers "no key". Without the generation guard that last
    // answer disabled the picker under a message telling the user to do the
    // thing they had just done.
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "preset");
    const harness = mountWithHeldProviderProbe();
    await flush();

    harness.refine.refreshRefineProbes();
    await flush();
    expect(harness.pending.length).toBe(2);

    harness.pending[1]?.(true); // the fresh probe: the key is there
    await flush();
    expect(harness.refine.refineOpenRouterReady()).toBe(true);

    harness.pending[0]?.(false); // the stale one, from before the key existed
    await flush();

    expect(harness.refine.refineOpenRouterReady()).toBe(true);
    expect(harness.refine.refineTarget()).toEqual({ mode: "preset" });
    harness.dispose();
  });
});

describe("a probe that fails is not an answer about the key", () => {
  /** Mounts with `/cloud/providers` rejecting, everything else healthy. */
  const mountWithFailingProviderProbe = () => {
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cloud/providers/openrouter/models")) return json({ data: [] });
      // 503, i.e. LLMRouter is there but cannot answer — a transport fault, not
      // a statement about the user's credentials.
      if (url.includes("/cloud/providers")) {
        return Promise.resolve(new Response("upstream down", { status: 503 }));
      }
      if (url.includes("/cloud/model")) return json({ provider: "openrouter", model: "openai/gpt-5" });
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as typeof globalThis.fetch;

    let dispose = () => {};
    const refine = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return useDictationRefine(
        () => BASE,
        () => "token",
        () => true,
      );
    });
    return { refine, dispose };
  };

  test("a rejected probe leaves a stored preset pointed at the user's own key", async () => {
    // THE SECOND HALF OF THE PRE-PROBE FIX. Requiring `openRouterChecked` closed
    // the in-flight window but the catch handler still set it true, so a single
    // 503 was read as "the absence of a key is confirmed" and the dictation was
    // rerouted to the agent's provider anyway. An unreachable LLMRouter is not
    // evidence about the user's credentials.
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "preset");
    const harness = mountWithFailingProviderProbe();
    await flush();

    expect(harness.refine.refineOpenRouterChecked()).toBe(false);
    expect(harness.refine.refineOpenRouterReady()).toBe(false);
    expect(harness.refine.refineTarget()).toEqual({ mode: "preset" });
    harness.dispose();
  });

  test("and the card is not told to add a key it may already have", async () => {
    // `openRouterChecked` is what gates the "add your OpenRouter key" reason.
    // Showing that after a transport fault instructs the user to fix something
    // that may not be broken, and hides the real failure.
    const harness = mountWithFailingProviderProbe();
    await flush();

    expect(harness.refine.refineOpenRouterChecked()).toBe(false);
    harness.dispose();
  });
});

describe("a connection change invalidates answers from the old one", () => {
  /** Holds `/cloud/providers` open, and lets the hub URL change underneath. */
  const mountSwappableHub = () => {
    const urls: string[] = [];
    const pending: Array<(keySet: boolean) => void> = [];
    const [hub, setHub] = createSignal("http://127.0.0.1:1");
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/cloud/providers/openrouter/models")) return json({ data: [] });
      if (url.includes("/cloud/providers")) {
        return new Promise<Response>((resolve) => {
          pending.push((keySet) =>
            resolve(
              new Response(JSON.stringify([{ id: "openrouter", api_key_set: keySet }]), {
                status: 200,
              }),
            ),
          );
        });
      }
      if (url.includes("/cloud/model")) return json({ provider: "openrouter", model: "openai/gpt-5" });
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as typeof globalThis.fetch;

    let dispose = () => {};
    const refine = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return useDictationRefine(hub, () => "token", () => true);
    });
    return { refine, urls, pending, setHub, dispose };
  };

  test("the old hub's answer does not overwrite the new hub's key", async () => {
    // THE GAP THE NONCE COULD NOT SEE. `probeNonce` advances only on
    // `refreshRefineProbes()`, so switching hubs re-ran the effect with the SAME
    // generation and a late reply from the old install passed the guard. The
    // consequence is the one that matters: a confirmed OpenRouter key replaced
    // by the previous install's "no key", which reroutes the user's dictated
    // text to the agent's provider.
    window.localStorage.setItem(VOICE_INPUT_REFINE_MODE_PREF_KEY, "preset");
    const harness = mountSwappableHub();
    await flush();

    // Second hub, which does have a key.
    harness.setHub("http://127.0.0.1:2");
    await flush();
    expect(harness.pending.length).toBe(2);

    harness.pending[1]?.(true);
    await flush();
    expect(harness.refine.refineOpenRouterReady()).toBe(true);

    // The first hub finally answers "no key" — about an install nobody is on.
    harness.pending[0]?.(false);
    await flush();

    expect(harness.refine.refineOpenRouterReady()).toBe(true);
    expect(harness.refine.refineOpenRouterChecked()).toBe(true);
    expect(harness.refine.refineTarget()).toEqual({ mode: "preset" });
    harness.dispose();
  });
});
