"""sys.modules stubs that let `latentfactorrouter` import without torch.

Production install is `pip install --no-deps llmrouter-lib` (#825), which
skips torch / torch-geometric / peft. Our serve path doesn't need any of
them, but the default trained router (``latentfactorrouter``) inherits from
``llmrouter.models.meta_router.MetaRouter`` whose upstream module does
``import torch`` + ``class MetaRouter(nn.Module)``.

This file installs minimal fake ``torch`` + ``llmrouter.{models,utils,data}``
into ``sys.modules`` BEFORE the dynamic import in
``RouterAdapter._load_router``. Stub recipe mirrors the vendored
``latentfactorrouter/tests/unit/conftest.py`` which already proves the
shapes suffice for the inference path. If real upstream is importable, the
probe-then-install pattern at the bottom skips stubs entirely — real modules
are never overridden.

Must be imported BEFORE any ``from llmrouter.*`` line — the parent
``__init__.py`` does this via a side-effect import.
"""

import sys as _sys
import types as _types


def _install_torch_stub() -> bool:
    """Install fake torch into sys.modules. No-op if real torch is importable. Returns True iff installed."""
    if "torch" in _sys.modules:
        return False
    # Check whether real torch is *installed* (not just imported). If it is,
    # skip stubbing so any downstream `import torch` gets the real thing —
    # installing a stub here would shadow it for the rest of the process.
    import importlib.util as _importlib_util

    if _importlib_util.find_spec("torch") is not None:
        return False
    torch = _types.ModuleType("torch")
    nn = _types.ModuleType("torch.nn")

    class _FakeTensor:  # scipy.array_api_compat probes torch.Tensor at import
        pass

    class _FakeModule:
        def __init__(self, *a, **kw): pass
        def __call__(self, x): return x

    nn.Module = _FakeModule
    torch.nn = nn
    torch.Tensor = _FakeTensor
    torch.save = lambda obj, path: None
    torch.load = lambda path, **kw: {}
    _sys.modules["torch"] = torch
    _sys.modules["torch.nn"] = nn
    return True


def _install_llmrouter_internals_stub() -> list:
    """Stub llmrouter.{models,utils,data} per-module. Real modules already in sys.modules are skipped."""
    import pickle as _pickle
    import pathlib as _pathlib

    def _save_model(obj, filepath):
        p = _pathlib.Path(filepath)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "wb") as fh:
            _pickle.dump(obj, fh)

    def _load_model(filepath):
        with open(filepath, "rb") as fh:
            return _pickle.load(fh)

    def _load_jsonl(path):
        import json as _json
        with open(path, encoding="utf-8") as fh:
            return [_json.loads(line) for line in fh if line.strip()]

    class _FakeMetaRouter:
        # Replaces upstream MetaRouter; latentfactor only uses __init__ + self.cfg.
        def __init__(self, model=None, yaml_path=None, resources=None):
            import yaml as _yaml
            self.model = model
            self.resources = resources
            self.cfg = {}
            self.metric_weights = []
            self.routing_data_train = None
            self.routing_data_test = None
            self.llm_data = None
            if yaml_path:
                with open(yaml_path, encoding="utf-8") as fh:
                    self.cfg = _yaml.safe_load(fh) or {}

        def forward(self, x):
            return x

    class _FakeBaseTrainer:
        def __init__(self, router, optimizer=None, device="cpu", **kw):
            self.router = router
            self.optimizer = optimizer
            self.device = device

    stubbed = []
    for name in ("llmrouter.models", "llmrouter.data"):
        if name not in _sys.modules:
            _sys.modules[name] = _types.ModuleType(name)
            stubbed.append(name)

    if "llmrouter.models.meta_router" not in _sys.modules:
        m = _types.ModuleType("llmrouter.models.meta_router")
        m.MetaRouter = _FakeMetaRouter
        _sys.modules["llmrouter.models.meta_router"] = m
        stubbed.append("llmrouter.models.meta_router")

    if "llmrouter.models.base_trainer" not in _sys.modules:
        m = _types.ModuleType("llmrouter.models.base_trainer")
        m.BaseTrainer = _FakeBaseTrainer
        _sys.modules["llmrouter.models.base_trainer"] = m
        stubbed.append("llmrouter.models.base_trainer")

    if "llmrouter.utils" not in _sys.modules:
        m = _types.ModuleType("llmrouter.utils")
        m.save_model = _save_model
        m.load_model = _load_model
        m.load_jsonl = _load_jsonl
        _sys.modules["llmrouter.utils"] = m
        stubbed.append("llmrouter.utils")

    return stubbed


def _real_internals_available() -> bool:
    try:
        from llmrouter.models.meta_router import MetaRouter  # noqa: F401
        from llmrouter.utils import save_model, load_model  # noqa: F401
        return True
    except Exception:
        return False


# Audit trail: one stderr line at startup so ops can grep which branch ran.
if _real_internals_available():
    print("[_runtime_stubs] real upstream present; stubs NOT installed.", file=_sys.stderr)
else:
    _torch = "stub" if _install_torch_stub() else "real-already-present"
    _stubbed = _install_llmrouter_internals_stub() or ["none-needed"]
    print(f"[_runtime_stubs] installed: torch={_torch}, modules={','.join(_stubbed)}", file=_sys.stderr)
