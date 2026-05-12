/*
 * Apply-watcher — detects when the user clicks an Apply/Submit button on a job page,
 * then auto-marks the most recently analyzed Application as "applied" in the backend.
 *
 * Stored state:
 *   chrome.storage.session
 *     lastApplicationId    — int, set by background.js when analysis returns
 *     lastApplicationUrl   — string
 */
(function () {
  if (window.__jaaApplyWatcherLoaded) return;
  window.__jaaApplyWatcherLoaded = true;

  const APPLY_PATTERNS = [
    /\bapply\b/i,
    /\bsubmit\s+application\b/i,
    /\beasy\s+apply\b/i,
    /\bsend\s+application\b/i,
    /\bbewerben\b/i,          // German
    /\bpostuler\b/i,          // French
    /\baplicar\b/i,           // Spanish
    /^submit$/i,
  ];

  function isApplyButton(el) {
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    if (!["BUTTON", "A", "INPUT"].includes(tag)) return false;
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
    if (!text || text.length > 80) return false;
    return APPLY_PATTERNS.some(p => p.test(text));
  }

  function toast(msg, kind = "good") {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = `
      position: fixed; right: 24px; bottom: 90px; z-index: 2147483647;
      background: ${kind === "good" ? "#16a34a" : "#b91c1c"}; color: #fff;
      font: 600 13px/1.3 -apple-system, system-ui, sans-serif;
      padding: 10px 14px; border-radius: 10px;
      box-shadow: 0 10px 24px rgba(0,0,0,.2);
      max-width: 320px;
    `;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  async function markApplied(buttonText) {
    let state = {};
    try {
      state = await chrome.storage.session.get(["lastApplicationId", "lastApplicationUrl"]);
    } catch { /* session storage may not be available in some contexts */ }
    const id = state.lastApplicationId;
    if (!id) {
      console.debug("[JAA] Apply clicked but no application_id in session.");
      return;
    }
    // Only auto-mark if we're on the same job URL we analyzed
    if (state.lastApplicationUrl && !location.href.startsWith(state.lastApplicationUrl.split("?")[0])) {
      // Different page — still mark, since LinkedIn opens apply in a modal
    }
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "API_PATCH",
        path: `/applications/${id}`,
        body: { status: "applied" },
      });
      if (resp?.ok) {
        toast(`✓ Marked "${buttonText.slice(0, 40)}" as applied`);
      } else {
        toast("Could not auto-mark: " + (resp?.error || "unknown"), "bad");
      }
    } catch (e) {
      console.warn("[JAA] auto-mark failed", e);
    }
  }

  // Capture-phase listener so we see the click before page handlers cancel it
  document.addEventListener("click", (e) => {
    let el = e.target;
    for (let i = 0; i < 5 && el; i++) {
      if (isApplyButton(el)) {
        const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        // Slight delay so the backend has time to know about the analyze that just happened
        setTimeout(() => markApplied(text), 400);
        break;
      }
      el = el.parentElement;
    }
  }, true);
})();
