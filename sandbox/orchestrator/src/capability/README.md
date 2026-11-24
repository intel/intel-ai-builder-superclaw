# capability - Product Profile runtime seam

**Owner:** sandbox orchestrator Product Profile runtime.
**Contracts implemented:** `RuntimeDeploymentSpec` (`shared/contracts/src/capability/runtime-deployment.ts`)
and `ProductProfileDescriptor` (`shared/contracts/src/capability/product-profile.ts`).

This directory holds only this README; the seam's code sits one level up.

## What the seam does

At start-up, before any agent child process runs, `cli.ts` reads the Runtime deployment the host
committed (`SUPERCLAW_RUNTIME_DEPLOYMENT_B64`), checks the packaged Profile's digest against it, and
publishes the complete Profile into the Runtime generation's OpenCode config directory. Any failure
stops start-up.

Start-up and online apply share one `live` / `.next` / `.backup` publisher. Nothing else writes the
live tree.

## Files

| File | Responsibility |
|---|---|
| `../runtime-deployment.ts` | Parse the deployment and instance identity, compute the Profile digest, bootstrap the generation. |
| `../profile-deployment.ts` | Validate packaged and live Profile trees, recover publication topology, publish by crash-safe rename. |
| `../runtime-profile-controller.ts` | Converge Runtime children and derive Runtime Profile status. |

## Allowed dependencies

- Node/Bun standard library, `@different-ai/openwork-contracts` capability schemas, and focused
  orchestrator services.
- **Never** `cli.ts`: it injects the real runtime paths; nothing here hardcodes them.

## Invariants

- **Fail-closed:** a missing deployment, invalid Profile content, digest mismatch, topology
  conflict, or publish failure prevents child start-up.
- **Single publisher:** start-up and online apply write `live` only through `profile-deployment.ts`.
- **Immutable parity:** packaged content that drifted under the same Profile ID triggers a normal
  `.next` publication; the managed dependency scaffold is excluded from the comparison.

## Tests

`test/runtime-deployment.test.ts`, `test/profile-deployment.test.ts` and
`test/runtime-profile-controller.test.ts`. From `sandbox/orchestrator`:

```powershell
pnpm test:capability   # all bun tests except test/smoke
pnpm typecheck
```
