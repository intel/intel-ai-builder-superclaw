from __future__ import annotations

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Hybrid Deep Research sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18324)
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()
    uvicorn.run(
        "hybrid_dr_orchestrator.api.serve:make_app",
        factory=True,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )


if __name__ == "__main__":
    main()
