#!/bin/bash
set -e

# Build the backend
cd "/Users/soomro/Desktop/Projects/job apply extension /backend"
bash build.sh

# Build the desktop app
cd ../desktop
npm run build

# --- Auto-install so you never run a stale build -------------------------------
APP_SRC="/Users/soomro/Desktop/Projects/job apply extension /desktop/src-tauri/target/release/bundle/macos/Job Apply Assistant.app"
if [ -d "$APP_SRC" ]; then
  echo "Installing new build to /Applications…"
  osascript -e 'quit app "Job Apply Assistant"' 2>/dev/null || true
  sleep 1
  rm -rf "/Applications/Job Apply Assistant.app"
  cp -R "$APP_SRC" "/Applications/Job Apply Assistant.app"
  echo "✓ Installed to /Applications — quit & reopen 'Job Apply Assistant'."
else
  echo "⚠ Built .app not found at: $APP_SRC"
  echo "  Open it from desktop/src-tauri/target/release/bundle/macos/ instead."
fi
