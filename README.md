# Job Apply Assistant

An end-to-end job application copilot:
- **Chrome extension** that lives on LinkedIn / Greenhouse / Lever pages, scores your fit, flags missing skills, warns when a job requires a non-English language (e.g. German), and autofills application forms.
- **FastAPI backend** that parses your CV(s), calls Azure OpenAI (`gpt-5-mini`) for fit analysis, and stores every application you've analyzed.
- **Dashboard website** that shows your CV library, profile (used for autofill), full application history, and analytics (fit-score distribution, sources, statuses).

```
job apply extension/
├── backend/     FastAPI + SQLite + Azure OpenAI
├── extension/   Chrome MV3 extension (LinkedIn, Greenhouse, Lever)
└── website/     Plain HTML/JS dashboard
```

## 1. Run the backend

```bash
cd backend
cp .env.example .env          # then fill in your Azure OpenAI key
bash run.sh
```

The API will start at http://localhost:8000 (Swagger UI at `/docs`).

The `.env` should contain your Azure OpenAI details:

```
AZURE_OPENAI_ENDPOINT=https://veilixdocumentextraction.openai.azure.com/
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-5-mini
AZURE_OPENAI_API_VERSION=2024-02-15-preview
```

> ⚠️ Rotate the key you pasted earlier in the Azure portal — it was shared in chat.

## 2. Load the Chrome extension

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the Job Apply Assistant icon.

The extension talks to `http://localhost:8000` by default. You can change this in the side panel → Settings or in the dashboard.

## 3. Run the dashboard

It's static — any local server works. Quickest option:

```bash
cd website
python3 -m http.server 5500
```

Open http://localhost:5500.

Then:
1. Go to **My CVs** and upload your CV. Multiple CVs are supported; one is marked active.
2. Go to **Profile** — most fields are pre-filled from the CV. Edit anything that's wrong (this is what gets autofilled into application forms).
3. Visit any LinkedIn job post. A floating button **Analyze this job** appears at the bottom-right; click it.
4. You'll see fit score, strengths, gaps, recommendations, and a language flag (e.g. "German required").
5. On Greenhouse/Lever application pages, click **Analyze & autofill** — known fields get filled and the role is logged in your dashboard.
6. The dashboard now shows the role under **Applications** with full analysis. Update status (Applied / Interviewing / Offer / Rejected) as you progress.

## How fit analysis works

For each job page the extension sends the JD plus your active CV's parsed text to `/analyze/`. The backend:

1. Detects the JD's language and scans for non-English language requirements (German, French, etc.) using a keyword + langdetect hybrid.
2. Sends CV + JD to `gpt-5-mini` with a recruiter persona prompt, asking for a fit score, strengths, gaps, and recommendations in strict JSON.
3. Saves the analysis as an `Application` row (status: `analyzed`) so you can revisit it on the dashboard.

## Supported job boards

- LinkedIn — job view + collections feed (fit analysis only)
- Greenhouse — analysis + autofill
- Lever — analysis + autofill
- Adding more boards: drop another script into `extension/content/` and add a `matches` entry in `manifest.json`. Copy the structure of `lever.js` — extract title / company / description into the shared payload and call `ANALYZE_JOB`.

## Where things live

| File | What it does |
|---|---|
| `backend/app/main.py` | FastAPI app + CORS |
| `backend/app/services/analyzer.py` | Azure OpenAI calls (`analyze_fit`, `structure_cv`, `answer_application_question`) |
| `backend/app/services/language.py` | Language detection + non-English requirement scanner |
| `backend/app/routes/` | REST endpoints for CVs, analyze, applications, profile |
| `extension/manifest.json` | Permissions and content-script matches |
| `extension/background/service_worker.js` | Centralized API proxy (avoids CORS in content scripts) |
| `extension/content/linkedin.js` | LinkedIn DOM extraction + on-page fit card |
| `extension/content/autofill.js` | Label-keyword field mapper used by Greenhouse + Lever |
| `extension/sidepanel/` | Persistent Chrome side panel UI |
| `website/index.html` | Dashboard (overview / applications / CVs / profile / settings) |

## Roadmap ideas

- Workday support (its DOM is hostile; needs site-specific selectors)
- Per-CV fit comparison — pick the best CV automatically based on the JD
- Cover-letter draft button on the side panel (already supported by `/analyze/answer`)
- Browser-based DOCX export of tailored CVs
- Move from SQLite to Postgres + auth when sharing across machines
