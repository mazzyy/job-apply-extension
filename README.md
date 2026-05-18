# Job Apply Assistant

A **cross-platform desktop application + Chrome extension + dashboard** that helps you apply to jobs faster and smarter. Analyze JD-vs-CV fit, autofill applications, draft cover letters, manage a question library, track everything in a dashboard, and route AI work to either Azure OpenAI (`gpt-5-mini`) or a local Ollama model — your choice per task.

> **Status:** v0.10.x — functional desktop app on macOS. See [`ROADMAP.md`](./ROADMAP.md) for the full plan and what's still pending.

---

## What it does (features in one place)

**On any job page (Chrome extension):**

- Detects job posts on LinkedIn, Greenhouse, Lever, Ashby, and generic career sites.
- Side-panel **Analyze this page** → fit score (0–100), strengths, gaps, recommendations, language requirements, JD char count.
- Side-panel **Autofill form** → fills name/email/phone/LinkedIn/etc. plus 100+ German/English labels, including custom ones from the question library.
- Side-panel **Draft cover letter** + **Draft LinkedIn DM** (to the person who posted the job, when LinkedIn shows them).
- **Easy Apply (guided)** on LinkedIn — walks every step of the Easy Apply modal, fills every field using your saved answers and AI fallbacks, **stops at the Submit button** for you to verify and click.
- On any open-ended question textarea, a small ✦ **Suggest answer** button appears that surfaces saved matching answers or drafts a new one via AI.
- Auto-watcher detects when you click any "Apply" / "Submit" / "Bewerben" button and marks that role as `applied` in your dashboard automatically.

**In the dashboard:**

- **Overview** — today / yesterday / week / month application counts, total stats (analyzed / applied / interviewing / offers / avg fit), 30-day daily activity bar chart.
- **Applications** — every role you've analyzed, filterable, click for detail dialog with full timeline.
- **Analytics** — funnel, response rate, avg fit by outcome, response-time stats, top recurring gaps, CV performance table, source effectiveness table, language demand chart, and **AI usage & cost** card (tokens, cost, by-provider, by-task, today/week/month rollups).
- **My answers** — 283 seeded common application questions (years per skill, work auth, language proficiency, salary, etc.) plus your custom questions. Each can have multiple answer variants (number, text, textarea, select, radio).
- **Question library** — full Q&A history with categories, pending-review queue.
- **Inbox** — paste a recruiter email, the AI classifies it (rejection / interview invite / offer / etc.) and updates the matching application's status.
- **My CVs** — upload multiple CVs, auto-pick the best one per JD.
- **Profile** — autofill data: name, contact, work auth (general + EU-specific), salutation, nobility title, gender, salary, current title, languages.
- **Settings** — LLM provider selector (Cloud / Local / Hybrid), per-task overrides, model picker dynamically populated from your installed Ollama models, API base URL, model verification.

**Behind the scenes:**

- All LLM calls logged to a database (`llm_usage` table) with task, provider, model, prompt + completion + reasoning tokens, estimated cost, latency, success/error.
- Library-first answer lookup: before the LLM gets a question, the curated bank is checked. Fuzzy matching on paraphrases. Translations across languages.
- Per-task routing in hybrid mode: routine tasks (CV parsing, Easy Apply field fills, email classification) → local; deep reasoning (fit analysis, cover letters) → cloud.
- Database schema migrations run on every startup (additive only — adds new columns idempotently).

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     macOS / Windows desktop app                          │
│                          (Tauri 2.x, Rust)                               │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐    │
│  │  Splash screen  │→ │  Webview shows   │→ │  System tray icon    │    │
│  │  + onboarding   │  │  dashboard at    │  │  Open / Quit         │    │
│  │  wizard         │  │  localhost:8000  │  │                      │    │
│  └─────────────────┘  └──────────────────┘  └──────────────────────┘    │
│              │              │                                            │
│              ▼              ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │              FastAPI backend (Python, PyInstaller-frozen)        │   │
│  │      → 50+ routes, SQLite database, Azure OpenAI + Ollama        │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│              │                                                           │
│              ▼ (optional, only if Local/Hybrid mode)                     │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │   Ollama runtime (user installs separately for now — Phase 6)    │   │
│  │   Default model: mistral:latest or llama3.2:3b                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
              ▲                                            ▲
              │ http://localhost:8000                      │
              │                                            │
┌─────────────┴──────────────┐              ┌──────────────┴─────────────┐
│   Chrome extension MV3     │              │   Browser tab (optional)   │
│   - LinkedIn / Greenhouse  │              │   localhost:8000/dashboard │
│   - Side panel             │              │   Same dashboard as the    │
│   - Easy Apply driver      │              │   Tauri webview            │
│   - Autofill engine        │              │                            │
│   - Question suggester     │              └────────────────────────────┘
└────────────────────────────┘
```

Three surfaces, one backend. The desktop app **runs the backend internally** (or *should* — see [Known issues](#known-issues)). The Chrome extension talks to the same backend on `localhost:8000`. The dashboard can be opened either inside the desktop window or in a regular browser tab.

---

## File structure

```
job apply extension/
│
├── README.md                   ← this file
├── ROADMAP.md                  ← full plan, phased build, decisions log
│
├── backend/                    ── FastAPI backend (Python 3.10+)
│   ├── app/
│   │   ├── main.py                  ← app entry, lifespan, model self-check on startup
│   │   ├── config.py                ← Azure key, paths, JAA_DATA_DIR resolution
│   │   ├── database.py              ← SQLAlchemy engine + ensure_schema() migration
│   │   ├── models/                  ── SQLAlchemy models (8 tables)
│   │   │   ├── cv.py, application.py, profile.py
│   │   │   ├── question.py          ← Question + QuestionAnswer (with answer_type)
│   │   │   ├── event.py             ← ApplicationEvent (timeline)
│   │   │   ├── llm_usage.py         ← every LLM call logged
│   │   │   └── settings.py          ← AppSettings (provider mode, model, base URL)
│   │   ├── routes/                  ── 50+ endpoints
│   │   │   ├── cvs.py               ← CV upload + multi-CV management
│   │   │   ├── analyze.py           ← /analyze/, /analyze/cover-letter, /analyze/linkedin-message
│   │   │   ├── applications.py     ← list + stats + events + /log dedupe
│   │   │   ├── profile.py           ← autofill data
│   │   │   ├── questions.py         ← library + answer-for-form + seed-bank + translation
│   │   │   ├── emails.py            ← paste-email parser + status updates
│   │   │   ├── analytics.py         ← overview, insights, llm-usage
│   │   │   └── settings.py          ← LLM provider + local-models picker
│   │   └── services/                ── business logic
│   │       ├── analyzer.py          ← _chat() routing, cloud + local clients, verify_model
│   │       ├── llm_pricing.py       ← per-model USD/1M-token rates
│   │       ├── cv_parser.py         ← PDF/DOCX text extraction
│   │       ├── cv_match.py          ← fast keyword-based CV ↔ JD scorer
│   │       ├── language.py          ← langdetect wrapper + JD lang requirement scanner
│   │       ├── question_matcher.py  ← paraphrase similarity (stems + char-ngrams)
│   │       ├── typed_answer.py      ← shape-correct answer per form input type
│   │       ├── answer_bank.py       ← 283 seed questions across 6 categories
│   │       ├── email_parser.py      ← LLM classification of recruiter emails
│   │       ├── events.py            ← emit() helper for timeline
│   │       └── translator.py        ← to_english + from_english helpers
│   ├── run.py                       ← uvicorn entry — used by both `bash run.sh` and PyInstaller
│   ├── run.sh                       ← dev launcher (bash run.sh — port 8000)
│   ├── build.spec                   ← PyInstaller spec
│   ├── build.sh / build.bat         ← one-command bundle
│   ├── dist/jobapply-backend/       ← PyInstaller output (gitignored)
│   ├── verify_model.py              ← standalone "does my Azure key work?" check
│   ├── requirements.txt
│   ├── .env / .env.example          ← Azure OpenAI credentials (override defaults in config.py)
│   ├── jobapply.db                  ← SQLite database (dev mode — installed app uses ~/Library/Application Support)
│   └── uploads/                     ← CV uploads (dev mode)
│
├── extension/                  ── Chrome extension (Manifest V3)
│   ├── manifest.json                ← permissions, content scripts, side panel
│   ├── background/
│   │   └── service_worker.js        ← API proxy + message routing
│   ├── content/
│   │   ├── linkedin.js              ← LinkedIn detection + JD/recruiter extraction
│   │   ├── linkedin_easyapply.js    ← guided Easy Apply driver
│   │   ├── greenhouse.js, lever.js, ashby.js
│   │   ├── generic.js               ← fallback for any career site
│   │   ├── autofill.js              ← shared autofill engine (FIELD_MAP, label discovery)
│   │   ├── apply_watcher.js         ← auto-status-update on Apply click
│   │   ├── question_suggest.js      ← ✦ Suggest answer button on textareas
│   │   └── overlay.css              ← shared on-page UI styles (FAB-era, mostly unused now)
│   ├── sidepanel/
│   │   ├── sidepanel.html           ← UI structure
│   │   ├── sidepanel.css            ← design tokens, theme
│   │   └── sidepanel.js             ← all the panel logic
│   └── icons/
│
├── website/                    ── Dashboard (vanilla HTML/CSS/JS)
│   ├── index.html                   ← all tabs in one document
│   ├── app.js                       ← all dashboard logic (~1500 lines)
│   ├── style.css                    ← design tokens + component styles
│   └── public/                      ← unused placeholder
│
├── desktop/                    ── Tauri 2.x desktop app
│   ├── README.md                    ← dev mode + build instructions
│   ├── PHASE5-BUILD.md              ← full install-build walkthrough
│   ├── package.json                 ← @tauri-apps/cli only
│   ├── src/                         ── frontend that loads first inside the Tauri window
│   │   ├── index.html               ← splash screen
│   │   ├── shell.css, shell.js      ← waits for backend, redirects to dashboard
│   │   ├── onboarding.html          ← three-screen first-run wizard
│   │   ├── onboarding.css, onboarding.js
│   │   └── (later) dashboard runs in iframe / direct navigation
│   ├── scripts/
│   │   ├── bundle-resources.sh      ← copies backend/dist into src-tauri/resources/ before build
│   │   └── bundle-resources.bat     ← same for Windows
│   ├── src-tauri/
│   │   ├── tauri.conf.json          ← bundle settings, window, tray, identifier
│   │   ├── Cargo.toml               ← Rust deps (tauri, tokio, reqwest, futures-util, which)
│   │   ├── build.rs                 ← tauri_build::build()
│   │   ├── capabilities/default.json ← Tauri 2.x permission model
│   │   ├── icons/                   ← placeholder icons (regenerate with `tauri icon`)
│   │   ├── resources/               ← populated at build time by bundle-resources.sh
│   │   │   └── backend/             ← copied from backend/dist/jobapply-backend/
│   │   └── src/
│   │       ├── main.rs              ← Windows-subsystem entry stub
│   │       ├── lib.rs               ← Tauri builder, lifespan, RunEvent::ExitRequested cleanup
│   │       ├── backend.rs           ← spawn / supervise FastAPI subprocess
│   │       ├── ollama.rs            ← spawn / supervise Ollama subprocess
│   │       └── commands.rs          ← Tauri IPC commands: backend_status, pull_model, set_provider…
│   └── target/                      ← Cargo build artifacts (gitignored, ~3 GB)
│
└── .gitignore
```

---

## Getting started

### Prerequisites

- **Python 3.10+**
- **Node.js 20+** (for the desktop app build only)
- **Rust stable** (for the desktop app build only — install via [rustup.rs](https://rustup.rs/))
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: Microsoft C++ Build Tools, WebView2
- *(Optional)* **Ollama** for local LLM mode — `brew install ollama` or [download](https://ollama.com/download)

### Quick dev mode (no installer)

This is the fastest way to get everything running for development:

```bash
# Terminal 1 — backend
cd backend
bash run.sh                          # uvicorn on http://localhost:8000

# Terminal 2 — dashboard (browser)
cd website
python3 -m http.server 5500
open http://localhost:5500           # macOS; on Windows use start http://localhost:5500
```

Then load the Chrome extension:

1. `chrome://extensions` → Developer mode ON → **Load unpacked** → select `extension/`
2. Pin the toolbar icon

Optionally start the Tauri desktop app (it'll detect the running backend and reuse it):

```bash
# Terminal 3 — Tauri dev
cd desktop
npm install
npm run dev
```

### Production build (installer)

See [`desktop/PHASE5-BUILD.md`](./desktop/PHASE5-BUILD.md) for the full walkthrough. The short version:

```bash
# Step 1 — freeze the Python backend
cd backend
bash build.sh                        # ~3 min first time; produces dist/jobapply-backend/

# Step 2 — build the desktop installer
cd ../desktop
npm run build                        # 10–40 min first time; subsequent runs much faster
```

Output:

- macOS: `desktop/src-tauri/target/release/bundle/dmg/Job Apply Assistant_0.10.0_aarch64.dmg`
- Windows: `...\bundle\msi\Job Apply Assistant_0.10.0_x64_en-US.msi`

First launch shows a security warning because we don't have a code-signing cert ($99/year, deferred to Phase 6). Right-click → Open on Mac, More info → Run anyway on Windows. After the first launch, it opens normally.

### Configuring credentials

Azure OpenAI credentials are baked into [`backend/app/config.py`](./backend/app/config.py) as defaults. You can override them with a `.env` file in `backend/`:

```
AZURE_OPENAI_ENDPOINT=https://veilixdocumentextraction.openai.azure.com/
AZURE_OPENAI_API_KEY=<your-key>
AZURE_OPENAI_DEPLOYMENT=gpt-5-mini
AZURE_OPENAI_API_VERSION=2024-02-15-preview
```

⚠️ The default key in `config.py` was pasted in chat and is logged in conversation history — **rotate it via Azure portal before sharing with anyone else.**

For local LLM: install Ollama, `ollama pull mistral:latest` (or `llama3.2:3b`), then in the app's Settings → LLM provider → pick **Local** or **Hybrid** → set the local model to whatever `ollama list` shows → Save → Test connection.

---

## LLM provider model

There are three modes (set in Settings → LLM provider):

| Mode | What runs where | Cost per day (moderate use) | Privacy |
|------|----------------|----------------------------|---------|
| **Cloud** | Everything → `gpt-5-mini` on Azure OpenAI | ~$0.50–$1.50 | Requests sent to Azure |
| **Local** | Everything → Ollama on your machine | $0 | Nothing leaves your machine |
| **Hybrid** | Routine tasks → Local; deep reasoning → Cloud | ~$0.10–$0.30 | Most data stays local |

Hybrid's per-task defaults (in `analyzer.py`'s `HYBRID_DEFAULTS`):

- **Cloud:** `analyze_fit`, `cover_letter`, `draft_answer` (quality matters most)
- **Local:** `structure_cv`, `typed_answer`, `email_classify` (constrained tasks where small models are fine)
- **Cloud:** `verify_model` (one-time health check)

You can override per-task in Settings (collapsed panel under "Per-task overrides"). Cost tracking lives in `llm_usage` table; see Analytics → AI usage & cost.

---

## Database

SQLite, single file. Lives in different places depending on how you run the app:

| How you launch | Database path |
|----------------|---------------|
| `bash run.sh` (dev) | `backend/jobapply.db` |
| Tauri desktop dev (`npm run dev`) | `~/Library/Application Support/com.jobapplyassistant.desktop/jobapply.db` |
| Installed `.app` from Applications | `~/Library/Application Support/com.jobapplyassistant.desktop/jobapply.db` |

Schema is created automatically on startup via `Base.metadata.create_all()`. Additive migrations run via `ensure_schema()` in `database.py` — adds new columns to existing DBs without breaking them. **Non-additive changes (rename, drop, type change) are not handled.**

Tables:

- `cvs` — your uploaded CVs (raw text + structured JSON)
- `applications` — every job you've analyzed or applied to
- `application_events` — timeline (analyzed / autofilled / applied / interview_scheduled / etc.)
- `profiles` — single-row, used for autofill
- `questions` + `question_answers` — library (with answer_type variants)
- `app_settings` — single-row, holds LLM provider + model + base URL
- `llm_usage` — every LLM call logged

---

## Known issues

| Issue | Status | Where to look |
|-------|--------|---------------|
| Bundled backend not found by Rust in installed .app | **Active** — needs `cargo clean` rebuild | `desktop/src-tauri/src/backend.rs` |
| Icons are placeholders | Open — regenerate with `npx @tauri-apps/cli icon` | `desktop/src-tauri/icons/` |
| Code signing not configured | Phase 6 (optional, $99/yr) | `desktop/src-tauri/tauri.conf.json` |
| Auto-update not wired | Phase 8 (deferred) | — |
| Ollama not bundled in installer | Phase A (next) — user installs separately | `desktop/scripts/bundle-resources.sh` (has BUNDLE_OLLAMA flag) |
| Single-user assumption (one Profile row, no auth) | Not blocking | — |
| LinkedIn DOM selectors will break on UI refresh | Maintenance debt | `extension/content/linkedin.js`, `linkedin_easyapply.js` |
| No real tests | Not blocking but should add before refactor | — |

---

## Recent work (most recent first)

- **Dynamic local-model dropdown** — Settings UI now populates the Local model dropdown from `GET /v1/models` against the live Ollama. Refresh button. Shows model sizes. Gracefully handles "Ollama not running" and "no models pulled."
- **Test Connection tests both providers** — Settings → Test connection now pings both cloud AND local regardless of mode. Per-provider green/red results.
- **Proxy-bypass on local calls** — `httpx.Client(trust_env=False)` so VPN apps that set system proxies via launchd don't break localhost calls.
- **Auto-append /v1** — if user types `http://localhost:11434` for Ollama base URL, code appends `/v1` automatically.
- **LinkedIn DM generator** — `/analyze/linkedin-message` endpoint + side-panel button + LinkedIn recruiter-name extraction.
- **English-only library + translation layer** — captured non-English questions get translated to English before storage. At fill time, the form's question is translated to English for matching, and the answer is translated back if the form is non-English (free-text fields only). Batch "Translate to English" button in dashboard.
- **Multi-type answer variants** — each question can store separate answers for number, text, textarea, select, radio. Autofill picks the matching variant.
- **283-question curated answer bank** — preseeded library covering years per skill (100+ tech terms), language proficiency (20 languages incl. German variants), work auth (EU/US/UK), salary, motivation, behavioral, EEO, education.
- **Profile fields expansion** — salutation, nobility_title, gender, eu_work_auth added to Profile model + dashboard form + autofill FIELD_MAP (German + English labels).
- **LLM usage tracking** — `llm_usage` table logs every call. Dashboard Analytics → AI usage & cost card shows totals, today/week/month, by-provider, by-task, with USD cost estimation.
- **Today/yesterday/week/month rollups** on Overview tab with daily activity bar chart.
- **Provider router** (analyzer.py `_chat()`) — cloud/local/hybrid mode with per-task overrides.
- **Tauri 2.x desktop app** — Rust + native webview + bundled Python backend + first-run wizard.

---

## Resuming work in a new chat (context dump for AI)

If you're a future AI assistant reading this:

**What's already built:** A complete desktop application (Tauri 2.x for macOS/Windows), Chrome extension (Manifest V3 for LinkedIn/Greenhouse/Lever/Ashby/generic career sites), FastAPI backend with 50+ endpoints, SQLite database, and a vanilla-JS dashboard. Provider routing supports Azure OpenAI (`gpt-5-mini`) and Ollama (local). The codebase is around 3000 lines of Python + 2000 lines of JavaScript + 500 lines of Rust + 200 lines of CSS/HTML.

**What's most recently in flux:** Phase 5 (installer) is mostly done but has one outstanding bug — the Rust code in `desktop/src-tauri/src/backend.rs` resolves the bundled backend path through `resource_dir()` which on macOS doesn't include the `resources/` subfolder, so the binary at `Contents/Resources/resources/backend/jobapply-backend` isn't found by candidate path #1 (`resource_dir.join("backend")`). I added a 4-path search but the user hasn't done a `cargo clean` rebuild yet to pick up the change. The workaround is the user runs `bash run.sh` in a terminal and the Rust code's "reuse-existing on port 8000" fallback picks it up.

**Where to start when resuming:**

1. Read `ROADMAP.md` for the full plan and what phases remain.
2. Read this README's "Known issues" section.
3. Last touched files: `desktop/src-tauri/src/backend.rs`, `backend/app/services/analyzer.py`, `backend/app/routes/settings.py`, `website/app.js`.
4. To run locally: `cd backend && bash run.sh`, then `cd ../desktop && npm run dev`. Backend on `localhost:8000`.
5. Ollama default port is 11434, OpenAI-compatible endpoint at `/v1`.
6. Database lives in `~/Library/Application Support/com.jobapplyassistant.desktop/` when running through Tauri.

**Coding conventions used:**

- Backend: FastAPI + SQLAlchemy 2.0, sync sessions, Pydantic v2.
- LLM calls go through `_chat()` in `analyzer.py` — never call OpenAI/Ollama directly elsewhere.
- Every LLM call passes a `task` keyword arg that drives provider routing and usage logging.
- Dashboard uses `window.location.origin` for API base URL (no hardcoded ports).
- Tauri 2.x is in use, NOT 1.x — the `Emitter` trait must be imported separately from `Manager`.
- Python is bundled via PyInstaller (one-folder mode). Hidden imports declared in `backend/build.spec`.

**Things to NOT do without asking:**

- Don't rewrite the backend in another framework / language (PyInstaller bundle is mature).
- Don't switch from Tauri to Electron (we made that decision for size/perf reasons — see ROADMAP section 8).
- Don't add server-side auth or hosting (single-user, localhost-only is the deliberate design).
- Don't change the database to Postgres without explicit migration planning (SQLite is correct for desktop apps).

---

## License

Personal project. No license assigned — ask before redistributing.

