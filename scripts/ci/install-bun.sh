#!/usr/bin/env bash
# Install bun via the official installer.
# `pnpm/action-setup` and `oven-sh/setup-bun` aren't on the ARC org allowlist;
# this script is the curl|sh fallback the plan calls for.
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.3.14}"

if command -v bun >/dev/null 2>&1; then
  CURRENT="$(bun --version 2>/dev/null || echo unknown)"
  if [ "$CURRENT" = "$BUN_VERSION" ]; then
    echo ">>> bun $BUN_VERSION already installed"
    exit 0
  fi
  echo ">>> bun $CURRENT installed, replacing with $BUN_VERSION"
fi

# bun installs to ~/.bun/bin by default. Honour HTTP_PROXY/HTTPS_PROXY via curl.
curl -fsSL "https://bun.sh/install" | bash -s "bun-v${BUN_VERSION}"

# Make bun available on PATH for the rest of the workflow step.
# In GitHub Actions, write to $GITHUB_PATH; locally just rely on caller sourcing.
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$HOME/.bun/bin" >> "$GITHUB_PATH"
else
  export PATH="$HOME/.bun/bin:$PATH"
fi

"$HOME/.bun/bin/bun" --version
