"""Phase node implementations.

Each node owns one row of `pipeline_config.json#stages_skeleton`. Node
bodies live in `nodes/<phase>.py`; the orchestrator's graph compilation
wires them via conditional edges (see `graph.py`).
"""
