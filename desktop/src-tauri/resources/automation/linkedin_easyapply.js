/*
 * LinkedIn Easy Apply guided submit.
 *
 * Exposes window.__jaaRunEasyApply() called by the side panel.
 *
 * IMPORTANT design choice: this is GUIDED, not unattended. It walks every
 * step of the Easy Apply modal, fills all the fields it can, then STOPS
 * at the final "Submit application" button so the user reviews and clicks
 * Submit themselves. This avoids LinkedIn's anti-automation enforcement
 * and keeps quality high on screening questions.
 */
(function () {
  if (window.__jaaEasyApplyLoaded) return;
  window.__jaaEasyApplyLoaded = true;

  const TIMEOUT_MS = 14000;          // max wait per step
  const STEP_POLL_MS = 220;          // DOM poll interval
  const log = (...a) => console.debug("[JAA/easyapply]", ...a);

  /* ------------ DOM helpers ------------ */
  function $(sel, root = document) { return root.querySelector(sel); }
  function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function waitFor(predicate, label = "", timeout = TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        try {
          const v = predicate();
          if (v) return resolve(v);
        } catch {}
        if (Date.now() - start > timeout) return reject(new Error(`Timeout waiting for: ${label}`));
        setTimeout(tick, STEP_POLL_MS);
      };
      tick();
    });
  }

  function getModal() {
    return (
      document.querySelector(".jobs-easy-apply-modal") ||
      document.querySelector("[data-test-modal][aria-labelledby*='easy-apply']") ||
      document.querySelector("div[role='dialog'][aria-labelledby*='jobs-apply']") ||
      document.querySelector("div[role='dialog']")
    );
  }

  function getModalContent(modal) {
    return modal?.querySelector(".jobs-easy-apply-modal__content, .artdeco-modal__content, [class*='content']") || modal;
  }

  function getStepHeading(modal) {
    const h = modal?.querySelector("h3, h2") || modal?.querySelector("[class*='heading']");
    return (h?.innerText || "").trim();
  }

  /* ------------ Native value setter (React-safe) ------------ */
  function setVal(el, value) {
    if (value === undefined || value === null) return false;
    const v = String(value);
    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find(o =>
        o.text.toLowerCase() === v.toLowerCase() ||
        o.text.toLowerCase().includes(v.toLowerCase()) ||
        (o.value || "").toLowerCase() === v.toLowerCase()
      );
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (el.type === "checkbox" || el.type === "radio") {
      // Don't touch directly — handled in radio/checkbox path
      return false;
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  /* ------------ Value sanitization ------------ */
  function sanitizeForInput(val, inputType, maxLength) {
    if (val === null || val === undefined) return val;
    let v = String(val).trim();
    if (inputType === "number") {
      // AI sometimes answers "5 years" / "ca. 3" — extract the first number
      const m = v.match(/-?\d+([.,]\d+)?/);
      if (!m) return null;
      v = m[0].replace(",", ".");
      // LinkedIn numeric fields usually want whole numbers
      if (/^\d+\.0*$/.test(v)) v = String(parseInt(v, 10));
    }
    if (maxLength && v.length > maxLength) v = v.slice(0, maxLength);
    return v;
  }

  /* ------------ Typeahead / combobox (City, Location, …) ------------ */
  function isTypeahead(el) {
    if (el.tagName !== "INPUT") return false;
    return el.getAttribute("role") === "combobox" ||
           el.getAttribute("aria-autocomplete") === "list" ||
           el.getAttribute("aria-expanded") !== null ||
           !!el.getAttribute("aria-controls") ||
           /search-typeahead|basic-typeahead|typeahead/i.test(el.className || "") ||
           // Field label says "location/city" — LinkedIn always makes these typeaheads
           /\b(location|city|stadt|ort)\b/i.test(labelOf(el) || "") ||
           !!el.closest("[data-test-single-typeahead-entity-form-component], .search-basic-typeahead, [class*='typeahead']");
  }

  function typeaheadOptions(el) {
    // Options can live in a listbox referenced by aria-controls, or globally.
    const controlled = el.getAttribute("aria-controls");
    let opts = [];
    if (controlled) {
      const box = document.getElementById(controlled);
      if (box) opts = $all("[role='option'], li", box);
    }
    if (!opts.length) {
      opts = $all(
        "[role='listbox'] [role='option'], [role='option'], " +
        ".basic-typeahead__triggered-content li, .basic-typeahead__selectable, " +
        ".search-typeahead-v2__hit, ul[class*='typeahead'] li, [class*='typeahead'] [role='option']"
      );
    }
    return opts.filter(visible).filter(o => (o.innerText || "").trim().length > 1);
  }

  async function fillTypeahead(el, value) {
    // 1. Focus + simulate real typing so LinkedIn opens the suggestion list.
    el.focus();
    el.click();
    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    // Clear first
    if (setter) setter.call(el, ""); else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    const v = String(value);
    // Type char-by-char with key events — LinkedIn's React typeahead listens to these
    for (let i = 1; i <= v.length; i++) {
      const partial = v.slice(0, i);
      if (setter) setter.call(el, partial); else el.value = partial;
      const ch = v[i - 1];
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await wait(40 + Math.random() * 50);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));

    // 2. Wait for the suggestion list to populate.
    let options = [];
    try {
      options = await waitFor(() => {
        const o = typeaheadOptions(el);
        return o.length ? o : null;
      }, "typeahead options", 4000);
    } catch { /* no dropdown appeared */ }

    // 3. Pick the best match (prefer one containing the typed value) and commit it.
    if (options && options.length) {
      const vl = v.toLowerCase();
      const best = options.find(o => (o.innerText || "").toLowerCase().startsWith(vl)) ||
                   options.find(o => (o.innerText || "").toLowerCase().includes(vl)) ||
                   options[0];
      best.scrollIntoView({ block: "nearest" });
      await wait(120);
      // Click the option (mousedown+click — some lists commit on mousedown)
      best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      best.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      best.click();
      await wait(300);
      return true;
    }

    // 4. No dropdown — fall back to Enter (some typeaheads accept the raw text)
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    await wait(200);
    return true;
  }

  /* ------------ Required checkboxes (consents, terms) ------------ */
  function tickRequiredCheckboxes(modal) {
    let ticked = 0;
    $all("input[type='checkbox']", modal).filter(visible).forEach(cb => {
      if (cb.checked) return;
      const required = cb.required || cb.getAttribute("aria-required") === "true" ||
        !!cb.closest("fieldset")?.querySelector("[class*='required']");
      const label = labelOf(cb).toLowerCase();
      const isConsent = /\b(agree|consent|terms|privacy|policy|acknowledge|confirm|zustimm|datenschutz|einverstanden)\b/i.test(label);
      // Only auto-tick when it's clearly a required consent — never marketing opt-ins
      const isMarketing = /\b(newsletter|updates|marketing|promotional|news)\b/i.test(label);
      if (required && isConsent && !isMarketing) {
        cb.click();
        cb.dispatchEvent(new Event("change", { bubbles: true }));
        ticked++;
        log("ticked required consent:", label.slice(0, 60));
      }
    });
    return ticked;
  }

  /* ------------ Inline validation errors ------------ */
  function getValidationErrors(modal) {
    return $all(
      ".artdeco-inline-feedback--error .artdeco-inline-feedback__message, " +
      ".artdeco-inline-feedback__message, [data-test-form-element-error-messages] *, " +
      ".fb-dash-form-element-error, [role='alert']", modal)
      .filter(visible)
      .map(e => (e.innerText || "").trim())
      .filter(t => t && t.length > 2 && t.length < 200);
  }

  function reportProgress(step, filled, note) {
    try {
      chrome.runtime.sendMessage({
        type: "EASYAPPLY_PROGRESS",
        step, filled, note: note || "",
      });
    } catch {}
  }

  /* ------------ Label discovery ------------ */
  function labelOf(el) {
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
    // LinkedIn wraps each question in a "fb-dash-form-element" or similar div
    const wrap = el.closest("fieldset, .fb-dash-form-element, .artdeco-text-input, .jobs-easy-apply-form-section, label, div");
    if (wrap) {
      const lab = wrap.querySelector("label, legend, [class*='label'], [class*='question'], span[data-test-text-selectable-option]");
      if (lab && lab.innerText.trim().length > 2) return lab.innerText.trim();
    }
    return el.placeholder || el.name || "";
  }

  /* ------------ Profile + answer cache ------------ */
  async function getProfile() {
    const r = await chrome.runtime.sendMessage({ type: "API_GET", path: "/profile/" });
    return r?.ok ? r.data : {};
  }
  async function matchQuestion(text) {
    // Used for radio Yes/No probe — looks up previous default answer
    const r = await chrome.runtime.sendMessage({
      type: "API_POST", path: "/questions/match",
      body: { text, top_k: 1, min_score: 0.30 },
    });
    if (r?.ok && r.data.matches?.length) {
      const m = r.data.matches[0];
      const a = (m.answers || []).find(x => x.is_default) || (m.answers || [])[0];
      return a?.answer || null;
    }
    return null;
  }
  async function typedAnswer({ text, inputType, maxLength, options, applicationId }) {
    const r = await chrome.runtime.sendMessage({
      type: "API_POST", path: "/questions/answer-for-form",
      body: {
        text, input_type: inputType, max_length: maxLength,
        options: options || null,
        application_id: applicationId, save: true,
      },
    });
    if (!r?.ok) {
      console.error("[JAA/easyapply] typedAnswer API error:", r?.error);
      return null;
    }
    return r.data;
  }

  /* ------------ Profile → field heuristics ------------ */
  const PROFILE_KEYS = [
    { match: /first ?name|vorname/i, src: "first_name" },
    { match: /last ?name|family|nachname|surname/i, src: "last_name" },
    { match: /\b(full ?)?name\b/i, src: "full_name" },
    { match: /email/i, src: "email" },
    { match: /phone|mobile|telephone|telefon|rufnummer/i, src: "phone" },
    { match: /linkedin/i, src: "linkedin_url" },
    { match: /github/i, src: "github_url" },
    { match: /portfolio|website|webseite/i, src: "portfolio_url" },
    { match: /current company|company name|arbeitgeber/i, src: "current_company" },
    { match: /current (title|position|role)|job title|jobtitel|berufsbezeichnung/i, src: "current_title" },
    { match: /years? of experience|years? experience|berufserfahrung/i, src: "years_experience" },
    { match: /city|stadt|ort|wohnort/i, src: "city" },
    { match: /country|land/i, src: "country" },
    { match: /salary expectation|expected salary|gehaltsvorstellung|wunschgehalt/i, src: "salary_expectation" },
    { match: /notice period|kündigungsfrist|available from|verfügbar/i, src: "notice_period" },
    { match: /work auth|right to work|sponsorship|visa|arbeitserlaubnis/i, src: "work_authorization" },
  ];

  function profileLookup(label, profile) {
    for (const m of PROFILE_KEYS) {
      if (m.match.test(label)) return profile[m.src];
    }
    return null;
  }

  /* ------------ Yes/No radio detection ------------ */
  function looksLikeYesNo(label) {
    return /\b(do you|are you|have you|can you|will you|would you|haben sie|sind sie)\b/i.test(label)
        || /\b(yes\/no)\b/i.test(label);
  }
  function preferYes(label) {
    // Sensible defaults — ALL must be verified by user before Submit
    if (/legally authorized|authorized to work|work authorization|eligible to work/i.test(label)) return "Yes";
    if (/sponsor|require sponsorship|need sponsorship/i.test(label)) return "No";
    if (/willing to (commute|relocate|work)/i.test(label)) return "Yes";
    if (/over 18|at least 18|adult/i.test(label)) return "Yes";
    return null;
  }

  /* ------------ Step navigation ------------ */
  function findNextButton(modal) {
    const buttons = $all("button, footer button, [role='button']", modal);
    // Priority: Submit (final) — Review — Next — Continue
    const pattern = [/submit application/i, /\breview\b/i, /\bnext\b/i, /\bcontinue\b/i];
    for (const re of pattern) {
      const btn = buttons.find(b => visible(b) && re.test(b.innerText || b.getAttribute("aria-label") || ""));
      if (btn) return { btn, kind: re === pattern[0] ? "submit" : re === pattern[1] ? "review" : "next" };
    }
    return { btn: null, kind: null };
  }

  function findReviewBanner(modal) {
    const text = (modal?.innerText || "").toLowerCase();
    return text.includes("review your application") || text.includes("application submitted");
  }

  function findEasyApplyButton() {
    // Easy Apply can be a <button>, <a>, or [role=button]. Sometimes the visible
    // text is just "Apply" with the LinkedIn icon and "Easy Apply" lives only
    // in aria-label or a nested span. Filter chips on search pages say
    // "N Easy Apply" — exclude those.
    const candidates = $all(
      "button, a[role='button'], [role='button'], a.jobs-apply-button, " +
      "button.jobs-apply-button, .jobs-apply-button button, " +
      "[data-control-name*='apply'], [data-test*='apply']"
    );
    const matches = candidates.filter(el => {
      if (!visible(el)) return false;
      const t = (el.innerText || el.textContent || "").trim();
      const aria = el.getAttribute("aria-label") || "";
      const dc = el.getAttribute("data-control-name") || "";
      const cls = el.className || "";
      const text = (t + " " + aria + " " + dc + " " + cls).toLowerCase();
      // Skip filter chips like "1,247 Easy Apply"
      if (/\d[\d,.]*\s+easy apply/i.test(t)) return false;
      // Skip the "Save" / "Share" buttons even if they appear near apply
      if (/\b(save|share|unsave|saved)\b/i.test(t) && !/apply/i.test(text)) return false;
      // Skip "Continue applying" / "Applied" status badges
      if (/applied/i.test(t) && !/apply/i.test(t.replace(/applied/gi, ""))) return false;
      // Positive matches
      if (/easy apply/i.test(text)) return true;
      // Some markup only says "Apply" but has the LinkedIn easy-apply class
      if (/jobs-apply-button|jobs-s-apply/.test(cls) && /apply/i.test(text)) return true;
      // data-control-name="jobdetails_topcard_inapply" is the classic Easy Apply hook
      if (/inapply|easy_apply|jobs_easy_apply/i.test(dc)) return true;
      return false;
    });
    return matches[0] || null;
  }

  /* ------------ Field fillers ------------ */
  function detectInputType(el) {
    // v0.6.1 — robust numeric detection across LinkedIn DOM variants
    if (el.tagName === "TEXTAREA") return "textarea";
    if (el.tagName === "SELECT") return "select";
    const t = (el.type || "").toLowerCase();
    if (t === "number") return "number";
    if (t === "tel") return "text";

    // 1. The QUESTION LABEL is the most reliable signal — "Wie viele Jahre" etc. always = number
    const labelTxt = (labelOf(el) || "").toLowerCase();
    if (/(wie viele jahre|how many years|years?\s+of\s+experience|jahre\s+erfahrung)/i.test(labelTxt)) {
      return "number";
    }
    if (/(rate yourself|skala von|scale of|out of \d+|von 1 bis \d+|from 1 to \d+|on a scale)/i.test(labelTxt)) {
      return "number";
    }

    // 2. Walk up to 6 ancestors looking for numeric validation copy ANYWHERE inside
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const txt = (node.innerText || node.textContent || "").toLowerCase();
      if (/(whole zahl|ganze zahl|whole number|integer|number between|zahl zwischen|0 und 99|0 and 99|enter a (whole )?number)/i.test(txt)) {
        return "number";
      }
      node = node.parentElement;
    }

    // 3. Adjacent siblings (validation message often follows the input)
    const wrap = el.closest(".fb-dash-form-element, .jobs-easy-apply-form-element, fieldset, .artdeco-text-input") || el.parentElement;
    if (wrap) {
      const wrapTxt = (wrap.innerText || wrap.textContent || "").toLowerCase();
      if (/(whole zahl|ganze zahl|whole number|integer|number between|zahl zwischen)/i.test(wrapTxt)) {
        return "number";
      }
    }

    // 4. Pattern attribute that's digit-only
    const patAttr = el.getAttribute("pattern") || "";
    if (/\d/.test(patAttr) && !/[a-z]/i.test(patAttr)) return "number";

    // 5. aria-describedby pointing to numeric hint
    const describedBy = el.getAttribute("aria-describedby") || "";
    if (describedBy) {
      const note = document.getElementById(describedBy);
      if (note && /(whole zahl|ganze zahl|whole number|integer|zahl zwischen)/i.test(note.innerText || "")) {
        return "number";
      }
    }

    return "text";
  }

  function selectOptionsOf(el) {
    if (el.tagName !== "SELECT") return null;
    return Array.from(el.options)
      .map(o => (o.text || "").trim())
      .filter(t => t && !/^select(\s+an?\s+option)?$/i.test(t));
  }

  async function fillTextInputs(modal, ctx) {
    const inputs = $all("input, textarea, select", modal).filter(visible);
    const results = { filled: 0, missing: [], required_blank: [], answered: [] };

    for (const el of inputs) {
      if (el.disabled || el.readOnly) { log("skip disabled/readonly", el); continue; }
      if (el.type === "hidden" || el.type === "file") { log("skip hidden/file", el.type); continue; }
      if (el.type === "radio" || el.type === "checkbox") continue;
      // Skip prefilled values — but only if they make sense for the field type.
      // A previous buggy build may have pasted a long sentence into a numeric field;
      // clear it so we can refill correctly.
      if (el.value && el.value.length > 1) {
        const inputTypePeek = detectInputType(el);
        const looksBad = (inputTypePeek === "number" && !/^-?\d+(\.\d+)?$/.test(String(el.value).trim()));
        if (looksBad) {
          log("clearing bogus prefilled value on numeric field:", labelOf(el), "had:", el.value);
          const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, ""); else el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          log("skip prefilled", labelOf(el), "=", el.value);
          continue;
        }
      }

      const label = labelOf(el);
      if (!label || label.length < 2) { log("skip no-label", el); continue; }

      const inputType = detectInputType(el);
      const options = selectOptionsOf(el);
      const maxLength = (el.maxLength && el.maxLength > 0) ? el.maxLength : null;
      log("field detected", { label, inputType, maxLength, options });

      // 0. Typeahead fields (City, Location): use profile, commit via dropdown
      if (isTypeahead(el)) {
        const tv = profileLookup(label, ctx.profile);
        if (tv) {
          await fillTypeahead(el, String(tv));
          results.filled++;
          log("✓ typeahead", label, "←", tv);
        } else {
          const required = el.required || el.getAttribute("aria-required") === "true";
          (required ? results.required_blank : results.missing).push(label.slice(0, 80));
        }
        continue;
      }

      // 1. Direct profile match for plain text/textarea ONLY
      let val = null;
      let source = null;
      if (inputType === "text" || inputType === "textarea") {
        val = profileLookup(label, ctx.profile);
        if (val) source = "profile";
      }

      // 1b. Same question already answered this run (LinkedIn repeats fields)
      if ((val === null || val === undefined || val === "") && ctx.answerCache?.has(label)) {
        val = ctx.answerCache.get(label);
        source = "cache";
        log("cache hit", label, "←", val);
      }

      // 2. Type-aware backend answer
      if (val === null || val === undefined || val === "") {
        log("calling /answer-for-form for:", label, "type=", inputType);
        try {
          const r = await typedAnswer({
            text: label, inputType, maxLength, options,
            applicationId: ctx.applicationId,
          });
          log("typed-answer response:", r);
          if (r && r.value !== null && r.value !== undefined && String(r.value).length > 0) {
            val = r.value;
            source = "ai";
            ctx.answerCache?.set(label, r.value);
            results.answered.push({ label, value: r.value, needs_review: r.needs_review, qid: r.question_id });
          } else if (!r) {
            log("typed-answer FAILED — likely backend error. Check backend logs.");
            results.api_errors = (results.api_errors || 0) + 1;
          }
        } catch (e) {
          console.error("[JAA/easyapply] typed-answer threw", e);
          results.api_errors = (results.api_errors || 0) + 1;
        }
      }

      val = sanitizeForInput(val, inputType, maxLength);
      if (val !== null && val !== undefined && String(val).length > 0) {
        const ok = setVal(el, val);
        if (ok) {
          results.filled++;
          log("✓ filled", label, "←", val, `(${source})`);
        } else {
          log("✗ setVal failed", label, "value=", val);
        }
      } else {
        const required = el.required || el.getAttribute("aria-required") === "true";
        if (required) results.required_blank.push(label.slice(0, 80));
        else results.missing.push(label.slice(0, 80));
      }
    }
    log("step fill summary", results);
    return results;
  }

  // The visible text of a single radio OPTION (e.g. "Yes"), not the question.
  function radioOptionText(r) {
    if (r.id) {
      const l = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
      if (l && l.innerText.trim()) return l.innerText.trim();
    }
    const lab = r.closest("label");
    if (lab && lab.innerText.trim()) return lab.innerText.trim();
    return (r.value || r.getAttribute("aria-label") || "").trim();
  }

  // For diversity / EEO questions, prefer a neutral "decline" option over guessing.
  function eeoDecline(radios) {
    return radios.find(r => /decline|prefer not|not (to )?(say|disclose|answer)|don'?t wish/i.test(radioOptionText(r)));
  }

  async function fillRadioGroups(modal, ctx) {
    // Group radios by `name` (fallback to fieldset legend / label).
    const groups = new Map();
    $all("input[type='radio']", modal).filter(visible).forEach(r => {
      const key = r.name || r.closest("fieldset")?.querySelector("legend")?.innerText || labelOf(r) || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    const out = { filled: 0, answered: [], required_blank: [] };
    for (const [name, radios] of groups) {
      if (radios.some(r => r.checked)) continue;                 // already answered
      const wrap = radios[0].closest("fieldset, [class*='form-element']");
      const legend = wrap?.querySelector("legend, [class*='label'], [class*='question']");
      const label = ((legend?.innerText || name || "").trim().split("\n")[0] || "").trim();
      if (/resume|^cv\b|lebenslauf/i.test(label + " " + name)) continue;   // resume handled elsewhere
      const opts = radios.map(radioOptionText).filter(Boolean);
      const required = (wrap && /\*|required|erforderlich|pflicht/i.test(wrap.innerText || ""))
        || radios.some(r => r.required || r.getAttribute("aria-required") === "true");

      // Diversity / EEO — don't guess: decline if possible, else leave for review.
      if (/gender|\bsex\b|race|ethnic|hispanic|latino|veteran|disab|sexual orientation|lgbt|pronoun/i.test(label)) {
        const dec = eeoDecline(radios);
        if (dec) { dec.click(); dec.dispatchEvent(new Event("change", { bubbles: true })); out.filled++; out.answered.push({ label, value: radioOptionText(dec), needs_review: true }); }
        else if (required) out.required_blank.push(label.slice(0, 80));
        continue;
      }

      // Resolve a value: fast heuristic -> saved answer bank -> LLM (with the real options).
      let want = preferYes(label), needsReview = false, qid = null;
      if (!want) { const saved = await matchQuestion(label); if (saved) want = saved; }
      if (!want) {
        const ans = await typedAnswer({ text: label, inputType: "radio", options: opts, applicationId: ctx.applicationId });
        if (ans && ans.value != null && String(ans.value).length) { want = String(ans.value); needsReview = !!ans.needs_review; qid = ans.question_id; }
      }
      if (!want) { if (required) out.required_blank.push(label.slice(0, 80)); continue; }

      // Match the chosen value to one of the radio options.
      const wl = want.toLowerCase();
      const pick =
        radios.find(r => radioOptionText(r).toLowerCase() === wl) ||
        radios.find(r => { const t = radioOptionText(r).toLowerCase(); return t && (t.startsWith(wl) || wl.startsWith(t)); }) ||
        radios.find(r => { const t = radioOptionText(r).toLowerCase(); return t && (t.includes(wl) || wl.includes(t)); });

      if (pick) {
        pick.click();
        pick.dispatchEvent(new Event("change", { bubbles: true }));
        out.filled++;
        out.answered.push({ label, value: radioOptionText(pick) || want, needs_review: needsReview, qid });
      } else if (required) {
        out.required_blank.push(label.slice(0, 80));
      }
    }
    return out;
  }

  async function pickFirstResume(modal) {
    // Resume step: LinkedIn lists previously-uploaded resumes; click the first selectable.
    // Returns the visible name of the resume that ends up selected (or null).
    const radios = $all("input[type='radio'][name*='resume'], input[type='radio'][value*='resume']", modal);
    if (radios[0] && !radios[0].checked) radios[0].click();
    const cards = $all(".jobs-resume-picker__resume, [data-test-resume-card], .jobs-document-upload-redesign-card__container", modal);
    if (!radios.length && cards[0] && !cards[0].classList.contains("active")) cards[0].click();
    await wait(250);
    // Read the selected resume's filename
    const sel = modal.querySelector(
      "input[type='radio'][name*='resume']:checked, " +
      ".jobs-resume-picker__resume--selected, [data-test-resume-card].active, " +
      ".jobs-document-upload-redesign-card__container--selected");
    const wrap = sel?.closest("label, .jobs-resume-picker__resume, [data-test-resume-card], .jobs-document-upload-redesign-card__container") || sel;
    const name = (wrap?.innerText || "").split("\n").find(l => /\.(pdf|docx?)\b/i.test(l) || l.trim().length > 3);
    return name ? name.trim().slice(0, 120) : null;
  }

  /* ------------ Banner ------------ */
  function showBanner(modal, html, kind = "info") {
    let banner = modal.querySelector(".jaa-easyapply-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "jaa-easyapply-banner";
      banner.style.cssText = `
        position: sticky; top: 0; z-index: 999;
        background: ${kind === "warn" ? "#fef3c7" : kind === "err" ? "#fee2e2" : "#dbeafe"};
        color: ${kind === "warn" ? "#92400e" : kind === "err" ? "#991b1b" : "#1e40af"};
        padding: 10px 14px; font: 600 13px/1.5 -apple-system, system-ui, sans-serif;
        border-radius: 8px; margin: 8px 12px 0;
      `;
      modal.insertBefore(banner, modal.firstChild);
    }
    banner.innerHTML = html;
  }

  function highlightFields(modal, labels) {
    if (!labels.length) return;
    $all("input, textarea, select", modal).forEach(el => {
      const lab = labelOf(el);
      if (labels.some(l => lab.includes(l))) {
        el.style.outline = "2px solid #f59e0b";
        el.style.outlineOffset = "2px";
      }
    });
  }

  /* ------------ Harvest: collect Easy-Apply job links from a search page ------------ */
  window.__jaaHarvestJobs = async function (maxJobs = 25) {
    if (!/linkedin\.com\/jobs\/(search|collections)/.test(location.href)) {
      // A /jobs/view url with currentJobId still has the list pane — allow it
      if (!document.querySelector(".scaffold-layout__list, .jobs-search-results-list")) {
        return { error: "Not a LinkedIn job search page." };
      }
    }
    const found = new Map();   // id -> url
    const listPane = document.querySelector(
      ".scaffold-layout__list, .jobs-search-results-list, .jobs-search-results-list__list");

    function collect() {
      $all("a[href*='/jobs/view/']").forEach(a => {
        const m = a.href.match(/\/jobs\/view\/(\d+)/);
        if (!m) return;
        const card = a.closest("li, .job-card-container, .jobs-search-results__list-item");
        const txt = (card?.innerText || "").toLowerCase();
        // Easy Apply only (search may include external-apply jobs even with the filter)
        if (card && !/easy apply|easy-apply/i.test(txt)) return;
        const id = m[1];
        if (!found.has(id)) found.set(id, `https://www.linkedin.com/jobs/view/${id}/`);
      });
    }

    // Scroll the list to lazy-load more cards
    collect();
    for (let i = 0; i < 12 && found.size < maxJobs; i++) {
      if (listPane) listPane.scrollBy(0, 800);
      else window.scrollBy(0, 800);
      await wait(700);
      collect();
    }
    // Try paginating once if we still want more
    const nextPage = document.querySelector("button[aria-label='View next page'], .jobs-search-pagination__button--next");
    if (found.size < maxJobs && nextPage && visible(nextPage)) {
      nextPage.click();
      await wait(2500);
      collect();
    }
    return { urls: Array.from(found.values()).slice(0, maxJobs) };
  };

  /* ------------ Human-ish pacing helpers ------------ */
  const rnd = (min, max) => min + Math.random() * (max - min);
  async function humanPause(min, max) { await wait(Math.round(rnd(min, max))); }
  async function humanScroll(el) {
    // A few small, uneven scroll nudges like a person skimming
    const target = el || document.scrollingElement;
    const steps = Math.round(rnd(2, 4));
    for (let i = 0; i < steps; i++) { target.scrollBy(0, rnd(120, 360)); await wait(rnd(180, 500)); }
  }

  /* ------------ Same-tab sequential apply on a search results page ------------
   * Walks the job cards in the left results list, clicks each, applies in the
   * right pane — one real session, one tab, human-like pacing. Returns a result
   * array the background worker records. NOTE: pacing reduces but does NOT
   * eliminate LinkedIn's ability to detect automation.
   */
  window.__jaaRunSearchSequential = async function (options = {}) {
    const maxJobs = options.max || 10;
    if (!document.querySelector(".scaffold-layout__list, .jobs-search-results-list")) {
      return { error: "Not on a LinkedIn job search results page." };
    }
    const results = [];
    const seen = new Set();

    function cardList() {
      return $all("li.scaffold-layout__list-item, li.jobs-search-results__list-item, .job-card-container--clickable")
        .filter(visible);
    }

    let idx = 0;
    while (results.length < maxJobs) {
      const cards = cardList();
      if (idx >= cards.length) {
        // Try to load more by scrolling the list, then re-collect
        const pane = document.querySelector(".scaffold-layout__list, .jobs-search-results-list");
        if (pane) { pane.scrollBy(0, 1200); await wait(1500); }
        const grown = cardList();
        if (grown.length <= cards.length) break;     // no more jobs
        continue;
      }
      const card = cards[idx++];
      const link = card.querySelector("a[href*='/jobs/view/']");
      const id = (link?.href.match(/\/jobs\/view\/(\d+)/) || [])[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // Easy Apply only
      if (!/easy apply/i.test(card.innerText || "")) continue;

      // Grab the title/company off the card itself (reliable even if the detail
      // pane extractor returns null on a search page).
      const cardTitle = (card.querySelector(
        ".job-card-list__title, .job-card-container__link span[aria-hidden='true'], " +
        "a.job-card-container__link, .artdeco-entity-lockup__title")?.innerText || "").trim().split("\n")[0];
      const cardCompany = (card.querySelector(
        ".job-card-container__primary-description, .artdeco-entity-lockup__subtitle, " +
        ".job-card-container__company-name")?.innerText || "").trim().split("\n")[0];

      // Behave like a person: scroll the card into view, pause to "read"
      card.scrollIntoView({ block: "center" });
      await humanPause(500, 1200);
      (link || card).click();
      await humanPause(1500, 3000);            // read the job

      // Skip jobs that apply on an external site — don't waste an attempt or log a failure.
      const hasEasy = !!findEasyApplyButton();
      const hasExternal = $all("button, a").some(b => visible(b) &&
        /^\s*apply\b/i.test((b.innerText || "").trim()) && !/easy apply/i.test(b.innerText));
      if (!hasEasy && hasExternal) {
        log("skip external-apply job", id);
        try { chrome.runtime.sendMessage({ type: "EASYAPPLY_PROGRESS",
          step: results.length, filled: 0, note: "skipped (external apply) · " + id }); } catch {}
        await humanPause(2000, 4000);
        continue;
      }

      // Apply in the right pane (reuse the full guided/auto driver, no extra logging)
      let r;
      try {
        r = await window.__jaaRunEasyApply({ autoSubmit: options.autoSubmit, noLog: true });
      } catch (e) {
        r = { error: e.message };
      }
      // External-apply detected inside the driver → skip, not fail
      if (/external site|external apply/i.test(r.error || "")) {
        await humanPause(1500, 3000);
        continue;
      }
      const job = r.job || {};
      const status =
        r.stopped === "submitted" ? "applied" :
        (r.stopped === "needs_review" || r.stopped === "required_field_blank" || r.stopped === "validation_error") ? "needs_review" :
        "failed";
      results.push({
        url: link?.href?.split("?")[0] || (id ? `https://www.linkedin.com/jobs/view/${id}/` : null),
        job_title: job.job_title || cardTitle || null, company: job.company || cardCompany || null,
        status, filled: r.filled || 0, cv_used: r.cv_used || null,
        answers: (r.answered || []).map(a => ({ label: a.label, value: a.value })),
        reason: status === "applied" ? null : (r.error || r.stopped || "unknown"),
      });

      try {
        chrome.runtime.sendMessage({ type: "EASYAPPLY_PROGRESS",
          step: results.length, filled: r.filled || 0,
          note: `${status} · ${job.job_title || id}` });
      } catch {}

      // Captcha / checkpoint? Stop the whole run immediately.
      if (r.error === "captcha" ||
          /\/checkpoint\/|\/challenge|captcha|security verification|security check|unusual activity/i
            .test(document.body.innerText + " " + location.href)) {
        return { results, blocked: true };
      }

      // Human-like gap between applications (longer after a real submit)
      await humanScroll(document.querySelector(".scaffold-layout__list"));
      if (status === "applied") await humanPause(30000, 75000);
      else await humanPause(6000, 14000);
    }
    return { results };
  };

  /* ------------ Main driver ------------ */
  window.__jaaRunEasyApply = async function (options = {}) {
    const result = { steps: 0, filled: 0, blanks: [], stopped: null, api_errors: 0 };

    // 1. Verify we're on a LinkedIn job page
    if (!/linkedin\.com\/jobs/.test(location.href)) {
      return { error: "Not on a LinkedIn job page." };
    }

    // 2. Already in the modal? Otherwise click Easy Apply
    let modal = getModal();
    if (!modal) {
      // Wait for the button to appear — LinkedIn job pages load slowly, especially
      // a fresh tab opened by auto-apply. Be patient (up to ~12s).
      let ea = null;
      try {
        ea = await waitFor(() => findEasyApplyButton(), "Easy Apply button", 12000);
      } catch {
        // On /jobs/search pages, the right pane may not have rendered yet.
        // Try clicking the highlighted job card to force-load the preview.
        const activeCard = document.querySelector(
          ".jobs-search-results-list .jobs-search-results__list-item--active, " +
          ".scaffold-layout__list .jobs-search-results__list-item--active, " +
          ".jobs-search-results__list-item.jobs-search-results-list__list-item--active"
        ) || document.querySelector(".jobs-search-results__list-item");
        if (activeCard) {
          activeCard.click();
          await wait(1200);
          try { ea = await waitFor(() => findEasyApplyButton(), "Easy Apply button (after card click)", 4000); } catch {}
        }
      }
      if (!ea) {
        // Final diagnostic: is this an external "Apply" job?
        const externalApply = Array.from(document.querySelectorAll("button, a"))
          .find(b => visible(b) && /^\s*apply\b/i.test((b.innerText||"").trim()) && !/easy apply/i.test(b.innerText));
        if (externalApply) {
          return { error: "This job uses the company's external website to apply, not LinkedIn Easy Apply. Click 'Apply' on LinkedIn to be taken to the company page, then use Autofill there." };
        }
        return { error: "No Easy Apply button found. Make sure you've clicked into a specific job (not the search results list), and the job actually offers Easy Apply (look for the LinkedIn icon next to 'Easy Apply' on the job card)." };
      }
      // Open the modal — retry the click a few times; LinkedIn sometimes ignores
      // the first programmatic click while the page is still hydrating.
      ea.scrollIntoView({ block: "center" });
      await wait(400);
      for (let attempt = 0; attempt < 3 && !modal; attempt++) {
        const btn = findEasyApplyButton() || ea;
        btn.click();
        try {
          modal = await waitFor(() => getModal(), "Easy Apply modal", 6000);
        } catch { await wait(900); }
      }
      if (!modal) {
        // Distinguish captcha / checkpoint from external-apply
        const bodyTxt = document.body.innerText.toLowerCase();
        const isCheckpoint = /\/checkpoint\/|\/challenge/i.test(location.href) ||
          /security check|captcha|verify you'?re a human|quick security check|unusual activity|are you a human|let'?s confirm/i.test(bodyTxt);
        if (isCheckpoint) {
          return { error: "captcha", message: "LinkedIn is showing a security check. Automation paused — solve it in the browser and let your account rest before resuming." };
        }
        const externalApply = Array.from(document.querySelectorAll("button, a"))
          .find(b => visible(b) && /^\s*apply\b/i.test((b.innerText||"").trim()) && !/easy apply/i.test(b.innerText));
        if (externalApply) {
          return { error: "This job applies on the company's external site, not LinkedIn Easy Apply — skipped." };
        }
        return { error: "Easy Apply modal didn't open after 3 tries (page may have loaded slowly)." };
      }
    }
    await wait(600);

    // 3. Resolve job metadata once + log analyzed-or-applied row
    let job = null;
    let applicationId = options.applicationId || null;
    if (window.__jaaExtractJob) {
      const j = window.__jaaExtractJob();
      if (j) job = j;
    }
    if (!applicationId && job && !options.noLog) {
      try {
        const r = await chrome.runtime.sendMessage({
          type: "API_POST", path: "/applications/log",
          body: {
            job_title: job.job_title, company: job.company,
            url: job.url, source: "linkedin-easyapply",
            fields_filled: 0, status: "analyzed",
          },
        });
        applicationId = r?.data?.id || null;
      } catch {}
    }
    result.job = job;

    const profile = await getProfile();
    const ctx = { profile, applicationId, answerCache: new Map() };

    // 4. Walk steps until Submit appears
    showBanner(modal, "<span>● Filling Easy Apply…</span>");

    for (let step = 0; step < 12; step++) {
      modal = getModal();
      if (!modal) { result.stopped = "modal_closed"; break; }
      const heading = getStepHeading(modal);
      log("step", step, "heading:", heading);

      // Resume step — pick existing + remember which CV was used
      if (/resume|cv/i.test(heading) || modal.querySelector("input[type='radio'][name*='resume'], .jobs-resume-picker__resume")) {
        const cvName = await pickFirstResume(modal);
        if (cvName) result.cv_used = cvName;
      }
      // Fill text inputs + selects
      const fr = await fillTextInputs(modal, ctx);
      result.filled += fr.filled;
      result.api_errors += (fr.api_errors || 0);
      result.answered = (result.answered || []).concat(fr.answered || []);
      // Fill radio groups (Yes/No + multi-option + EEO), with LLM fallback
      const rr = await fillRadioGroups(modal, ctx);
      result.filled += rr.filled;
      result.answered = (result.answered || []).concat(rr.answered || []);
      if (rr.required_blank.length) result.blanks.push(...rr.required_blank);
      // Tick required consent checkboxes (never marketing opt-ins)
      result.filled += tickRequiredCheckboxes(modal);
      reportProgress(step + 1, result.filled, heading);
      // Track blanks
      if (fr.required_blank.length) result.blanks.push(...fr.required_blank);
      // If every field on this step failed via API errors, stop with a clear message
      if ((fr.required_blank.length > 0 || fr.missing.length > 0) && fr.filled === 0 && (fr.api_errors || 0) > 0) {
        showBanner(modal, "Backend error — none of the fields could be answered. Check the side panel for details and verify the backend is running.", "err");
        result.stopped = "backend_error";
        break;
      }

      await wait(300);

      // Find Next / Review / Submit
      const { btn, kind } = findNextButton(modal);
      if (!btn) {
        showBanner(modal, "Couldn't find Next or Submit button. Please continue manually.", "warn");
        result.stopped = "no_next_button";
        break;
      }
      if (kind === "submit") {
        // FULL AUTOMATION: submit only when nothing needs human input
        if (options.autoSubmit) {
          if (result.blanks.length === 0) {
            showBanner(modal, "<b>Submitting application…</b>", "info");
            btn.click();
            // Wait for LinkedIn's confirmation (post-apply dialog / toast)
            let confirmed = false;
            try {
              await waitFor(() => {
                const m = getModal();
                const txt = ((m?.innerText || "") + " " + document.body.innerText.slice(0, 3000)).toLowerCase();
                return txt.includes("application was sent") || txt.includes("application submitted") ||
                       txt.includes("bewerbung wurde gesendet") || !m;
              }, "submit confirmation", 10000);
              confirmed = true;
            } catch {}
            // Dismiss the post-apply modal if present
            try {
              const dismiss = document.querySelector(
                "button[aria-label='Dismiss'], .artdeco-modal__dismiss, button[data-test-modal-close-btn]");
              if (dismiss) dismiss.click();
            } catch {}
            result.stopped = confirmed ? "submitted" : "submit_unconfirmed";
            result.steps = step + 1;
            break;
          }
          // Blanks present — do NOT submit unattended
          result.stopped = "needs_review";
          result.steps = step + 1;
          break;
        }
        // GUIDED (default): leave the Submit button for the user
        let msg = `<b>✓ All fields filled.</b> Review your answers above, then click <b>Submit application</b> when ready.`;
        if (result.blanks.length) {
          msg += `<br/><span style="color:#92400e;font-weight:500">Heads-up: ${result.blanks.length} required field${result.blanks.length===1?"":"s"} need your input (highlighted in yellow).</span>`;
          highlightFields(modal, result.blanks);
          showBanner(modal, msg, "warn");
        } else {
          showBanner(modal, msg, "info");
        }
        result.stopped = "review_ready";
        result.steps = step + 1;
        // Mark application as ready_to_submit so dashboard knows
        if (applicationId) {
          try {
            await chrome.runtime.sendMessage({
              type: "API_POST", path: `/applications/${applicationId}/events`,
              body: { kind: "ready_to_submit", title: `Easy Apply filled (${result.filled} fields, ${result.blanks.length} blanks)`, source: "easyapply" },
            });
          } catch {}
        }
        break;
      }

      // Click Next / Review — but only if no required-blank on THIS step
      if (fr.required_blank.length) {
        showBanner(modal,
          `Step ${step+1}: ${fr.required_blank.length} required answer${fr.required_blank.length===1?"":"s"} needed (highlighted). Fill them, then click Next.`,
          "warn");
        highlightFields(modal, fr.required_blank);
        result.stopped = "required_field_blank";
        break;
      }

      btn.click();
      // Wait for the next step to render (DOM change in modal)
      let advanced = true;
      try {
        const before = heading;
        await waitFor(() => {
          const m = getModal();
          if (!m) return true;
          const h = getStepHeading(m);
          return h && h !== before;
        }, "next step", 8000);
      } catch {
        advanced = false;
        await wait(800);
      }

      // LinkedIn rejected the step? Surface its inline validation errors.
      if (!advanced) {
        const m2 = getModal();
        const errors = m2 ? getValidationErrors(m2) : [];
        if (errors.length) {
          log("validation errors:", errors);
          showBanner(m2,
            `<b>LinkedIn flagged ${errors.length} field${errors.length === 1 ? "" : "s"}:</b><br/>` +
            errors.slice(0, 4).map(e => "• " + e).join("<br/>") +
            `<br/>Fix the highlighted fields, then click Next.`, "err");
          result.stopped = "validation_error";
          result.validation_errors = errors;
          result.steps = step + 1;
          break;
        }
      }
      result.steps = step + 1;
    }

    return result;
  };
})();
