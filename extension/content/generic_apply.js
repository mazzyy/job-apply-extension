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
    return !!document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], .g-recaptcha, [class*='captcha']") ||
      /are you a human|verify you are|security check|captcha/i.test(document.body.innerText.slice(0, 4000));
  }
  function isAccountWall() {
    const hasForm = document.querySelector("input[type='file'], textarea, input[type='email']");
    if (hasForm) return false;
    return /(sign in|log in|create an account|create account|register to apply)/i.test(document.body.innerText.slice(0, 3000));
  }

  async function clickApplyTrigger() {
    if (document.querySelector("input[type='file'], textarea, input[type='email']")) return;
    const cands = Array.from(document.querySelectorAll("a, button")).filter(visible);
    const b = cands.find(x => /^\s*(apply( for this job| now)?|jetzt bewerben|bewerben)\s*$/i.test((x.innerText || "").trim()));
    if (b) { b.click(); await wait(1500); }
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

  window.__jaaGenericApply = async function (opts) {
    opts = opts || {};
    const autoSubmit = opts.autoSubmit !== false;
    const applicationId = opts.applicationId || null;
    const supported = opts.supported || ["greenhouse", "lever", "ashby", "personio", "smartrecruiters", "workable", "recruitee"];
    try {
      const ats = detectATS();
      await clickApplyTrigger();
      await wait(800);
      if (isCaptcha()) return { stopped: "captcha", ats, error: "captcha on page", filled: 0 };
      if (isAccountWall()) return { stopped: "needs_account", ats, reason: "account/login required — finish manually", filled: 0 };

      // Portals are slow SPAs — wait for the application form to render, retrying the
      // Apply trigger in case the page is still showing the job description.
      let _t = 0;
      while (_t < 8 && findFields(document).length < 2) { prog("waiting for the form…"); await clickApplyTrigger(); await wait(1500); _t++; }
      if (findFields(document).length < 1 && !document.querySelector("input[type='file']")) {
        return { stopped: "needs_account", ats, filled: 0, reason: "No application form detected — open & finish manually" };
      }
      prog("found " + findFields(document).length + " fields · " + ats);

      let pf = 0;
      if (window.JAA_Autofill && window.JAA_Autofill.fillAll) { try { const a = await window.JAA_Autofill.fillAll(); pf = a.filled || 0; } catch {} }
      const res = await answerAll(applicationId);
      const cvN = await attachCV();
      tickConsents();
      const filled = pf + res.filled;
      prog("filled " + filled + (res.blanks && res.blanks.length ? " · " + res.blanks.length + " to ask" : "") + (cvN ? " · CV attached" : ""));

      if (supported.indexOf(ats) < 0) {
        return { stopped: "needs_account", ats, filled, answered: res.answered, missing: res.blanks, reason: "Portal not auto-submittable (" + ats + ") — review & submit" };
      }
      if (!autoSubmit) return { stopped: "ready_to_submit", ats, filled, answered: res.answered, missing: res.blanks };
      // Don't blind-submit: if required fields are still empty, ask the user (ask & save).
      if (res.blanks && res.blanks.length) {
        return { stopped: "needs_input", ats, filled, answered: res.answered, missing: res.blanks };
      }
      if (isCaptcha()) return { stopped: "captcha", ats, filled, answered: res.answered, error: "captcha before submit" };
      prog("submitting…");
      const btn = findSubmit();
      if (!btn) return { stopped: "ready_to_submit", ats, filled, answered: res.answered, reason: "no submit button found" };
      btn.click();
      await wait(3000);
      if (submittedOK()) return { stopped: "submitted", ats, filled, answered: res.answered, cv_attached: cvN };
      const again = findSubmit(); if (again) { again.click(); await wait(3000); }
      if (submittedOK()) return { stopped: "submitted", ats, filled, answered: res.answered, cv_attached: cvN };
      return { stopped: "submit_unconfirmed", ats, filled, answered: res.answered, reason: "clicked submit; confirmation not detected — verify", cv_attached: cvN };
    } catch (e) {
      return { stopped: "failed", error: String((e && e.message) || e) };
    }
  };
})();
