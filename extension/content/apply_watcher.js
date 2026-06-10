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

  // STRONG patterns are unambiguous — trusted even cross-site (e.g. LinkedIn
  // handed off to a company career site).
  const STRONG_PATTERNS = [
    /\bsubmit\s+application\b/i,
    /\bsend\s+application\b/i,
    /\beasy\s+apply\b/i,
    /\bbewerbung\s+(absenden|senden|abschicken)\b/i, // German
  ];
  // WEAK patterns ("Apply", "Submit") only count on the same host we analyzed.
  const WEAK_PATTERNS = [
    /\bapply\b/i,
    /\bbewerben\b/i,          // German
    /\bpostuler\b/i,          // French
    /\baplicar\b/i,           // Spanish
    /^submit$/i,
  ];
  // Buttons like "Apply filters" / "Apply changes" / "Apply coupon" must never match.
  const EXCLUDE_PATTERN = /\b(filters?|changes?|settings?|coupon|promo|discount|code|theme|sort)\b/i;

  // Don't trust an analysis older than this for auto-marking.
  const MAX_ANALYSIS_AGE_MS = 45 * 60 * 1000;

  function applyMatchKind(el) {
    if (!el || el === document.body) return null;
    if (!["BUTTON", "A", "INPUT"].includes(el.tagName)) return null;
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
    if (!text || text.length > 80) return null;
    if (EXCLUDE_PATTERN.test(text)) return null;
    if (STRONG_PATTERNS.some(p => p.test(text))) return "strong";
    if (WEAK_PATTERNS.some(p => p.test(text))) return "weak";
    return null;
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

  async function markApplied(buttonText, matchKind) {
    let state = {};
    try {
      state = await chrome.storage.session.get(["lastApplicationId", "lastApplicationUrl", "lastApplicationAt"]);
    } catch { /* session storage may not be available in some contexts */ }
    const id = state.lastApplicationId;
    if (!id) {
      console.debug("[JAA] Apply clicked but no application_id in session.");
      return;
    }
    // Stale analysis — don't guess.
    if (state.lastApplicationAt && Date.now() - state.lastApplicationAt > MAX_ANALYSIS_AGE_MS) {
      console.debug("[JAA] Apply clicked but last analysis is stale — not auto-marking.");
      return;
    }
    // URL guard: weak matches ("Apply") must be on the same host we analyzed.
    // Strong matches ("Submit application") may be cross-host (career-site handoff).
    if (state.lastApplicationUrl) {
      try {
        const analyzedHost = new URL(state.lastApplicationUrl).hostname;
        if (matchKind !== "strong" && analyzedHost !== location.hostname) {
          console.debug("[JAA] Apply clicked on a different site than analyzed — not auto-marking.");
          return;
        }
      } catch { /* unparsable stored URL — fall through */ }
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
      const kind = applyMatchKind(el);
      if (kind) {
        const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        // Slight delay so the backend has time to know about the analyze that just happened
        setTimeout(() => markApplied(text, kind), 400);
        break;
      }
      el = el.parentElement;
    }
  }, true);
})();
