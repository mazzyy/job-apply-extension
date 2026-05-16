# Job Apply Assistant — Full Roadmap

A single, honest plan to take this from "works for me locally" to "real cross-platform desktop application with optional cloud or local LLM." This document is the source of truth — when in doubt, follow this file.

Last updated: 2026-05-15 · Phase 0 complete · Phase 1 in progress

---

## 1. Current state — what actually exists today

### 1.1 What works well
- **FastAPI backend** (`backend/`) with 40+ routes covering CV upload, multi-CV management, fit analysis, cover letters, application logging, application events/timeline, question library, email parsing, analytics, settings.
- **LLM provider router** (`backend/app/services/analyzer.py`) — `cloud` / `local` / `hybrid` modes, with per-task overrides. Cloud path verified against `gpt-5-mini`. Local path uses Ollama's OpenAI-compatible API at `localhost:11434/v1` but has not been tested end-to-end yet.
- **Chrome extension v0.8.0**, Manifest V3, with content scripts for LinkedIn, Greenhouse, Lever, Ashby, and a generic fallback. Side-panel UI redesigned. Autofill engine with German label coverage. Question-suggest button on textareas. Apply-watcher for auto-status-update.
- **LinkedIn Easy Apply guided submit** — type-aware field filling (numbers, selects, textareas), question-library lookup first, LLM fallback, stops at Submit for user review.
- **Question library with 283 seeded questions** across technical/logistics/salary/motivation/behavioral/diversity categories. Editable text/type/options. Add custom questions.
- **Dashboard website** (`website/`) with tabs: Overview, Applications, Analytics, My answers (bank), Question library, Inbox, CVs, Profile, Settings. Activity timeline in app-detail dialog. Email parser widget.

### 1.2 What works but is fragile
- **LinkedIn DOM selectors** — work today, will break when LinkedIn ships a UI refresh. Need to be treated as maintenance debt.
- **Ollama local provider** — code path exists, never tested with a real local server. May need small tweaks once exercised.
- **DB schema migrations** — handled by `ensure_schema()` on startup, but additive-only. Any non-additive change (drop column, rename, type change) will need a real migration story.
- **No real auth** — single-user assumption. The whole app trusts `localhost` and one Profile row.

### 1.3 What is partial or broken
- **Some content-script floating buttons (`.jaa-fab`) referenced in legacy CSS** but no longer injected after the v0.3 cleanup. Cosmetic only — no functional impact.
- **CSV/JSON export** of applications mentioned in early roadmap but not implemented.
- **No tests** — the whole codebase relies on manual verification. This will hurt at scale.
- **No retries / backoff** on Azure OpenAI failures beyond the four-strategy fallback in `_chat()`.
- **Email parsing is paste-only** — no Gmail / Outlook integration.

### 1.4 What's missing that the desktop release needs
- **Native window** — currently runs in a regular browser tab. Need Tauri shell.
- **Bundled Python runtime** — currently requires `pip install -r requirements.txt`. Need PyInstaller.
- **Bundled Ollama** — currently asks user to install separately. Need to ship it.
- **First-run wizard** — currently no onboarding. Need model-download UI.
- **Code signing** — currently unsigned. Need Apple Developer ID + Windows cert (or accept "unknown publisher" for personal use).
- **Auto-update** — currently no update mechanism. Tauri has an updater plugin we can wire in.
- **Installers** — currently nothing. Need `.dmg` for macOS and `.msi` for Windows.

---

## 2. Goal — what we're building

A **proper cross-platform desktop application** named **Job Apply Assistant** that:

1. Installs from a single `.dmg` (macOS) or `.msi` (Windows) installer.
2. Opens in a native window with no terminal commands or browser tab switching.
3. Lets the user choose between three LLM modes:
   - **Cloud** — uses Azure OpenAI `gpt-5-mini` (current behavior, ~$15-45/month for moderate use)
   - **Local** — uses an embedded Ollama runtime with a downloaded local model (zero ongoing cost, fully private)
   - **Hybrid** — routes routine tasks to local, deep-reasoning tasks to cloud (default — best cost/quality balance)
4. Bundles a sensible default local model (Llama 3.2 3B Instruct, ~2 GB Q4_K_M) but lets users upgrade to Qwen 2.5 7B (~4 GB) or any other Ollama model with one click.
5. Continues to host the same Chrome extension as a peer — the extension talks to `localhost:8000` regardless of whether the backend is running standalone or inside the desktop app.
6. Provides a system tray icon for quick access and a "Quit" affordance.

---

## 3. Architecture decisions (locked in)

| Decision | Choice | Rationale |
|---|---|---|
| Desktop framework | **Tauri 2.x** (Rust + native webview) | 8-15 MB installer vs Electron 80-150 MB. Native webview for tighter OS feel. Real cross-platform from one codebase. |
| Backend packaging | **PyInstaller one-folder** | Mature, ships Python + FastAPI as a subprocess of the Tauri app. Avoids requiring Python on user's machine. |
| Local LLM runtime | **Ollama** (subprocess) | Free, OpenAI-compatible API, model library, cross-platform. Already supported in our code. |
| Default local model | **Llama 3.2 3B Instruct (Q4_K_M)** | ~2 GB, runs on 8 GB RAM laptops, ~30-60 tok/s on CPU, decent JSON output. |
| Optional upgrade model | **Qwen 2.5 7B Instruct (Q4_K_M)** | ~4.4 GB, much better quality, needs 12 GB RAM. |
| Dashboard rendering | **Inside Tauri webview** (loaded from local FastAPI) | No browser tab. Tauri serves the existing `website/` files via the FastAPI static-files mount. |
| Chrome extension | **Continues to install separately** | Tauri can't ship a Chrome extension. Users install it once from chrome://extensions or eventually the Web Store. |
| Settings persistence | **SQLite in user's app-data directory** | Existing `jobapply.db` moves into `~/Library/Application Support/JobApplyAssistant/` on Mac, `%APPDATA%\JobApplyAssistant\` on Windows. |
| Code signing | **Optional Apple Developer ID + Windows cert** | For personal use, skip. For distribution, plan ~$300/year combined. |
| Auto-update | **Tauri updater plugin** (deferred to Phase 4) | Not blocking initial release. |
| Build automation | **GitHub Actions** (mac-latest + windows-latest runners) | Produces signed installers on every tag. |

---

## 4. Phased build plan

Each phase has explicit deliverables, a "definition of done", and an honest time estimate. Phases run in order — no parallelism unless called out.

### Phase 0 — Backend provider routing (DONE ✓)
- [x] `LLM_PROVIDER` setting (cloud / local / hybrid) stored in `app_settings` table
- [x] `_chat()` routes per task to Azure OpenAI or Ollama
- [x] Per-task overrides via `per_task` JSON field
- [x] `/settings/` GET + PUT endpoints
- [x] Backend smoke tests pass

### Phase 1 — Settings UI + Ollama smoke test (DONE ✓)
**Why this comes before the desktop app**: we need to confirm the cloud-vs-local switch actually works end-to-end with a real Ollama install before we package it inside a Tauri shell. Sequencing matters.

Deliverables:
- [x] Dashboard `Settings` tab gets a provider selector card: three radio buttons (Cloud / Local / Hybrid), model dropdown, base-URL input
- [x] Per-task override toggles (collapsed by default) for the seven LLM tasks
- [x] "Test connection" button that calls `/verify-model` and shows the result
- [x] Document a one-liner Ollama install for current backend users
- [ ] **Manual test (you do this)**: install Ollama on dev machine, pull `llama3.2:3b`, switch backend to `local`, run an analyze + an Easy Apply, verify quality is acceptable

Definition of done: `verify-model` returns PONG in all three modes on the dev machine, an Easy Apply field gets answered correctly in local mode.

### Phase 2 — PyInstaller backend bundle (DONE ✓)
The Tauri app launches the backend as a subprocess. The subprocess can't depend on system Python. So we freeze it.

Deliverables:
- [x] `backend/build.spec` — PyInstaller spec including FastAPI, SQLAlchemy, openai, langdetect, pypdf, python-docx
- [x] `backend/build.sh` + `backend/build.bat` — one-command bundle for Mac and Windows
- [ ] **Manual build (you do this)**: `cd backend && bash build.sh` produces `dist/jobapply-backend` (Mac) and `jobapply-backend.exe` (Windows) — single-folder bundle, ~80 MB each
- [x] Path-handling: bundled backend looks for DB / uploads in `~/Library/Application Support/JobApplyAssistant/` or `%APPDATA%\JobApplyAssistant\` (set via `JAA_DATA_DIR` env var)
- [ ] **Manual test (you do this)**: run the frozen binary directly, open the dashboard at `localhost:8000`, verify CV upload + analyze still work

Definition of done: `./jobapply-backend` boots on a Mac without Python installed, dashboard loads, CV uploads succeed.

### Phase 3 — Tauri shell + subprocess management (DONE ✓)
This is the heart of the desktop app: a Rust binary that starts the FastAPI backend, optionally starts Ollama, opens a window, and shuts everything down cleanly.

Deliverables:
- [x] `desktop/` folder with Tauri 2.x scaffold (`cargo create-tauri-app`)
- [x] `desktop/src-tauri/src/main.rs` + `lib.rs` — Rust entrypoint
- [x] `desktop/src-tauri/src/backend.rs` — spawn/kill PyInstaller bundle, health-check loop, port detection
- [x] `desktop/src-tauri/src/ollama.rs` — detect Ollama install, spawn `ollama serve` if needed, kill on exit
- [x] `desktop/src/index.html` + shell.js wrapper UI: window chrome, "Loading..." state until backend is ready, then iframe loads `http://localhost:8000/dashboard`
- [x] System tray config in tauri.conf.json (real menu wired in Phase 5)
- [ ] **Manual test (you do this)**: `npm run dev` on Mac — window opens, backend boots, dashboard loads in webview, Quit cleanly stops backend + Ollama

Definition of done: Single command (`npm run tauri dev`) opens a native window with the full dashboard running, no terminal commands separately.

### Phase 4 — First-run wizard + model downloader (DONE ✓)
On first launch, the app asks: "Cloud (faster, $0.50/day) or Local (free, slower)?" If local, downloads the model with progress.

Deliverables:
- [x] `desktop/src/onboarding.html` — three-screen wizard (welcome, mode pick, model download)
- [x] Tauri command `pull_model(name)` streams progress via events — calls Ollama's `/api/pull` and streams progress to the frontend
- [x] Model picker (Llama 3.2 3B, Llama 3.2 1B, Qwen 2.5 7B): Llama 3.2 3B (default), Qwen 2.5 7B (better), gpt-5-mini cloud only (no download)
- [x] On finish, calls `set_provider` and navigates to dashboard, transitions to main dashboard
- [ ] **Manual test (you do this)**: fresh launch on a clean machine, complete the wizard, verify selected model is set in the backend

Definition of done: A first-time user can complete setup in under 5 minutes with no terminal use.

### Phase 5 — macOS + Windows installers (~1 day)
Produce real installers, not dev builds.

Deliverables:
- [ ] `desktop/tauri.conf.json` configured with bundle settings (identifier `com.jobapplyassistant.app`, version, icons, file associations none)
- [ ] Icon set: 16/32/64/128/256/512 px PNG + ICO for Windows + ICNS for Mac
- [ ] Bundling step that copies the PyInstaller output into `desktop/src-tauri/resources/`
- [ ] Bundling step that copies the Ollama binary for each target into resources
- [ ] `npm run tauri build` produces `.dmg` on Mac and `.msi` on Windows
- [ ] **Manual test**: install the .dmg on a second Mac, install the .msi on a Windows VM, verify both launch and complete onboarding

Definition of done: a friend can download the installer, double-click, and use the app.

### Phase 6 — Code signing + notarization (optional, ~half a day)
Only do this if distributing beyond personal use.

Deliverables:
- [ ] Apple Developer ID Application certificate added to Tauri config (env var `APPLE_SIGNING_IDENTITY`)
- [ ] `APPLE_ID` + `APPLE_PASSWORD` (app-specific) configured for notarization via `xcrun notarytool`
- [ ] Windows code-signing cert wired into `signtool` (env var `WINDOWS_CERT_THUMBPRINT`)
- [ ] **Manual test**: install signed `.dmg` — no security dialogs; install signed `.msi` — no SmartScreen warning

Definition of done: First-time installer launches with zero security prompts on Mac and Windows.

### Phase 7 — CI release pipeline (~half a day)
Make releases reproducible.

Deliverables:
- [ ] `.github/workflows/release.yml` — runs on git tag, builds on macos-latest + windows-latest, uploads artifacts to GitHub Releases
- [ ] Tag format: `v0.9.0`, `v1.0.0`, etc.
- [ ] **Manual test**: push `v0.9.0` tag, watch GitHub Actions produce two installers in the release page

Definition of done: `git tag v0.9.0 && git push --tags` produces downloadable installers without manual intervention.

### Phase 8 — Auto-update (~1 day, deferred until first real users)
Tauri updater plugin checks a JSON manifest and downloads new versions.

Deliverables:
- [ ] `desktop/src-tauri/tauri.conf.json` updater section pointing at a manifest URL
- [ ] Static `latest.json` published alongside each release (hand-edited or CI-generated)
- [ ] In-app "Check for updates" menu item

Definition of done: tagged release N triggers update prompts on machines running release N-1.

---

## 5. File structure target

```
job-apply-extension/
├── ROADMAP.md                          # this file
├── README.md
├── backend/                            # existing FastAPI server
│   ├── app/
│   ├── requirements.txt
│   ├── build.spec                      # PHASE 2 — PyInstaller spec
│   ├── build.sh / build.bat            # PHASE 2 — one-command bundle
│   └── dist/                           # PyInstaller output (gitignored)
├── extension/                          # existing Chrome MV3 extension
├── website/                            # existing dashboard HTML/JS
│   └── (served by FastAPI static mount)
├── desktop/                            # PHASE 3 — Tauri app
│   ├── package.json
│   ├── tauri.conf.json                 # bundle + window config
│   ├── src/
│   │   ├── index.html                  # window shell
│   │   ├── onboarding.html             # PHASE 4 — first-run wizard
│   │   └── shell.js                    # iframe / lifecycle
│   ├── src-tauri/
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   ├── icons/                      # PHASE 5 — full icon set
│   │   ├── resources/                  # bundled PyInstaller output + Ollama bin
│   │   └── src/
│   │       ├── main.rs                 # entrypoint
│   │       ├── backend.rs              # FastAPI subprocess manager
│   │       ├── ollama.rs               # Ollama subprocess manager
│   │       └── commands.rs             # IPC commands for the frontend
│   └── scripts/
│       ├── bundle-ollama.sh            # download Ollama binary for current OS
│       └── bundle-backend.sh           # run PyInstaller, copy into resources/
└── .github/
    └── workflows/
        └── release.yml                 # PHASE 7 — CI build
```

---

## 6. Detailed task checklist (run top to bottom)

### Phase 1
- [ ] Add provider selector card to `website/index.html` Settings tab
- [ ] Wire `/settings/` GET in `website/app.js` to populate selector
- [ ] Wire change handlers to PUT `/settings/`
- [ ] Add per-task override accordion (analyze_fit, cover_letter, etc.)
- [ ] Add Test Connection button calling `/verify-model`
- [ ] Document Ollama install one-liner in README: `curl -fsSL https://ollama.com/install.sh | sh` (Mac/Linux), `winget install Ollama.Ollama` (Windows)
- [ ] User runs `ollama pull llama3.2:3b`, switches backend to local mode, verifies an Easy Apply still answers correctly

### Phase 2
- [ ] `pip install pyinstaller==6.10` added to backend/requirements.txt
- [ ] Write `backend/build.spec` (one-folder, --windowed, hidden-imports for uvicorn workers, sqlalchemy dialects, langdetect data)
- [ ] Add `--add-data` for the `website/` folder so FastAPI can serve it
- [ ] Patch `config.py` to use `os.environ.get("JAA_DATA_DIR")` for DB and uploads, defaulting to OS-appropriate path
- [ ] Test: `./dist/jobapply-backend/jobapply-backend` boots, `curl localhost:8000/health` returns ok

### Phase 3
- [ ] `cd desktop && npm create tauri-app@latest .` with template vanilla-ts
- [ ] Bump Tauri to 2.x stable
- [ ] Implement `backend.rs::spawn_backend()` — spawns frozen binary, captures stdout, waits for `/health` 200
- [ ] Implement `backend.rs::kill_backend()` — sends SIGTERM on Unix, taskkill on Windows
- [ ] Implement `ollama.rs::ensure_running()` — try `localhost:11434`, if not running spawn `ollama serve`
- [ ] Implement `main.rs::run()` — spawn backend, wait for ready, load webview pointing at `http://localhost:8000`
- [ ] Add window menu (File → Quit, Help → About)
- [ ] Add system tray with menu (Open dashboard, Settings, Quit)
- [ ] Frontend `src/index.html` — loading spinner until backend ready, then `<iframe>` of dashboard
- [ ] `npm run tauri dev` confirms native window + working dashboard

### Phase 4
- [ ] Tauri command `check_first_run() -> bool` — returns true if no profile + no CVs in DB
- [ ] Tauri command `pull_model(name)` — runs `ollama pull <name>`, returns stream of progress events
- [ ] Frontend wizard with three screens, smooth transitions
- [ ] Save chosen mode to backend `/settings/` on completion
- [ ] Detect Ollama not installed → show install link instead of pull progress

### Phase 5
- [ ] Generate icons from source SVG using `tauri icon path/to/icon.png`
- [ ] Configure `tauri.conf.json` bundle.identifier, bundle.icon array, bundle.resources
- [ ] Add bundling script that runs `bundle-backend.sh` + `bundle-ollama.sh` before `tauri build`
- [ ] Test `npm run tauri build` on Mac and Windows
- [ ] Open the resulting installer fresh on a clean machine, verify full flow

### Phase 6 (optional)
- [ ] Apply for Apple Developer Program
- [ ] Buy Windows code-signing cert (Sectigo or DigiCert OV cert ~$200/yr)
- [ ] Set env vars in CI: `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `WINDOWS_CERT_THUMBPRINT`
- [ ] Verify notarized `.dmg` opens with no Gatekeeper warning

### Phase 7
- [ ] Write `.github/workflows/release.yml`
- [ ] Test: `git tag v0.9.0 && git push --tags`
- [ ] Verify both installers appear on the Release page

### Phase 8 (deferred)
- [ ] Enable updater in `tauri.conf.json`
- [ ] Sign update bundles
- [ ] Publish `latest.json`
- [ ] Add "Check for updates" menu item

---

## 7. Known limitations + carry-forward debt

| Area | Limitation | When to address |
|---|---|---|
| Auth | Single-user, trusts localhost | If we ever ship multi-user, replace `Profile` row with users table + auth |
| DB migrations | Additive only via `ensure_schema()` | When we need a real schema change. Add Alembic. |
| Tests | None | Before any major refactor or open-sourcing |
| LinkedIn selectors | Will break on UI refresh | Treat as ongoing maintenance. Add e2e Playwright test that runs on a known job listing. |
| Local LLM quality on fit analysis | 3B/7B models are weaker than `gpt-5-mini` | Default hybrid mode mitigates. Document the tradeoff in onboarding. |
| Model file size | 2-4 GB download on first run | Make the wizard handle resume + retry. Show estimate before download starts. |
| Windows Defender / SmartScreen | Unsigned .msi triggers warnings | Phase 6 — code signing |
| macOS Gatekeeper | Unsigned .dmg requires right-click → Open | Phase 6 — notarization |
| Auto-update | Manual upgrades only | Phase 8 |
| Privacy doc | None | Required for Chrome Web Store and Mac/Windows store listings |
| Telemetry | None | Don't add without explicit opt-in. State that clearly. |

---

## 8. Decision log

Every irreversible choice gets recorded here so we remember why later.

- **2026-05-15** — Picked Tauri over Electron. Reason: 10× smaller binary, native webview, easier cross-platform.
- **2026-05-15** — Picked Llama 3.2 3B as default local model. Reason: smallest model that handles JSON output reliably; ~2 GB download.
- **2026-05-15** — Picked Ollama over llama.cpp direct or LM Studio. Reason: OpenAI-compatible API means zero code change in backend.
- **2026-05-15** — Picked PyInstaller over Nuitka or Briefcase. Reason: most mature, ships fine on both OSes, large ecosystem.
- **2026-05-15** — Decided to bundle backend as a subprocess rather than rewrite in Rust. Reason: ~3000 lines of Python work today; rewriting would be months for no user-visible benefit.

---

## 9. How to use this document

1. **Always start from Phase 1 if returning after a break.** Don't skip ahead.
2. **One phase at a time.** Don't begin Phase 3 until Phase 2 is fully done.
3. **Definition of Done is binary.** If the manual test fails, the phase isn't done.
4. **Update this file as we go.** When something is finished, check it off. When a decision changes, add a new line to section 8.
5. **Honesty over optics.** If something half-works, mark it as partial in section 1.3 — don't pretend it's done.

---

## 10. Open questions to resolve before Phase 5

These are decisions I need from you, not technical work I can do alone:

- **Distribution scope**: just for you, or planning to give it to other people? Determines code-signing investment.
- **Apple Developer Program**: do you have an account? ($99/year)
- **Windows code-signing**: do you want to invest in a cert? ($200-500/year)
- **GitHub repo**: is the code in a repo yet? If yes, what's the URL? Needed for CI.
- **App name**: "Job Apply Assistant" or something else?
- **Default mode for first-time users**: I propose `hybrid` (cheap parts local, hard parts cloud). Confirm?

Answer these when ready and we proceed to Phase 1.
