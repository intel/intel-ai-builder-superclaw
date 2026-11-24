"""Fixed-purpose CLI used by the file-tool tier to unseal Connector client config."""

from __future__ import annotations

import json
from pathlib import Path
import sys

from .dpapi_secret_file import read_connector_client_config


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("expected exactly one Connector config path")
    value = read_connector_client_config(Path(sys.argv[1]))
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()