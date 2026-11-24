"""Build-only source/wheel parity gate; stdlib only, never imports the package."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import sys


def file_hashes(root: Path) -> dict[str, str]:
    """Inventory all file types, ignoring only Python bytecode/cache directories."""
    if not root.is_dir():
        raise ValueError(f"package directory missing: {root}")
    hashes: dict[str, str] = {}
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if "__pycache__" in relative.parts or path.suffix == ".pyc":
            continue
        if path.is_file():
            hashes[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    if not hashes:
        raise ValueError(f"package directory has no source/resource files: {root}")
    return hashes


def verify_source_parity(source: Path, installed: Path) -> int:
    expected = file_hashes(source)
    actual = file_hashes(installed)
    errors = [f"missing: {name}" for name in sorted(expected.keys() - actual.keys())]
    errors += [f"extra: {name}" for name in sorted(actual.keys() - expected.keys())]
    errors += [
        f"stale: {name} (source sha256={expected[name]}, installed sha256={actual[name]})"
        for name in sorted(expected.keys() & actual.keys())
        if expected[name] != actual[name]
    ]
    if errors:
        raise ValueError("source parity failed:\n" + "\n".join(errors))
    return len(expected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--installed", required=True, type=Path)
    args = parser.parse_args()
    try:
        count = verify_source_parity(args.source, args.installed)
    except (OSError, ValueError) as exc:
        print(f"Python source parity: {exc}", file=sys.stderr)
        return 1
    print(f"Python source parity OK: {count} files (paths + SHA-256)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())