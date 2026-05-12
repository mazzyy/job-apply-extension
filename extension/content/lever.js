/* Lever — no on-page UI. */
(function () {
  if (window.__jaaLeverLoaded) return;
  window.__jaaLeverLoaded = true;

  function $(s,r=document){return r.querySelector(s)}
  function txt(el){return (el?.innerText||"").trim()}

  window.__jaaExtractJob = function () {
    const title = txt($(".posting-headline h2") || $("h2") || $("h1"));
    const company = (location.hostname.split(".")[0] || "").replace(/^www$/, "");
    const desc = txt($(".posting-page") || $(".content-wrapper") || $("main") || document.body);
    if (!title || !desc || desc.length < 200) return null;
    return { job_title:title, company, location:"", job_description:desc, url:location.href, source:"lever" };
  };
})();
