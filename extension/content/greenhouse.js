(function () {
  if (window.__jaaGreenhouseLoaded) return;
  window.__jaaGreenhouseLoaded = true;

  function $(s, r=document){return r.querySelector(s)}
  function txt(el){return (el?.innerText||"").trim()}

  function extractJob() {
    const title = txt($(".app-title") || $("h1.section-header") || $("h1"));
    const company = txt($(".company-name") || $("a.heading--employer") || $(".section-header__employer-name")) ||
                    (document.title.split("-").slice(-1)[0] || "").trim();
    const desc = txt($("#content") || $(".main") || $(".job-post")) || txt(document.body);
    if (!title || !desc || desc.length < 200) return null;
    return { job_title:title, company, location:"", job_description:desc, url:location.href, source:"greenhouse" };
  }

  function injectFab() {
    if (document.querySelector(".jaa-fab")) return;
    const btn = document.createElement("button");
    btn.className = "jaa-fab";
    btn.innerHTML = `<span class="jaa-dot"></span> Analyze & autofill`;
    btn.addEventListener("click", async () => {
      const job = extractJob();
      if (job) chrome.runtime.sendMessage({ type: "ANALYZE_JOB", payload: job });
      if (window.JAA_Autofill) {
        const r = await window.JAA_Autofill.fillAll();
        btn.innerHTML = `<span class="jaa-dot"></span> Filled ${r.filled} fields`;
      }
    });
    document.body.appendChild(btn);
  }

  // Inject autofill helper
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("content/autofill.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);

  setTimeout(injectFab, 1000);
})();
