/* Generic career page detector — no on-page UI; provides extractJob() for the side panel. */
(function () {
  if (window.__jaaGenericLoaded) return;
  window.__jaaGenericLoaded = true;

  if (location.protocol === "chrome-extension:") return;
  const url = location.href;
  if (/google\.com\/search|gmail|youtube|facebook|twitter|x\.com|reddit|stackoverflow/.test(url)) return;

  function txt(el){ return (el?.innerText || el?.textContent || "").trim(); }

  window.__jaaExtractJob = function () {
    let title = "";
    for (const h of document.querySelectorAll("h1, h2")) {
      const t = txt(h);
      if (t && t.length > 4 && t.length < 200) { title = t; break; }
    }
    const ogSite = document.querySelector('meta[property="og:site_name"]')?.content;
    const company = ogSite || location.hostname.replace(/^www\./, "").split(".")[0];
    const descEl =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.querySelector("[role='main']") ||
      document.querySelector(".job, .job-description, .posting-page, #content") ||
      document.body;
    const description = txt(descEl).slice(0, 12000);
    if (!title || !description || description.length < 200) return null;
    return {
      job_title: title, company, location: "",
      job_description: description, url: location.href, source: "career-site",
    };
  };
})();
