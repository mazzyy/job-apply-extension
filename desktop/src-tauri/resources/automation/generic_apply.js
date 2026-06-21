/*
 * generic_apply.js — fully automated apply for standard ATS single-page forms
 * (Greenhouse, Lever, Ashby) inside the integrated browser.
 *
 * Exposes window.__jaaGenericApply({autoSubmit, applicationId, supported}).
 * Flow: reveal form → autofill profile → answer questions (bank + LLM) →
 *       attach best CV → tick required consents → submit → detect outcome.
 * Bails to needs_review on captcha / account walls / unsupported portals.
 */
(function () {
  if (window.__jaaGenericApplyLoaded) return;
  window.__jaaGenericApplyLoaded = true;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const prog = (note) => { try { if (window.__jaaEmit) window.__jaaEmit("jaa-progress", { note: note }); } catch (e) {} };

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== "hidden" && el.offsetParent !== null;
  }
  async function apiGet(path) { try { const r = await chrome.runtime.sendMessage({ type: "API_GET", path }); return r && r.ok ? r.data : null; } catch { return null; } }
  async function apiPost(path, body) { try { const r = await chrome.runtime.sendMessage({ type: "API_POST", path, body }); return r && r.ok ? r.data : null; } catch { return null; } }

  function labelFor(el) {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const x = document.getElementById(lb); if (x) return x.innerText.trim(); }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText.trim(); }
    const wrap = el.closest("label, .field, .form-group, .application--question, .question, fieldset, [class*='field'], div");
    if (wrap) { const l = wrap.querySelector("label, legend, [class*='label'], [class*='question']"); if (l && l !== el && l.innerText.trim().length > 1) return l.innerText.trim().split("\n")[0]; }
    return el.placeholder || el.name || "";
  }
  function setVal(el, v) {
    if (v == null) return false;
    v = String(v);
    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find(o => o.text.toLowerCase() === v.toLowerCase()) ||
        Array.from(el.options).find(o => o.text.toLowerCase().includes(v.toLowerCase()) || (o.value || "").toLowerCase().includes(v.toLowerCase()));
      if (!opt) return false;
      el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); return true;
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }
  function detectType(el) {
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA") return "textarea";
    return (el.type || "text").toLowerCase() === "number" ? "number" : "text";
  }
  function optionsOf(el) { return el.tagName === "SELECT" ? Array.from(el.options).map(o => (o.text || "").trim()).filter(x => x && !/^select/i.test(x)) : null; }
  function radioOptionText(r) {
    if (r.id) { const l = document.querySelector(`label[for="${CSS.escape(r.id)}"]`); if (l && l.innerText.trim()) return l.innerText.trim(); }
    const lab = r.closest("label"); if (lab && lab.innerText.trim()) return lab.innerText.trim();
    return (r.value || r.getAttribute("aria-label") || "").trim();
  }

  function detectATS() {
    const h = location.hostname;
    if (/greenhouse\.io/.test(h) || document.querySelector("#grnhse_app, #application_form, .application--form")) return "greenhouse";
    if (/lever\.co/.test(h) || document.querySelector(".application-form, [data-qa='btn-submit']")) return "lever";
    if (/ashbyhq\.com/.test(h) || document.querySelector("[class*='_applicationForm'], form[class*='ashby']")) return "ashby";
    if (/personio\.(de|com)|jobs\.personio/.test(h)) return "personio";
    if (/smartrecruiters\.com/.test(h)) return "smartrecruiters";
    if (/workable\.com/.test(h)) return "workable";
    if (/recruitee\.com/.test(h)) return "recruitee";
    if (/myworkdayjobs\.com|workday/.test(h)) return "workday";
    return "generic";
  }
  function isCaptcha() {
    // Only a VISIBLE challenge blocks. Many normal forms (JOIN, Arbeitnow, …) embed an
    // invisible/background reCAPTCHA that runs silently on submit — that must NOT count.
    const chal = Array.from(document.querySelectorAll("iframe")).find(f => {
      const s = (f.getAttribute("src") || "") + " " + (f.getAttribute("title") || "");
      return /api2\/bframe|hcaptcha.*(challenge|checkbox)|turnstile|\/challenge/i.test(s) && visible(f);
    });
    if (chal) return true;
    const cb = document.querySelector("iframe[title='reCAPTCHA'], .recaptcha-checkbox");
    if (cb && visible(cb)) { const r = cb.getBoundingClientRect(); if (r.width > 40 && r.height > 40) return true; }
    if (document.querySelector("#challenge-stage, #cf-challenge-running")) return true;
    return /verify (you are|that you are) (a )?human|are you a robot|press (and|&) hold|complete the security check/i.test(document.body.innerText.slice(0, 2000));
  }
  function isAccountWall() {
    const hasForm = document.querySelector("input[type='file'], textarea, input[type='email']");
    if (hasForm) return false;
    return /(sign in|log in|create an account|create account|register to apply)/i.test(document.body.innerText.slice(0, 3000));
  }

  async function dismissCookies() {
    const rx = /^(accept all|allow all|accept( cookies| & close)?|agree|i agree|got it|ok|alle akzeptieren|akzeptieren|zustimmen|einverstanden|alle zulassen|alle annehmen|verstanden|tout accepter|accepter|aceptar)$/i;
    for (const id of ["onetrust-accept-btn-handler", "accept-recommended-btn-handler", "CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "CybotCookiebotDialogBodyButtonAccept", "uc-btn-accept-banner"]) {
      const el = document.getElementById(id);
      if (el && visible(el)) { try { el.click(); } catch (e) {} await wait(400); return true; }
    }
    const b = Array.from(document.querySelectorAll("button, a, [role='button']")).filter(visible)
      .find(x => rx.test((x.innerText || x.value || "").trim()));
    if (b) { try { b.click(); } catch (e) {} await wait(400); return true; }
    return false;
  }

  // Close marketing / email-capture / "subscribe" modals (NOT the apply form).
  async function closePopups() {
    let closed = 0;
    const rx = /^(skip for now|skip|no thanks|no,? thanks|maybe later|not now|continue without|close|dismiss|nein danke|sp\u00e4ter|\u00fcberspringen|schlie\u00dfen|ablehnen|x|\u2715|\u00d7)$/i;
    for (const el of Array.from(document.querySelectorAll("a, button, [role='button'], span")).filter(visible)) {
      const t = ((el.innerText || el.getAttribute("aria-label") || "").trim());
      if (t && t.length <= 24 && rx.test(t)) { try { el.click(); closed++; await wait(400); } catch (e) {} }
    }
    for (const sel of ["[aria-label='Close']", "[aria-label='close']", "button.close", ".modal-close", "[data-dismiss='modal']", "button[class*='close']", "a[class*='close']"]) {
      const el = document.querySelector(sel);
      if (el && visible(el)) { try { el.click(); closed++; await wait(300); } catch (e) {} }
    }
    return closed;
  }

  async function clickApplyTrigger() {
    if (document.querySelector("input[type='file']")) return;          // a real form is already on the page
    if (findFields(document).length >= 4) return;
    const rx = /(apply now|apply for|apply online|^apply$|apply\b|jetzt bewerben|online bewerben|bewerbung starten|zur bewerbung|jetzt online bewerben|bewerben\b|i'?m interested|postuler|solliciteren|aplicar)/i;
    const cands = Array.from(document.querySelectorAll("a, button, [role='button'], input[type='submit'], input[type='button']")).filter(visible);
    const b = cands.find(x => { const t = ((x.innerText || x.value || "").trim()); return t && t.length <= 40 && rx.test(t); });
    if (b) { try { b.scrollIntoView({ block: "center" }); } catch (e) {} b.click(); await wait(1800); }
  }

  function findFields(root) {
    const sel = "input, textarea, select";
    const list = Array.from(root.querySelectorAll(sel));
    root.querySelectorAll("iframe").forEach(f => { try { const d = f.contentDocument; if (d) list.push(...d.querySelectorAll(sel)); } catch {} });
    return list.filter(visible);
  }

  async function answerAll(applicationId) {
    const out = { filled: 0, answered: [], blanks: [] };
    const cache = new Map();
    for (const el of findFields(document)) {
      if (el.disabled || el.readOnly) continue;
      const t = (el.type || "").toLowerCase();
      if (["hidden", "file", "radio", "checkbox", "submit", "button", "password"].includes(t)) continue;
      if (el.value && String(el.value).trim().length > 0) continue;
      const label = labelFor(el);
      if (!label || label.length < 2) continue;
      const it = detectType(el), options = optionsOf(el);
      const required = el.required || el.getAttribute("aria-required") === "true";
      if (cache.has(label)) { if (setVal(el, cache.get(label))) out.filled++; continue; }
      const ans = await apiPost("/questions/answer-for-form", { text: label, input_type: it, options: options || null, max_length: (el.maxLength > 0 ? el.maxLength : null), application_id: applicationId, save: true });
      if (ans && ans.value != null && String(ans.value).length) {
        if (setVal(el, ans.value)) { out.filled++; cache.set(label, ans.value); out.answered.push({ label, value: ans.value, needs_review: ans.needs_review, qid: ans.question_id }); }
        else if (required) out.blanks.push({ label: label.slice(0, 120), type: it, options: options || null });
      } else if (required) out.blanks.push({ label: label.slice(0, 120), type: it, options: options || null });
    }
    // radio groups
    const groups = new Map();
    Array.from(document.querySelectorAll("input[type='radio']")).filter(visible).forEach(r => {
      const key = r.name || (r.closest("fieldset") && r.closest("fieldset").querySelector("legend") && r.closest("fieldset").querySelector("legend").innerText) || labelFor(r) || "";
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r);
    });
    for (const [name, radios] of groups) {
      if (radios.some(r => r.checked)) continue;
      const wrap = radios[0].closest("fieldset, [class*='field'], [class*='question']");
      const label = (((wrap && wrap.querySelector("legend, [class*='label'], [class*='question']") && wrap.querySelector("legend, [class*='label'], [class*='question']").innerText) || name || "").split("\n")[0] || "").trim();
      const opts = radios.map(radioOptionText).filter(Boolean);
      if (/gender|\bsex\b|race|ethnic|hispanic|veteran|disab|sexual orientation|pronoun/i.test(label)) {
        const dec = radios.find(r => /decline|prefer not|not to (say|disclose)/i.test(radioOptionText(r)));
        if (dec) { dec.click(); dec.dispatchEvent(new Event("change", { bubbles: true })); out.filled++; }
        continue;
      }
      const requiredR = radios.some(r => r.required || r.getAttribute("aria-required") === "true") ||
        (wrap && /\*|required|erforderlich|pflicht/i.test(wrap.innerText || ""));
      const ans = await apiPost("/questions/answer-for-form", { text: label, input_type: "radio", options: opts, application_id: applicationId, save: true });
      const want = ans && ans.value != null ? String(ans.value).toLowerCase() : null;
      let pick = null;
      if (want) pick = radios.find(r => radioOptionText(r).toLowerCase() === want) ||
        radios.find(r => { const x = radioOptionText(r).toLowerCase(); return x && (x.startsWith(want) || want.startsWith(x) || x.includes(want)); });
      if (pick) { pick.click(); pick.dispatchEvent(new Event("change", { bubbles: true })); out.filled++; out.answered.push({ label, value: radioOptionText(pick), needs_review: ans && ans.needs_review, qid: ans && ans.question_id }); }
      else if (requiredR) out.blanks.push({ label: label.slice(0, 120), type: "radio", options: opts });
    }
    return out;
  }

  function tickConsents() {
    let n = 0;
    Array.from(document.querySelectorAll("input[type='checkbox']")).filter(visible).forEach(cb => {
      if (cb.checked) return;
      const label = labelFor(cb).toLowerCase();
      const required = cb.required || cb.getAttribute("aria-required") === "true";
      const consent = /(privacy|consent|terms|gdpr|data protection|agree|datenschutz|einwillig|zustimm)/i.test(label);
      const marketing = /(newsletter|marketing|subscribe|updates|promotional)/i.test(label);
      if ((required || consent) && !marketing) { cb.click(); n++; }
    });
    return n;
  }

  async function attachCV() {
    const inputs = Array.from(document.querySelectorAll("input[type='file']")).filter(i => !i.disabled);
    if (!inputs.length) return 0;
    const job = window.__jaaExtractJob ? (window.__jaaExtractJob() || {}) : {};
    const cv = await apiPost("/cvs/best", { job_description: job.job_description || "" });
    if (!cv || !cv.id) return 0;
    let blob; try { const r = await fetch(window.__JAA_API_BASE + "/cvs/" + cv.id + "/file"); blob = await r.blob(); } catch { return 0; }
    const file = new File([blob], cv.filename || "cv.pdf", { type: blob.type || "application/pdf" });
    let n = 0;
    for (const inp of inputs) { try { const dt = new DataTransfer(); dt.items.add(file); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true })); inp.dispatchEvent(new Event("input", { bubbles: true })); n++; } catch {} }
    return n;
  }

  function findSubmit() {
    const btns = Array.from(document.querySelectorAll("button, input[type='submit'], a[role='button']")).filter(visible);
    return btns.find(b => /submit application|^submit$|send application|apply now|bewerbung absenden|absenden/i.test((b.innerText || b.value || "").trim())) ||
      document.querySelector("#submit_app") || document.querySelector("button[type='submit'], input[type='submit']");
  }
  function submittedOK() {
    const t = document.body.innerText.toLowerCase();
    return /thank you for applying|application (received|submitted)|we'?ve received your application|successfully applied|thanks for applying|your application has been/i.test(t) ||
      /confirmation|thank|applied/i.test(location.href);
  }

  // Fill specific answers the user just provided (by label), for the ask-&-save loop.
  window.__jaaIsCaptcha = function () { try { return isCaptcha(); } catch (e) { return false; } };

  window.__jaaFillAnswers = async function (list) {
    let n = 0;
    for (const item of (list || [])) {
      const val = item && item.value; if (val == null || val === "") continue;
      const key = String(item.label || "").toLowerCase().slice(0, 40);
      if (!key) continue;
      const f = findFields(document).find(el => {
        const t = (el.type || "").toLowerCase();
        if (["radio", "checkbox", "hidden", "file", "submit", "button"].indexOf(t) >= 0) return false;
        return labelFor(el).toLowerCase().indexOf(key) >= 0;
      });
      if (f) { if (setVal(f, val)) n++; continue; }
      const radios = Array.from(document.querySelectorAll("input[type='radio']")).filter(visible).filter(r => {
        const wrap = r.closest("fieldset, [class*='field'], [class*='question']");
        const lab = ((wrap && wrap.querySelector("legend, [class*='label'], [class*='question']") && wrap.querySelector("legend, [class*='label'], [class*='question']").innerText) || "").toLowerCase();
        return lab.indexOf(key) >= 0;
      });
      const wl = String(val).toLowerCase();
      const pick = radios.find(r => radioOptionText(r).toLowerCase() === wl) ||
        radios.find(r => { const x = radioOptionText(r).toLowerCase(); return x && (x.indexOf(wl) >= 0 || wl.indexOf(x) >= 0); });
      if (pick) { pick.click(); pick.dispatchEvent(new Event("change", { bubbles: true })); n++; }
    }
    return n;
  };
  window.__jaaSubmitForm = async function () {
    tickConsents();
    if (isCaptcha()) return { stopped: "captcha", error: "captcha before submit" };
    const btn = findSubmit();
    if (!btn) return { stopped: "ready_to_submit", reason: "no submit button found" };
    btn.click(); await wait(3000);
    if (submittedOK()) return { stopped: "submitted" };
    const again = findSubmit(); if (again) { again.click(); await wait(3000); }
    return submittedOK() ? { stopped: "submitted" } : { stopped: "submit_unconfirmed", reason: "clicked submit; confirmation not detected — verify" };
  };

  function isExpired() {
    return /no longer (available|accepting)|position (has been |is )?(filled|closed)|posting is closed|job (has )?expired|vacancy (is )?closed|this (job|posting) is closed|nicht mehr verf\u00fcgbar|stelle .{0,20}besetzt|bewerbungsphase .{0,20}beendet|abgelaufen/i.test(document.body.innerText.slice(0, 4000));
  }
  function isRegionBlock() {
    return /not available in your (country|region|location)|nicht in deinem land verf\u00fcgbar/i.test(document.body.innerText.slice(0, 3000));
  }
  function findApplyLink() {
    const rx = /(apply|bewerb|application|postuler|solliciteren|aplicar)/i;
    for (const a of Array.from(document.querySelectorAll("a[href]")).filter(visible)) {
      const t = ((a.innerText || a.getAttribute("aria-label") || "").trim());
      const href = a.href || "";
      if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
      if (t && t.length <= 40 && rx.test(t)) {
        try { const u = new URL(href, location.href); if (u.href.split("#")[0] !== location.href.split("#")[0]) return u.href; } catch (e) {}
      }
    }
    return null;
  }
  function findNext() {
    const btns = Array.from(document.querySelectorAll("button, a[role='button'], input[type='button'], input[type='submit']")).filter(visible);
    return btns.find(b => { const t = ((b.innerText || b.value || "").trim()); return t && /^(next|continue|weiter|save (and|&) continue|continue to|n\u00e4chster schritt|next step|proceed)\b/i.test(t) && !/submit|absenden|apply now|send application/i.test(t); });
  }
  // Best-effort filler for custom JS dropdowns (react-select / comboboxes).
  async function fillCustomSelects(applicationId) {
    const out = { filled: 0, answered: [], blanks: [] };
    const ctrls = Array.from(document.querySelectorAll(".select__control, [class*='select__control'], [role='combobox']")).filter(visible);
    for (const ctrl of ctrls) {
      try {
        const valNode = ctrl.querySelector(".select__single-value, [class*='single-value']");
        if (valNode && valNode.innerText.trim()) continue;            // already chosen
        const wrap = ctrl.closest("[class*='field'], .form-group, label, [class*='question'], div");
        const labEl = wrap && wrap.querySelector("label, legend, [class*='label']");
        const lab = ((labEl && labEl.innerText) || "").split("\n")[0].trim();
        if (!lab || lab.length < 2) continue;
        ctrl.click(); await wait(450);
        let opts = Array.from(document.querySelectorAll(".select__option, [class*='select__option'], [role='option']")).filter(visible);
        const optTexts = opts.map(o => o.innerText.trim()).filter(Boolean);
        if (!optTexts.length) { try { document.body.click(); } catch (e) {} continue; }
        const ans = await apiPost("/questions/answer-for-form", { text: lab, input_type: "select", options: optTexts, application_id: applicationId, save: true });
        const want = ans && ans.value != null ? String(ans.value).toLowerCase() : null;
        let pick = null;
        if (want) { opts = Array.from(document.querySelectorAll(".select__option, [class*='select__option'], [role='option']")).filter(visible); pick = opts.find(o => o.innerText.trim().toLowerCase() === want) || opts.find(o => o.innerText.trim().toLowerCase().indexOf(want) >= 0); }
        if (pick) { pick.click(); out.filled++; out.answered.push({ label: lab, value: pick.innerText.trim(), qid: ans && ans.question_id }); await wait(300); }
        else { try { document.body.click(); } catch (e) {} }
      } catch (e) {}
    }
    return out;
  }

  window.__jaaGenericApply = async function (opts) {
    opts = opts || {};
    const autoSubmit = opts.autoSubmit !== false;
    const applicationId = opts.applicationId || null;
    const supported = opts.supported || ["greenhouse", "lever", "ashby", "personio", "smartrecruiters", "workable", "recruitee"];
    const steps = [];
    const step = (m) => { steps.push(m); try { prog(m); } catch (e) {} };
    try {
      const ats = detectATS();
      step("opened page (" + (ats || "generic") + ")");
      if (await dismissCookies()) step("closed cookie banner");
      const pop = await closePopups(); if (pop) step("closed " + pop + " popup(s)");
      const onAgg = /jooble\.|indeed\.|glassdoor\.|stepstone\.|ziprecruiter\.|talent\.com/i.test(location.hostname);
      if (onAgg && isCaptcha()) { step("stopped: aggregator human-check (" + location.hostname + ")"); return { stopped: "needs_review", ats, filled: 0, reason: "Aggregator (" + location.hostname + ") shows a human-check before the employer site - open & click through it manually.", steps }; }
      if (isExpired()) { step("stopped: job expired / no longer available"); return { stopped: "expired", ats, filled: 0, reason: "Job posting expired or no longer available", steps }; }
      if (isRegionBlock()) { step("stopped: not available in your region"); return { stopped: "needs_review", ats, filled: 0, reason: "Not available in your region - open & check manually", steps }; }
      if (isCaptcha()) { step("stopped: human check on page"); return { stopped: "captcha", ats, error: "captcha on page", filled: 0, steps }; }

      await clickApplyTrigger(); step("looked for an Apply button");
      await wait(800);
      if (isCaptcha()) { step("stopped: human check on page"); return { stopped: "captcha", ats, error: "captcha on page", filled: 0, steps }; }
      if (isAccountWall()) { step("stopped: login/account required"); return { stopped: "needs_account", ats, reason: "account/login required - finish manually", filled: 0, steps }; }

      let _t = 0;
      while (_t < 10 && findFields(document).length < 2) { await dismissCookies(); await closePopups(); prog("waiting for the form..."); await clickApplyTrigger(); await wait(1500); _t++; }
      const nFields = findFields(document).length;
      if (nFields < 1 && !document.querySelector("input[type='file']")) {
        const follow = findApplyLink();
        if (follow) { step("Apply opens another page - following: " + follow.slice(0, 80)); return { stopped: "follow", url: follow, ats, steps }; }
        step("no application form on this page");
        return { stopped: "needs_review", ats, filled: 0, reason: (onAgg ? ("Aggregator (" + location.hostname + ") gates the employer link behind a human-check - open & apply manually.") : "No form on this page - description/aggregator page and no Apply link found. Open & finish manually."), steps };
      }
      step("found " + nFields + " form field(s)");

      let pf = 0;
      if (window.JAA_Autofill && window.JAA_Autofill.fillAll) { try { const a = await window.JAA_Autofill.fillAll(); pf = a.filled || 0; } catch (e) {} }
      const res = await answerAll(applicationId);
      const cs = await fillCustomSelects(applicationId);
      const cvN = await attachCV();
      tickConsents();
      let filledTotal = pf + res.filled + cs.filled;
      let answered = (res.answered || []).concat(cs.answered || []);
      let blanks = (res.blanks || []).concat(cs.blanks || []);
      step("filled " + filledTotal + " field(s)" + (cvN ? " + attached CV" : "") + (blanks.length ? " (" + blanks.length + " required still blank)" : ""));

      // Complex multi-page portals: fill but leave for manual review (too risky to blind-submit).
      const reviewOnly = ["workday", "taleo"];
      if (reviewOnly.indexOf(ats) >= 0) { step("stopped: complex portal (" + ats + ") - review & submit manually"); return { stopped: "needs_review", ats, filled: filledTotal, answered, missing: blanks, reason: "Complex multi-page portal (" + ats + ") - review & submit manually", steps }; }
      // Unknown/generic forms: only auto-submit if it really looks like an application (CV attached or several fields filled).
      if (ats === "generic" && autoSubmit && !(cvN > 0 || filledTotal >= 2)) { step("stopped: unrecognized form - review & submit"); return { stopped: "needs_review", ats, filled: filledTotal, answered, missing: blanks, reason: "Unrecognized form - review & submit manually", steps }; }
      if (!autoSubmit) { step("ready to submit (auto-submit off)"); return { stopped: "ready_to_submit", ats, filled: filledTotal, answered, missing: blanks, steps }; }
      if (blanks.length) { step("stopped: need your answers for " + blanks.length + " required field(s)"); return { stopped: "needs_input", ats, filled: filledTotal, answered, missing: blanks, steps }; }
      if (isCaptcha()) { step("stopped: human check before submit"); return { stopped: "captcha", ats, filled: filledTotal, answered, error: "captcha before submit", steps }; }

      // Multi-step wizard: advance through Next/Continue steps until a Submit button appears.
      let btn = findSubmit();
      let wstep = 0;
      while (!btn && wstep < 6) {
        const nx = findNext();
        if (!nx) break;
        step("multi-step: Next -> (step " + (wstep + 2) + ")");
        try { nx.scrollIntoView({ block: "center" }); } catch (e) {}
        nx.click(); await wait(2600);
        await dismissCookies(); await closePopups();
        const r2 = await answerAll(applicationId);
        const cs2 = await fillCustomSelects(applicationId);
        await attachCV(); tickConsents();
        filledTotal += r2.filled + cs2.filled;
        answered = answered.concat(r2.answered || [], cs2.answered || []);
        const b2 = (r2.blanks || []).concat(cs2.blanks || []);
        if (b2.length) { step("stopped: need your answers on step " + (wstep + 2)); return { stopped: "needs_input", ats, filled: filledTotal, answered, missing: b2, steps }; }
        if (isCaptcha()) { step("stopped: human check on step " + (wstep + 2)); return { stopped: "captcha", ats, filled: filledTotal, answered, error: "captcha", steps }; }
        btn = findSubmit();
        wstep++;
      }
      if (!btn) { step("stopped: multi-step form, no submit reached"); return { stopped: "ready_to_submit", ats, filled: filledTotal, answered, reason: "Multi-step form - review & submit manually", steps }; }

      step("clicking submit");
      btn.click();
      await wait(3000);
      if (submittedOK()) { step("submitted - confirmation detected"); return { stopped: "submitted", ats, filled: filledTotal, answered, cv_attached: cvN, steps }; }
      const again = findSubmit(); if (again) { again.click(); await wait(3000); }
      if (submittedOK()) { step("submitted - confirmation detected"); return { stopped: "submitted", ats, filled: filledTotal, answered, cv_attached: cvN, steps }; }
      step("clicked submit - confirmation NOT detected");
      return { stopped: "submit_unconfirmed", ats, filled: filledTotal, answered, reason: "clicked submit; confirmation not detected - verify", cv_attached: cvN, steps };
    } catch (e) {
      steps.push("error: " + String((e && e.message) || e));
      return { stopped: "failed", error: String((e && e.message) || e), steps };
    }
  };

})();
