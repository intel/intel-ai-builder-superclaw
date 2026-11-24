# ServiceHub Capability

Owns the Product Profile catalog and ServiceHub's durable active/pending Profile state.

- `product_profile_catalog.py` loads and validates Profiles: from `sandbox/agent_config/profiles`
  in source mode, from the packaged `agent-config/profiles` next to the exe when frozen.
- `profile_store.py` / `atomic_json.py` persist Profile records and primary-Bundle state. These two
  and the catalog depend only on the generated `contracts` package and pydantic: no FastAPI, HTTP
  client, LRM or SandboxManager code.
- `lifecycle.py` (`CapabilityLifecycle`) wires the store to the LRM and SandboxManager adapters in
  `servicehub/adapters/` and to Model Binding activation.
- `api.py` serves `GET /app/capability-profile`, mounted only when `CAPABILITY_GATING_V1` is set.

**Contract:** `ProductProfileDescriptor`, `ProfileSnapshot`, `PrimaryBundleState` and
`AppCapabilityProfile` from `shared/contracts`.

```powershell
uv run --directory host\servicehub pytest -q tests/capability
```
