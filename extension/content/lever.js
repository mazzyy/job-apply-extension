(function () {
  if (window.__jaaLeverLoaded) return;
  window.__jaaLeverLoaded = true;

  function $(s,r=document){return r.querySelector(s)}
  function txt(el){return (el?.innerText||"").trim()}

  function extractJob() {
    const title = txt($(".posting-headline h2") || $("h2"));
    const company = txt($(".main-header-logo .main-header-logo-image")?.parentElement) ||
                    (location.hostname.split(".")[0] || "");
    const desc = txt($(".posting-page") || $(".content-wrapper") || document.body);
    if (!title || !desc || desc.length < 200) return null;
    return { job_title:title, company, location:"", job_description:desc, url:location.href, source:"lever" };
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

  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("content/autofill.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);

  setTimeout(injectFab, 1000);
})();
