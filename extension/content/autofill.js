/*
 * Shared autofill engine — included by Greenhouse and Lever content scripts.
 * Maps common label keywords to profile fields and fills them.
 */
window.JAA_Autofill = (function () {
  const FIELD_MAP = [
    { keys: ["first name", "given name"], src: "first_name" },
    { keys: ["last name", "family name", "surname"], src: "last_name" },
    { keys: ["full name", "your name", "name"], src: "full_name" },
    { keys: ["email"], src: "email" },
    { keys: ["phone", "mobile", "telephone"], src: "phone" },
    { keys: ["city"], src: "city" },
    { keys: ["country"], src: "country" },
    { keys: ["linkedin", "linked in"], src: "linkedin_url" },
    { keys: ["github"], src: "github_url" },
    { keys: ["portfolio", "website", "personal site"], src: "portfolio_url" },
    { keys: ["current company", "company name"], src: "current_company" },
    { keys: ["current title", "current position", "job title"], src: "current_title" },
    { keys: ["years of experience", "years experience"], src: "years_experience" },
    { keys: ["work authorization", "right to work", "authorized to work"], src: "work_authorization" },
    { keys: ["salary expectation", "expected salary", "compensation"], src: "salary_expectation" },
    { keys: ["notice period"], src: "notice_period" },
  ];

  function labelTextFor(input) {
    // Try multiple strategies to find the visible label for an input.
    if (input.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lab) return lab.innerText.trim();
    }
    const wrap = input.closest("label, .field, .form-group, .application--question, .input-block, div");
    if (wrap) {
      const lab = wrap.querySelector("label, legend, .text, .application-label");
      if (lab) return lab.innerText.trim();
    }
    return input.placeholder || input.name || "";
  }

  function matchField(label) {
    const l = (label || "").toLowerCase();
    for (const m of FIELD_MAP) {
      if (m.keys.some(k => l.includes(k))) return m.src;
    }
    return null;
  }

  function setValue(el, value) {
    if (value === undefined || value === null || value === "") return;
    const v = String(value);
    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find(o =>
        o.text.toLowerCase().includes(v.toLowerCase()) ||
        o.value.toLowerCase().includes(v.toLowerCase())
      );
      if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
    } else {
      // React/Vue need the native setter to fire correctly
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter ? setter.call(el, v) : (el.value = v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  async function getProfile() {
    const resp = await chrome.runtime.sendMessage({ type: "API_GET", path: "/profile/" });
    return resp?.ok ? resp.data : {};
  }

  async function fillAll() {
    const profile = await getProfile();
    if (!profile || Object.keys(profile).length === 0) {
      alert("No profile yet — upload a CV in the dashboard first.");
      return { filled: 0 };
    }
    const inputs = Array.from(document.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea, select'
    ));
    let filled = 0;
    for (const el of inputs) {
      if (el.disabled || el.readOnly) continue;
      const label = labelTextFor(el);
      const key = matchField(label);
      if (!key) continue;
      if (el.value && el.value.length > 1) continue;     // don't clobber existing answers
      const val = profile[key];
      if (val) { setValue(el, val); filled++; }
    }
    return { filled };
  }

  return { fillAll, getProfile };
})();
