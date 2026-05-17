const $ = s => document.querySelector(s);
let lastAnalysis = null;
let lastJobPayload = null;     // Extracted JD/title/company from the active tab
let lastApplicationId = null;  // Either from analyze or from autofill log

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

/* ---------- Header status ---------- */
async function refreshHeader(){
  const dot = $("#status-dot"); const tag = $("#cv-tag"); const sub = $("#brand-sub");
  try {
    const h = await chrome.runtime.sendMessage({ type: "API_GET", path: "/health" });
    if (!h?.ok) throw new Error("api offline");
    const d = h.data;
    dot.className = "status-dot " + (d.model_verified ? "live" : "warn");
    dot.title = d.model_verified ? `${d.model} verified` : (d.model_error || "Unverified");
    sub.textContent = d.model_verified ? `${d.model} · ready` : `${d.model} · unverified`;
  } catch {
    dot.className = "status-dot offline"; dot.title = "Backend offline";
    sub.textContent = "Backend offline";
  }
  try {
    const cv = await chrome.runtime.sendMessage({ type: "API_GET", path: "/cvs/active" });
    tag.textContent = cv?.ok ? (cv.data.label || "Active CV") : "No CV";
  } catch { tag.textContent = "—"; }
}

/* ---------- Extract job from active tab ---------- */
async function extractCurrentJob(){
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    // Prefer the board-specific extractor injected by content scripts (linkedin/greenhouse/lever/ashby/generic)
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (window.__jaaExtractJob) {
          const r = window.__jaaExtractJob();
          if (r) return r;
        }
        // Fallback inline extraction
        const txt = el => (el?.innerText || "").trim();
        const title = txt(document.querySelector("h1, h2"));
        const body = txt(document.querySelector("main") || document.querySelector("article") || document.body).slice(0, 12000);
        const company = document.querySelector('meta[property="og:site_name"]')?.content
          || location.hostname.replace(/^www\./, "").split(".")[0];
        return { job_title: title, company, job_description: body, url: location.href, source: "manual" };
      },
    });
    return result;
  } catch (e) {
    console.warn("extractCurrentJob failed", e);
    return null;
  }
}

/* ---------- Render ---------- */
function renderResult(r){
  lastAnalysis = r;
  if (r.application_id) lastApplicationId = r.application_id;
  const score = Math.round(r.fit_score || 0);
  const tone = fitTone(score);
  const lang = r.language || {};
  const langChips = (lang.requires_other_languages || []).length
    ? lang.requires_other_languages.map(l => `<span class="pill lang">${esc(l)} required</span>`).join("")
    : `<span class="pill good">English OK</span>`;
  const cvLabel = r.cv_used?.label || "—";
  const cvBadge = r.cv_selection?.strategy === "auto"
    ? `<span class="pill info" title="Auto-selected from your CV library">auto-picked</span>` : "";
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
    <div class="section strengths"><div class="section-title"><span class="swatch"></span> Strengths</div>
      <ul class="bullets">${(r.strengths||[]).map(s => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul></div>
    <div class="section gaps"><div class="section-title"><span class="swatch"></span> Gaps</div>
      <ul class="bullets">${(r.gaps||[]).map(s => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul></div>
    <div class="section recs"><div class="section-title"><span class="swatch"></span> Recommendations</div>
      <ul class="bullets">${(r.recommendations||[]).map(s => `<li>${esc(s)}</li>`).join("") || "<li>—</li>"}</ul></div>`;
}
function renderLoading(msg){
  $("#result-card").innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <div>
        <div style="font-weight:600;color:var(--text);font-size:13px">${esc(msg || "Analyzing this role…")}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Comparing your CV against the job description</div>
      </div>
    </div>`;
}
function renderError(msg){
  $("#result-card").innerHTML = `<div class="error-state">${esc(msg)}</div>`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ANALYSIS_RESULT") renderResult(msg.data);
});

/* ---------- Analyze this page ---------- */
$("#analyze-this").addEventListener("click", async () => {
  const status = $("#action-status");
  setLoadingStatus(status, "Reading page…");
  renderLoading("Reading page…");
  const job = await extractCurrentJob();
  if (!job || (job.job_description || "").length < 200) {
    setStatus(status, "Couldn't find enough job text on this page. Scroll the JD into view.", "err");
    $("#result-card").innerHTML = `<div class="empty"><div class="empty-title">Page not ready</div><div class="empty-text">Make sure the job description is visible on screen, then try again.</div></div>`;
    return;
  }
  lastJobPayload = job;
  setLoadingStatus(status, `Analyzing ${job.job_title || "this role"}…`);
  renderLoading();
  const { autoCv = true } = await chrome.storage.sync.get("autoCv");
  const resp = await chrome.runtime.sendMessage({
    type: "ANALYZE_JOB", payload: { ...job, auto_select_cv: autoCv },
  });
  if (!resp?.ok) { renderError(resp?.error || "Analysis failed"); setStatus(status, resp?.error || "Failed", "err"); return; }
  renderResult(resp.data);
  setStatus(status, "Analysis complete.", "ok");
});

/* ---------- Autofill — also logs as applied ---------- */
$("#autofill").addEventListener("click", async () => {
  const status = $("#action-status");
  setLoadingStatus(status, "Autofilling fields…");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { setStatus(status, "No active tab.", "err"); return; }

  // Make sure the autofill engine is loaded in every frame
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

  if (error) { setStatus(status, error, "err"); return; }

  // Resolve job metadata for logging — pull from page if we don't already have it
  let job = lastJobPayload;
  if (!job) job = await extractCurrentJob();

  // No form fields at all: offer to log the role anyway (common on German recruiter
  // pages where the Apply flow is an external mailto link).
  if (seen === 0) {
    if (!job || !job.job_title) {
      setStatus(status, "No form fields and no job content found on this page.", "err");
      return;
    }
    if (!confirm(`No application form on this page (Apply is likely via email or external link).\n\nLog "${(job.job_title||'').slice(0,80)}" at ${(job.company||'')} as applied anyway?`)) {
      setStatus(status, "Cancelled — nothing logged.", "err");
      return;
    }
    // fall through to logging below with filled=0
  }
  // Some fields but none matched profile
  if (seen > 0 && filled === 0) {
    setStatus(status, `${seen} fields seen, 0 matched your profile. Update your profile in the dashboard for better autofill.`, "err");
    return;
  }
  try {
    const logResp = await chrome.runtime.sendMessage({
      type: "API_POST", path: "/applications/log",
      body: {
        job_title: job?.job_title || "(unknown role)",
        company: job?.company || "(unknown company)",
        url: job?.url || tab.url,
        source: job?.source || "autofill",
        fields_filled: filled,
        status: "applied",
      },
    });
    if (logResp?.ok) {
      lastApplicationId = logResp.data.id;
      const dedupedNote = logResp.data.deduped ? " (merged with existing record)" : "";
      setStatus(status, `Filled ${filled} of ${seen} fields · logged as applied${dedupedNote}.`, "ok");
    } else {
      setStatus(status, `Filled ${filled} of ${seen} fields (couldn't log: ${logResp?.error || "unknown"})`, "warn");
    }
  } catch (e) {
    setStatus(status, `Filled ${filled} of ${seen} fields (log failed: ${e.message})`, "warn");
  }
});

/* ---------- Cover letter ---------- */
async function generateCoverLetter(){
  const card = $("#letter-card");
  const ta = $("#letter-text");
  const ls = $("#letter-status");
  card.classList.remove("hidden");
  if (!lastJobPayload) {
    // Try to extract on the fly
    lastJobPayload = await extractCurrentJob();
    if (!lastJobPayload) {
      setStatus(ls, "Open a job page first.", "err");
      return;
    }
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

/* ============================== Easy Apply guided ============================== */
$("#easyapply-btn")?.addEventListener("click", async () => {
  const status = $("#action-status");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/linkedin\.com\/jobs/.test(tab.url)) {
    setStatus(status, "Open a LinkedIn job page first.", "err"); return;
  }
  setLoadingStatus(status, "Driving Easy Apply form…");
  try {
    // Make sure both scripts are present
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/linkedin.js"] }).catch(()=>{});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/linkedin_easyapply.js"] }).catch(()=>{});
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => window.__jaaRunEasyApply ? await window.__jaaRunEasyApply() : { error: "Easy Apply script not loaded" },
    });
    const r = result || {};
    if (r.error) { setStatus(status, r.error, "err"); return; }
    if (r.stopped === "review_ready") {
      setStatus(status, `Filled ${r.filled} fields across ${r.steps} steps. Review answers below + on LinkedIn, then Submit.`, "ok");
      renderEasyApplyAnswers(r.answered || []);
    } else if (r.stopped === "required_field_blank") {
      setStatus(status, `Stopped at a step with required blank fields (highlighted). Fill them and click Next.`, "warn");
    } else {
      setStatus(status, `Stopped: ${r.stopped || "unknown"} (filled ${r.filled||0})`, "warn");
    }
  } catch (e) {
    setStatus(status, "Error: " + e.message, "err");
  }
});


function renderEasyApplyAnswers(items){
  if (!items.length) return;
  const card = document.createElement("section");
  card.className = "card";
  card.id = "easyapply-log";
  card.innerHTML = `
    <div class="card-header"><span class="card-title">Answers I filled</span>
      <button class="btn ghost small" id="ea-close">✕</button></div>
    <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">
      ${items.map(it => `
        <li style="border-left:3px solid ${it.needs_review ? '#d97706' : '#16a34a'};
                   padding:6px 10px;background:var(--bg-subtle);border-radius:8px;font-size:12px;">
          <div style="font-weight:600">${esc(it.label)}</div>
          <div>→ <b>${esc(String(it.value))}</b>${it.needs_review ? ' <span class="pill warn">needs review</span>' : ''}</div>
        </li>`).join("")}
    </ul>`;
  document.querySelector("#letter-card")?.before(card);
  document.getElementById("ea-close")?.addEventListener("click", () => card.remove());
}

/* ============================== LinkedIn DM generator ============================== */
async function generateLinkedInMessage() {
  const card = $("#linkedin-msg-card");
  const ta = $("#linkedin-msg-text");
  const ls = $("#msg-status");
  card?.classList.remove("hidden");

  if (!lastJobPayload) {
    lastJobPayload = await extractCurrentJob();
    if (!lastJobPayload) {
      setStatus(ls, "Open a job page first.", "err");
      return;
    }
  }
  ta.value = "";
  setLoadingStatus(ls, "Drafting LinkedIn message…");
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "API_POST", path: "/analyze/linkedin-message",
      body: {
        job_description: lastJobPayload.job_description,
        job_title: lastJobPayload.job_title,
        company: lastJobPayload.company,
        recruiter_name: lastJobPayload.recruiter_name || "",
        recruiter_title: lastJobPayload.recruiter_title || "",
        cv_id: lastAnalysis?.cv_used?.id || undefined,
        style: "polite-direct",
      },
    });
    if (!resp?.ok) throw new Error(resp?.error || "Failed");
    ta.value = resp.data.message || "";
    const who = resp.data.recipient ? ` for ${resp.data.recipient}` : "";
    setStatus(ls, `Drafted${who}.`, "ok");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    setStatus(ls, e.message, "err");
  }
}

$("#linkedin-msg-btn")?.addEventListener("click", generateLinkedInMessage);
$("#regen-msg")?.addEventListener("click", generateLinkedInMessage);
$("#close-msg")?.addEventListener("click", () => $("#linkedin-msg-card")?.classList.add("hidden"));
$("#copy-msg")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#linkedin-msg-text").value);
  setStatus($("#msg-status"), "Copied to clipboard.", "ok");
});
