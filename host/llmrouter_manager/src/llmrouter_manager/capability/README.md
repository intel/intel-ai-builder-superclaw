# LRM Bundle Capability

Implements the ModelRouter/Capability boundary for trusted Bundle facts and the primary-Bundle
lifecycle served under `/llm-router/v1/capability/*` (process credential required).

- `data/bundles.builtin.json` is the sole trusted Bundle registry (`bundle_registry.py`). Each
  Bundle declares its `compatible_product_profiles`; ServiceHub selects a complete Product Profile
  from the prepared Binding's list.
- Local Bundle assets resolve only against the packaged `models.builtin.json`. User and
  `LRM_MODEL_REGISTRY_OVERRIDE` catalogs remain custom runtime inputs and never grant a Product
  Profile.
- `capability_grade` is opaque v1 Bundle metadata, never used for ranking or Profile selection.
- `bundle_capability.py` independently evaluates compute support, verified cache state and
  cache-volume download feasibility.
- `bundle_lifecycle.py` and `api.py` implement staged prepare, commit, abort and release of the
  primary Bundle; `model_binding.py` projects the committed Binding.
- `GET /llm-router/v1/capability/primary-bundle` is read-only: it does not download, activate,
  persist, or start workers.

```powershell
uv run --directory host/llmrouter_manager pytest -q tests/test_bundle_registry.py tests/test_bundle_capability.py tests/test_registry.py
```
