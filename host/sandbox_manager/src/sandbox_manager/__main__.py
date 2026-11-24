"""``python -m sandbox_manager`` entry point.

Delegates to :func:`sandbox_manager.main.run`, which parses the required
``--port`` flag (assigned by ServiceHub) and starts the control-plane server.
"""

from __future__ import annotations

from .main import run

if __name__ == "__main__":  # pragma: no cover
    run()
