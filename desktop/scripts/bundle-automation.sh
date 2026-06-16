#!/usr/bin/env bash
# Mirror the content-script engines into the Tauri resources so the integrated
# browser can inject them. Single source of truth: engines live in
# extension/content/ and are copied here on every build (and in dev, see
# tauri.conf.json beforeDevCommand).
set -euo pipefail

cd "$(dirname "$0")/.."
DESKTOP_DIR="$(pwd)"
ROOT="$(cd .. && pwd)"
SRC="$ROOT/extension/content"
DST="$DESKTOP_DIR/src-tauri/resources/automation"

mkdir -p "$DST/adapters"

# 1. Engines (linkedin, successfactors, autofill, greenhouse, lever, ashby, generic, …)
cp "$SRC"/*.js "$DST/"

# 2. Adapter registry (canonical copy lives in website/) — mirror for parity
if [ -f "$ROOT/website/registry.js" ]; then
  cp "$ROOT/website/registry.js" "$DST/adapters/registry.js"
fi

# NOTE: jaa_bridge.js is authored directly in $DST and is NOT overwritten here.
echo "✓ automation engines bundled → $DST"
