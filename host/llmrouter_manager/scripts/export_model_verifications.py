from __future__ import annotations

import argparse
from pathlib import Path

from llmrouter_manager.common.store import export_model_verifications


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export model verification records to a fresh LRM database."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    count = export_model_verifications(args.source, args.destination)
    print(f"Exported {count} model verification record(s).")


if __name__ == "__main__":
    main()
