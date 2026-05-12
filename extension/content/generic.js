/*
 * Generic content script — runs on all sites NOT covered by board-specific scripts.
 * Detects if the page looks like a job description or an application form, and
 * shows a single floating button that does "Analyze & autofill".
 *
 * This is what makes company career sites that embed Greenhouse/Lever/Workday
 * (like flix.careers) work even when we don't have a custom adapter for them.
 */
(function () {
  if (window.__jaaGenericLoaded) return;
  window.__jaaGenericLoaded = true;

  // Don't run in obvious non-job pages
  const url = location.href;
  if (/google\.com\/search|gmail|youtube|facebook|twitter|x\.com|reddit|stackoverflow/.test(url)) return;
  // Don't render inside the side panel/extension contexts
  if (location.protocol === "chrome-extension:") return;

  function $(s, r=document){ return r.querySelector(s); }
  function txt(el){ return (el?.innerText || el?.textContent || "").trim(); }

  function looksLikeJobPage() {
    const body = document.body?.innerText || "";
    if (body.length < 400) return false;
    const lower = body.toLowerCase();
    const hits = [
      "responsibilities", "qualifications", "requirements", "what you'll do",
      "about the role", "about you", "we offer", "benefits", "apply now",
      "application", "your tasks", "your profile", "what you bring",
      "deine aufgaben", "dein profil",
    ].filter(k => lower.includes(k)).length;
    return hits >= 2;
  }

  function hasApplicationForm() {
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], textarea, select'
    );
    return inputs.length >= 3;
  }

  function extractJob() {
    // Title — first h1 with non-trivial text
    let title = "";
    for (const h of document.querySelectorAll("h1, h2")) {
      const t = txt(h);
      if (t && t.length > 4 && t.length < 200) { title = t; break; }
    }
    // Company — try common og: meta, then host
    const ogSite = document.querySelector('meta[property="og:site_name"]')?.content;
    const company = ogSite || location.hostname.replace(/^www\./, "").split(".")[0];

    // Description: prefer <main>, <article>, role=main; fallback to body
    let descEl =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.querySelector("[role='main']") ||
      document.querySelector(".job, .job-description, .posting-page, #content") ||
      document.body;
    const description = txt(descEl).slice(0, 12000);

    if (!title || !description || description.length < 200) return null;
    return {
      job_title: title,
      company,
      location: "",
      job_description: description,
      url: location.href,
      source: "career-site",
    };
  }

  function makeFab() {
    if (document.querySelector(".jaa-fab")) return;
    const btn = document.createElement("button");
    btn.className = "jaa-fab";
    btn.type = "button";
    const hasForm = hasApplicationForm();
    btn.innerHTML = `<span class="jaa-dot"></span> ${hasForm ? "Analyze & autofill" : "Analyze this job"}`;

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const original = btn.innerHTML;
      btn.innerHTML = `<span class="jaa-dot"></span> Working…`;
      try {
        // 1. Try to analyze if the page looks like a JD
        const job = extractJob();
        if (job) {
          chrome.runtime.sendMessage({ type: "ANALYZE_JOB", payload: job }).catch(()=>{});
        }
        // 2. Try to autofill
        if (window.JAA_Autofill) {
          const r = await window.JAA_Autofill.fillAll();
          if (r.error) {
            btn.innerHTML = `<span class="jaa-dot"></span> ${r.error}`;
          } else {
            btn.innerHTML = `<span class="jaa-dot"></span> Filled ${r.filled}/${r.total} · analyzed`;
          }
        } else {
          btn.innerHTML = original;
        }
      } catch (e) {
        btn.innerHTML = `<span class="jaa-dot"></span> Error: ${e.message}`;
      } finally {
        btn.disabled = false;
        setTimeout(() => { if (btn.isConnected) btn.innerHTML = original; }, 5000);
      }
    });

    document.body.appendChild(btn);
  }

  function check() {
    if (looksLikeJobPage() || hasApplicationForm()) makeFab();
  }

  // Initial + observer for SPA / late-loading forms
  setTimeout(check, 800);
  setTimeout(check, 2500);
  const obs = new MutationObserver(() => {
    if (!document.querySelector(".jaa-fab")) check();
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
