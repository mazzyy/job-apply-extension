/*
 * Universal autofill engine.
 * Now exposed as window.JAA_Autofill AND callable via chrome.runtime message.
 * Handles:
 *   - Greenhouse, Lever, Ashby, Workday, and unknown career sites
 *   - iframe-embedded Greenhouse forms (#grnhse_iframe, embedded boards)
 *   - React/Vue controlled inputs (uses native setter)
 *   - Label discovery via 6 strategies
 */
(function () {
  if (window.__jaaAutofillLoaded) return;
  window.__jaaAutofillLoaded = true;

  const FIELD_MAP = [
    { keys: ["first name", "given name", "vorname"], src: "first_name" },
    { keys: ["last name", "family name", "surname", "nachname"], src: "last_name" },
    { keys: ["vor- und nachname", "name (first and last)"], src: "full_name" },
    { keys: ["full name", "your name", "name"], src: "full_name" },
    { keys: ["email", "e-mail", "mail"], src: "email" },
    { keys: ["phone", "mobile", "telephone", "telefon", "tel", "rufnummer"], src: "phone" },
    { keys: ["city", "stadt", "ort", "wohnort"], src: "city" },
    { keys: ["country", "land"], src: "country" },
    // NOTE: street / postal-code intentionally NOT mapped — the profile has no
    // address fields, and filling them with the city name puts wrong data in forms.
    { keys: ["linkedin"], src: "linkedin_url" },
    { keys: ["xing"], src: "linkedin_url" },
    { keys: ["github"], src: "github_url" },
    { keys: ["portfolio", "website", "personal site", "homepage", "webseite"], src: "portfolio_url" },
    { keys: ["current company", "company name", "employer", "arbeitgeber", "unternehmen"], src: "current_company" },
    { keys: ["current title", "current position", "job title", "current role", "jobtitel", "position", "berufsbezeichnung"], src: "current_title" },
    { keys: ["years of experience", "years experience", "berufserfahrung"], src: "years_experience" },
    { keys: ["work authorization", "right to work", "authorized to work", "visa", "arbeitserlaubnis", "aufenthaltsstatus"], src: "work_authorization" },
    { keys: ["salary expectation", "expected salary", "compensation", "gehaltsvorstellung", "wunschgehalt"], src: "salary_expectation" },
    { keys: ["notice period", "kündigungsfrist", "verfügbar ab", "available from", "start date"], src: "notice_period" },
    // --- new in v0.10: 10 extra labels from German + English forms ---
    { keys: ["salutation", "anrede", "title", "title (of nobility)", "form of address", "honorific"], src: "salutation" },
    { keys: ["title of nobility", "nobility title", "adelstitel"], src: "nobility_title" },
    { keys: ["gender", "geschlecht", "sex"], src: "gender" },
    { keys: [
        "authorized to work in the eu", "authorized to work in eu", "eu work authorization",
        "berechtigt in der eu zu arbeiten", "berechtigt in eu zu arbeiten",
        "right to work in the eu", "right to work in eu",
        "legally authorized to work in the eu without visa sponsorship",
        "without visa sponsorship",
      ], src: "eu_work_auth" },
    { keys: ["desired salary range", "salary range", "salary range including currency",
             "gehaltsband", "gehaltsspanne", "wunschgehaltsspanne"], src: "salary_expectation" },
    { keys: ["current designation", "designation", "current job designation"], src: "current_title" },
  ];

  function labelTextFor(input) {
    // 1. aria-labelledby
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const el = document.getElementById(labelledBy);
      if (el) return el.innerText.trim();
    }
    // 2. aria-label
    if (input.getAttribute("aria-label")) return input.getAttribute("aria-label").trim();
    // 3. <label for=id>
    if (input.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lab) return lab.innerText.trim();
    }
    // 4. Closest label ancestor
    const closestLab = input.closest("label");
    if (closestLab) return closestLab.innerText.trim();
    // 5. Wrapping container's label/legend
    const wrap = input.closest(
      ".field, .form-group, .application--question, .input-block, " +
      ".question, .field--group, .form-field, .input-wrapper, div, fieldset"
    );
    if (wrap) {
      const lab = wrap.querySelector("label, legend, .text, .application-label, [class*='label']");
      if (lab && lab !== input) return lab.innerText.trim();
    }
    // 6. Placeholder / name attribute as last resort
    return input.placeholder || input.name || input.id || "";
  }

  function matchField(label) {
    const l = (label || "").toLowerCase();
    for (const m of FIELD_MAP) {
      if (m.keys.some(k => l.includes(k))) return m.src;
    }
    return null;
  }

  function setValue(el, value) {
    if (value === undefined || value === null || value === "") return false;
    const v = String(value);
    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find(o =>
        o.text.toLowerCase().includes(v.toLowerCase()) ||
        (o.value || "").toLowerCase().includes(v.toLowerCase())
      );
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    // Use native setter so React/Vue see the update
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  async function getProfile() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "API_GET", path: "/profile/" });
      return resp?.ok ? (resp.data || {}) : {};
    } catch { return {}; }
  }

  function findInputs(root) {
    const sel = 'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], ' +
                'input[type="search"], input:not([type]), textarea, select';
    const list = Array.from(root.querySelectorAll(sel));
    // Also descend into same-origin iframes (Greenhouse embed)
    root.querySelectorAll("iframe").forEach(f => {
      try {
        const doc = f.contentDocument;
        if (doc) list.push(...doc.querySelectorAll(sel));
      } catch { /* cross-origin, skip */ }
    });
    return list;
  }

  async function fillAll() {
    const profile = await getProfile();
    if (!profile || Object.keys(profile).length === 0) {
      return { filled: 0, error: "No profile yet — upload a CV in the dashboard first." };
    }
    const inputs = findInputs(document);
    let filled = 0, skipped = 0;
    const debug = [];
    for (const el of inputs) {
      if (el.disabled || el.readOnly) continue;
      if (el.type === "hidden") continue;
      if (el.value && el.value.length > 1) { skipped++; continue; }
      const label = labelTextFor(el);
      const key = matchField(label);
      if (!key) { debug.push({ label, key: null }); continue; }
      const val = profile[key];
      if (!val) continue;
      if (setValue(el, val)) {
        filled++;
        debug.push({ label, key, filled: true });
      }
    }
    console.log("[JAA] autofill:", { filled, skipped, inputs: inputs.length, debug });
    return { filled, skipped, total: inputs.length };
  }

  window.JAA_Autofill = { fillAll, getProfile };

  // Allow background to invoke autofill via executeScript message
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "RUN_AUTOFILL") {
      fillAll().then(r => sendResponse({ ok: true, ...r })).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });
})();
