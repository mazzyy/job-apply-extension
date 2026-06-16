/* Greenhouse — no on-page UI. Provides extractJob() to the side panel via messages. */
(function () {
  if (window.__jaaGreenhouseLoaded) return;
  window.__jaaGreenhouseLoaded = true;

  function $(s, r=document){return r.querySelector(s)}
  function txt(el){return (el?.innerText||"").trim()}

  window.__jaaExtractJob = function () {
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
  };
})();
