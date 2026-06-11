/*
 * SuccessFactors (SAP) career-portal adapter.
 * Covers employers on SAP SuccessFactors Recruiting — Siemens, Deutsche Telekom/
 * T-Systems, SAP, and most large German/European enterprises.
 *
 * Exposes:
 *   window.__jaaSFHarvest(keyword, max) → { urls } of job links on a search page
 *   window.__jaaSFApply({autoSubmit, applicationId}) → drives one job's apply flow
 *   window.__jaaExtractJob() → job metadata for the side panel
 *
 * Generic best-effort driver: SF instances are heavily themed per employer, so it
 * leans on the shared autofill engine (window.JAA_Autofill) plus SF selectors, and
 * STOPS before final submit unless autoSubmit is set. Account creation uses the
 * stored profile email + reusable portal password.
 */
(function () {
  if (window.__jaaSFLoaded) return;
  window.__jaaSFLoaded = true;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const $ = (s, r = document) => r.querySelector(s);
  const $all = (s, r = document) => Array.from(r.querySelectorAll(s));
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }
  function waitFor(pred, label = "", timeout = 12000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        try { const v = pred(); if (v) return resolve(v); } catch {}
        if (Date.now() - t0 > timeout) return reject(new Error("timeout: " + label));
        setTimeout(tick, 250);
      };
      tick();
    });
  }
  function txt(el) { return (el?.innerText || el?.textContent || "").trim(); }

  async function getProfile() {
    try {
      const r = await chrome.runtime.sendMessage({ type: "API_GET", path: "/profile/?reveal=true" });
      return r?.ok ? (r.data || {}) : {};
    } catch { return {}; }
  }

  function setVal(el, value) {
    if (value == null || value === "") return false;
    const v = String(value);
    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find(o =>
        o.text.toLowerCase().includes(v.toLowerCase()) ||
        (o.value || "").toLowerCase().includes(v.toLowerCase()));
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  window.__jaaExtractJob = function () {
    const title = txt($("h1, .jobTitle, [data-automation-id='jobPostingHeader'], .job-title")) || txt($("h2"));
    const company = $("meta[property='og:site_name']")?.content ||
      location.hostname.replace(/^(www|jobs|careers|career)\./, "").split(".")[0];
    const descEl = $("[data-automation-id='jobPostingDescription'], .jobDescription, .job-description, main, #content") || document.body;
    const description = txt(descEl).slice(0, 12000);
    if (!title || description.length < 120) return null;
    return { job_title: title, company, location: "", job_description: description,
             url: location.href, source: "successfactors" };
  };

  window.__jaaSFHarvest = async function (keyword, max = 25) {
    const found = new Map();
    function collect() {
      $all("a[href*='/job/'], a[href*='jobdetail'], a[href*='requisition'], a.jobTitle-link, a[data-automation-id='jobTitle']")
        .forEach(a => {
          const href = a.href;
          if (!/successfactors|sapsf|\/job\/|jobdetail|requisition/i.test(href)) return;
          const key = href.split("?")[0];
          if (!found.has(key)) found.set(key, href);
        });
    }
    collect();
    for (let i = 0; i < 10 && found.size < max; i++) {
      window.scrollBy(0, 900);
      await wait(rnd(500, 900));
      collect();
      const more = $all("button, a").find(b => visible(b) && /more results|load more|mehr anzeigen|weitere/i.test(txt(b)));
      if (more && found.size < max) { more.click(); await wait(1500); collect(); }
    }
    return { urls: Array.from(found.values()).slice(0, max) };
  };

  async function ensureAccount(profile) {
    const pwFields = $all("input[type='password']").filter(visible);
    const emailField = $all("input[type='email'], input[name*='mail' i], input[id*='mail' i]").filter(visible)[0];
    if (!pwFields.length && !emailField) return { needed: false };
    if (!profile.email || !profile.portal_password) {
      return { needed: true, blocked: "Set your email and a portal password in Profile to let auto-apply create portal accounts." };
    }
    const registerBtn = $all("button, a").find(b => visible(b) &&
      /create account|register|registrieren|konto erstellen|sign up/i.test(txt(b)));
    if (registerBtn) { registerBtn.click(); await wait(1500); }
    const emails = $all("input[type='email'], input[name*='mail' i], input[id*='mail' i]").filter(visible);
    if (emails[0]) setVal(emails[0], profile.email);
    if (emails[1]) setVal(emails[1], profile.email);
    $all("input[type='password']").filter(visible).forEach(p => setVal(p, profile.portal_password));
    return { needed: true, filled: true };
  }

  function findApplyButton() {
    return $all("button, a, [role='button']").find(b => visible(b) &&
      /^\s*(apply|jetzt bewerben|bewerben|apply now|start application)\s*$/i.test(txt(b)));
  }
  function findNextButton() {
    const btns = $all("button, [role='button'], input[type='submit']").filter(visible);
    for (const re of [/submit application|application absenden|bewerbung absenden|submit$/i,
                      /review/i, /next|continue|weiter|save and continue|speichern und weiter/i]) {
      const b = btns.find(x => re.test(txt(x) || x.value || ""));
      if (b) return { btn: b, submit: /submit/.test(re.source) };
    }
    return { btn: null, submit: false };
  }

  window.__jaaSFApply = async function (options = {}) {
    const result = { filled: 0, steps: 0, stopped: null, blanks: [], job: window.__jaaExtractJob() };
    const profile = await getProfile();

    const applyBtn = findApplyButton();
    if (applyBtn) { applyBtn.scrollIntoView({ block: "center" }); await wait(rnd(600, 1200)); applyBtn.click(); await wait(2500); }

    const acct = await ensureAccount(profile);
    if (acct.blocked) { result.stopped = "needs_account"; result.reason = acct.blocked; return result; }
    if (acct.filled) {
      const cont = $all("button").find(b => visible(b) && /continue|weiter|next|submit|create|registrieren/i.test(txt(b)));
      if (cont) { cont.click(); await wait(2500); }
    }

    for (let step = 0; step < 10; step++) {
      result.steps = step + 1;
      await wait(rnd(700, 1400));
      if (window.JAA_Autofill?.fillAll) {
        try { const r = await window.JAA_Autofill.fillAll(); result.filled += (r.filled || 0); } catch {}
      }
      $all("input[type='checkbox']").filter(visible).forEach(cb => {
        if (cb.checked) return;
        const label = txt(cb.closest("label, .sf-checkbox, div")) || "";
        if (/(consent|privacy|datenschutz|agree|einverstanden|terms|processing of my data)/i.test(label) &&
            !/newsletter|marketing/i.test(label)) {
          cb.click(); cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      const blanks = $all("input[required], select[required], textarea[required]")
        .filter(el => visible(el) && !el.value && el.type !== "checkbox" && el.type !== "file")
        .map(el => (el.getAttribute("aria-label") || el.name || el.id || "field"));
      result.blanks = blanks;

      const { btn, submit } = findNextButton();
      if (!btn) { result.stopped = "no_next_button"; break; }
      if (submit) {
        if (options.autoSubmit && blanks.length === 0) {
          btn.scrollIntoView({ block: "center" }); await wait(rnd(800, 1500));
          btn.click();
          let ok = false;
          try {
            await waitFor(() => /application (has been )?submitted|received your application|bewerbung.*(eingegangen|gesendet|erhalten)|thank you for applying/i
              .test(document.body.innerText), "submit confirm", 12000);
            ok = true;
          } catch {}
          result.stopped = ok ? "submitted" : "submit_unconfirmed";
        } else {
          result.stopped = blanks.length ? "needs_review" : "ready_to_submit";
        }
        break;
      }
      if (blanks.length) { result.stopped = "required_field_blank"; break; }
      btn.scrollIntoView({ block: "center" }); await wait(rnd(600, 1100));
      btn.click();
    }
    return result;
  };
})();
