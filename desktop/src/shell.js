import { invoke } from "https://esm.sh/@tauri-apps/api@2/core";
import { listen } from "https://esm.sh/@tauri-apps/api@2/event";

const barFill   = document.getElementById("bar-fill");
const barPct    = document.getElementById("bar-pct");
const barStage  = document.getElementById("bar-stage");
const stepsEl   = document.getElementById("steps");
const errorPanel = document.getElementById("error-panel");
const errorDetail = document.getElementById("error-detail");
const retryBtn  = document.getElementById("retry");

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

/* ---- Weighted boot stages. Each step contributes to the overall %. ---- */
const STEPS = [
  { id: "launch",   label: "Launching app",            weight: 5  },
  { id: "backend",  label: "Starting backend server",  weight: 35 },
  { id: "db",       label: "Initializing database",    weight: 15 },
  { id: "model",    label: "Verifying AI model",       weight: 20 },
  { id: "ollama",   label: "Preparing local AI (Ollama)", weight: 15 },
  { id: "dashboard",label: "Loading dashboard",        weight: 10 },
];
const state = {};                 // id -> { status: pending|active|done, detail, pct }
STEPS.forEach(s => state[s.id] = { status: "pending", detail: "", pct: 0 });

function render() {
  // overall % = sum of (weight * step-progress)
  let pct = 0;
  for (const s of STEPS) {
    const st = state[s.id];
    const frac = st.status === "done" ? 1 : st.status === "active" ? (st.pct || 0.15) : 0;
    pct += s.weight * frac;
  }
  pct = Math.min(100, Math.round(pct));
  barFill.style.width = pct + "%";
  barPct.textContent = pct + "%";
  const active = STEPS.find(s => state[s.id].status === "active");
  barStage.textContent = active
    ? (active.label + (state[active.id].detail ? " — " + state[active.id].detail : "") + "…")
    : (pct >= 100 ? "Ready" : "Starting up…");

  stepsEl.innerHTML = STEPS.map(s => {
    const st = state[s.id];
    if (st.status === "pending") return "";   // only show reached steps
    const icon = st.status === "done"
      ? `<span class="ic check">✓</span>`
      : `<span class="ic"><span class="dot"></span></span>`;
    const meta = st.status === "done" && st.at ? `<span class="meta">${st.at}</span>` : "";
    const detail = st.detail ? ` — ${st.detail}` : "";
    return `<li class="${st.status}">${icon}<span>${s.label}${detail}</span>${meta}</li>`;
  }).join("");
}

function setStep(id, status, detail) {
  const st = state[id];
  if (!st) return;
  // auto-complete any earlier active steps when a later one starts
  if (status === "active") {
    const idx = STEPS.findIndex(s => s.id === id);
    for (let i = 0; i < idx; i++) {
      const prev = state[STEPS[i].id];
      if (prev.status !== "done") { prev.status = "done"; prev.at = prev.at || elapsed(); }
    }
  }
  st.status = status;
  if (detail !== undefined) st.detail = detail;
  if (status === "done") st.at = elapsed();
  render();
}
function setStepPct(id, frac, detail) {
  const st = state[id];
  if (!st) return;
  st.status = "active"; st.pct = frac;
  if (detail !== undefined) st.detail = detail;
  render();
}

function finishAll() {
  STEPS.forEach(s => { if (state[s.id].status !== "done") { state[s.id].status = "done"; state[s.id].at = state[s.id].at || elapsed(); } });
  barFill.classList.add("done");
  render();
}

function showError(detail) {
  errorPanel.classList.remove("hidden");
  errorDetail.textContent = detail;
}

let navigated = false;
async function goToApp(port) {
  if (navigated) return;
  navigated = true;
  setStep("model", "done");
  setStepPct("dashboard", 0.5, "almost there");
  let firstRun = false;
  try { firstRun = await invoke("check_first_run"); } catch {}
  finishAll();
  await new Promise(r => setTimeout(r, 350));   // let the bar reach 100%
  window.location.href = firstRun ? "./onboarding.html" : `http://127.0.0.1:${port}/dashboard/`;
}

async function boot() {
  setStep("launch", "done");
  setStep("backend", "active", "connecting");

  // Backend ready → verify model via /health, then navigate
  const unlistenReady = await listen("backend-ready", async (event) => {
    const port = event.payload;
    setStep("backend", "done");
    setStep("db", "done");
    setStep("model", "active", "checking deployment");
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
      setStep("model", h.model_verified ? "done" : "active",
        h.model_verified ? (h.model || "verified") : "unverified (you can still use the app)");
    } catch {}
    await goToApp(port);
  });

  // Ollama download progress (first launch may fetch the binary)
  await listen("ollama-install-progress", (e) => {
    const p = e.payload || {};
    if (p.total > 0) {
      const mb = (p.downloaded / 1048576).toFixed(0), tot = (p.total / 1048576).toFixed(0);
      setStepPct("ollama", Math.max(0.05, (p.percent || 0) / 100), `downloading ${mb}/${tot} MB`);
    } else {
      setStepPct("ollama", 0.2, "downloading");
    }
  });
  await listen("ollama-ready", () => setStep("ollama", "done"));
  await listen("ollama-error", () => setStep("ollama", "done", "skipped (cloud mode)"));

  await listen("backend-error", (event) => {
    showError(event.payload || "Unknown backend error");
  });

  // Fallback: maybe the backend was already up before we subscribed
  try {
    const status = await invoke("backend_status");
    if (status.ready) await goToApp(status.port);
  } catch {}

  // Gentle "still working" creep so the bar never looks frozen on a slow first launch
  setInterval(() => {
    const a = STEPS.find(s => state[s.id].status === "active");
    if (a && (state[a.id].pct || 0) < 0.9) setStepPct(a.id, Math.min(0.9, (state[a.id].pct || 0.15) + 0.04));
  }, 1200);
}

retryBtn.addEventListener("click", () => window.location.reload());
boot();
