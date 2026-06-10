# Job Apply Assistant

A **cross-platform desktop application + Chrome extension + dashboard** that helps you apply to jobs faster and smarter. Analyzes job-vs-CV fit, autofills applications, drafts cover letters and LinkedIn DMs, manages a 283-question answer library, tracks every role in a dashboard with analytics, and routes AI work to either Azure OpenAI (`gpt-5-mini`) or a local Ollama model — your choice per task.

> **Version:** 0.10.x · macOS arm64 + Windows x64 (dev) · Single-user
> **Status:** Functional end-to-end. See [Section 2 — Status](#2-current-status--known-issues).

---

## Table of contents

1. [Project overview](#1-project-overview)
2. [Current status & known issues](#2-current-status--known-issues)
3. [What it does (features)](#3-what-it-does-features)
4. [Architecture](#4-architecture)
5. [File structure](#5-file-structure)
6. [Quick start (dev mode)](#6-quick-start-dev-mode)
7. [Building the installer](#7-building-the-installer)
8. [Configuration](#8-configuration)
9. [LLM provider routing](#9-llm-provider-routing)
10. [Backend reference](#10-backend-reference)
11. [Chrome extension reference](#11-chrome-extension-reference)
12. [Dashboard reference](#12-dashboard-reference)
13. [Database schema](#13-database-schema)
14. [Troubleshooting](#14-troubleshooting)
15. [Recent work](#15-recent-work)
16. [Phase status & roadmap](#16-phase-status--roadmap)
17. [Context for resuming in a new chat](#17-context-for-resuming-in-a-new-chat)

---

## 1. Project overview

Three components share one backend:

- **Desktop app** (Tauri 2.x) — single `.dmg` / `.msi` install. Boots a bundled Python backend + opens a native window with the dashboard.
- **Chrome extension** (Manifest V3) — lives in your browser, talks to `localhost:8000`. Handles LinkedIn / Greenhouse / Lever / Ashby / generic career sites.
- **Dashboard** (vanilla HTML/JS) — served by the backend at `localhost:8000/dashboard/`. Same UI inside the desktop app or in any browser.

Built around `gpt-5-mini` on Azure OpenAI with optional Ollama for local/free inference. Per-task routing in hybrid mode lets routine work run locally while deep reasoning runs cloud-side.

---

## 2. Current status & known issues

### What works end-to-end today

- Backend serving 50+ endpoints, SQLite persistence, additive schema migrations
- Chrome extension on all 5 supported job-board flavours
- LinkedIn Easy Apply guided submission (type-aware field filling, library lookup, stop-before-submit)
- Cloud LLM (gpt-5-mini) verified
- Local LLM (Ollama / mistral / llama3.2) verified working
- Hybrid mode with per-task routing
- Question library with 283 seeded questions + multi-type variants
- LLM usage tracking with cost estimation
- Activity timelines per application
- Email parser for status auto-updates
- LinkedIn DM generator
- Cover letter generator
- Today/yesterday/week/month rollups + 30-day activity chart
- Tauri desktop app launches, runs bundled backend, shows dashboard
- UI-editable Azure credentials (no `.env` editing needed)
- Layered `.env` loader (works in dev AND installed)

### Known issues being tracked

| Issue | Severity | Workaround / next step |
|---|---|---|
| `cargo` sometimes reuses stale Rust artifacts on `npm run build` | Medium | `cargo clean` before rebuilding when paths change |
| Webview caches dashboard HTML aggressively | Low | Press **Cmd+R** in app after backend updates |
| Tauri icons are placeholder `J` logos | Low | Run `npx @tauri-apps/cli icon path/to/source-1024.png` before public release |
| Installer is unsigned (Mac Gatekeeper + Windows SmartScreen warnings on first launch) | Low | Right-click → Open on Mac; More info → Run anyway on Windows. Phase 6 of roadmap: $99/yr Apple Dev cert |
| Ollama is **not** bundled — user installs separately | Medium | Phase A of roadmap: bundle Ollama binary so installer is fully self-contained |
| LinkedIn DOM selectors will break on UI refresh | Permanent | Maintenance debt. Watch logs in console; update selectors in `linkedin.js` / `linkedin_easyapply.js` |
| No real test suite | Medium | Manual verification only. Add Playwright e2e before any major refactor |

---

## 3. What it does (features)

### On any job page (Chrome extension)

- Detects job posts on LinkedIn, Greenhouse, Lever, Ashby, and generic career sites.
- **Analyze this page** → fit score (0–100), strengths, gaps, recommendations, language requirements (e.g. "fluent German required"), JD character count.
- **Autofill form** → fills name, email, phone, LinkedIn, GitHub, salutation, nobility title, gender, EU work auth, salary expectation, plus 100+ German/English label patterns.
- **Cover letter** → 220–320 word tailored letter, copy-to-clipboard, regenerate.
- **LinkedIn DM** → short message to the role's poster (auto-extracts recruiter name from LinkedIn), references CV-vs-JD specifics.
- **Easy Apply (guided)** on LinkedIn — walks every step, fills every field using library + AI fallbacks, **stops at Submit** for user verification.
- **✦ Suggest answer** button on every open-ended textarea in any form — finds saved answers or drafts new ones via AI.
- **Auto-status-update** — detects clicks on Apply/Submit/Bewerben buttons and marks the role as `applied` in the dashboard.

### In the dashboard

- **Overview** — Today / Yesterday / Week / Month application counts; total stats (analyzed / applied / interviewing / offers / avg fit); 30-day daily-activity bar chart; fit-score distribution; source split; recent activity feed.
- **Applications** — every role with filters, click for detail dialog showing full event timeline.
- **Analytics** — funnel, response rate, avg fit by outcome, response-time stats, top recurring gaps, CV performance table, source effectiveness, language demand chart, **AI usage & cost** card with cloud vs local split.
- **My answers** — 283 seeded application questions across 6 categories; per-question multiple answer variants (number/text/textarea/select/radio); search + filter; add custom questions.
- **Question library** — full Q&A history, pending-review queue for AI-drafted answers needing verification.
- **Inbox** — paste a recruiter email, AI classifies it (rejection/interview/offer/recruiter reachout/etc.) and auto-updates the matching application's status.
- **My CVs** — upload multiple CVs, mark one as active, auto-pick the best per JD.
- **Profile (autofill)** — name, contact, work auth, salutation, gender, languages, salary expectations.
- **Settings** — LLM provider (Cloud/Local/Hybrid), per-task overrides, Azure credentials, local model picker (dynamic from Ollama), API base URL, model verification.

### Behind the scenes

- Every LLM call logged with task, provider, model, tokens, cost, latency, success.
- Library-first answer lookup — paraphrases matched fuzzily; LLM is the fallback, not the default.
- Form-language translation: German questions captured into English library; answers translated back at fill time for free-text fields.
- Type-aware answers: number fields get integers, selects get exact option matches, textareas get prose.
- Pre-seeded answer bank covers every common technical YOE question and language proficiency dropdown across 20 languages.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  Tauri 2.x desktop app (Rust + WebView)                  │
│                                                                          │
│  ┌──────────────┐ → ┌─────────────────┐ → ┌──────────────────────────┐  │
│  │ Splash       │   │ Webview loads   │   │ System tray             │  │
│  │ + first-run  │   │ localhost:8000/ │   │ (Open / Quit)           │  │
│  │ wizard       │   │ dashboard/      │   │                          │  │
│  └──────────────┘   └─────────────────┘   └──────────────────────────┘  │
│         │                                                                │
│         ▼  spawns + supervises                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  FastAPI backend (Python, PyInstaller-frozen one-folder bundle) │    │
│  │  • 50+ routes (CVs, analyze, applications, questions, ...)       │    │
│  │  • SQLite at ~/Library/Application Support/JobApplyAssistant/    │    │
│  │  • Serves dashboard at /dashboard/                                │    │
│  │  • LLM router: cloud (Azure) vs local (Ollama) per task          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│         │                                                                │
│         │ (optional, only when local/hybrid mode is on)                  │
│         ▼                                                                │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Ollama runtime — user installs separately (Phase A: bundle it)  │    │
│  │  Models: mistral:latest / llama3.2:3b / qwen2.5:7b (user picks)  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                                ▲
                                │ HTTP localhost:8000
                                │
┌───────────────────────────────┴──────────────┐  ┌──────────────────────┐
│           Chrome extension (MV3)              │  │  Browser tab          │
│  • Side panel (analyze / autofill / DM)       │  │  localhost:8000/      │
│  • 5 content scripts (linkedin / greenhouse / │  │  dashboard/           │
│    lever / ashby / generic)                   │  │  (optional 2nd view) │
│  • Easy Apply guided driver                   │  └──────────────────────┘
│  • Apply-watcher (auto-status-update)          │
│  • Question suggester (✦ button on textareas) │
└───────────────────────────────────────────────┘
```

One backend, three surfaces. The Chrome extension and the dashboard can run side-by-side; both talk to the same `localhost:8000`.

---

## 5. File structure

```
job apply extension/
│
├── README.md                       ← this file
├── ROADMAP.md                      ← phased build plan, decisions log
│
├── backend/                        ─── FastAPI backend (Python 3.10+)
│   ├── app/
│   │   ├── main.py                      ← FastAPI app, lifespan, model self-check, static mount
│   │   ├── config.py                    ← Layered .env loader, Azure creds, paths
│   │   ├── database.py                  ← SQLAlchemy engine + ensure_schema() additive migrations
│   │   │
│   │   ├── models/                      ─── SQLAlchemy ORM (8 tables)
│   │   │   ├── cv.py                        ← CV (multi-CV per user)
│   │   │   ├── application.py               ← Application (every analyzed/applied role)
│   │   │   ├── event.py                     ← ApplicationEvent (timeline entries)
│   │   │   ├── profile.py                   ← Profile (autofill data — salutation, gender, EU auth, ...)
│   │   │   ├── question.py                  ← Question + QuestionAnswer (with answer_type variants)
│   │   │   ├── llm_usage.py                 ← every LLM call logged with cost
│   │   │   └── settings.py                  ← AppSettings (provider, model, Azure creds, per-task)
│   │   │
│   │   ├── routes/                      ─── REST endpoints
│   │   │   ├── cvs.py                       ← CV upload, list, set-active, delete, parse
│   │   │   ├── analyze.py                   ← /analyze/, /cover-letter, /linkedin-message, /best-cv, /answer
│   │   │   ├── applications.py              ← list, stats, events, /log (dedupe within 30min)
│   │   │   ├── profile.py                   ← autofill GET/PUT
│   │   │   ├── questions.py                 ← /, /custom, /seed-bank, /unanswered, /by-id, /answers, /match,
│   │   │   │                                 /draft, /answer-for-form, /needs-review, /translate-to-english
│   │   │   ├── emails.py                    ← /parse — LLM email classification + status update
│   │   │   ├── analytics.py                 ← /overview, /insights, /llm-usage
│   │   │   └── settings.py                  ← /, /local-models (Ollama proxy)
│   │   │
│   │   └── services/                    ─── Business logic
│   │       ├── analyzer.py                  ← THE LLM router. _chat() dispatches to cloud/local.
│   │       │                                  verify_model() pings both providers.
│   │       │                                  _resolve_azure_credentials() reads DB > .env > config.
│   │       ├── llm_pricing.py               ← Per-model USD/1M-token rates for cost estimation
│   │       ├── cv_parser.py                 ← PDF (pypdf) + DOCX (python-docx) text extraction
│   │       ├── cv_match.py                  ← Fast keyword-based CV ↔ JD scorer (pick best CV)
│   │       ├── language.py                  ← langdetect + JD language requirement scanner
│   │       ├── question_matcher.py          ← Paraphrase similarity (stems + char-ngrams)
│   │       ├── typed_answer.py              ← Shape-correct answer per input type (num/text/select)
│   │       ├── answer_bank.py               ← 283 seed questions across 6 categories
│   │       ├── email_parser.py              ← Recruiter email LLM classifier
│   │       ├── events.py                    ← emit() helper for timeline
│   │       └── translator.py                ← to_english / from_english using the LLM router
│   │
│   ├── run.py                           ← uvicorn entrypoint (used by run.sh AND PyInstaller)
│   ├── run.sh                           ← dev launcher: bash run.sh → uvicorn on port 8000
│   ├── build.spec                       ← PyInstaller spec (hidden imports, data files)
│   ├── build.sh / build.bat             ← one-command bundle
│   ├── dist/jobapply-backend/           ← PyInstaller output (gitignored, ~80MB folder)
│   ├── verify_model.py                  ← standalone "does Azure key work?" checker
│   ├── requirements.txt
│   ├── .env / .env.example              ← Azure OpenAI credentials override
│   ├── jobapply.db                      ← dev SQLite (installed app uses ~/Library/Application Support/)
│   └── uploads/                         ← dev CV uploads
│
├── extension/                      ─── Chrome extension (MV3)
│   ├── manifest.json                    ← permissions, content scripts per board, side panel
│   ├── background/
│   │   └── service_worker.js            ← API proxy, message routing, session storage
│   ├── content/
│   │   ├── linkedin.js                      ← LinkedIn JD/recruiter extraction + on-page card (deprecated)
│   │   ├── linkedin_easyapply.js            ← THE Easy Apply guided driver — type-aware field filler
│   │   ├── greenhouse.js / lever.js / ashby.js  ← board-specific JD extractors
│   │   ├── generic.js                       ← fallback for any career site (auteega.com etc.)
│   │   ├── autofill.js                      ← shared FIELD_MAP + label discovery (multilingual)
│   │   ├── apply_watcher.js                 ← detects Apply/Submit clicks → auto-marks applied
│   │   ├── question_suggest.js              ← ✦ Suggest answer button on textareas
│   │   └── overlay.css                      ← legacy on-page UI styles
│   ├── sidepanel/
│   │   ├── sidepanel.html                   ← UI structure
│   │   ├── sidepanel.css                    ← design tokens, components
│   │   └── sidepanel.js                     ← all the panel logic
│   └── icons/
│
├── website/                        ─── Dashboard (single-page vanilla)
│   ├── index.html                       ← all 9 tabs in one document
│   ├── app.js                           ← all logic (~1700 lines, well-commented sections)
│   ├── style.css                        ← design tokens + components
│   └── public/                          ← unused placeholder
│
├── desktop/                        ─── Tauri 2.x desktop app
│   ├── README.md                        ← dev mode + build instructions
│   ├── PHASE5-BUILD.md                  ← full install-build walkthrough
│   ├── package.json                     ← @tauri-apps/cli dev dep only
│   ├── src/                             ─── frontend loaded first in Tauri window
│   │   ├── index.html                       ← splash screen
│   │   ├── shell.css / shell.js             ← waits for backend, redirects to dashboard
│   │   ├── onboarding.html                  ← three-screen first-run wizard
│   │   ├── onboarding.css / onboarding.js
│   ├── scripts/
│   │   ├── bundle-resources.sh              ← copies backend/dist into src-tauri/resources/ before build
│   │   └── bundle-resources.bat
│   ├── src-tauri/
│   │   ├── tauri.conf.json                  ← bundle, window, tray, identifiers
│   │   ├── Cargo.toml                       ← Rust deps (tauri, tokio, reqwest, futures-util, which)
│   │   ├── build.rs                         ← tauri_build::build()
│   │   ├── capabilities/default.json        ← Tauri 2.x permission model
│   │   ├── icons/                           ← placeholders (regenerate with `tauri icon`)
│   │   ├── resources/                       ← populated by bundle-resources at build time
│   │   │   └── backend/                         ← PyInstaller output copied here
│   │   └── src/
│   │       ├── main.rs                      ← Windows-subsystem entry stub
│   │       ├── lib.rs                       ← Tauri builder, lifespan, cleanup
│   │       ├── backend.rs                   ← FastAPI subprocess manager (4-candidate path search)
│   │       ├── ollama.rs                    ← Ollama subprocess manager
│   │       └── commands.rs                  ← IPC commands: backend_status, pull_model, set_provider...
│   └── target/                          ← Cargo artifacts (gitignored, ~3GB)
│
└── .gitignore
```

---

## 6. Quick start (dev mode)

Fastest way to get running, no installer needed.

### Prerequisites

- Python 3.10+
- Node.js 20+ (for desktop app dev only)
- Rust stable (for desktop app dev only — install from <https://rustup.rs>)
- macOS: `xcode-select --install`
- Windows: Microsoft C++ Build Tools + WebView2
- Optional: Ollama for local LLM (`brew install ollama` or <https://ollama.com/download>)

### Run in three terminals

```
# Terminal 1 — backend
cd backend
pip install -r requirements.txt   # first time only
bash run.sh                        # uvicorn on http://localhost:8000

# Terminal 2 — dashboard in browser
cd website
python3 -m http.server 5500
open http://localhost:5500         # or browse to localhost:8000/dashboard/ via backend

# Terminal 3 — Tauri desktop app (optional)
cd desktop
npm install                        # first time only
npm run dev                         # native window + reuses backend on 8000
```

Then load the Chrome extension:

1. `chrome://extensions` → Developer mode ON
2. **Load unpacked** → select `extension/` folder
3. Pin the toolbar icon

---

## 7. Building the installer

Produces a `.dmg` on macOS / `.msi` on Windows. ~10–40 min first build, faster on subsequent runs.

```
# Step 1 — freeze the Python backend (≈3 min first time)
cd backend
bash build.sh                              # creates dist/jobapply-backend/ (~80 MB folder)

# Step 2 — build the desktop installer (≈8 min first time, 2-5 min subsequent)
cd ../desktop
npm run build                              # produces .dmg / .msi in target/release/bundle/
```

Output locations:

- macOS: `desktop/src-tauri/target/release/bundle/dmg/Job Apply Assistant_0.10.0_aarch64.dmg`
- Windows: `desktop\src-tauri\target\release\bundle\msi\Job Apply Assistant_0.10.0_x64_en-US.msi`

### First-launch security warnings (unsigned build)

Both OSes will warn on first launch because we don't have signing certs. One-time per OS:

- **macOS**: Right-click the `.app` in Applications → **Open** → click Open in the dialog
- **Windows**: SmartScreen says "Windows protected your PC" → click **More info** → **Run anyway**

After first launch, both open normally.

### Optional: bundle Ollama binary into the installer

By default users install Ollama separately. To bundle:

```
BUNDLE_OLLAMA=1 npm run build
```

Adds ~30 MB to the installer; user no longer needs `brew install ollama`. The model itself still downloads on first run via the wizard.

### When Tauri uses stale Rust artifacts

If you change `src-tauri/src/*.rs` files and `npm run build` doesn't seem to pick them up:

```
cd desktop/src-tauri
cargo clean                                # nuke compiled artifacts
cd ..
npm run build                              # forces clean rebuild
```

---

## 8. Configuration

### Azure OpenAI credentials — three ways to set them (priority order)

**1. UI (recommended)** — Open the app → Settings → **Azure OpenAI credentials** card → paste API key, deployment name, endpoint URL, API version → Save. Stored in the database, masked in the UI (only last 4 chars shown), survives rebuilds.

**2. `.env` file** — Four locations searched in priority order, first match wins:

```
backend/.env                                          # dev mode
~/Library/Application Support/JobApplyAssistant/.env  # installed app (Mac)
%APPDATA%\JobApplyAssistant\.env                      # installed app (Windows)
~/.jobapply.env                                        # cross-platform fallback
```

Format:

```
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=sk-...
AZURE_OPENAI_DEPLOYMENT=gpt-5-mini
AZURE_OPENAI_API_VERSION=2024-02-15-preview
```

**3. Environment variables** — Standard OS env vars work too. `AZURE_OPENAI_API_KEY=... uvicorn ...`.

### Local LLM (Ollama)

```
brew install ollama          # macOS
winget install Ollama.Ollama # Windows
ollama pull llama3.2:3b      # 2 GB, recommended
ollama pull mistral:latest   # 4.4 GB, better quality
ollama serve                  # auto-starts on Mac, manual on others
```

Then in the app: Settings → LLM provider → **Local** or **Hybrid** → pick model from the dropdown (auto-populates from your Ollama install) → Save → Test connection.

### Database location

| Context | SQLite path |
|---|---|
| `bash run.sh` (dev) | `backend/jobapply.db` |
| Tauri dev (`npm run dev`) | `~/Library/Application Support/com.jobapplyassistant.desktop/jobapply.db` |
| Installed `.app` | Same as above |

The schema is created automatically on first launch. Additive migrations run via `ensure_schema()` in `database.py` — adds new columns without breaking existing data. Non-additive changes (rename, drop, type change) are not handled.

### Profile data (used for autofill)

Open the app → Profile (autofill) tab. Fill in:

- Name (full / first / last), email, phone
- Address (city, country)
- LinkedIn, GitHub, portfolio URLs
- Current company + title
- Years of experience
- Salutation (Mr/Ms/Dr/Prof)
- Title of nobility (Dr., Prof. Dr., ...)
- Gender
- EU work authorization (Yes/No)
- Work authorization (free text)
- Salary expectation, notice period
- Languages (used for proficiency dropdowns)

---

## 9. LLM provider routing

Three modes, set in Settings → LLM provider:

| Mode | Cost/day (moderate use) | Privacy | Speed |
|---|---|---|---|
| **Cloud** | $0.50–$1.50 | Requests sent to Azure | Fastest (2–5s/call) |
| **Local** | $0 | Nothing leaves machine | Slower (10–30s/call) |
| **Hybrid** | $0.10–$0.30 | Mixed | Mixed (best for routine + cloud for hard reasoning) |

### Hybrid mode per-task defaults

Set in `analyzer.py` (`HYBRID_DEFAULTS`):

| Task | Default in hybrid |
|---|---|
| `analyze_fit` | Cloud (heaviest reasoning) |
| `cover_letter` | Cloud (writing quality matters) |
| `draft_answer` | Cloud (nuanced first-person prose) |
| `structure_cv` | Local (constrained structured extraction) |
| `typed_answer` | Local (short Easy Apply field fills) |
| `email_classify` | Local (simple classification) |
| `verify_model` | Cloud (one-time health check) |

Override per-task in Settings → LLM provider → "Per-task overrides" accordion.

### How verification works

Settings → **Test connection** always pings both providers (cloud + local) regardless of mode. Shows separate green/red results so you can verify Ollama setup before flipping to local mode. The top-level "model verified" indicator in the sidebar reflects the active mode's primary provider.

---

## 10. Backend reference

### Routes (50+)

**CVs** (`/cvs/`)

- `GET /cvs/` — list all CVs
- `POST /cvs/` — upload PDF/DOCX/TXT (multipart with file + label + tag + set_active)
- `GET /cvs/active` — get currently-active CV
- `POST /cvs/{id}/activate` — set as active
- `DELETE /cvs/{id}` — delete

**Analyze** (`/analyze/`)

- `POST /analyze/` — fit analysis (JD + CV → score, gaps, strengths, recs, language flags). Auto-selects best CV if `auto_select_cv: true`. Saves an Application row by default.
- `POST /analyze/best-cv` — score each CV vs JD, return ranked list
- `POST /analyze/cover-letter` — 220–320 word tailored letter
- `POST /analyze/linkedin-message` — 110–180 word DM to the role poster
- `POST /analyze/answer` — generic open-ended answer drafter (legacy; prefer `/questions/answer-for-form`)

**Applications** (`/applications/`)

- `GET /applications/` — list (with filter/limit)
- `GET /applications/stats` — totals + funnel + buckets
- `GET /applications/{id}` — detail
- `PATCH /applications/{id}` — update status (analyzed → applied → interview → offer → rejected)
- `DELETE /applications/{id}` — delete
- `POST /applications/log` — log a role applied via autofill (idempotent — same URL within 30min dedupes)
- `GET /applications/{id}/events` — timeline
- `POST /applications/{id}/events` — add note

**Profile** (`/profile/`)

- `GET /profile/` — autofill data
- `PUT /profile/` — update

**Questions** (`/questions/`)

- `GET /questions/` — full library (with answers and variants)
- `POST /questions/` — create from text (auto-classifies category)
- `POST /questions/custom` — create with input_type + options
- `POST /questions/seed-bank` — idempotently load 283 seeded common questions
- `GET /questions/unanswered` — bank questions with no user answer yet
- `GET /questions/needs-review` — auto-drafted answers awaiting verification
- `POST /questions/match` — paraphrase match a question to the library
- `POST /questions/draft` — LLM draft a new answer
- `POST /questions/answer-for-form` — **the main one**: returns shape-correct answer for one form field (library-first lookup, then LLM fallback, with input_type / max_length / options metadata for type-aware answers)
- `POST /questions/translate-to-english` — batch translate existing non-English questions to English (merges duplicates)
- `GET/PATCH/DELETE /questions/by-id/{qid}` — manage one question
- `POST /questions/by-id/{qid}/answers` — add an answer variant (with answer_type)
- `POST /questions/by-id/{qid}/mark-reviewed` — clear the needs-review flag
- `PATCH/DELETE /questions/answers/{aid}` — update / delete one variant
- `POST /questions/answers/{aid}/use` — bump usage counter

**Emails** (`/emails/`)

- `POST /emails/parse` — pasted recruiter email → classified kind, summary, suggested status, auto-applies to matching application

**Analytics** (`/analytics/`)

- `GET /analytics/overview` — total + funnel + today/yesterday/week/month rollups + by-source + fit-buckets + CV performance + source effectiveness + language demand + 30-day daily activity + top recurring gaps
- `GET /analytics/insights` — short narrative notes derived from overview
- `GET /analytics/llm-usage` — total cost, tokens, calls, latency + today/week/month rollups + by-provider + by-task + by-model + 30-day daily series

**Settings** (`/settings/`)

- `GET /settings/` — LLM provider, local model, base URL, per-task overrides, Azure creds (masked)
- `PUT /settings/` — update any subset (azure_api_key empty string = no change, null = clear)
- `GET /settings/local-models` — proxies Ollama's `/v1/models` (tries localhost + 127.0.0.1, bypasses system proxies)

**Health + verification**

- `GET /health` — backend status, model, endpoint, dotenv path, data dir, model_verified flag
- `POST /verify-model` — force re-verify (pings both cloud + local providers)
- `GET /dashboard/` — serves the website (static mount)

### Services (in `backend/app/services/`)

- **`analyzer.py`** — central LLM router. Every LLM call goes through `_chat(messages, task=...)`. Routes to cloud or local based on `_resolve_provider(task)`. Captures token usage from response. Writes one row to `llm_usage` per call (with cost estimation from `llm_pricing.py`). Has multiple retry strategies for empty / malformed responses.
- **`typed_answer.py`** — for form fields. Builds a strict prompt that returns shape-correct JSON `{value, explanation, confidence, needs_review}`. Coerces number/select/textarea outputs into the requested type. Handles language-proficiency questions specially using `Profile.languages`. Has `lookup_default_answer()` that checks the library before calling the LLM.
- **`cv_parser.py`** — PDF (pypdf) + DOCX (python-docx) → plain text.
- **`cv_match.py`** — fast keyword scorer for picking the best CV per JD without an LLM call.
- **`question_matcher.py`** — paraphrase similarity using token overlap + char-trigrams + a stem/synonym dictionary.
- **`answer_bank.py`** — 283 seed questions in a Python list, organized by category. Idempotent insertion.
- **`translator.py`** — `to_english(text)` + `from_english(text, lang_code)` using the LLM router.
- **`email_parser.py`** — LLM classifier + heuristic application-matching by sender domain / company name.
- **`events.py`** — `emit(db, app_id, kind, title, ...)` helper used everywhere status changes.
- **`llm_pricing.py`** — per-model USD/1M-token rates. Update when prices change.
- **`language.py`** — langdetect wrapper + scanner for non-English language requirements in JDs.

---

## 11. Chrome extension reference

Manifest V3. Content scripts inject per-domain. Side panel and background service worker coordinate.

### Content scripts (in `extension/content/`)

- **`linkedin.js`** — runs on LinkedIn job pages. Extracts title/company/location/JD/recruiter via 7-selector fallback (LinkedIn's DOM is volatile). Watches SPA URL changes.
- **`linkedin_easyapply.js`** — the Easy Apply driver. Walks each step of the modal, fills every visible field using the library + AI fallback, **stops at the Submit button**. Type-aware field detection (number/text/select/radio/textarea via 5 strategies). Highlights required-blank fields in yellow.
- **`greenhouse.js` / `lever.js` / `ashby.js`** — board-specific JD extractors.
- **`generic.js`** — fallback for any career site that isn't on the supported list. Heuristic detection ("looks like a job page" / "has form fields").
- **`autofill.js`** — shared engine. `FIELD_MAP` has 30+ entries covering English + German labels for every Profile field. 6-strategy label discovery (aria-label, aria-labelledby, `<label for>`, closest ancestor, wrapper text, fallback to placeholder/name).
- **`apply_watcher.js`** — listens for clicks on Apply/Submit/Bewerben/Postuler/Aplicar buttons across all sites. Auto-marks the last-analyzed application as `applied`.
- **`question_suggest.js`** — adds a ✦ Suggest answer button next to every textarea on every form. Opens a popover with saved matches + AI draft.

### Background (`extension/background/service_worker.js`)

- Proxies all API calls (avoids CORS in content scripts).
- Stores `lastApplicationId` + `lastApplicationUrl` in `chrome.storage.session` so `apply_watcher.js` knows which row to update on submit.
- Settings: API base URL + per-user preferences.

### Side panel (`extension/sidepanel/`)

- HTML: splash screen → analyze + autofill + cover-letter + Easy Apply + LinkedIn DM buttons + Settings card.
- JS: tracks `lastAnalysis`, `lastJobPayload`, `lastApplicationId` so cover letter / DM buttons reuse the most recent context.
- Settings: API base URL, auto-pick best CV toggle, Test Connection (pings both providers), local model picker.

---

## 12. Dashboard reference

Nine tabs in `website/index.html`. All JS in `website/app.js` (~1700 lines, sectioned by `/* ====== Tab name ====== */` comments).

| Tab | Loaded function | Backend endpoints |
|---|---|---|
| Overview | `loadStats`, `loadApps`, `loadTimeframes` | `/applications/stats`, `/applications/`, `/analytics/overview` |
| Applications | `loadApps`, `openApp` | `/applications/`, `/applications/{id}`, `/applications/{id}/events` |
| Analytics | `loadAnalytics`, `loadLLMUsage` | `/analytics/overview`, `/analytics/insights`, `/analytics/llm-usage` |
| My answers | `loadAnswerBank` | `/questions/`, `/questions/seed-bank`, `/questions/custom`, `/questions/translate-to-english` |
| Question library | `loadQuestions`, `loadNeedsReview` | `/questions/`, `/questions/needs-review` |
| Inbox | submit handler on `#email-text` | `/emails/parse` |
| My CVs | `loadCvs` | `/cvs/` |
| Profile (autofill) | `loadProfile` | `/profile/` |
| Settings | `loadProviderSettings`, `loadLocalModels`, `loadAzureFields`, `checkApi` | `/settings/`, `/settings/local-models`, `/verify-model`, `/health` |

API base URL is derived from `window.location.origin` (with `localStorage.apiBase` override), so the dashboard works on any port that backend chooses.

---

## 13. Database schema

SQLite single file. Schema auto-created via `Base.metadata.create_all()`. Additive migrations via `ensure_schema()` in `database.py`.

### Tables

| Table | Rows | Purpose |
|---|---|---|
| `cvs` | many | Uploaded CVs (raw text + structured JSON + active flag) |
| `applications` | many | Every analyzed/applied job |
| `application_events` | many | Per-application timeline (analyzed, autofilled, applied, status_change, email_received, rejected, offered, note, ready_to_submit) |
| `profiles` | 1 | Single Profile row — autofill data |
| `questions` | many | Question library entries (text, normalized, category, input_type metadata, needs_review flag) |
| `question_answers` | many | Per-question answer variants tagged by answer_type (number / text / textarea / select / radio); is_default flag |
| `app_settings` | 1 | Single AppSettings row — provider mode, local model, base URL, per-task JSON, Azure credentials |
| `llm_usage` | many | One row per LLM call: task, provider, model, tokens, cost, latency, success/error |

### Single-user assumption

The app deliberately stores ONE Profile row and ONE AppSettings row. Switching to multi-user would require an explicit users table + auth model — not blocked but not built.

---

## 14. Troubleshooting

### "AZURE_OPENAI_API_KEY is empty"

- Paste your key in Settings → **Azure OpenAI credentials** → Save.
- Or curl directly: `curl -X PUT http://localhost:8000/settings/ -H "Content-Type: application/json" -d '{"azure_api_key":"YOUR_REAL_KEY"}'`
- Or drop a `.env` at `~/Library/Application Support/JobApplyAssistant/.env` (Mac) or `%APPDATA%\JobApplyAssistant\.env` (Windows) and restart the app.
- Verify with `curl http://localhost:8000/health` — `api_key_set: true` should appear.

### Cloud says PONG but local says "Connection error"

Run `ollama list` to confirm models are pulled. The model name in Settings must **exactly** match what Ollama reports (e.g. `mistral:latest`, not `mistral:7b`). Use the dropdown in Settings to pick from your installed models — don't type the name manually.

### Local URL says "Ollama not reachable"

- Confirm Ollama is running: `curl http://localhost:11434/v1/models` should return JSON.
- Confirm base URL ends with `/v1`: `http://localhost:11434/v1` (the code auto-appends if you typed just `http://localhost:11434`).
- macOS VPN/proxy apps that set system proxies via launchd may intercept localhost calls. The backend now passes `trust_env=False` to httpx — should be fixed.

### Dashboard doesn't show the latest UI changes

The Tauri webview caches HTML. Inside the app window: **Cmd+R** to force-reload. If that's not enough, quit (Cmd+Q) and relaunch.

### "Bundled backend not found in any of N candidate paths"

The Rust code can't locate the PyInstaller bundle inside the .app. Run with diagnostic logging:

```
"/Applications/Job Apply Assistant.app/Contents/MacOS/job-apply-assistant"
```

Look for `[JAA]` lines listing which paths were checked. The actual binary should be at `Contents/Resources/resources/backend/jobapply-backend`.

Fix is in code as of 0.10.0 (4-path search + tree walk on failure). If you have an older build:

```
cd desktop/src-tauri && cargo clean && cd .. && npm run build
```

### `npm run build` is stuck at "Sanity-checking the bundled binary"

Old version of the script had a non-terminating health check. Fixed in current `bundle-resources.sh` — uses `kill -9` and a 5s timeout. If you still hit it, set `JAA_SKIP_SANITY=1 npm run build`.

### `cargo metadata` fails with `command not found`

Rust isn't installed or not in PATH. Install via <https://rustup.rs>, then **restart your terminal** so PATH updates.

### Bundled backend starts but dashboard says API unreachable

Backend started on a port other than 8000 (find_free_port walked up). Chrome extension defaults to 8000. Either:
- Kill the conflicting process on 8000 and relaunch the app
- Or in the extension's side-panel Settings, set API base URL to whatever port the app is actually using

---

## 15. Recent work (chronological, newest first)

### 0.10.x — recent

- **Layered `.env` loader** — config.py now searches 4 locations (CWD, backend/, ~/Library/Application Support/JobApplyAssistant/, ~/.jobapply.env). Installed apps can drop their `.env` in the per-user data dir.
- **`/health` endpoint reports dotenv path + data dir** — easy debugging of "where is my config coming from?"
- **UI-managed Azure API key** — new Azure OpenAI credentials card in Settings. Stored masked in DB. Cache-invalidates on save. Removes the need to edit `config.py` or `.env`.
- **Dynamic Ollama model dropdown** — Settings → Local model field populates from `GET /v1/models`. Shows model sizes. Refresh button. Graceful "Ollama not reachable" + install hint when needed.
- **Test Connection pings both providers** regardless of mode. Per-provider green/red. Diagnostic block (URLs tried, proxy env vars) on failures.
- **Proxy-bypass for localhost** — both `_local_client()` and `/local-models` use `httpx.Client(trust_env=False)` so VPN apps that set system proxies don't break localhost calls.
- **Auto-append `/v1`** to Ollama base URLs if missing.
- **4-candidate path search** for bundled backend resolution in installed `.app`.
- **LinkedIn DM generator** — `/analyze/linkedin-message` + side-panel button + LinkedIn recruiter-name auto-extraction.
- **English-only question library** — captured non-English questions translated to English on storage; answers translated back to form's language at fill time (free-text only). Dashboard "Translate to English" batch button.
- **Multi-type answer variants** — each question can have separate number / text / textarea / select / radio answers. Autofill picks the matching variant.
- **283-question curated bank** — preseeded covering YOE for 100+ skills, language proficiency in 20 languages (+ German variants), work auth (EU/US/UK/DE), salary, motivation, behavioral, EEO, education.
- **Expanded Profile fields** — salutation, nobility_title, gender, eu_work_auth + new German/English labels in autofill FIELD_MAP.
- **LLM usage tracking** — `llm_usage` table logs every call with cost. Dashboard Analytics → AI usage & cost card.
- **Today / Yesterday / Week / Month rollups** + 30-day activity bar chart on Overview.

### 0.9.x — installer + LLM router

- **Tauri 2.x desktop app** — Rust + native webview + bundled Python backend + first-run wizard
- **LLM provider router** — cloud / local / hybrid with per-task overrides
- **PyInstaller backend bundle**
- **Phase 5 build pipeline** — `bash build.sh` → `npm run build` → `.dmg` / `.msi`

### 0.5–0.8 — Easy Apply + extensions

- LinkedIn Easy Apply guided submission
- Question library backend + UI
- Application timeline / activity events
- Email parser → status updates
- Analytics dashboard
- Auto-pick best CV per JD
- Cover letter generator
- Auto-mark as applied on submit click

### 0.1–0.4 — foundation

- FastAPI backend skeleton
- Chrome MV3 extension with content scripts per board
- Dashboard with overview / applications / CVs / profile / settings tabs
- CV upload + parsing
- Fit analysis via gpt-5-mini

---

## 16. Phase status & roadmap

From [`ROADMAP.md`](./ROADMAP.md):

| Phase | What | Status |
|---|---|---|
| 0 | Backend provider routing | ✅ Done |
| 1 | Settings UI + Ollama smoke test | ✅ Done |
| 2 | PyInstaller backend bundle | ✅ Done |
| 3 | Tauri shell + subprocess management | ✅ Done |
| 4 | First-run wizard + model downloader | ✅ Done |
| 5 | Real `.dmg` / `.msi` installers | ✅ Done |
| **A** | **Bundle Ollama binary into installer** | **Next** |
| 6 | Code signing + notarization | Optional ($99/yr) |
| 7 | CI release pipeline (GitHub Actions) | Optional |
| 8 | Auto-update via Tauri updater | Optional |

Phase A is the recommended next step — bundles Ollama so users get a fully self-contained installer (one `.dmg`, no separate Ollama install). See ROADMAP section 4 Phase A discussion.

---

## 17. Context for resuming in a new chat

If you're a future AI assistant picking up this project, here's what you need to know in 60 seconds.

**What's already built:** A complete cross-platform desktop app (Tauri 2.x), Chrome extension (Manifest V3), FastAPI backend with 50+ routes, SQLite database with 8 tables, and a vanilla-JS dashboard. ~3000 lines of Python + 2500 lines of JavaScript + 500 lines of Rust + 400 lines of CSS/HTML. Supports both Azure OpenAI (`gpt-5-mini`) and Ollama (local) with per-task routing.

**Where work is most likely to land:**

- Adding new fields to `Profile` model → also add to `routes/profile.py`, `website/index.html` profile form, `extension/content/autofill.js` FIELD_MAP
- Adding new application-form labels for autofill → just expand FIELD_MAP in `autofill.js`
- New LLM-using features → call `_chat(messages, task=...)` from `services/analyzer.py`. Never call OpenAI/Ollama clients directly.
- New seed questions → edit `services/answer_bank.py` (list of tuples), `POST /questions/seed-bank` is idempotent
- New routes → add to `routes/`, register in `main.py`

**Coding conventions:**

- Python: FastAPI + SQLAlchemy 2.0, sync sessions, Pydantic v2, type hints everywhere
- JS: vanilla, `$(sel)` = `document.querySelector`, `$all(sel)` = Array.from(querySelectorAll), `esc(s)` = HTML escape
- Rust: Tauri 2.x (NOT 1.x — `Emitter` is a separate trait from `Manager`, must be imported explicitly)
- Every LLM call passes `task=` keyword for routing + usage logging
- Dashboard uses `window.location.origin` for API base (no hardcoded ports)
- Database schema migrations are additive-only via `ensure_schema()` — never drop or rename in place

**Things NOT to do without asking:**

- Don't rewrite the backend in another framework
- Don't switch Tauri to Electron (size + perf reasons)
- Don't add server-side auth or hosting (single-user localhost is the design)
- Don't change SQLite to Postgres (single-user desktop app)
- Don't paste API keys back into chat (rotate via Azure portal if exposed)

**Most recently in flux:**

- Bundled backend path resolution in installed `.app` — fixed with 4-candidate search but may need `cargo clean` rebuild
- Azure key now lives in DB (UI-editable) — no more `config.py` editing required
- Layered `.env` loader — backend/, ~/Library/Application Support/JobApplyAssistant/, etc.

**Start by reading:**

1. This README (you're here)
2. [`ROADMAP.md`](./ROADMAP.md) for phased plan
3. `backend/app/services/analyzer.py` for the LLM routing logic — most central piece
4. `desktop/src-tauri/src/backend.rs` for how the desktop app spawns the FastAPI backend

**To verify everything works locally before starting:**

```
cd backend && bash run.sh                          # backend on :8000
curl http://localhost:8000/health                  # should return JSON with api_key_set, dotenv_path
curl http://localhost:8000/analytics/overview      # should return stats
# Browser: http://localhost:8000/dashboard/        # should show the dashboard
```

If all three work, the codebase is healthy.

---

## License

Personal project. No license assigned — ask before redistributing.

