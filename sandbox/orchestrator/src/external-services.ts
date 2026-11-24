/**
 * Which runtime services this supervisor connects to rather than spawns, and on which port.
 *
 * A service is "external" when something outside the supervisor owns its lifecycle. On the
 * host-native backend that owner is the Sandbox Manager, which launches the service as its own
 * governed role in its own isolation tier and hands the supervisor the port it is listening on.
 *
 * This lives in its own module rather than inside `cli.ts` for one reason that is worth stating:
 * `cli.ts` calls `main()` at module scope, so importing anything from it runs the whole CLI. A test
 * that imported the decision from there would start a supervisor as a side effect and take its exit
 * code with it. Every other unit test in this package targets a small pure module for the same
 * reason - see `opencode-router-env.ts` and `intent-classifier-bridge-url.ts`.
 */

import { resolveBindHost } from "./bind-host.js";

/**
 * The port a managed service is reachable on, given whether its lifecycle is external.
 *
 * The external branch must not probe. `resolvePort` treats an unbindable preferred port as a reason to
 * pick a different one, which is right when this process is about to bind it and exactly wrong when
 * another process already has: probing would walk away from the only port the service is listening on
 * and then health-check something else. So an external service requires its port to be stated, and a
 * missing one is refused rather than guessed.
 */
export function validateExternalHdrOwnership(input: {
  external: boolean;
  externalOpencode: boolean;
  externalOpenworkServer: boolean;
  required: boolean;
  managed: boolean;
}): void {
  if (
    input.external
    && (
      !input.externalOpencode
      || !input.externalOpenworkServer
      || !input.required
      || !input.managed
    )
  ) {
    throw new Error(
      "External HDR requires a managed HDR Profile and owner-launched Runtime/OpenWork Server",
    );
  }
  if (input.managed && input.required && !input.external) {
    throw new Error("Native managed HDR lifecycle must be owned by Sandbox Manager");
  }
}

export function resolveHybridDrHost(input: {
  external: boolean;
  cliHost: string | undefined;
  envHost: string | undefined;
}): string {
  if (input.external) {
    if (input.cliHost?.trim() || input.envHost?.trim()) {
      throw new Error("External managed HDR does not accept a host override");
    }
    return "127.0.0.1";
  }
  return resolveBindHost(input.cliHost, input.envHost);
}

export function removeInheritedHdrCredentials(env: NodeJS.ProcessEnv): void {
  const forbidden = new Set(["HYBRID_DR_API_TOKEN", "HYBRID_DR_READY_TOKEN"]);
  for (const name of Object.keys(env)) {
    if (forbidden.has(name.toUpperCase())) delete env[name];
  }
}

export async function resolveManagedServicePort(input: {
  /** How the service is named in a refusal, e.g. `External OpenCode`. */
  service: string;
  /** The flag that must supply the port in external mode, e.g. `--opencode-port`. */
  portFlag: string;
  external: boolean;
  configured: number | undefined;
  resolveAvailable: () => Promise<number>;
}): Promise<number> {
  if (input.external) {
    if (input.configured === undefined) {
      throw new Error(`${input.service} requires ${input.portFlag}`);
    }
    return input.configured;
  }
  return input.resolveAvailable();
}

/**
 * The OpenCode basic-auth password, given whether the runtime's lifecycle is external.
 *
 * An external runtime was started with a password its owner minted, so a generated one can never
 * match it: every probe would get 401 and startup would fail as an opaque timeout. External mode
 * therefore requires the password to be stated. The refusal names only the variable, never a value.
 */
export function resolveOpencodePassword(input: {
  external: boolean;
  configured: string | undefined;
  generate: () => string;
}): string {
  if (input.external) {
    if (!input.configured) {
      throw new Error("External OpenCode auth requires OPENWORK_OPENCODE_PASSWORD");
    }
    return input.configured;
  }
  return input.configured ?? input.generate();
}

/**
 * The intent-classifier Bearer token, given whether openwork-server and the router are external.
 *
 * External mode requires the broker to have minted the token; a generated one would not match what
 * callers present. The refusal names only the variable, never a value.
 */
export function resolveIntentClassifierToken(input: {
  external: boolean;
  configured: string | undefined;
  generate: () => string;
}): string {
  const configured = input.configured?.trim() || undefined;
  if (input.external) {
    if (!configured) {
      throw new Error("External intent classifier auth requires INTENT_CLASSIFIER_TOKEN");
    }
    return configured;
  }
  return configured ?? input.generate();
}
