/** Environment handed to the opencode-router child process. */

import type { IntentClassifierEndpoint } from "./intent-classifier-bridge-url.js";
import { mergeResourceAttributes } from "./resource-attributes.js";
import { removeInheritedHdrCredentials } from "./external-services.js";

export type OpenCodeRouterEnvOptions = {
  workspace: string;
  runId: string;
  logFormat: string;
  controlToken: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencodeRouterHealthPort?: number;
  opencodeRouterDataDir?: string;
  llmrouterUrl?: string;
  /**
   * Classifier endpoint and credential to advertise to the Slack/Telegram bridge, or null when
   * this Product Profile does not run the sidecar.
   */
  intentClassifier?: IntentClassifierEndpoint | null;
};

/**
 * Built from `baseEnv` rather than reading `process.env` directly so the
 * inherit-then-override behaviour is testable — which matters most for
 * INTENT_CLASSIFIER_URL below, whose whole point is removing an inherited value.
 */
export function buildOpenCodeRouterEnv(
  options: OpenCodeRouterEnvOptions,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!options.controlToken.trim()) {
    throw new Error("OpenCode Router control token is required");
  }
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    OPENWORK_RUN_ID: options.runId,
    OPENWORK_LOG_FORMAT: options.logFormat,
    OPENCODE_ROUTER_CONTROL_TOKEN: options.controlToken,
    OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
      {
        "service.name": "opencode-router",
        "service.instance.id": options.runId,
      },
      baseEnv.OTEL_RESOURCE_ATTRIBUTES,
    ),
    ...(options.opencodeUrl ? { OPENCODE_URL: options.opencodeUrl } : {}),
    OPENCODE_DIRECTORY: options.workspace,
    ...(options.opencodeRouterHealthPort ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.opencodeRouterHealthPort) } : {}),
    ...(options.opencodeRouterDataDir ? { OPENCODE_ROUTER_DATA_DIR: options.opencodeRouterDataDir } : {}),
    ...(options.opencodeUsername ? { OPENCODE_SERVER_USERNAME: options.opencodeUsername } : {}),
    ...(options.opencodePassword ? { OPENCODE_SERVER_PASSWORD: options.opencodePassword } : {}),
    ...(options.llmrouterUrl ? { LRM_API_BASE_URL: options.llmrouterUrl } : {}),
    ...(baseEnv.SC_CHANNEL_SECRET_API_URL ? { SC_CHANNEL_SECRET_API_URL: baseEnv.SC_CHANNEL_SECRET_API_URL } : {}),
    ...(baseEnv.SC_CHANNEL_SECRET_RESOLVE_TOKEN ? { SC_CHANNEL_SECRET_RESOLVE_TOKEN: baseEnv.SC_CHANNEL_SECRET_RESOLVE_TOKEN } : {}),
  };
  delete env.SC_CHANNEL_SECRET_MANAGEMENT_TOKEN;

  // The bridge decides once, at startup, whether Slack/Telegram threads get
  // classified: INTENT_CLASSIFIER_URL present means "classify the first message
  // of every thread". sandbox-manager injects that variable into every runtime
  // regardless of Product Profile, so on Profiles that do not run the sidecar the
  // bridge spent its classifier timeout on the first message of each thread
  // before falling through to the default agent. The orchestrator owns the
  // sidecar's lifecycle, so it also owns whether the endpoint is advertised —
  // hence the explicit delete of the inherited value.
  if (options.intentClassifier) {
    env.INTENT_CLASSIFIER_URL = options.intentClassifier.url;
    env.INTENT_CLASSIFIER_TOKEN = options.intentClassifier.token;
  } else {
    delete env.INTENT_CLASSIFIER_URL;
    for (const name of Object.keys(env)) {
      if (name.toUpperCase() === "INTENT_CLASSIFIER_TOKEN") delete env[name];
    }
  }

  removeInheritedHdrCredentials(env);

  return env;
}
