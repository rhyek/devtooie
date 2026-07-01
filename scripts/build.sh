#!/usr/bin/env bash
set -euo pipefail

PKG="packages/devtooie"

rm -rf "$PKG/dist"
pnpm exec tsc -p "$PKG/tsconfig.build.json"

# Ensure the compiled bin has an executable shebang.
BIN="$PKG/dist/cli.js"
if [ -f "$BIN" ]; then
  if ! head -n1 "$BIN" | grep -q '^#!'; then
    printf '#!/usr/bin/env node\n%s' "$(cat "$BIN")" > "$BIN"
  fi
  chmod +x "$BIN"
fi

echo "build complete"
