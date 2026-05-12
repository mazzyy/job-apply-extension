/*
 * LinkedIn job page assistant.
 * - Detects when a job posting is being viewed.
 * - Extracts title, company, location, description.
 * - Calls /analyze/ via the background service worker.
 * - Renders an on-page card with fit score, gaps, language requirements.
 */
(function () {
  if (window.__jaaLinkedInLoaded) return;
  window.__jaaLinkedInLoaded = true;

  const log = (...a) => console.debug("[JAA/linkedin]", ...a);

  let currentJobKey = null;
  let card = null;

  function $(sel, root = document) { return root.querySelector(sel); }
  function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function textOf(el) { return (el?.innerText || el?.textContent || "").trim(); }

  function extractJob() {
    // LinkedIn's DOM changes often; try several selectors.
    const titleEl =
      $(".job-details-jobs-unified-top-card__job-title") ||
      $(".jobs-unified-top-card__job-title") ||
      $("h1.t-24") ||
      $("h1");
    const companyEl =
      $(".job-details-jobs-unified-top-card__company-name a") ||
      $(".job-details-jobs-unified-top-card__company-name") ||
      $(".jobs-unified-top-card__company-name a") ||
      $(".jobs-unified-top-card__company-name");
    const locationEl =
      $(".job-details-jobs-unified-top-card__bullet") ||
      $(".jobs-unified-top-card__bullet") ||
      $(".job-details-jobs-unified-top-card__primary-description-container span");
    const descEl =
      $(".jobs-description__content .jobs-box__html-content") ||
      $(".jobs-description-content__text") ||
      $(".jobs-description__container") ||
      $(".jobs-description");
    const title = textOf(titleEl);
    const company = textOf(companyEl);
    const location = textOf(locationEl);
    const description = textOf(descEl);
    if (!title || !description || description.length < 120) return null;
    return {
      job_title: title,
      company,
      location,
      job_description: description,
      url: location.href || window.location.href,
      source: "linkedin",
    };
  }

  function fitClass(score) {
    if (score >= 80) return "good";
    if (score >= 60) return "warn";
    return "bad";
  }

  function renderCard(state) {
    if (!card) {
      card = document.createElement("div");
      card.className = "jaa-card";
      document.body.appendChild(card);
    }
    if (state.loading) {
      card.innerHTML = `
        <header>
          Job Apply Assistant
          <button class="jaa-x" aria-label="close">×</button>
        </header>
        <div class="jaa-loading">Analyzing this role against your CV…</div>`;
    } else if (state.error) {
      card.innerHTML = `
        <header>
          Job Apply Assistant
          <button class="jaa-x" aria-label="close">×</button>
        </header>
        <div class="jaa-body"><div class="jaa-error">${escapeHtml(state.error)}</div></div>`;
    } else {
      const r = state.result || {};
      const lang = r.language || {};
      const score = Math.round(r.fit_score ?? 0);
      const langPills = (lang.requires_other_languages || []).map(
        l => `<span class="jaa-pill lang">${escapeHtml(l)} required</span>`
      ).join("") || `<span class="jaa-pill good">English OK</span>`;

      card.innerHTML = `
        <header>
          Fit analysis
          <button class="jaa-x" aria-label="close">×</button>
        </header>
        <div class="jaa-body">
          <div class="jaa-score-row">
            <div class="jaa-score">${score}<span style="font-size:14px;color:#6b7280">/100</span></div>
            <div>
              <span class="jaa-pill ${fitClass(score)}">${escapeHtml(r.fit_label || "")}</span>
              <div style="font-size:12px;color:#6b7280;margin-top:4px">CV: ${escapeHtml(r.cv_used?.label || "—")}</div>
            </div>
          </div>
          <div>${langPills}</div>
          <div style="margin-top:8px;font-size:13px;color:#374151">${escapeHtml(r.verdict || "")}</div>

          <div class="jaa-section">
            <h4>Strengths</h4>
            <ul class="jaa-list">${(r.strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join("") || "<li>—</li>"}</ul>
          </div>
          <div class="jaa-section">
            <h4>What's missing</h4>
            <ul class="jaa-list">${(r.gaps || []).map(s => `<li>${escapeHtml(s)}</li>`).join("") || "<li>—</li>"}</ul>
          </div>
          <div class="jaa-section">
            <h4>How to strengthen the application</h4>
            <ul class="jaa-list">${(r.recommendations || []).map(s => `<li>${escapeHtml(s)}</li>`).join("") || "<li>—</li>"}</ul>
          </div>

          <div class="jaa-actions">
            <button class="jaa-btn" id="jaa-mark-applied">Mark as applied</button>
            <button class="jaa-btn secondary" id="jaa-open-dash">Open dashboard</button>
          </div>
        </div>`;

      card.querySelector("#jaa-mark-applied")?.addEventListener("click", async () => {
        if (!r.application_id) return;
        await chrome.runtime.sendMessage({
          type: "API_PATCH",
          path: `/applications/${r.application_id}`,
          body: { status: "applied" },
        });
        card.querySelector("#jaa-mark-applied").textContent = "Marked ✓";
      });
      card.querySelector("#jaa-open-dash")?.addEventListener("click", () => {
        window.open("http://localhost:5500/index.html", "_blank");
      });
    }
    card.querySelector(".jaa-x")?.addEventListener("click", () => {
      card.remove(); card = null;
    });
  }

  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function ensureFab() {
    if ($(".jaa-fab")) return;
    const btn = document.createElement("button");
    btn.className = "jaa-fab";
    btn.innerHTML = `<span class="jaa-dot"></span> Analyze this job`;
    btn.addEventListener("click", () => analyze(true));
    document.body.appendChild(btn);
  }

  async function analyze(force = false) {
    const job = extractJob();
    if (!job) { log("no job detected"); return; }
    const key = `${job.job_title}|${job.company}`;
    if (!force && key === currentJobKey) return;
    currentJobKey = key;
    renderCard({ loading: true });
    try {
      const resp = await chrome.runtime.sendMessage({ type: "ANALYZE_JOB", payload: job });
      if (!resp?.ok) throw new Error(resp?.error || "Analysis failed");
      renderCard({ result: resp.data });
    } catch (e) {
      log("analyze error", e);
      renderCard({ error: e.message + " — is the backend running on localhost:8000?" });
    }
  }

  // Watch for SPA navigation (LinkedIn switches jobs without reload)
  const observer = new MutationObserver(() => {
    ensureFab();
    const job = extractJob();
    if (!job) return;
    const key = `${job.job_title}|${job.company}`;
    if (key !== currentJobKey) {
      // Don't auto-analyze on every scroll — only when job changes,
      // and only after user clicks the FAB the first time.
      // (analyzing automatically would burn tokens — but user can flip this in settings.)
      ensureFab();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(ensureFab, 1500);
})();
