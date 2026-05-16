# Phase 5 — Build the real installer

This is the one-time build sequence to go from "works in dev mode" to "I have a `.dmg` I can double-click."

## On macOS (Apple Silicon)

### Step 1 — Build the frozen Python backend (3–5 min, one-time)

```
cd "/Users/soomro/Desktop/Projects/job apply extension /backend"
bash build.sh
```

What this does:
- Creates `backend/.venv/` if it doesn't exist
- `pip install -r requirements.txt` (including PyInstaller)
- Runs `pyinstaller build.spec --clean`
- Produces `backend/dist/jobapply-backend/jobapply-backend` (~80 MB folder)

When it finishes, verify the binary boots:

```
./dist/jobapply-backend/jobapply-backend &
sleep 3
curl http://127.0.0.1:8000/health
kill %1
```

You should see `{"status":"ok",...}`. If not, the spec is missing a hidden import — paste the error and we patch the spec.

### Step 2 — Build the desktop app installer (4–8 min, one-time)

```
cd ../desktop
npm run build
```

What this does:
- Runs `bundle-resources.sh` — copies the frozen backend into `src-tauri/resources/backend/`
- Runs `cargo tauri build` in release mode (much slower than dev, but everything is cached after the first run)
- Produces a `.dmg` installer

Output location:

```
desktop/src-tauri/target/release/bundle/dmg/Job Apply Assistant_0.9.0_aarch64.dmg
```

### Step 3 — Install it

Double-click the `.dmg`. A Finder window opens showing the Job Apply Assistant icon. Drag it into the Applications folder shortcut.

The **first time** you launch the app, macOS will refuse to open it because it's not signed by a Developer ID. To bypass:

1. Open Applications in Finder
2. Right-click **Job Apply Assistant** → **Open**
3. macOS shows: *"Apple cannot verify that this app is free of malware..."* → click **Open**

After that, it launches normally every time.

## On Windows (x64)

### Step 1 — Build the backend

```
cd "C:\path\to\job apply extension\backend"
build.bat
```

### Step 2 — Build the installer

```
cd ..\desktop
npm run build
```

Two installers are produced:
- MSI: `desktop\src-tauri\target\release\bundle\msi\Job Apply Assistant_0.9.0_x64_en-US.msi`
- NSIS: `desktop\src-tauri\target\release\bundle\nsis\Job Apply Assistant_0.9.0_x64-setup.exe`

### Step 3 — Install it

Double-click either installer. Windows Defender SmartScreen will show *"Windows protected your PC"* because the installer isn't signed by a known publisher.

Click **More info** → **Run anyway**.

Same story as macOS: this dialog only appears the first time.

## Build options

```
# Default: don't bundle Ollama — users install it separately (~80 MB installer)
npm run build

# Bundle Ollama into the installer (~250 MB but no separate Ollama install needed)
BUNDLE_OLLAMA=1 npm run build
```

## What you should see in the running app

After install + first launch:

1. Splash screen "Starting backend…" appears
2. Backend spawns from inside the bundle, finds port 8000 (or 8001 if 8000 is taken)
3. **First-run wizard** appears asking Cloud / Local / Hybrid
4. After completing the wizard, the dashboard loads
5. Subsequent launches skip the wizard and go straight to the dashboard

## Common issues

### "ModuleNotFoundError" in backend logs

The PyInstaller spec missed a hidden import. Add it to `backend/build.spec` under `hidden`, rebuild backend, rebuild app.

### macOS: "Job Apply Assistant is damaged and can't be opened"

This is Gatekeeper interfering with an unsigned app. Run:

```
xattr -cr "/Applications/Job Apply Assistant.app"
```

That strips the quarantine attribute. Open the app normally afterwards.

### Windows: WiX Toolset missing

Tauri tries to download WiX automatically. If it fails (corporate network etc.), install manually:

```
winget install WixToolset.WixToolset
```

Then rerun `npm run build`.

### Build size is way too big

Check `desktop/src-tauri/resources/backend/` — should be ~80 MB. If it's 500 MB, your backend venv has dev tooling that shouldn't be bundled. Delete `backend/.venv/` and re-run `bash build.sh` — the venv will recreate fresh from requirements.txt.
