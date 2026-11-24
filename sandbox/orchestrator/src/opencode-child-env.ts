import { basename, dirname } from "node:path";
import { mergeResourceAttributes } from "./resource-attributes.js";

export interface OpencodeChildStateLayout {
  readonly devMode: boolean;
  readonly configDir: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface OpencodeProcessEnvOptions {
  readonly runId: string;
  readonly logFormat: string;
  readonly hotReload: { readonly enabled: boolean; readonly debounceMs: number; readonly cooldownMs: number };
  readonly username?: string;
  readonly password?: string;
  readonly opencodeRouterHealthPort?: number;
  readonly controlToken?: string;
  readonly telemetryToken?: string;
}

export interface OpenworkServerEnvOptions {
  readonly token: string;
  readonly hostToken?: string;
  readonly telemetryToken: string;
  readonly runId: string;
  readonly logFormat: string;
  readonly opencodeRouterHealthPort?: number;
  readonly opencodeRouterDataDir?: string;
  readonly routerControlToken?: string;
  readonly opencodeBaseUrl?: string;
  readonly opencodeDirectory?: string;
  readonly opencodeUsername?: string;
  readonly opencodePassword?: string;
  readonly controlBaseUrl?: string;
  readonly controlToken?: string;
  readonly llmrouterUrl?: string;
  readonly intentClassifierToken?: string;
}

export function buildOpencodeChildEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  stateLayout?: OpencodeChildStateLayout,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    ...(stateLayout?.env ?? {}),
    ...(stateLayout?.configDir ? { OPENCODE_CONFIG_DIR: stateLayout.configDir } : {}),
  };
  delete env.SC_CHANNEL_SECRET_API_URL;
  delete env.SC_CHANNEL_SECRET_MANAGEMENT_TOKEN;
  delete env.SC_CHANNEL_SECRET_RESOLVE_TOKEN;
  delete env.OPENWORK_HOST_TOKEN;
  delete env.OPENWORK_HOST_TOKEN_HASH;
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === "INTENT_CLASSIFIER_TOKEN") delete env[name];
  }

  const authoritativeConfigDir = Boolean(inheritedEnv.SUPERCLAW_RUNTIME_DEPLOYMENT_B64?.trim());
  if (!stateLayout || stateLayout.devMode || !authoritativeConfigDir) return env;
  if (basename(stateLayout.configDir) !== "opencode") {
    throw new Error("Authoritative OpenCode config directory must be named opencode");
  }

  return {
    ...env,
    XDG_CONFIG_HOME: dirname(stateLayout.configDir),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  };
}

export function buildOpencodeProcessEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  stateLayout: OpencodeChildStateLayout | undefined,
  options: OpencodeProcessEnvOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildOpencodeChildEnv(inheritedEnv, stateLayout),
    OPENCODE_CLIENT: "openwork-orchestrator",
    OPENWORK: "1",
    OPENWORK_RUN_ID: options.runId,
    OPENWORK_LOG_FORMAT: options.logFormat,
    ...(options.telemetryToken ? { OPENWORK_TELEMETRY_TOKEN: options.telemetryToken } : {}),
    OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
      { "service.name": "opencode", "service.instance.id": options.runId },
      inheritedEnv.OTEL_RESOURCE_ATTRIBUTES,
    ),
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    ...(options.username ? { OPENCODE_SERVER_USERNAME: options.username } : {}),
    ...(options.password ? { OPENCODE_SERVER_PASSWORD: options.password } : {}),
    OPENCODE_HOT_RELOAD: options.hotReload.enabled ? "1" : "0",
    OPENCODE_HOT_RELOAD_DEBOUNCE_MS: String(options.hotReload.debounceMs),
    OPENCODE_HOT_RELOAD_COOLDOWN_MS: String(options.hotReload.cooldownMs),
    ...(options.opencodeRouterHealthPort ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.opencodeRouterHealthPort) } : {}),
    ...(options.controlToken ? { OPENCODE_ROUTER_CONTROL_TOKEN: options.controlToken } : {}),
  };
  if (!options.telemetryToken) delete env.OPENWORK_TELEMETRY_TOKEN;
  return env;
}

export function buildOpenworkServerEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  options: OpenworkServerEnvOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    OPENWORK_TOKEN: options.token,
    OPENWORK_HOST_TOKEN: undefined,
    ...(options.telemetryToken ? { OPENWORK_TELEMETRY_TOKEN: options.telemetryToken } : {}),
    OPENWORK_RUN_ID: options.runId,
    OPENWORK_LOG_FORMAT: options.logFormat,
    OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
      { "service.name": "openwork-server", "service.instance.id": options.runId },
      inheritedEnv.OTEL_RESOURCE_ATTRIBUTES,
    ),
    ...(options.opencodeRouterHealthPort ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.opencodeRouterHealthPort) } : {}),
    ...(options.opencodeRouterDataDir ? { OPENCODE_ROUTER_DATA_DIR: options.opencodeRouterDataDir } : {}),
    ...(options.routerControlToken ? { OPENCODE_ROUTER_CONTROL_TOKEN: options.routerControlToken } : {}),
    ...(inheritedEnv.SC_CHANNEL_SECRET_API_URL ? { SC_CHANNEL_SECRET_API_URL: inheritedEnv.SC_CHANNEL_SECRET_API_URL } : {}),
    ...(inheritedEnv.SC_CHANNEL_SECRET_MANAGEMENT_TOKEN ? { SC_CHANNEL_SECRET_MANAGEMENT_TOKEN: inheritedEnv.SC_CHANNEL_SECRET_MANAGEMENT_TOKEN } : {}),
    ...(options.opencodeBaseUrl ? { OPENWORK_OPENCODE_BASE_URL: options.opencodeBaseUrl } : {}),
    ...(options.opencodeDirectory ? { OPENWORK_OPENCODE_DIRECTORY: options.opencodeDirectory } : {}),
    ...(options.opencodeUsername ? { OPENWORK_OPENCODE_USERNAME: options.opencodeUsername } : {}),
    ...(options.opencodePassword ? { OPENWORK_OPENCODE_PASSWORD: options.opencodePassword } : {}),
    ...(options.controlBaseUrl ? { OPENWORK_CONTROL_BASE_URL: options.controlBaseUrl } : {}),
    ...(options.controlToken ? { OPENWORK_CONTROL_TOKEN: options.controlToken } : {}),
    ...(options.llmrouterUrl ? { LRM_API_BASE_URL: options.llmrouterUrl } : {}),
    ...(options.intentClassifierToken ? { INTENT_CLASSIFIER_TOKEN: options.intentClassifierToken } : {}),
  };
  delete env.OPENWORK_HOST_TOKEN;
  if (!options.intentClassifierToken) {
    for (const name of Object.keys(env)) {
      if (name.toUpperCase() === "INTENT_CLASSIFIER_TOKEN") delete env[name];
    }
  }
  if (!options.telemetryToken) delete env.OPENWORK_TELEMETRY_TOKEN;
  if (!options.opencodeRouterHealthPort) delete env.OPENCODE_ROUTER_HEALTH_PORT;
  if (!options.opencodeRouterDataDir) delete env.OPENCODE_ROUTER_DATA_DIR;
  delete env.SC_CHANNEL_SECRET_RESOLVE_TOKEN;
  return env;
}
