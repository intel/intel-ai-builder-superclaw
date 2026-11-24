# `features/providers/`

Authenticating a cloud model provider against LLMRouter: saving and validating an API key,
and driving the OAuth flows (device, PKCE, code and auto) to completion.
`providerAuthService` holds the request/response shaping so the hook only deals in UI state.

**Public surface:** `index.ts` — `useProviderAuth`.

**Depends on:** `~/shared/types/models` (`ProviderListItem`). The LLMRouter auth client is
injected: the slice declares the shape it needs rather than importing the transport.

**Contract:** leaf UI slice ([`../README.md`](../README.md)).

**Still in `app/`:** the provider settings UI.

**Verify:** from `apps/ui`, `pnpm test src/features/providers`.
