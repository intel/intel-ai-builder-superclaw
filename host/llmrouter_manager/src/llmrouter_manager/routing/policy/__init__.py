"""Serving-policy layer ported from ``D:/routing_service/sidecar.py``.

Pure, import-light helpers (context-cap derivation, the compaction tracker,
config resolvers, retry policy) that the proxy middleware composes. Kept as a
leaf package with a trivial ``__init__`` so tests can import individual modules
without pulling heavy deps (see docs/design/routing_service_integration_plan.md
§4). Each module lands with the phase that wires it into ``proxy.py``.
"""
