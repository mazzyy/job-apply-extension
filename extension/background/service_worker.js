// Background service worker.
const DEFAULT_API_BASE = "http://localhost:8000";

chrome.runtime.onInstalled.addListener(async () => {
  const { apiBase } = await chrome.storage.sync.get("apiBase");
  if (!apiBase) await chrome.storage.sync.set({ apiBase: DEFAULT_API_BASE });
});

chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (e) { console.warn(e); }
});

async function getApiBase() {
  const { apiBase } = await chrome.storage.sync.get("apiBase");
  return apiBase || DEFAULT_API_BASE;
}

async function apiFetch(path, opts = {}) {
  const base = await getApiBase();
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  return data;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "API_GET") {
        sendResponse({ ok: true, data: await apiFetch(msg.path) });
      } else if (msg.type === "API_POST") {
        sendResponse({ ok: true, data: await apiFetch(msg.path, { method: "POST", body: JSON.stringify(msg.body || {}) }) });
      } else if (msg.type === "API_PATCH") {
        sendResponse({ ok: true, data: await apiFetch(msg.path, { method: "PATCH", body: JSON.stringify(msg.body || {}) }) });
      } else if (msg.type === "API_DELETE") {
        sendResponse({ ok: true, data: await apiFetch(msg.path, { method: "DELETE" }) });
      } else if (msg.type === "ANALYZE_JOB") {
        const data = await apiFetch("/analyze/", {
          method: "POST",
          body: JSON.stringify(msg.payload),
        });
        // Stash so apply_watcher can mark the right row when the user clicks Apply
        if (data.application_id) {
          try {
            await chrome.storage.session.set({
              lastApplicationId: data.application_id,
              lastApplicationUrl: msg.payload?.url || "",
              lastApplicationAt: Date.now(),
            });
          } catch (e) { /* session storage may be unavailable */ }
        }
        chrome.runtime.sendMessage({ type: "ANALYSIS_RESULT", data });
        sendResponse({ ok: true, data });
      } else if (msg.type === "OPEN_PANEL") {
        try { await chrome.sidePanel.open({ tabId: sender.tab?.id }); } catch {}
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown message type: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});


/* ============================== Auto-apply runner ==============================
 * Polls the backend queue (only while the dashboard toggle is ON), opens each
 * queued LinkedIn job, drives Easy Apply with autoSubmit, records the result.
 * Guardrails: backend-enforced daily cap, one job at a time, 45-120s random
 * delay between applications, skip-don't-submit when answers need review.
 */
const AUTOAPPLY_ALARM = "jaa-autoapply";
let autoApplyBusy = false;

async function sendHeartbeat(action) {
  try {
    await apiFetch("/applications/auto-apply/heartbeat", {
      method: "POST", body: JSON.stringify({ action: action || "idle" }),
    });
  } catch { /* backend offline */ }
}

chrome.alarms.create(AUTOAPPLY_ALARM, { periodInMinutes: 1 });
// Fire a heartbeat the moment the worker boots so the dashboard sees it
// within seconds instead of waiting up to a minute for the first alarm.
sendHeartbeat("starting");
runAutoApplyTick();
// Keep-alive: a 25s self-ping prevents the MV3 worker from going fully idle
// while the user has automation running.
setInterval(() => { sendHeartbeat(autoApplyBusy ? "working" : "idle"); }, 25000);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOAPPLY_ALARM) runAutoApplyTick();
});

async function runAutoApplyTick() {
  // Heartbeat first — the dashboard shows whether the extension is alive
  let st;
  try {
    st = await apiFetch("/applications/auto-apply/status");
    await sendHeartbeat(autoApplyBusy ? "working" : "idle");
  } catch { return; }   // backend offline

  if (autoApplyBusy || !st.enabled || !st.next) return;
  if (st.next.task === "apply" && st.cap_reached) return;

  // Random human-like gap between SUBMITS (harvests run with a short gap)
  const { lastAutoApplyAt } = await chrome.storage.local.get("lastAutoApplyAt");
  const minGap = st.next.task === "harvest"
    ? 8000
    : 45000 + Math.floor(Math.random() * 75000);   // 45–120s
  if (lastAutoApplyAt && Date.now() - lastAutoApplyAt < minGap) return;

  autoApplyBusy = true;
  try {
    await apiFetch("/applications/auto-apply/heartbeat", {
      method: "POST",
      body: JSON.stringify({ action: (st.next.task === "harvest" ? "expanding search" : "applying") + " · " + (st.next.url || "").slice(0, 80) }),
    }).catch(() => {});
    if (st.next.task === "session") await runSession(st.next);
    else if (st.next.task === "harvest") await runHarvest(st.next);
    else await runOneAutoApply(st.next);
  } catch (e) {
    console.warn("[JAA] auto-apply run failed", e);
  } finally {
    // Harvest is quick & low-risk → shorter cooldown than a real submit
    const cooldown = st.next.task === "harvest" ? Date.now() - 90000 : Date.now();
    await chrome.storage.local.set({ lastAutoApplyAt: cooldown });
    autoApplyBusy = false;
    // If more work is pending, run again soon rather than waiting for the alarm
    if (st.next.task === "harvest") setTimeout(runAutoApplyTick, 9000);
  }
}

async function runSession(next) {
  // Same-tab mode: open the search page once, apply to each job in place.
  const tab = await chrome.tabs.create({ url: next.url, active: true });
  try {
    await waitForTabComplete(tab.id);
    await new Promise(r => setTimeout(r, 6000));
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/linkedin.js"] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/linkedin_easyapply.js"] }).catch(() => {});
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (max) => window.__jaaRunSearchSequential
        ? await window.__jaaRunSearchSequential({ autoSubmit: true, max })
        : { error: "sequential runner not loaded" },
      args: [Math.max(1, Math.min(next.remaining || 5, 10))],
    });
    const r = result || { error: "no result" };
    await apiFetch("/applications/auto-apply/session-batch", {
      method: "POST",
      body: JSON.stringify({ search_id: next.id, results: r.results || [], blocked: !!r.blocked }),
    }).catch(() => {});
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

async function runHarvest(next) {
  // Open a LinkedIn search page, scrape all Easy-Apply job links, queue them.
  const tab = await chrome.tabs.create({ url: next.url, active: true });
  try {
    await waitForTabComplete(tab.id);
    await new Promise(r => setTimeout(r, 4000));
    const isSF = next.platform === "successfactors";
    await chrome.scripting.executeScript({ target: { tabId: tab.id },
      files: [isSF ? "content/successfactors.js" : "content/linkedin_easyapply.js"] }).catch(() => {});
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (sf) => sf
        ? (window.__jaaSFHarvest ? await window.__jaaSFHarvest("", 25) : { error: "SF harvest not loaded" })
        : (window.__jaaHarvestJobs ? await window.__jaaHarvestJobs(25) : { error: "harvest not loaded" }),
      args: [isSF],
    });
    const urls = result?.urls || [];
    await apiFetch(`/applications/${next.id}/expanded`, {
      method: "POST", body: JSON.stringify({ urls }),
    }).catch(() => {});
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const cleanup = () => { try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch {} };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // In case it already completed before we attached
    chrome.tabs.get(tabId, (t) => { if (t && t.status === "complete") finish(); });
    setTimeout(finish, timeoutMs);
  });
}

async function runOneAutoApply(next) {
  const tab = await chrome.tabs.create({ url: next.url, active: true });
  const report = (body) =>
    apiFetch(`/applications/${next.id}/auto-result`, { method: "POST", body: JSON.stringify(body) })
      .catch(() => {});
  try {
    // Wait for the page to actually finish loading, then let LinkedIn's SPA hydrate
    await waitForTabComplete(tab.id);
    await new Promise(r => setTimeout(r, 6000));
    const isSF = next.platform === "successfactors";
    // Whether portals auto-submit is user-controlled in settings
    let portalAutoSubmit = false;
    try { const st = await apiFetch("/applications/auto-apply/status"); portalAutoSubmit = !!st.portal_auto_submit; } catch {}

    if (isSF) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/autofill.js"] }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/successfactors.js"] }).catch(() => {});
    } else {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/linkedin.js"] }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/linkedin_easyapply.js"] }).catch(() => {});
    }

    // Run, retrying the whole flow if the modal didn't open in time (SPA still hydrating).
    let r = { error: "no result" };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(res => setTimeout(res, 4000));
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (appId, sf, autoSub) => {
          const job = window.__jaaExtractJob ? window.__jaaExtractJob() : null;
          let rr;
          if (sf) {
            rr = window.__jaaSFApply
              ? await window.__jaaSFApply({ autoSubmit: autoSub, applicationId: appId })
              : { error: "SF adapter not loaded" };
          } else {
            rr = window.__jaaRunEasyApply
              ? await window.__jaaRunEasyApply({ autoSubmit: true, applicationId: appId })
              : { error: "script not loaded" };
          }
          return { ...rr, job };
        },
        args: [next.id, isSF, portalAutoSubmit],
      });
      r = result || { error: "no result" };
      if (!/modal didn'?t open/i.test(r.error || "")) break;
      // Detect a captcha / checkpoint page and bail out clearly
      const [{ result: blocked } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => /checkpoint\/challenge|captcha|security verification|are you a human/i
          .test(document.body.innerText + " " + location.href),
      });
      if (blocked) { r = { error: "LinkedIn security check (captcha) — auto-apply paused. Open LinkedIn and verify manually." }; break; }
    }
    const meta = {
      job_title: r.job?.job_title || null, company: r.job?.company || null,
      filled: r.filled || 0, cv_used: r.cv_used || null,
      answers: (r.answered || []).map(a => ({ label: a.label, value: a.value })),
    };
    if (r.stopped === "submitted") {
      await report({ ...meta, status: "applied" });
    } else if (["needs_review", "required_field_blank", "validation_error", "ready_to_submit", "needs_account"].includes(r.stopped)) {
      await report({ ...meta, status: "needs_review",
        reason: r.reason || (r.stopped === "ready_to_submit"
          ? "Filled — waiting for your review & submit"
          : r.stopped === "validation_error"
            ? "Flagged: " + ((r.validation_errors || [])[0] || "validation error")
            : `${(r.blanks || []).length} required answers missing`) });
    } else {
      await report({ ...meta, status: "failed", reason: r.error || r.stopped || "unknown" });
      // Hitting a captcha → stop automation entirely to protect the account.
      if (/captcha|security check|checkpoint/i.test(r.error || "")) {
        try { await apiFetch("/applications/auto-apply/toggle", { method: "POST", body: JSON.stringify({ enabled: false }) }); } catch {}
      }
    }
  } finally {
    // Close the tab unless it needs the user's attention
    try {
      const fresh = await apiFetch(`/applications/auto-apply/status`);
      await chrome.tabs.remove(tab.id);
      void fresh;
    } catch { try { await chrome.tabs.remove(tab.id); } catch {} }
  }
}
