/**
 * The upstream OpenWork `--sandbox docker|container` modes are gone: SuperClaw's only sandbox is the
 * Windows-native one, which Sandbox Manager owns, so the orchestrator never starts a container.
 *
 * A leftover option is refused by name instead of ignored. Ignoring `--sandbox docker` would start the
 * worker unsandboxed on the host while the caller believed it was contained.
 */
const REMOVED_SANDBOX_FLAGS = ["sandbox", "sandbox-image", "sandbox-persist-dir", "sandbox-mount"] as const;

const REMOVED_SANDBOX_ENV = [
  "OPENWORK_SANDBOX",
  "OPENWORK_SANDBOX_IMAGE",
  "OPENWORK_SANDBOX_PERSIST_DIR",
  "OPENWORK_SANDBOX_MOUNT",
] as const;

const REMOVED_MESSAGE = "The Docker and container sandbox modes were removed; Sandbox Manager owns the sandbox.";

export function assertNoRemovedSandboxOptions(
  flags: ReadonlyMap<string, string | boolean>,
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const flag of REMOVED_SANDBOX_FLAGS) {
    if (flags.has(flag)) {
      throw new Error(`--${flag} was removed. ${REMOVED_MESSAGE} Drop the flag.`);
    }
  }
  for (const name of REMOVED_SANDBOX_ENV) {
    const value = env[name]?.trim();
    if (value) {
      throw new Error(`${name} was removed. ${REMOVED_MESSAGE} Unset the variable.`);
    }
  }
}
