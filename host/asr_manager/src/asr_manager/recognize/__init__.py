"""Recognition internals: model residency, weight download, audio decode, engine.

Nothing here imports FastAPI, and nothing in ``api/`` holds recognition state --
so the pipeline can be driven from a test or a script without an HTTP server.
"""
