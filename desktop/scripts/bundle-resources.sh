#!/usr/bin/env bash
# Runs as Tauri's beforeBuildCommand. Populates src-tauri/resources/ with
# the frozen backend + the Ollama binary for the target platform.
set -euo pipefail
cd "$(dirname "$0")/.."

RES_DIR="src-tauri/resources"
mkdir -p "$RES_DIR/backend"

# 1. Backend — produced by `cd ../backend && bash build.sh`
if [ ! -d "../backend/dist/jobapply-backend" ]; then
  echo "→ Backend bundle not found, building it now…"
  (cd ../backend && bash build.sh)
fi
cp -R ../backend/dist/jobapply-backend/. "$RES_DIR/backend/"
echo "✓ Backend copied to $RES_DIR/backend/"

# 2. Ollama binary (optional — only if user wants offline-ready install)
# We DON'T bundle Ollama by default to keep installer size down. Users install
# Ollama themselves (one-line install) if they want local LLM. Override by
# setting BUNDLE_OLLAMA=1 in the environment.
if [ "${BUNDLE_OLLAMA:-0}" = "1" ]; then
  mkdir -p "$RES_DIR/ollama"
  if [ "$(uname)" = "Darwin" ]; then
    URL="https://github.com/ollama/ollama/releases/latest/download/ollama-darwin"
  else
    URL="https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64"
  fi
  echo "→ Downloading Ollama from $URL"
  curl -fSL -o "$RES_DIR/ollama/ollama" "$URL"
  chmod +x "$RES_DIR/ollama/ollama"
  echo "✓ Ollama bundled"
fi

echo "Done."
