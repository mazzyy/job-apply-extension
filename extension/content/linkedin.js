/*
 * LinkedIn job assistant — works on:
 *   /jobs/view/:id     (standalone job page)
 *   /jobs/search/...   (search results with right-pane preview)
 *   /jobs/collections/... (LinkedIn's curated lists)
 *
 * LinkedIn is an SPA and rebuilds the right pane when you click another job,
 * so we watch URL changes (currentJobId param) and re-render.
 */
(function () {
  if (window.__jaaLinkedInLoaded) return;
  window.__jaaLinkedInLoaded = true;

  const log = (...a) => console.debug("[JAA/linkedin]", ...a);

  let currentJobKey = null;
  let card = null;
  let fab = null;

  function $(sel, root = document) { return root.querySelector(sel); }
  function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function textOf(el) { return (el?.innerText || el?.textContent || "").trim(); }

  function tryEach(selectors) {
    for (const s of selectors) {
      const el = $(s);
      if (el) {
        const t = textOf(el);
        if (t) return t;
      }
    }
    return "";
  }

  function extractJob() {
    // Title
    const title = tryEach([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      ".jobs-details-top-card__job-title",
      ".jobs-search__job-details--container h1",
      "h1.t-24",
      ".jobs-details h1",
    ]);

    // Company
    const company = tryEach([
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name",
      ".jobs-details-top-card__company-url",
      ".jobs-search__job-details--container .jobs-unified-top-card__company-name",
    ]);

    // Location (under the title, usually one bullet point in)
    const location = tryEach([
      ".job-details-jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__bullet",
      ".job-details-jobs-unified-top-card__primary-description-container",
      ".jobs-unified-top-card__subtitle-primary-grouping span",
    ]);

    // Description body (largest variant first)
    const description = tryEach([
      ".jobs-description__content .jobs-box__html-content",
      ".jobs-description-content__text",
      ".jobs-description__container",
      ".jobs-description",
      ".jobs-search__job-details .jobs-description__container",
      ".jobs-search__job-details--container",
    ]);

    if (!title || !description || description.length < 200) return null;
    return {
      job_title: title,
      company,
      location,
      job_description: description,
      url: "",
      source: "linkedin",
    };
  }

  function fitClass(s){ return s>=80?"good":s>=60?"warn":"bad"; }
  function escapeHtml(s){
    return (s || "").toString().replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }

  function renderCard(state){
    if (!card) {
      card = document.createElement("div");
      card.className = "jaa-card";
      document.body.appendChild(card);
    }
    if (state.loading){
      card.innerHTML = `
        <header>Job Apply Assistant <button class="jaa-x" aria-label="close">×</button></header>
        <div class="jaa-loading">Analyzing this role against your CV…</div>`;
    } else if (state.error){
      card.innerHTML = `
        <header>Job Apply Assistant <button class="jaa-x" aria-label="close">×</button></header>
        <div class="jaa-body"><div class="jaa-error">${escapeHtml(state.error)}</div></div>`;
    } else {
      const r = state.result || {};
      const lang = r.language || {};
      const score = Math.round(r.fit_score ?? 0);
      const langPills = (lang.requires_other_languages || []).map(
        l => `<span class="jaa-pill lang">${escapeHtml(l)} required</span>`
      ).join("") || `<span class="jaa-pill good">English OK</span>`;
      card.innerHTML = `
        <header>Fit analysis <button class="jaa-x" aria-label="close">×</button></header>
        <div class="jaa-body">
          <div class="jaa-score-row">
            <div class="jaa-score">${score}<span style="font-size:14px;color:#6b7280">/100</span></div>
            <div>
              <span class="jaa-pill ${fitClass(score)}">${escapeHtml(r.fit_label || "")}</span>
              <div style="font-size:12px;color:#6b7280;margin-top:4px">CV: ${escapeHtml(r.cv_used?.label || "—")}</div>
            </div>
          </div>
          <div>${langPills}</div>
          ${(r.cv_selection?.strategy === "auto")
            ? `<div style="margin-top:6px;font-size:11px;color:#6b7280">CV: <b>${escapeHtml(r.cv_used?.label || "")}</b> <span style="background:#eef2ff;color:#3730a3;padding:2px 6px;border-radius:999px;font-size:10px;font-weight:600">auto-picked</span> · JD: ${(r.jd_length||0).toLocaleString()} chars</div>`
            : `<div style="margin-top:6px;font-size:11px;color:#6b7280">JD: <b>${(r.jd_length||0).toLocaleString()}</b> chars analyzed</div>`}
          ${r.jd_warning
            ? `<div style="background:#fef3c7;color:#92400e;padding:6px 8px;border-radius:6px;font-size:11px;margin-top:6px">⚠️ ${escapeHtml(r.jd_warning)}</div>`
            : ""}
          <div style="margin-top:8px;font-size:13px;color:#374151">${escapeHtml(r.verdict || "")}</div>
          <div class="jaa-section"><h4>Strengths</h4>
            <ul class="jaa-list">${(r.strengths||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul></div>
          <div class="jaa-section"><h4>What's missing</h4>
            <ul class="jaa-list">${(r.gaps||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul></div>
          <div class="jaa-section"><h4>How to strengthen the application</h4>
            <ul class="jaa-list">${(r.recommendations||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")||"<li>—</li>"}</ul></div>
          <div class="jaa-actions">
            <button class="jaa-btn" id="jaa-mark-applied">Mark as applied</button>
            <button class="jaa-btn secondary" id="jaa-open-dash">Open dashboard</button>
          </div>
        </div>`;
      card.querySelector("#jaa-mark-applied")?.addEventListener("click", async () => {
        if (!r.application_id) return;
        await chrome.runtime.sendMessage({
          type: "API_PATCH", path: `/applications/${r.application_id}`,
          body: { status: "applied" },
        });
        card.querySelector("#jaa-mark-applied").textContent = "Marked ✓";
      });
      card.querySelector("#jaa-open-dash")?.addEventListener("click", () => {
        window.open("http://localhost:5500/index.html", "_blank");
      });
    }
    card.querySelector(".jaa-x")?.addEventListener("click", () => { card.remove(); card = null; });
  }

  function ensureFab(){
    if (fab && document.body.contains(fab)) return;
    fab = document.createElement("button");
    fab.className = "jaa-fab";
    fab.type = "button";
    fab.innerHTML = `<span class="jaa-dot"></span> Analyze this job`;
    fab.addEventListener("click", () => analyze(true));
    document.body.appendChild(fab);
  }

  async function analyze(force = false){
    const job = extractJob();
    if (!job) {
      renderCard({ error: "Couldn't read the job posting from this page. Make sure the job description is visible on screen and try again." });
      return;
    }
    job.url = window.location.href;
    const key = job.job_title + "|" + job.company;
    if (!force && key === currentJobKey) return;
    currentJobKey = key;
    renderCard({ loading: true });
    try {
      const { autoCv = true } = await chrome.storage.sync.get("autoCv");
      job.auto_select_cv = autoCv;
      const resp = await chrome.runtime.sendMessage({ type: "ANALYZE_JOB", payload: job });
      if (!resp?.ok) throw new Error(resp?.error || "Analysis failed");
      renderCard({ result: resp.data });
    } catch (e) {
      log("analyze error", e);
      renderCard({ error: e.message + " — is the backend running on localhost:8000?" });
    }
  }

  // Watch for SPA URL changes (currentJobId param)
  let lastUrl = location.href;
  const urlWatch = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Don't auto-analyze, but reset the cached key so a fresh click re-runs
      currentJobKey = null;
    }
  }, 800);

  // Re-inject FAB if LinkedIn nukes it during re-renders
  const obs = new MutationObserver(() => ensureFab());
  obs.observe(document.body, { childList: true, subtree: true });

  setTimeout(ensureFab, 1000);
  setTimeout(ensureFab, 3000);
})();
