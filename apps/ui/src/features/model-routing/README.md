# `features/model-routing/`

Switching what the app's models run on: starting, polling, resuming and cancelling a
model-binding activation (a local Model Bundle or an edge server), applying the routing
defaults for the new bundle, and the cloud-model and edge settings read and written through
LLMRouter. Also reads the primary bundle's capability, writes the perf weight and fetches the
system preflight that decides what the hardware is eligible for.

**Public surface:** `index.ts` — `createModelRoutingFeature`.

**Depends on:** `~/shared/platform/capability/` (activation and preflight clients, routing
defaults, activation error text, the edge-degraded signal),
`~/shared/platform/transport/llmrouter-client`,
`~/shared/platform/transport/managed-workspace-token-refresh`,
`~/shared/util/bundle-switch-step-progress`, and
`@different-ai/openwork-contracts/capability` for the activation stage type.

**Contract:** leaf UI slice ([`../README.md`](../README.md)); consumes the `capability`
contract through the clients above.

**Still in `app/`:** the model picker, the provider list and the auto-route display.

**Verify:** from `apps/ui`, `pnpm test src/features/model-routing`.
