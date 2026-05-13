/*
 * Question-suggest: detects open-ended question textareas and adds a small
 * "Suggest answer" button. Clicking it asks the backend for a saved match
 * (or a fresh LLM draft), inserts the chosen answer, and tracks usage.
 */
(function () {
  if (window.__jaaQSLoaded) return;
  window.__jaaQSLoaded = true;

  const PROCESSED = new WeakSet();

  function labelTextFor(el) {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    const lblBy = el.getAttribute("aria-labelledby");
    if (lblBy) {
      const x = document.getElementById(lblBy);
      if (x) return x.innerText.trim();
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return lab.innerText.trim();
    }
    const wrap = el.closest("label, .field, .form-group, .application--question, .question, fieldset, div");
    if (wrap) {
      const lab = wrap.querySelector("label, legend, [class*='label'], [class*='question']");
      if (lab && lab !== el && lab.innerText.trim().length > 6) return lab.innerText.trim();
    }
    return el.placeholder || el.name || "";
  }

  function looksLikeQuestion(text) {
    if (!text || text.length < 12) return false;
    const t = text.toLowerCase();
    if (text.includes("?")) return true;
    return /\b(why|how|describe|tell|explain|what|when|where|reason|interest|motivate)\b/.test(t);
  }

  function makeButton(textarea, question) {
    if (PROCESSED.has(textarea)) return;
    PROCESSED.add(textarea);

    const wrap = document.createElement("div");
    wrap.className = "jaa-qs-wrap";
    wrap.style.cssText = "position: relative; display: inline-block; margin: 4px 0; z-index: 2147483646;";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "jaa-qs-btn";
    btn.innerHTML = "✦ Suggest answer";
    btn.style.cssText = `
      background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff;
      border: none; padding: 6px 12px; border-radius: 999px;
      font: 600 11px/1 -apple-system, system-ui, sans-serif;
      cursor: pointer; box-shadow: 0 4px 10px rgba(99,102,241,.25);
    `;

    const popover = document.createElement("div");
    popover.className = "jaa-qs-pop";
    popover.style.cssText = `
      display: none; position: absolute; top: 100%; left: 0; margin-top: 4px;
      background: #fff; color: #111; border: 1px solid #e5e7eb;
      border-radius: 10px; padding: 10px; min-width: 320px; max-width: 480px;
      box-shadow: 0 12px 32px rgba(0,0,0,.12); font: 12.5px/1.5 -apple-system, system-ui, sans-serif;
      z-index: 2147483647;
    `;

    function close() { popover.style.display = "none"; document.removeEventListener("click", outside, true); }
    function outside(e) { if (!popover.contains(e.target) && e.target !== btn) close(); }

    async function open() {
      popover.style.display = "block";
      popover.innerHTML = `<div style="color:#64748b">Looking up saved answers…</div>`;
      document.addEventListener("click", outside, true);
      try {
        const matchResp = await chrome.runtime.sendMessage({
          type: "API_POST", path: "/questions/match",
          body: { text: question, top_k: 3, min_score: 0.28 },
        });
        const matches = matchResp?.ok ? matchResp.data.matches : [];
        renderPopover(matches);
      } catch (e) {
        popover.innerHTML = `<div style="color:#b91c1c">Error: ${e.message}</div>`;
      }
    }

    function escapeHtml(s){ return (s||"").toString().replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

    function renderPopover(matches) {
      const head = `
        <div style="font-weight:700;font-size:12px;margin-bottom:4px">Question</div>
        <div style="background:#f5f6fa;padding:6px 8px;border-radius:6px;margin-bottom:8px;font-size:11px;color:#374151">${escapeHtml(question.slice(0,180))}</div>
      `;
      const matchList = matches.length ? matches.map(m => {
        const a = (m.answers || [])[0];
        if (!a) return "";
        return `
          <div class="jaa-qs-match" style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:6px;cursor:pointer;background:#fafbff" data-aid="${a.id}">
            <div style="display:flex;justify-content:space-between;font-size:10px;color:#6b7280;margin-bottom:4px">
              <span><b>${escapeHtml(m.text.slice(0,80))}</b></span>
              <span>${Math.round((m.score||0)*100)}% match</span>
            </div>
            <div style="font-size:12px;color:#111;max-height:80px;overflow:hidden">${escapeHtml(a.answer)}</div>
          </div>`;
      }).join("") : `<div style="color:#6b7280;font-size:12px;margin-bottom:8px">No saved answers match this question yet.</div>`;
      const draftBtn = `
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          <button class="jaa-qs-draft" type="button" style="flex:1;background:#0f172a;color:#fff;border:none;padding:7px 10px;border-radius:6px;font-weight:600;font-size:11px;cursor:pointer">✨ Draft fresh with AI</button>
          <button class="jaa-qs-close" type="button" style="background:#e5e7eb;color:#111;border:none;padding:7px 10px;border-radius:6px;font-weight:600;font-size:11px;cursor:pointer">Close</button>
        </div>`;
      popover.innerHTML = head + matchList + draftBtn;

      popover.querySelectorAll(".jaa-qs-match").forEach(node => {
        node.addEventListener("click", async () => {
          const aid = +node.dataset.aid;
          insertAnswer(node.querySelector("div:last-child").textContent);
          try {
            await chrome.runtime.sendMessage({ type: "API_POST", path: `/questions/answers/${aid}/use`, body: {} });
          } catch {}
          close();
        });
      });
      popover.querySelector(".jaa-qs-draft")?.addEventListener("click", async () => {
        popover.innerHTML = `<div style="color:#64748b">Drafting…</div>`;
        try {
          const resp = await chrome.runtime.sendMessage({
            type: "API_POST", path: "/questions/draft",
            body: { text: question, save: true },
          });
          if (resp?.ok) {
            insertAnswer(resp.data.answer);
            popover.innerHTML = `<div style="color:#16a34a;font-size:12px">✓ Drafted and saved to your library.</div>`;
            setTimeout(close, 1500);
          } else {
            popover.innerHTML = `<div style="color:#b91c1c">Error: ${resp?.error || "failed"}</div>`;
          }
        } catch (e) {
          popover.innerHTML = `<div style="color:#b91c1c">Error: ${e.message}</div>`;
        }
      });
      popover.querySelector(".jaa-qs-close")?.addEventListener("click", close);
    }

    function insertAnswer(text) {
      const proto = HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(textarea, text); else textarea.value = text;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      textarea.focus();
    }

    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); open(); });
    wrap.appendChild(btn);
    wrap.appendChild(popover);

    // Insert wrap right after the textarea
    if (textarea.parentElement) {
      textarea.parentElement.insertBefore(wrap, textarea.nextSibling);
    }
  }

  function scan() {
    document.querySelectorAll("textarea").forEach(ta => {
      if (PROCESSED.has(ta)) return;
      if (ta.offsetWidth < 80 || ta.offsetHeight < 20) return; // ignore tiny/hidden
      const label = labelTextFor(ta);
      if (!looksLikeQuestion(label)) return;
      makeButton(ta, label);
    });
  }

  setTimeout(scan, 1200);
  setTimeout(scan, 3000);
  new MutationObserver(() => scan())
    .observe(document.body, { childList: true, subtree: true });
})();
