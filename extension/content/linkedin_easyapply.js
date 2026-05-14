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
    const r = await chrome.runtime.sendMessage({
      type: "API_POST", path: "/questions/match",
      body: { text, top_k: 1, min_score: 0.30 },
    });
    if (r?.ok && r.data.matches?.length) {
      const m = r.data.matches[0];
      const a = (m.answers || [])[0];
      return a?.answer || null;
    }
    return null;
  }
  async function draftQuestion(text, applicationId) {
    const r = await chrome.runtime.sendMessage({
      type: "API_POST", path: "/questions/draft",
      body: { text, application_id: applicationId, save: true },
    });
    return r?.ok ? r.data.answer : null;
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
  async function fillTextInputs(modal, ctx) {
    const inputs = $all("input, textarea", modal).filter(visible);
    const ttSelects = $all("select", modal).filter(visible);
    const results = { filled: 0, missing: [], required_blank: [] };

    for (const el of [...inputs, ...ttSelects]) {
      if (el.disabled || el.readOnly) continue;
      if (el.type === "hidden" || el.type === "file") continue;
      if (el.type === "radio" || el.type === "checkbox") continue;
      if (el.value && el.value.length > 1) continue;     // don't clobber existing

      const label = labelOf(el);
      if (!label) continue;

      // 1. Direct profile match
      let val = profileLookup(label, ctx.profile);
      // 2. Question library match
      if (!val) val = await matchQuestion(label);
      // 3. AI draft (only for textareas / long inputs — shorter inputs left blank)
      const isLong = el.tagName === "TEXTAREA" || (el.maxLength === -1 || el.maxLength > 100);
      if (!val && isLong) {
        val = await draftQuestion(label, ctx.applicationId);
      }

      if (val !== null && val !== undefined && String(val).length > 0) {
        if (setVal(el, val)) results.filled++;
      } else {
        // Mark required-but-empty for the banner
        const required = el.required || el.getAttribute("aria-required") === "true";
        if (required) results.required_blank.push(label.slice(0, 80));
        else results.missing.push(label.slice(0, 80));
      }
    }
    return results;
  }

  async function fillRadioGroups(modal, ctx) {
    // Each fieldset / radio group: find the group label and pick a sensible option
    const groups = new Map();
    $all("input[type='radio']", modal).filter(visible).forEach(r => {
      const groupName = r.name || r.closest("fieldset")?.querySelector("legend")?.innerText || "";
      const key = groupName || labelOf(r);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    let filled = 0;
    for (const [name, radios] of groups) {
      if (radios.some(r => r.checked)) continue;   // already answered
      const wrap = radios[0].closest("fieldset, [class*='form-element']");
      const label = (wrap?.querySelector("legend, label, [class*='label']")?.innerText || name || "").trim();
      let pick = null;

      // Yes/No: try profile + question library + heuristic
      if (looksLikeYesNo(label)) {
        let want = preferYes(label);
        if (!want) {
          const saved = await matchQuestion(label);
          if (saved) want = /^yes/i.test(saved.trim()) ? "Yes" : (/^no/i.test(saved.trim()) ? "No" : null);
        }
        if (want) pick = radios.find(r => {
          const labText = labelOf(r).toLowerCase();
          return labText === want.toLowerCase() || labText.startsWith(want.toLowerCase());
        });
      }

      if (pick) {
        pick.click();
        pick.dispatchEvent(new Event("change", { bubbles: true }));
        filled++;
      }
    }
    return filled;
  }

  async function pickFirstResume(modal) {
    // Resume step: LinkedIn lists previously-uploaded resumes; click the first selectable
    const radios = $all("input[type='radio'][name*='resume'], input[type='radio'][value*='resume']", modal);
    if (radios[0] && !radios[0].checked) {
      radios[0].click();
      return true;
    }
    // Alternatively, click "Choose existing" cards
    const cards = $all(".jobs-resume-picker__resume, [data-test-resume-card]", modal);
    if (cards[0] && !cards[0].classList.contains("active")) {
      cards[0].click();
      return true;
    }
    return false;
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

  /* ------------ Main driver ------------ */
  window.__jaaRunEasyApply = async function (options = {}) {
    const result = { steps: 0, filled: 0, blanks: [], stopped: null };

    // 1. Verify we're on a LinkedIn job page
    if (!/linkedin\.com\/jobs/.test(location.href)) {
      return { error: "Not on a LinkedIn job page." };
    }

    // 2. Already in the modal? Otherwise click Easy Apply
    let modal = getModal();
    if (!modal) {
      // Wait briefly for the button to appear (right-pane might still be loading)
      let ea = null;
      try {
        ea = await waitFor(() => findEasyApplyButton(), "Easy Apply button", 4000);
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
      ea.click();
      try {
        modal = await waitFor(() => getModal(), "Easy Apply modal", 7000);
      } catch (e) {
        return { error: "Easy Apply modal didn't open. The job may require external apply, or LinkedIn is showing a captcha." };
      }
    }
    await wait(400);

    // 3. Resolve job metadata once + log analyzed-or-applied row
    let job = null;
    let applicationId = options.applicationId || null;
    if (window.__jaaExtractJob) {
      const j = window.__jaaExtractJob();
      if (j) job = j;
    }
    if (!applicationId && job) {
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

    const profile = await getProfile();
    const ctx = { profile, applicationId };

    // 4. Walk steps until Submit appears
    showBanner(modal, "<span>● Filling Easy Apply…</span>");

    for (let step = 0; step < 12; step++) {
      modal = getModal();
      if (!modal) { result.stopped = "modal_closed"; break; }
      const heading = getStepHeading(modal);
      log("step", step, "heading:", heading);

      // Resume step — pick existing
      if (/resume|cv/i.test(heading)) {
        await pickFirstResume(modal);
      }
      // Fill text inputs + selects
      const fr = await fillTextInputs(modal, ctx);
      result.filled += fr.filled;
      // Fill radio groups
      const rfilled = await fillRadioGroups(modal, ctx);
      result.filled += rfilled;
      // Track blanks
      if (fr.required_blank.length) result.blanks.push(...fr.required_blank);

      await wait(300);

      // Find Next / Review / Submit
      const { btn, kind } = findNextButton(modal);
      if (!btn) {
        showBanner(modal, "Couldn't find Next or Submit button. Please continue manually.", "warn");
        result.stopped = "no_next_button";
        break;
      }
      if (kind === "submit") {
        // STOP — leave the Submit button for the user
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
      try {
        const before = heading;
        await waitFor(() => {
          const m = getModal();
          if (!m) return true;
          const h = getStepHeading(m);
          return h && h !== before;
        }, "next step", 8000);
      } catch {
        // Sometimes the same heading carries over with new content — give it a moment
        await wait(800);
      }
      result.steps = step + 1;
    }

    return result;
  };
})();
