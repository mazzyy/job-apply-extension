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

chrome.alarms.create(AUTOAPPLY_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== AUTOAPPLY_ALARM || autoApplyBusy) return;
  // Random extra wait so runs aren't perfectly periodic
  const { lastAutoApplyAt } = await chrome.storage.local.get("lastAutoApplyAt");
  const minGap = 45000 + Math.floor(Math.random() * 75000);   // 45–120s
  if (lastAutoApplyAt && Date.now() - lastAutoApplyAt < minGap) return;

  let st;
  try { st = await apiFetch("/applications/auto-apply/status"); } catch { return; }
  if (!st.enabled || !st.next || st.cap_reached) return;

  autoApplyBusy = true;
  try {
    await runOneAutoApply(st.next);
  } catch (e) {
    console.warn("[JAA] auto-apply run failed", e);
  } finally {
    await chrome.storage.local.set({ lastAutoApplyAt: Date.now() });
    autoApplyBusy = false;
  }
});

async function runOneAutoApply(next) {
  const tab = await chrome.tabs.create({ url: next.url, active: true });
  const report = (body) =>
    apiFetch(`/applications/${next.id}/auto-result`, { method: "POST", body: JSON.stringify(body) })
      .catch(() => {});
  try {
    // Wait for the page + content scripts
    await new Promise(r => setTimeout(r, 6000));
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/linkedin.js"] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/linkedin_easyapply.js"] }).catch(() => {});

    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (appId) => {
        const job = window.__jaaExtractJob ? window.__jaaExtractJob() : null;
        const r = window.__jaaRunEasyApply
          ? await window.__jaaRunEasyApply({ autoSubmit: true, applicationId: appId })
          : { error: "script not loaded" };
        return { ...r, job };
      },
      args: [next.id],
    });
    const r = result || { error: "no result" };
    const meta = {
      job_title: r.job?.job_title || null, company: r.job?.company || null,
      filled: r.filled || 0, cv_used: r.cv_used || null,
      answers: (r.answered || []).map(a => ({ label: a.label, value: a.value })),
    };
    if (r.stopped === "submitted") {
      await report({ ...meta, status: "applied" });
    } else if (r.stopped === "needs_review" || r.stopped === "required_field_blank" || r.stopped === "validation_error") {
      await report({ ...meta, status: "needs_review",
        reason: r.stopped === "validation_error"
          ? "LinkedIn flagged: " + ((r.validation_errors || [])[0] || "validation error")
          : `${(r.blanks || []).length} required answers missing` });
    } else {
      await report({ ...meta, status: "failed", reason: r.error || r.stopped || "unknown" });
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
