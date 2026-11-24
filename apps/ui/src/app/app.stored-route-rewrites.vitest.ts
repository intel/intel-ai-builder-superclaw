/**
 * The reactive side of `app.stored-route-rewrites`: the effects that move
 * stored picks when Cloud is hidden or the profile is cloud-only. The pure
 * helper is covered by `app.stored-route-rewrites.test.ts` under bun; these
 * need Solid's client build to run effects, so they run in the vitest lane.
 */
import { createRoot, createSignal, type Accessor } from "solid-js";
import { afterEach, describe, expect, test } from "vitest";

import { LLMROUTER_ROUTE_ALIASES } from "~/shared/platform/capability/session-route-policy";

import { createHiddenCloudRoute } from "./app.stored-route-rewrites";
import type { ModelRef } from "./types";

const AUTO = LLMROUTER_ROUTE_ALIASES.auto;
const CLOUD = LLMROUTER_ROUTE_ALIASES.cloudModel;
const LOCAL = LLMROUTER_ROUTE_ALIASES.localModel;
const ALL_ALIASES = [AUTO, LOCAL, CLOUD];

let dispose: (() => void) | undefined;
afterEach(() => dispose?.());

function setup(options: { allowedAliases: readonly ModelRef[] }) {
  const [cloudModelMissing, setCloudModelMissing] = createSignal(false);
  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(CLOUD);
  const [pendingSessionModel, setPendingSessionModel] = createSignal<ModelRef | null>(CLOUD);
  const [overrides, setOverrides] = createSignal<Record<string, ModelRef>>({ withOverride: CLOUD, onLocal: LOCAL });
  const [sessionModelById] = createSignal<Record<string, ModelRef>>({ fromServer: CLOUD });
  let hideCloudRoute!: Accessor<boolean>;
  createRoot((disposeRoot) => {
    dispose = disposeRoot;
    hideCloudRoute = createHiddenCloudRoute({
      allowedAliases: () => options.allowedAliases,
      cloudModelMissing,
      defaultModel,
      setDefaultModel,
      pendingSessionModel,
      setPendingSessionModel,
      selectedSessionId: () => "fromMessages",
      modelFromMessages: () => CLOUD,
      sessionModelById,
      sessionModelOverrideById: overrides,
      setSessionModelOverrideById: setOverrides,
    });
  });
  return { setCloudModelMissing, hideCloudRoute, defaultModel, pendingSessionModel, overrides };
}

describe("createHiddenCloudRoute", () => {
  test("touches nothing while a cloud model is saved", () => {
    const s = setup({ allowedAliases: ALL_ALIASES });
    expect(s.hideCloudRoute()).toBe(false);
    expect(s.defaultModel()).toEqual(CLOUD);
    expect(s.pendingSessionModel()).toEqual(CLOUD);
    expect(s.overrides()).toEqual({ withOverride: CLOUD, onLocal: LOCAL });
  });

  test("once the cloud model is gone, moves every stored Cloud pick to Auto and keeps the rest", () => {
    const s = setup({ allowedAliases: ALL_ALIASES });
    s.setCloudModelMissing(true);

    expect(s.hideCloudRoute()).toBe(true);
    expect(s.defaultModel()).toEqual(AUTO);
    expect(s.pendingSessionModel()).toEqual(AUTO);
    expect(s.overrides()).toEqual({
      withOverride: AUTO,
      onLocal: LOCAL,
      // No override before: the server-reported and message-history Cloud picks get an Auto one.
      fromServer: AUTO,
      fromMessages: AUTO,
    });
  });

  test("the picks stay on Auto after a cloud model is saved again", () => {
    const s = setup({ allowedAliases: ALL_ALIASES });
    s.setCloudModelMissing(true);
    s.setCloudModelMissing(false);

    expect(s.hideCloudRoute()).toBe(false);
    expect(s.defaultModel()).toEqual(AUTO);
    expect(s.overrides().fromServer).toEqual(AUTO);
  });

  test("on a cloud-only profile Cloud stays, so nothing is rewritten", () => {
    const s = setup({ allowedAliases: [CLOUD] });
    s.setCloudModelMissing(true);

    expect(s.hideCloudRoute()).toBe(false);
    expect(s.defaultModel()).toEqual(CLOUD);
    expect(s.pendingSessionModel()).toEqual(CLOUD);
    expect(s.overrides()).toEqual({ withOverride: CLOUD, onLocal: LOCAL });
  });
});
