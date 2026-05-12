const $ = s => document.querySelector(s);
let lastAnalysis = null;
let lastJobPayload = null;

function esc(s){
  return (s ?? "").toString().replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])
  );
}

function fitTone(score){
  if (score >= 80) return { cls: "good", color: "#16a34a" };
  if (score >= 60) return { cls: "warn", color: "#d97706" };
  return { cls: "bad", color: "#dc2626" };
}

function setStatus(el, msg, kind){
  el.className = "status-line" + (kind ? " " + kind : "");
  el.innerHTML = msg || "";
}

function setLoadingStatus(el, msg){
  el.className = "status-line";
  el.innerHTML = `<span class="spinner"></span> ${esc(msg)}`;
}

/* ---------- Top bar status ---------- */
async function refreshHeader(){
  const dot = $("#status-dot");
  const tag = $("#cv-tag");
  const sub = $("#brand-sub");
  try {
    const health = await chrome.runtime.sendMessage({ type: "API_GET", path: "/health" });
    if (!health?.ok) throw new Error("api offline");
    const h = health.data;
    const verified = h.model_verified;
    dot.className = "status-dot " + (verified ? "live" : "warn");
    dot.title = verified ? `${h.model} verified` : (h.model_error || "Unverified");
    sub.textContent = verified ? `${h.model} · ready` : `${h.model} · unverified`;
  } catch {
    dot.className = "status-dot offline";
    dot.title = "Backend offline";
    sub.textContent = "Backend offline";
  }
  try {
    const cv = await chrome.runtime.sendMessage({ type: "API_GET", path: "/cvs/active" });
    if (cv?.ok) tag.textContent = cv.data.label || "Active CV";
    else tag.textContent = "No CV";
  } catch { tag.textContent = "—"; }
}

/* ---------- Render result ---------- */
function renderResult(r){
  lastAnalysis = r;
  const score = Math.round(r.fit_score || 0);
  const tone = fitTone(score);
  const lang = r.language || {};
  const langChips = (lang.requires_other_languages || []).length
    ? lang.requires_other_languages.map(l => `<span class="pill lang">${esc(l)} required</span>`).join("")
    : `<span class="pill good">English OK</span>`;

  const cvLabel = r.cv_used?.label || "—";
  const cvStrategy = r.cv_selection?.strategy;
  const cvBadge = cvStrategy === "auto"
    ? `<span class="pill info" title="Auto-selected from your CV library">auto-picked</span>`
    : cvStrategy === "explicit" ? `<span class="pill muted">manual</span>` : "";

  const jdLen = (r.jd_length || 0).toLocaleString();
  const warning = r.jd_warning ? `
    <div class="warn-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <div>${esc(r.jd_warning)}</div>
    </div>` : "";

  $("#result-card").innerHTML = `
    <div class="score-row">
      <div class="score-ring" style="--p:${score};--c:${tone.color}">
        <div>
          <span class="score-ring-value" style="color:${tone.color}">${score}</span>
          <span class="score-ring-suffix">/100</span>
        </div>
      </div>
      <div class="score-meta">
        <div class="score-label">${esc(r.fit_label || "—")}</div>
        <div class="pills">${langChips} ${cvBadge}</div>
      </div>
    </div>

    <div class="jd-meta">
      <span>CV: <b>${esc(cvLabel)}</b></span>
      <span>·</span>
      <span>JD: <b>${jdLen}</b> chars</span>
    </div>

    ${warning}

    ${r.verdict ? `<div class="verdict">${esc(r.verdict)}</div>` : ""}

    <div class="section strengths">
      <div class="section-title"><span class="swatch"></span> Strengths</div>
      <ul class="bullets">${(r.strengths||[]).map(s => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul>
    </div>

    <div class="section gaps">
      <div class="section-title"><span class="swatch"></span> Gaps</div>
      <ul class="bullets">${(r.gaps||[]).map(s => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul>
    </div>

    <div class="section recs">
      <div class="section-title"><span class="swatch"></span> Recommendations</div>
      <ul class="bullets">${(r.recommendations||[]).map(s => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul>
    </div>
  `;
}

function renderLoading(){
  $("#result-card").innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <div>
        <div style="font-weight:600;color:var(--text);font-size:13px">Analyzing this role…</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Comparing your CV against the job description</div>
      </div>
    </div>`;
}

function renderError(msg){
  $("#result-card").innerHTML = `<div class="error-state">${esc(msg)}</div>`;
}

/* ---------- Background message listener ---------- */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ANALYSIS_RESULT") renderResult(msg.data);
});

/* ---------- Analyze this page ---------- */
$("#analyze-this").addEventListener("click", async () => {
  const status = $("#action-status");
  setLoadingStatus(status, "Reading page…");
  renderLoading();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { setStatus(status, "No active tab.", "err"); return; }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const txt = el => (el?.innerText || "").trim();
        const title = txt(document.querySelector("h1, h2"));
        const body = txt(document.querySelector("main") || document.querySelector("article") || document.body).slice(0, 12000);
        const company = document.querySelector('meta[property="og:site_name"]')?.content
          || location.hostname.replace(/^www\./, "").split(".")[0];
        return { job_title: title, company, job_description: body, url: location.href, source: "manual" };
      },
    });
    const job = result;
    if (!job || (job.job_description || "").length < 200) {
      setStatus(status, "Couldn't find enough job text on this page. Scroll the JD into view first.", "err");
      $("#result-card").innerHTML = `<div class="empty"><div class="empty-title">Page not ready</div><div class="empty-text">Make sure the job description is visible on screen, then try again.</div></div>`;
      return;
    }
    lastJobPayload = job;
    setLoadingStatus(status, `Analyzing ${job.job_title || "this role"}…`);
    const { autoCv = true } = await chrome.storage.sync.get("autoCv");
    const resp = await chrome.runtime.sendMessage({
      type: "ANALYZE_JOB", payload: { ...job, auto_select_cv: autoCv },
    });
    if (!resp?.ok) {
      renderError(resp?.error || "Analysis failed");
      setStatus(status, resp?.error || "Failed", "err");
      return;
    }
    renderResult(resp.data);
    setStatus(status, "Analysis complete.", "ok");
  } catch (e) {
    setStatus(status, e.message, "err");
    renderError(e.message);
  }
});

/* ---------- Autofill ---------- */
$("#autofill").addEventListener("click", async () => {
  const status = $("#action-status");
  setLoadingStatus(status, "Autofilling fields…");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { setStatus(status, "No active tab.", "err"); return; }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, files: ["content/autofill.js"],
    });
  } catch (e) { setStatus(status, "Cannot autofill on this page (" + e.message + ")", "err"); return; }
  let filled = 0, seen = 0, error = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: async () => window.JAA_Autofill ? await window.JAA_Autofill.fillAll() : { filled:0, total:0 },
    });
    for (const r of results) {
      const v = r.result || {};
      if (v.error) error = v.error;
      filled += v.filled || 0;
      seen += v.total || 0;
    }
  } catch (e) { error = e.message; }
  if (error) setStatus(status, error, "err");
  else if (filled === 0) setStatus(status, `${seen} fields seen, 0 matched. Update your profile in the dashboard.`, "err");
  else setStatus(status, `Filled ${filled} of ${seen} fields.`, "ok");
});

/* ---------- Cover letter ---------- */
async function generateCoverLetter(){
  const card = $("#letter-card");
  const ta = $("#letter-text");
  const ls = $("#letter-status");
  card.classList.remove("hidden");
  if (!lastJobPayload) {
    setStatus(ls, "Click Analyze this page first.", "err");
    return;
  }
  ta.value = "";
  setLoadingStatus(ls, "Drafting tailored cover letter…");
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "API_POST", path: "/analyze/cover-letter",
      body: {
        job_description: lastJobPayload.job_description,
        job_title: lastJobPayload.job_title,
        company: lastJobPayload.company,
        cv_id: lastAnalysis?.cv_used?.id || undefined,
        tone: "professional",
      },
    });
    if (!resp?.ok) throw new Error(resp?.error || "Failed");
    ta.value = resp.data.cover_letter || "";
    setStatus(ls, `Drafted using ${resp.data.cv_used?.label || "your CV"}.`, "ok");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) { setStatus(ls, e.message, "err"); }
}
$("#cover-letter-btn").addEventListener("click", generateCoverLetter);
$("#regen-letter").addEventListener("click", generateCoverLetter);
$("#close-letter").addEventListener("click", () => $("#letter-card").classList.add("hidden"));
$("#copy-letter").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#letter-text").value);
  setStatus($("#letter-status"), "Copied to clipboard.", "ok");
});

/* ---------- Dashboard ---------- */
$("#open-dash").addEventListener("click", () => {
  chrome.tabs.create({ url: "http://localhost:5500/index.html" });
});

/* ---------- Settings ---------- */
(async () => {
  const { apiBase, autoCv } = await chrome.storage.sync.get(["apiBase", "autoCv"]);
  $("#api-base").value = apiBase || "http://localhost:8000";
  $("#auto-cv").checked = autoCv !== false;
})();
$("#save-settings").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    apiBase: $("#api-base").value.trim(),
    autoCv: $("#auto-cv").checked,
  });
  setStatus($("#settings-status"), "Saved.", "ok");
  await refreshHeader();
  setTimeout(() => setStatus($("#settings-status"), ""), 1800);
});

refreshHeader();
setInterval(refreshHeader, 30000);
