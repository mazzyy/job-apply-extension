#!/usr/bin/env bash
# Tauri's beforeBuildCommand. Copies the frozen backend into src-tauri/resources/
# so the .dmg / .msi includes it.
set -euo pipefail

cd "$(dirname "$0")/.."
DESKTOP_DIR="$(pwd)"
PROJECT_ROOT="$(cd .. && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
RES_DIR="$DESKTOP_DIR/src-tauri/resources"

echo "→ Bundling resources for release build"
echo "  Desktop:  $DESKTOP_DIR"
echo "  Backend:  $BACKEND_DIR"
echo "  Output:   $RES_DIR"

if [[ "$(uname -s)" == "Darwin" || "$(uname -s)" == "Linux" ]]; then
  BIN_NAME="jobapply-backend"
else
  BIN_NAME="jobapply-backend.exe"
fi

BACKEND_DIST="$BACKEND_DIR/dist/jobapply-backend"

# 1. Build the backend if needed
if [ ! -x "$BACKEND_DIST/$BIN_NAME" ]; then
  echo "→ Backend bundle not found at $BACKEND_DIST/$BIN_NAME"
  echo "  Building it now (this takes 1–3 minutes the first time)…"
  (cd "$BACKEND_DIR" && bash build.sh)
fi

# 2. Verify build produced an executable
if [ ! -x "$BACKEND_DIST/$BIN_NAME" ]; then
  echo "✗ Backend build failed — $BACKEND_DIST/$BIN_NAME not found." >&2
  echo "  Run 'cd $BACKEND_DIR && bash build.sh' manually and look for errors." >&2
  exit 1
fi
echo "  ✓ Backend binary exists"

# 3. Quick sanity check — start the binary on a throwaway port with a hard timeout,
#    confirm it responds to /health, then kill it. Skipped on CI / when JAA_SKIP_SANITY=1.
if [ "${JAA_SKIP_SANITY:-0}" != "1" ]; then
  echo "→ Sanity-checking the bundled binary (5s timeout)…"
  TEST_PORT=18765
  TMP_DATA="$(mktemp -d)"
  # Run in background, redirect all output to /dev/null, max 5s wall time
  (
    JAA_PORT="$TEST_PORT" JAA_DATA_DIR="$TMP_DATA" \
      "$BACKEND_DIST/$BIN_NAME" </dev/null >/dev/null 2>&1 &
    PID=$!
    SUCCESS=0
    for _ in $(seq 1 25); do  # up to 5 seconds
      if curl -s -o /dev/null -m 1 "http://127.0.0.1:$TEST_PORT/health"; then
        SUCCESS=1
        break
      fi
      sleep 0.2
    done
    kill -9 "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    rm -rf "$TMP_DATA"
    if [ "$SUCCESS" = "1" ]; then
      echo "  ✓ Binary responds to /health"
    else
      echo "  ⚠ Binary didn't respond on port $TEST_PORT — release will still build but app may not run."
      echo "    Set JAA_SKIP_SANITY=1 to skip this check."
    fi
  )
fi

# 4. Copy backend into Tauri resources
mkdir -p "$RES_DIR/backend"
rm -rf "$RES_DIR/backend"/*
cp -R "$BACKEND_DIST/." "$RES_DIR/backend/"
echo "  ✓ Backend bundle copied to $RES_DIR/backend/"

# 5. Bundle Ollama if requested
if [ "${BUNDLE_OLLAMA:-0}" = "1" ]; then
  mkdir -p "$RES_DIR/ollama"
  case "$(uname -s)" in
    Darwin) URL="https://github.com/ollama/ollama/releases/latest/download/ollama-darwin" ;;
    Linux)  URL="https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64" ;;
    *) echo "Unknown OS for Ollama bundling"; exit 1 ;;
  esac
  echo "→ Downloading Ollama from $URL"
  curl -fSL -o "$RES_DIR/ollama/ollama" "$URL"
  chmod +x "$RES_DIR/ollama/ollama"
  echo "  ✓ Ollama bundled"
fi

echo "✓ Resources ready. Tauri build continues."
