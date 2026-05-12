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
