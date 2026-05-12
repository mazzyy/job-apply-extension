(function () {
  if (window.__jaaGreenhouseLoaded) return;
  window.__jaaGreenhouseLoaded = true;

  function $(s, r=document){return r.querySelector(s)}
  function txt(el){return (el?.innerText||"").trim()}

  function extractJob() {
    // The job description on Greenhouse application pages
    const title = txt($("h1.app-title") || $(".app-title") || $("h1.section-header") || $("h1"));
    const company =
      txt($(".company-name")) ||
      txt($("a.heading--employer")) ||
      txt($(".section-header__employer-name")) ||
      (document.title.split("-").slice(-1)[0] || "").trim();
    const desc =
      txt($("#content")) ||
      txt($(".main")) ||
      txt($(".job-post")) ||
      txt(document.body);
    if (!title || !desc || desc.length < 200) return null;
    return { job_title:title, company, location:"", job_description:desc, url:location.href, source:"greenhouse" };
  }

  function injectFab() {
    if (document.querySelector(".jaa-fab")) return;
    if (window.top !== window.self) return; // only show FAB in top frame
    const btn = document.createElement("button");
    btn.className = "jaa-fab";
    btn.type = "button";
    btn.innerHTML = `<span class="jaa-dot"></span> Analyze & autofill`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const original = btn.innerHTML;
      btn.innerHTML = `<span class="jaa-dot"></span> Working…`;
      const job = extractJob();
      if (job) chrome.runtime.sendMessage({ type: "ANALYZE_JOB", payload: job }).catch(()=>{});
      if (window.JAA_Autofill) {
        const r = await window.JAA_Autofill.fillAll();
        if (r.error) btn.innerHTML = `<span class="jaa-dot"></span> ${r.error}`;
        else btn.innerHTML = `<span class="jaa-dot"></span> Filled ${r.filled}/${r.total}`;
      } else {
        btn.innerHTML = original;
      }
      btn.disabled = false;
      setTimeout(() => { if (btn.isConnected) btn.innerHTML = original; }, 6000);
    });
    document.body.appendChild(btn);
  }

  setTimeout(injectFab, 1200);
  new MutationObserver(() => { if (!document.querySelector(".jaa-fab")) injectFab(); })
    .observe(document.body, { childList: true, subtree: true });
})();
