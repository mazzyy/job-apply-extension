/* Ashby — no on-page UI. */
(function () {
  if (window.__jaaAshbyLoaded) return;
  window.__jaaAshbyLoaded = true;

  function $(s,r=document){return r.querySelector(s)}
  function txt(el){return (el?.innerText||"").trim()}

  window.__jaaExtractJob = function () {
    const title = txt($("h1") || $(".ashby-job-posting-heading"));
    const company = (location.hostname.split(".")[0] || "");
    const desc = txt($("._descriptionText_ud4nd_201") || $("main") || document.body);
    if (!title || !desc || desc.length < 200) return null;
    return { job_title:title, company, location:"", job_description:desc, url:location.href, source:"ashby" };
  };
})();
