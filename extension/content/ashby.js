(function () {
  if (window.__jaaAshbyLoaded) return;
  window.__jaaAshbyLoaded = true;

  function $(s,r=document){return r.querySelector(s)}
  function txt(el){return (el?.innerText||"").trim()}

  function extractJob() {
    const title = txt($("h1") || $(".ashby-job-posting-heading"));
    const company = (location.hostname.split(".")[0] || "");
    const desc = txt($("._descriptionText_ud4nd_201") || $("main") || document.body);
    if (!title || !desc || desc.length < 200) return null;
    return { job_title:title, company, location:"", job_description:desc, url:location.href, source:"ashby" };
  }

  function injectFab() {
    if (document.querySelector(".jaa-fab")) return;
    const btn = document.createElement("button");
    btn.className = "jaa-fab";
    btn.type = "button";
    btn.innerHTML = `<span class="jaa-dot"></span> Analyze & autofill`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const job = extractJob();
      if (job) chrome.runtime.sendMessage({ type: "ANALYZE_JOB", payload: job }).catch(()=>{});
      if (window.JAA_Autofill) {
        const r = await window.JAA_Autofill.fillAll();
        btn.innerHTML = `<span class="jaa-dot"></span> Filled ${r.filled||0}/${r.total||0}`;
      }
      btn.disabled = false;
    });
    document.body.appendChild(btn);
  }

  setTimeout(injectFab, 1200);
  new MutationObserver(() => { if (!document.querySelector(".jaa-fab")) injectFab(); })
    .observe(document.body, { childList: true, subtree: true });
})();
