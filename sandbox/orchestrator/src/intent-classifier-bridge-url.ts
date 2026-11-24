/** Classifier endpoint advertised to the Slack/Telegram bridge. */

import { randomUUID } from "node:crypto";

import { resolveIntentClassifierToken } from "./external-services.js";

export type IntentClassifierEndpoint = { url: string; token: string };

function readAndStripIntentClassifierToken(env: NodeJS.ProcessEnv): string | undefined {
  let configured: string | undefined;
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === "INTENT_CLASSIFIER_TOKEN") {
      if (configured === undefined) configured = env[name];
      delete env[name];
    }
  }
  return configured?.trim() || undefined;
}

/**
 * The bridge treats INTENT_CLASSIFIER_URL as an on/off switch, read once at
 * startup: set means "classify the first message of every Slack/Telegram
 * thread". sandbox-manager injects it into every runtime without knowing which
 * sidecars the runtime will spawn, so the switch has to be re-derived here, by
 * the process that owns the sidecar's lifecycle.
 *
 * Returning null (rather than the URL) is what keeps a Profile without the
 * sidecar from spending the bridge's classifier timeout on the first message of
 * every thread before falling through to the default agent.
 *
 * Removes `INTENT_CLASSIFIER_TOKEN` from `env` so no child inherits it; the
 * returned endpoint is the only carrier from here on.
 */
export function resolveIntentClassifierEndpoint(input: {
  sidecarSpawned: boolean;
  port: number;
  external: boolean;
  env: NodeJS.ProcessEnv;
  generateToken?: () => string;
}): IntentClassifierEndpoint | null {
  const configuredToken = readAndStripIntentClassifierToken(input.env);
  if (!input.sidecarSpawned) return null;
  const injected = input.env.INTENT_CLASSIFIER_URL?.trim();
  const url = injected || `http://127.0.0.1:${input.port}`;
  const token = resolveIntentClassifierToken({
    external: input.external,
    configured: configuredToken,
    generate: input.generateToken ?? randomUUID,
  });
  return { url, token };
}
