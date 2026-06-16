/*
 * Portal adapter registry — the single place that knows how to drive each job
 * portal. Add a new portal by adding ONE row here, then whitelist its domain in
 * desktop/src-tauri/capabilities/browser-pane.json (integrated mode) and the
 * extension manifest (system mode).
 *
 * Fields:
 *   id       queue "platform" tag / adapter id
 *   match    RegExp tested against the job URL
 *   files    engine scripts to inject (from resources/automation/)
 *   apply    name of the window.* fn that fills + (optionally) submits one job
 *   harvest  name of the window.* fn that scrapes a search page for job links
 *   session  name of the window.* fn that applies to many jobs in one page
 *   autofill true => no dedicated apply fn; use JAA_Autofill.fillAll() then stop
 *   mode     "auto"  => queue may auto-submit
 *            "manual"=> prefill and stop for the user to review + submit
 */
window.JAA_ADAPTERS = [
  {
    id: "linkedin",
    match: /linkedin\.com\/jobs/i,
    files: ["linkedin.js", "linkedin_easyapply.js"],
    apply: "__jaaRunEasyApply",
    harvest: "__jaaHarvestJobs",
    session: "__jaaRunSearchSequential",
    mode: "auto",
  },
  {
    // Siemens, T-Systems, SAP and other SuccessFactors-hosted portals
    id: "successfactors",
    match: /\.(successfactors|sapsf)\.(com|eu)/i,
    files: ["autofill.js", "successfactors.js"],
    apply: "__jaaSFApply",
    harvest: "__jaaSFHarvest",
    mode: "auto",
  },
  { id: "greenhouse", match: /greenhouse\.io/i, files: ["autofill.js", "greenhouse.js"], autofill: true, mode: "manual" },
  { id: "lever",      match: /lever\.co/i,      files: ["autofill.js", "lever.js"],      autofill: true, mode: "manual" },
  { id: "ashby",      match: /ashbyhq\.com/i,   files: ["autofill.js", "ashby.js"],      autofill: true, mode: "manual" },

  // Example of a future portal — uncomment + ship puma.js (or just reuse autofill):
  // { id: "puma", match: /puma\.[a-z0-9-]+\.(com|io)/i, files: ["autofill.js", "puma.js"], autofill: true, mode: "manual" },

  { id: "generic",    match: /.*/,              files: ["autofill.js", "generic.js"],    autofill: true, mode: "manual" },
];

/* Pick by explicit platform tag first (from the queue), else by URL. */
window.JAA_pickAdapter = function (url, platform) {
  var list = window.JAA_ADAPTERS || [];
  if (platform) {
    for (var i = 0; i < list.length; i++) if (list[i].id === platform) return list[i];
  }
  for (var j = 0; j < list.length; j++) {
    try { if (list[j].match.test(url || "")) return list[j]; } catch (e) {}
  }
  return list[list.length - 1]; // generic fallback
};
