# Job Apply Assistant — Desktop App (Tauri 2.x)

Cross-platform desktop wrapper for the FastAPI backend, extension, and dashboard. Produces a single installer on macOS and Windows.

## Prerequisites

- **Rust** (stable, 1.77+) — install via [rustup.rs](https://rustup.rs/)
- **Node.js** 20+
- **Python** 3.10+ (used by the bundled FastAPI backend)
- **Platform deps**:
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) + WebView2 (preinstalled on Win11)
  - Linux: `sudo apt install libwebkit2gtk-4.1-dev libssl-dev`

## Run in dev mode

This runs the Python backend directly from `../backend/` (no PyInstaller needed). Hot-reload on Rust + frontend changes:

```bash
cd desktop
npm install
npm run dev
```

You should see a native window open. The splash screen waits for the backend to come up, then redirects to the dashboard or the first-run wizard.

## Build a production installer

Builds the PyInstaller backend first, then bundles everything into a `.dmg` (macOS) / `.msi` (Windows) / `.AppImage` (Linux).

```bash
# From desktop/
npm run build
```

Output:
- macOS: `src-tauri/target/release/bundle/dmg/Job Apply Assistant_0.9.0_x64.dmg`
- Windows: `src-tauri/target/release/bundle/msi/Job Apply Assistant_0.9.0_x64_en-US.msi`
- Linux: `src-tauri/target/release/bundle/deb/job-apply-assistant_0.9.0_amd64.deb`

## Bundling Ollama into the installer (optional)

By default, users install Ollama themselves with a one-line command. If you want Ollama embedded inside the installer (much larger but no extra install):

```bash
BUNDLE_OLLAMA=1 npm run build
```

## Architecture

```
Tauri shell (Rust)
├── spawns FastAPI backend (PyInstaller binary in release, python -m uvicorn in dev)
├── (optional) spawns ollama serve
├── waits for /health
└── webview navigates to http://127.0.0.1:<port>/dashboard/
```

The Chrome extension installs separately. It talks to the same `localhost:8000` backend.

## Files

- `src-tauri/src/main.rs` — Windows-subsystem entry stub
- `src-tauri/src/lib.rs` — Tauri builder + app lifecycle
- `src-tauri/src/backend.rs` — FastAPI subprocess manager
- `src-tauri/src/ollama.rs` — Ollama subprocess manager
- `src-tauri/src/commands.rs` — IPC commands callable from JS
- `src/index.html` — splash + auto-redirect
- `src/onboarding.html` + `onboarding.js` — three-screen first-run wizard
- `scripts/bundle-resources.sh` — copies PyInstaller output into Tauri resources

## Replacing placeholder icons

The icons in `src-tauri/icons/` are auto-generated placeholders. For real releases:

```bash
npx @tauri-apps/cli icon path/to/source-1024x1024.png
```

That command produces the full icon set (Mac .icns, Windows .ico, multiple PNG sizes) from a single source image.
