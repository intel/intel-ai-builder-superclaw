# `shared/platform/capability/`

Product Profile policy modules: the capability gate (`useCapabilityGate()` and its pure
selectors in `capability-gate.ts`), the app capability profile and provider, model-binding
activation and system-preflight clients, routing defaults, startup signals, and activation
poll decisions. The startup resolver UI and its dialogs stay in `app/capability/`.

**Allowed imports:** `shared/` and npm only (including `@different-ai/openwork-contracts/capability`).

**Verify:** from `apps/ui`, `pnpm test src/shared/platform/capability/`.

**Contract:** leaf platform adapter; consumes the `capability` contract. Entitlement comes from
the active Product Profile, not from code here.
