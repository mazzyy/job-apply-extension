/*
 * integrated.js — desktop-only. Adds the integrated-browser controls to the
 * dashboard's Auto-apply tab and runs the in-app auto-apply driver, showing the
 * embedded browser webview as a panel on the right of that tab.
 * No-op in a normal browser / the Chrome extension (no window.__TAURI__).
 */
(function () {
  if (!window.__TAURI__ || !window.__TAURI__.core) return;
  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const BASE = location.origin;
  const JAA_UI_BUILD = "2026-06-16-email-apps"; // shown in the log to confirm what's actually running

  const SPEEDS = {
    slow:   { min: 90000, rand: 90000, label: "~90–180s between submits (safest)" },
    normal: { min: 45000, rand: 75000, label: "~45–120s between submits" },
    fast:   { min: 15000, rand: 25000, label: "~15–40s between submits (higher risk)" },
  };
  const getSpeed = () => localStorage.getItem("jaa_speed") || "normal";

  let status = {}, busy = false, lastRunAt = 0, browserVisible = false, browserLoaded = false, currentManual = null;
  const pendingRun = new Map();
  let navResolve = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function api(p, o = {}) {
    const r = await fetch(BASE + p, { headers: { "Content-Type": "application/json", "X-JAA-Client": "desktop-dashboard" }, ...o });
    const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = { raw: t }; }
    if (!r.ok) throw new Error(d.detail || d.error || ("HTTP " + r.status));
    return d;
  }
  function logLine(msg, kind) {
    const el = document.getElementById("aa-ib-log"); if (!el) return;
    const d = document.createElement("div");
    d.className = "aa-ib-line" + (kind ? " " + kind : "");
    d.textContent = new Date().toLocaleTimeString() + "  " + msg;
    el.appendChild(d); el.scrollTop = el.scrollHeight;
    while (el.children.length > 200) el.removeChild(el.firstChild);
  }
  function setIBStatus(t) { const el = document.getElementById("aa-ib-status"); if (el) el.textContent = t || ""; }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ---------- inject UI ---------- */
  function injectUI() {
    const tab = document.getElementById("tab-autoapply");
    if (!tab || document.getElementById("aa-ib-bar")) return true;
    const head = tab.querySelector(".aa-page-head");

    const style = document.createElement("style");
    style.textContent = `
      #aa-ib-bar .aa-ib-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      #aa-ib-bar .aa-ib-adv{margin-top:8px;font-size:12px;color:#6b7280}
      #aa-ib-bar .aa-ib-tips{margin-top:8px;font-size:11px;color:#6b7280;line-height:1.5}
      #aa-ib-bar .aa-ib-adv select{margin-left:6px}
      .aa-ib-seg{display:inline-flex;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
      .aa-ib-seg button{border:0;background:transparent;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;color:#6b7280}
      .aa-ib-seg button.active{background:linear-gradient(135deg,#818cf8,#a855f7);color:#fff}
      .aa-ib-actions{display:flex;gap:8px;margin-left:auto}
      .aa-ib-host{display:none;position:fixed;top:0;right:0;width:56vw;height:100vh;border-left:1px solid #e5e7eb;background:#0c0e15;z-index:60}
      #aa-ib-bar.on .aa-ib-host{display:block}
      body.aa-ib-open main{padding-right:57vw}
      .aa-ib-spin{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#cbd2e0;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}
      .aa-ib-spin .ring{width:34px;height:34px;border-radius:50%;border:3px solid #2a3042;border-top-color:#a855f7;animation:aaspin 0.8s linear infinite}
      @keyframes aaspin{to{transform:rotate(360deg)}}
      .aa-ib-log{margin-top:10px;max-height:120px;overflow:auto;font:11px/1.5 ui-monospace,Menlo,monospace;color:#9aa0b5}
      .aa-ib-line.ok{color:#16a34a}.aa-ib-line.warn{color:#b45309}.aa-ib-line.err{color:#dc2626}
      #aa-ib-manual .aa-ib-manual-h{font-weight:700;font-size:13px;margin-bottom:8px}
      .aa-ib-mrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid #eef0f5}
      .aa-ib-minfo{display:flex;flex-direction:column;min-width:0}
      .aa-ib-minfo b{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38vw}
      .aa-ib-minfo span{font-size:11px;color:#6b7280}
      .aa-ib-mbtns{display:flex;gap:6px;flex:0 0 auto}
      .aa-ib-mbtns .btn{padding:5px 10px;font-size:12px}
    `;
    document.head.appendChild(style);

    const bar = document.createElement("div");
    bar.className = "card"; bar.id = "aa-ib-bar";
    bar.innerHTML =
      '<div class="aa-ib-row">' +
      '  <div class="aa-ib-seg" title="Which browser applies for you">' +
      '    <button id="aa-ib-integrated" class="active">Integrated browser</button>' +
      '    <button id="aa-ib-system">System (extension)</button>' +
      '  </div>' +
      '  <div class="aa-ib-actions">' +
      '    <button class="btn" id="aa-ib-start">Start</button>' +
      '    <button class="btn secondary" id="aa-ib-signin">Sign in to LinkedIn</button>' +
      '    <button class="btn secondary" id="aa-ib-toggleview">Show browser</button>' +
      '  </div>' +
      '  <span class="muted" id="aa-ib-status"></span>' +
      '</div>' +
      '<div class="aa-ib-row aa-ib-adv">' +
      '  <label>Applying speed' +
      '    <select id="aa-ib-speed">' +
      '      <option value="slow">Slow (safest)</option>' +
      '      <option value="normal">Normal</option>' +
      '      <option value="fast">Fast (higher risk)</option>' +
      '    </select>' +
      '  </label>' +
      '  <span id="aa-ib-speed-note"></span>' +
      '  <label style="margin-left:14px"><input type="checkbox" id="aa-ib-ext"> Auto-submit external portals (Greenhouse/Lever/Ashby/Personio…)</label>' +
      '  <label style="margin-left:14px">Apply to <select id="aa-ib-types"><option value="easy">Easy Apply</option><option value="direct">Direct (external)</option><option value="both">Both</option></select></label>' +
      '</div>' +
      '<div class="aa-ib-row aa-ib-tips">Tips: Sign in first · keep speed Normal · auto-submit covers Greenhouse/Lever/Ashby/Personio (+ SmartRecruiters/Workable/Recruitee) · other portals → Manual queue (Open &amp; assist) · review “needs review” before trusting results.</div>' +
      '<div class="aa-ib-row" id="aa-ib-manualbar" style="display:none">' +
      '  <span id="aa-ib-manualtitle" class="muted"></span>' +
      '  <div class="aa-ib-actions">' +
      '    <button class="btn secondary" id="aa-ib-autofill">Autofill</button>' +
      '    <button class="btn secondary" id="aa-ib-attach">Attach CV</button>' +
      '    <button class="btn" id="aa-ib-applied">Mark applied</button>' +
      '    <button class="btn secondary" id="aa-ib-skip">Skip</button>' +
      '  </div>' +
      '</div>' +
      '<div id="aa-ib-host" class="aa-ib-host"></div>' +
      '<div id="aa-ib-log" class="aa-ib-log"></div>';
    if (head && head.nextSibling) head.parentNode.insertBefore(bar, head.nextSibling);
    else tab.insertBefore(bar, tab.firstChild);

    const mcard = document.createElement("div");
    mcard.className = "card"; mcard.id = "aa-ib-manual"; mcard.style.display = "none";
    bar.after(mcard);

    document.getElementById("aa-ib-autofill").onclick = runAutofill;
    document.getElementById("aa-ib-attach").onclick = attachCV;
    document.getElementById("aa-ib-applied").onclick = () => { if (currentManual) manualResult(currentManual, "applied"); };
    document.getElementById("aa-ib-skip").onclick = () => { if (currentManual) manualResult(currentManual, "skipped"); };

    document.getElementById("aa-ib-integrated").onclick = () => setMode("integrated");
    document.getElementById("aa-ib-system").onclick = () => setMode("system");
    document.getElementById("aa-ib-signin").onclick = async () => {
      await showBrowser();
      logLine("Opening LinkedIn sign-in.");
      await navigate("https://www.linkedin.com/login").catch((e) => logLine(String(e), "err"));
    };
    document.getElementById("aa-ib-toggleview").onclick = () => (browserVisible ? hideBrowser() : showBrowser());
    document.getElementById("aa-ib-start").onclick = toggleEnabled;

    const sp = document.getElementById("aa-ib-speed");
    sp.value = getSpeed();
    sp.onchange = () => { localStorage.setItem("jaa_speed", sp.value); updateSpeedNote(); };
    updateSpeedNote();
    const ext = document.getElementById("aa-ib-ext");
    ext.onchange = async () => {
      try { await api("/settings/", { method: "PUT", body: JSON.stringify({ auto_apply_external: ext.checked }) }); logLine(ext.checked ? "External auto-submit ON — Greenhouse/Lever/Ashby will be applied & submitted automatically." : "External auto-submit OFF.", ext.checked ? "warn" : ""); await refresh(); }
      catch (e) { logLine(e.message, "err"); }
    };
    const jtypes = document.getElementById("aa-ib-types");
    jtypes.onchange = async () => {
      try { await api("/settings/", { method: "PUT", body: JSON.stringify({ apply_types: jtypes.value }) }); logLine("Apply to: " + jtypes.options[jtypes.selectedIndex].text); await refresh(); }
      catch (e) { logLine(e.message, "err"); }
    };
    return true;
  }
  function updateSpeedNote() { const n = document.getElementById("aa-ib-speed-note"); if (n) n.textContent = (SPEEDS[getSpeed()] || SPEEDS.normal).label; }

  /* ---------- show/hide other dashboard cards while browsing ---------- */
  function otherCards(show) {
    const tab = document.getElementById("tab-autoapply"); if (!tab) return;
    [".aa-status-card", ".aa-cols"].forEach((s) => { const e = tab.querySelector(s); if (e) e.style.display = show ? "" : "none"; });
    const logHead = tab.querySelector(".aa-log-head");
    const logCard = logHead && logHead.closest(".card");
    if (logCard) logCard.style.display = show ? "" : "none";
  }

  /* ---------- browser placement + loader ---------- */
  function hostRect() {
    const el = document.getElementById("aa-ib-host"); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function showSpinner(text) {
    const h = document.getElementById("aa-ib-host");
    if (h) h.innerHTML = '<div class="aa-ib-spin"><div class="ring"></div><span>' + (text || "Loading…") + "</span></div>";
  }
  function clearSpinner() { const h = document.getElementById("aa-ib-host"); if (h) h.innerHTML = ""; }

  async function revealBrowser() { clearSpinner(); const rc = hostRect(); if (rc) await invoke("browser_show", rc).catch((e) => logLine(String(e), "err")); }

  async function showBrowser() {
    const bar = document.getElementById("aa-ib-bar"); if (!bar) return;
    bar.classList.add("on"); document.body.classList.add("aa-ib-open"); otherCards(false); browserVisible = true;
    const tv = document.getElementById("aa-ib-toggleview"); if (tv) tv.textContent = "Hide browser";
    await new Promise((r) => requestAnimationFrame(r));
    if (browserLoaded) { await revealBrowser(); }
    else { showSpinner("Starting browser…"); navigate("https://www.linkedin.com/feed/"); }
  }
  async function hideBrowser() {
    browserVisible = false;
    await invoke("browser_hide").catch(() => {});
    const bar = document.getElementById("aa-ib-bar"); if (bar) bar.classList.remove("on");
    document.body.classList.remove("aa-ib-open"); otherCards(true);
    const tv = document.getElementById("aa-ib-toggleview"); if (tv) tv.textContent = "Show browser";
  }
  function syncBounds() { if (!browserVisible || !browserLoaded) return; const rc = hostRect(); if (rc) invoke("browser_set_bounds", rc).catch(() => {}); }
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(syncBounds, 80); });
  setInterval(() => {
    const active = document.getElementById("tab-autoapply") && document.getElementById("tab-autoapply").classList.contains("active");
    if (!active && browserVisible) hideBrowser();
  }, 600);

  /* ---------- mode + status ---------- */
  async function setMode(m) {
    try { await api("/settings/", { method: "PUT", body: JSON.stringify({ browser_mode: m }) }); await refresh(); logLine("Mode → " + m); }
    catch (e) { logLine(e.message, "err"); }
  }
  async function toggleEnabled() {
    try {
      const cap = +((document.getElementById("aa-cap") || {}).value) || 15;
      const mode = ((document.getElementById("aa-mode") || {}).value) || "session";
      const portal = ((document.getElementById("aa-portal-submit") || {}).value) === "1";
      await api("/applications/auto-apply/toggle", { method: "POST", body: JSON.stringify({ enabled: !status.enabled, daily_cap: cap, mode, portal_auto_submit: portal }) });
      await refresh();
      logLine(status.enabled ? "Auto-apply started." : "Auto-apply stopped.");
    } catch (e) { logLine(e.message, "err"); }
  }
  // Explain, in plain words, why nothing is applying right now.
  function idleReason() {
    const mode = status.browser_mode || "system";
    if (mode !== "integrated") return "System mode — the extension applies (not the in-app browser)";
    if (!status.enabled) return "Auto-apply is OFF — press Start";
    if (status.cap_reached) return "Daily cap reached (" + (status.daily_cap || "?") + ")";
    if (!status.next) return "No jobs queued — add jobs above, then Start";
    if (busy) return "Working…";
    const sp = SPEEDS[getSpeed()] || SPEEDS.normal;
    const minGap = (status.next.task === "harvest" || status.next.task === "session") ? 8000 : ((status.next.platform || "") === "linkedin" ? sp.min : 5000);
    const wait = lastRunAt ? Math.max(0, minGap - (Date.now() - lastRunAt)) : 0;
    if (wait > 1500) return "Next " + status.next.task + " in ~" + Math.ceil(wait / 1000) + "s";
    return "Ready · next: " + status.next.task;
  }
  async function refresh() {
    try { status = await api("/applications/auto-apply/status"); } catch { setIBStatus("Backend offline"); return; }
    const mode = status.browser_mode || "system";
    const i = document.getElementById("aa-ib-integrated"), s = document.getElementById("aa-ib-system");
    if (i && s) { i.classList.toggle("active", mode === "integrated"); s.classList.toggle("active", mode === "system"); }
    const startBtn = document.getElementById("aa-ib-start");
    if (startBtn) { startBtn.textContent = status.enabled ? "Stop" : "Start"; startBtn.className = status.enabled ? "btn secondary" : "btn"; }
    const ext = document.getElementById("aa-ib-ext"); if (ext) ext.checked = !!status.auto_apply_external;
    const jt = document.getElementById("aa-ib-types"); if (jt) jt.value = status.apply_types || "easy";
    if (!busy) setIBStatus(idleReason());
  }
  // Route "Open job in browser" links to the internal browser when in integrated mode.
  async function onDocClick(e) {
    const el = e.target.closest && e.target.closest("[data-ext]"); if (!el) return;
    if ((status.browser_mode || "system") !== "integrated") return;
    const url = el.getAttribute("data-ext") || "";
    if (!/^https?:\/\//i.test(url)) return;
    // Keep genuine utility links (account pages, docs) in the external browser.
    if (/(myaccount|accounts|calendar)\.google\.com|\.microsoft\.com|\/\/support\.|\/\/docs\./i.test(url)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    logLine("Opening job in the integrated browser…");
    await showBrowser();
    await navigate(url);
  }

  /* ---------- manual apply (assisted) ---------- */
  async function runAutofill() {
    const af = await runEval("(async()=>{ return window.JAA_Autofill ? await window.JAA_Autofill.fillAll() : {filled:0}; })()", 60000).catch(() => null);
    if (af) logLine("Autofilled " + (af.filled || 0) + " field(s)", "ok");
  }
  async function attachCV() {
    const r = await runEval(
      "(async()=>{" +
      " const inputs=[...document.querySelectorAll('input[type=file]')].filter(i=>!i.disabled && i.offsetParent!==null);" +
      " if(!inputs.length) return {attached:0, reason:'no file field on page'};" +
      " const job = window.__jaaExtractJob ? (window.__jaaExtractJob()||{}) : {};" +
      " let cv; try{ cv = await window.__jaaApi('/cvs/best',{method:'POST',body:JSON.stringify({job_description: job.job_description||''})}); }catch(e){ return {attached:0, reason:'best:'+e.message}; }" +
      " if(!cv||!cv.id) return {attached:0, reason:'no cv'};" +
      " let blob; try{ const resp=await fetch(window.__JAA_API_BASE+'/cvs/'+cv.id+'/file'); blob=await resp.blob(); }catch(e){ return {attached:0, reason:'dl:'+e.message}; }" +
      " const file=new File([blob], cv.filename||'cv.pdf', {type: blob.type||'application/pdf'});" +
      " let n=0; for(const inp of inputs){ try{ const dt=new DataTransfer(); dt.items.add(file); inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true})); inp.dispatchEvent(new Event('input',{bubbles:true})); n++; }catch(e){} }" +
      " return {attached:n, cv:cv.label};" +
      "})()", 60000).catch((e) => ({ attached: 0, reason: String(e) }));
    if (r && r.attached) logLine('Attached CV "' + (r.cv || "") + '" to ' + r.attached + " field(s)", "ok");
    else logLine("CV not attached" + (r && r.reason ? " (" + r.reason + ")" : ""), "warn");
  }
  function showManualBar(on) {
    const b = document.getElementById("aa-ib-manualbar"); if (b) b.style.display = on ? "" : "none";
    const t = document.getElementById("aa-ib-manualtitle");
    if (t) t.textContent = on && currentManual ? "Manual: " + (currentManual.job_title || currentManual.url || "") : "";
  }
  async function openManual(job) {
    currentManual = job;
    logLine("Manual: opening " + (job.job_title || job.url));
    await showBrowser();
    await navigate(job.url);
    await sleep(2500);
    const ad = window.JAA_pickAdapter(job.url, job.platform);
    await invoke("browser_inject", { files: ad.files.concat(["question_suggest.js"]) });
    await runAutofill();
    await attachCV();
    showManualBar(true);
    logLine("Review the form (✦ Suggest answer on questions), then click Mark applied.", "warn");
  }
  async function manualResult(job, statusVal) {
    try {
      await api("/applications/" + job.id + "/manual-result", { method: "POST", body: JSON.stringify({ status: statusVal }) });
      logLine((statusVal === "applied" ? "Marked applied: " : "Skipped: ") + (job.job_title || job.url), statusVal === "applied" ? "ok" : "warn");
      if (currentManual && currentManual.id === job.id) { currentManual = null; showManualBar(false); }
      loadManual();
    } catch (e) { logLine(e.message, "err"); }
  }
  async function loadManual() {
    let rows = [];
    try { rows = await api("/applications/manual-queue"); } catch { return; }
    const card = document.getElementById("aa-ib-manual"); if (!card) return;
    if (!rows.length) { card.style.display = "none"; card.innerHTML = ""; return; }
    card.style.display = "";
    const hasATS = rows.some((r) => ["greenhouse", "lever", "ashby"].indexOf(r.platform) >= 0);
    const tip = (hasATS && !status.auto_apply_external)
      ? ' <span style="font-weight:400;color:#b45309">· tip: turn on “Auto-submit external portals” + Start to auto-apply these</span>'
      : "";
    card.innerHTML = '<div class="aa-ib-manual-h">Manual queue (' + rows.length + ') — external portals & forms you submit yourself' + tip + '</div>' +
      rows.map((r) => {
        const t = esc(r.job_title || r.url || "Job");
        const sub = esc([r.company, r.platform, r.status].filter(Boolean).join(" · "));
        return '<div class="aa-ib-mrow" data-id="' + r.id + '">' +
          '<div class="aa-ib-minfo"><b>' + t + '</b><span>' + sub + '</span></div>' +
          '<div class="aa-ib-mbtns"><button class="btn open">Open &amp; assist</button>' +
          '<button class="btn secondary applied">Applied</button>' +
          '<button class="btn secondary skip">Skip</button></div></div>';
      }).join("");
    rows.forEach((r) => {
      const row = card.querySelector('.aa-ib-mrow[data-id="' + r.id + '"]'); if (!row) return;
      row.querySelector(".open").onclick = () => openManual(r);
      row.querySelector(".applied").onclick = () => manualResult(r, "applied");
      row.querySelector(".skip").onclick = () => manualResult(r, "skipped");
    });
  }

  /* ---------- browser-pane control ---------- */
  async function navigate(url) {
    if (browserVisible) { showSpinner("Loading…"); await invoke("browser_hide").catch(() => {}); } // reveal spinner while it loads
    const p = new Promise((res) => { navResolve = res; setTimeout(() => { if (navResolve) { navResolve = null; res(null); } }, 30000); });
    await invoke("browser_navigate", { url });
    await p;
    browserLoaded = true;
    if (browserVisible) await revealBrowser();
  }
  async function runEval(asyncExpr, timeout = 120000) {
    const nonce = "n" + Math.random().toString(36).slice(2);
    const js =
      "(async function(){ try{ const __r = await (" + asyncExpr + ");" +
      " window.__jaaEmit('jaa-run-finished',{nonce:'" + nonce + "',ok:true,result:__r}); }" +
      " catch(e){ window.__jaaEmit('jaa-run-finished',{nonce:'" + nonce + "',ok:false,error:String(e&&e.message||e)}); } })()";
    const waiter = new Promise((res) => { pendingRun.set(nonce, res); setTimeout(() => { if (pendingRun.has(nonce)) { pendingRun.delete(nonce); res(null); } }, timeout); });
    await invoke("browser_eval", { js });
    const ev = await waiter;
    if (!ev) throw new Error("run timed out");
    if (!ev.ok) throw new Error(ev.error || "run failed");
    return ev.result;
  }
  const isCaptcha = (r) => { const s = (r && (r.error || r.message)) || ""; return /captcha|security check|checkpoint|are you a human/i.test(s); };

  /* ---------- task runners ---------- */
  // LinkedIn: Easy Apply in-app, or Direct (external) → click Apply, follow to the
  // company site, run the generic engine there.
  async function runLinkedInJob(next) {
    logLine("Applying · linkedin · " + (next.url || ""));
    await showBrowser();
    await navigate(next.url); await sleep(6000);
    await invoke("browser_inject", { files: ["linkedin.js", "linkedin_easyapply.js"] });
    const det = await runEval("(async()=>{ return window.__jaaDetectApply ? window.__jaaDetectApply() : {type:'none'}; })()", 30000).catch(() => ({ type: "none" }));
    const types = status.apply_types || "easy";

    if (det && det.type === "easy") {
      const r = await runEval("(async()=>{ const j=window.__jaaExtractJob?window.__jaaExtractJob():null; const rr=window.__jaaRunEasyApply?await window.__jaaRunEasyApply({autoSubmit:true, applicationId:" + next.id + "}):{error:'engine not loaded'}; return Object.assign({}, rr, {job:j}); })()", 180000);
      if (isCaptcha(r)) { logLine("Security check — pausing.", "err"); await api("/applications/auto-apply/toggle", { method: "POST", body: JSON.stringify({ enabled: false }) }).catch(() => {}); await report(next, r, "failed", "Security check — paused"); return; }
      await finishExternal(next, r); return;
    }
    if (det && det.type === "direct" && types !== "easy") {
      logLine("Direct apply — opening the company site…");
      const w = new Promise((res) => { navResolve = res; setTimeout(() => { if (navResolve) { navResolve = null; res(null); } }, 25000); });
      await runEval("(async()=>{ return {clicked: !!(window.__jaaClickExternalApply && window.__jaaClickExternalApply())}; })()", 20000).catch(() => {});
      await w; await sleep(4000);
      await invoke("browser_inject", { files: ["autofill.js", "greenhouse.js", "lever.js", "ashby.js", "generic.js", "generic_apply.js"] });
      const r = await runEval("(async()=>{ const j=window.__jaaExtractJob?window.__jaaExtractJob():null; const rr=window.__jaaGenericApply?await window.__jaaGenericApply({autoSubmit:true, applicationId:" + next.id + "}):{error:'engine not loaded'}; return Object.assign({}, rr, {job:j}); })()", 180000);
      if (isCaptcha(r)) { logLine("Security check — pausing.", "err"); await api("/applications/auto-apply/toggle", { method: "POST", body: JSON.stringify({ enabled: false }) }).catch(() => {}); await report(next, r, "failed", "Security check — paused"); return; }
      await finishExternal(next, r); return;
    }
    const reason = (det && det.type === "direct") ? "Direct-apply job skipped (Apply mode = Easy Apply only)" : "No apply option detected on the page";
    await report(next, {}, (det && det.type === "direct") ? "needs_review" : "failed", reason);
    logLine("→ " + reason, "warn");
  }

  async function runApply(next) {
    const ad = window.JAA_pickAdapter(next.url, next.platform);
    if (ad.id === "linkedin") return runLinkedInJob(next);
    logLine("Applying · " + (ad.id || "external") + " · " + (next.url || ""));
    await showBrowser();
    await navigate(next.url); await sleep(6000);
    let r;
    if (ad.id === "successfactors") {
      await invoke("browser_inject", { files: ["autofill.js", "successfactors.js"] });
      const autoSub = !!status.portal_auto_submit;
      r = await runEval("(async()=>{ const j=window.__jaaExtractJob?window.__jaaExtractJob():null; const rr=window.__jaaSFApply?await window.__jaaSFApply({autoSubmit:" + autoSub + ", applicationId:" + next.id + "}):{error:'engine not loaded'}; return Object.assign({}, rr, {job:j}); })()", 180000);
    } else {
      // Any external portal → generic engine: auto-submits supported ATS (Greenhouse/Lever/Ashby/Personio/…), else fills & leaves needs-review.
      await invoke("browser_inject", { files: ["autofill.js", "greenhouse.js", "lever.js", "ashby.js", "generic.js", "generic_apply.js"] });
      r = await runEval("(async()=>{ const j=window.__jaaExtractJob?window.__jaaExtractJob():null; const rr=window.__jaaGenericApply?await window.__jaaGenericApply({autoSubmit:true, applicationId:" + next.id + "}):{error:'engine not loaded'}; return Object.assign({}, rr, {job:j}); })()", 180000);
    }
    if (isCaptcha(r)) {
      logLine("Security check detected — pausing auto-apply.", "err");
      await api("/applications/auto-apply/toggle", { method: "POST", body: JSON.stringify({ enabled: false }) }).catch(() => {});
      await report(next, r, "failed", "Security check — paused"); return;
    }
    await finishExternal(next, r);
  }
  async function reportApply(next, r) {
    const meta = { job_title: r.job ? r.job.job_title : null, company: r.job ? r.job.company : null, filled: r.filled || 0, cv_used: r.cv_used || null, answers: (r.answered || []).map((a) => ({ label: a.label, value: a.value })) };
    let stat = "failed", reason = r.error || r.stopped || "unknown";
    if (r.stopped === "submitted") { stat = "applied"; reason = null; }
    else if (r.stopped === "submit_unconfirmed") { stat = "applied"; reason = "submitted (confirmation not detected — verify)"; }
    else if (["needs_review", "required_field_blank", "validation_error", "ready_to_submit", "needs_account", "needs_input"].indexOf(r.stopped) >= 0) { stat = "needs_review"; reason = r.reason || r.stopped; }
    await api("/applications/" + next.id + "/auto-result", { method: "POST", body: JSON.stringify(Object.assign({}, meta, { status: stat, reason })) });
    logLine("→ " + stat + (reason ? " (" + reason + ")" : "") + " · " + meta.filled + " fields", stat === "applied" ? "ok" : stat === "needs_review" ? "warn" : "err");
  }
  async function report(next, r, stat, reason) {
    const meta = { job_title: r.job ? r.job.job_title : null, company: r.job ? r.job.company : null, filled: r.filled || 0 };
    await api("/applications/" + next.id + "/auto-result", { method: "POST", body: JSON.stringify(Object.assign({}, meta, { status: stat, reason })) }).catch(() => {});
  }

  // Ask the user for fields we couldn't answer; save them to the bank; then fill + submit.
  function promptMissing(missing) {
    return new Promise((resolve) => {
      const bar = document.getElementById("aa-ib-bar"); if (!bar) { resolve(null); return; }
      const prev = document.getElementById("aa-ib-ask"); if (prev) prev.remove();
      const card = document.createElement("div");
      card.id = "aa-ib-ask";
      card.style.cssText = "margin-top:10px;border-top:1px solid #eef0f5;padding-top:10px";
      card.innerHTML =
        '<div style="font-weight:700;font-size:13px;margin-bottom:8px">Answer to finish — saved to your bank for next time</div>' +
        missing.map((m, i) => {
          const id = "aa-ask-" + i;
          let input;
          if ((m.type === "radio" || m.type === "select") && m.options && m.options.length) {
            input = '<select id="' + id + '" class="input" style="width:100%"><option value="">— choose —</option>' + m.options.map((o) => '<option>' + esc(o) + '</option>').join("") + '</select>';
          } else if (m.type === "textarea") {
            input = '<textarea id="' + id + '" class="input" rows="2" style="width:100%"></textarea>';
          } else {
            input = '<input id="' + id + '" class="input" style="width:100%" />';
          }
          return '<div style="margin-bottom:8px"><div style="font-size:12px;margin-bottom:3px">' + esc(m.label) + '</div>' + input + '</div>';
        }).join("") +
        '<div style="display:flex;gap:8px"><button class="btn" id="aa-ask-go">Save &amp; submit</button><button class="btn secondary" id="aa-ask-skip">Skip job</button></div>';
      const log = document.getElementById("aa-ib-log");
      bar.insertBefore(card, log);
      document.getElementById("aa-ask-go").onclick = () => {
        const answers = missing.map((m, i) => ({ label: m.label, value: (document.getElementById("aa-ask-" + i).value || "").trim(), type: m.type, options: m.options || null }));
        card.remove(); resolve(answers);
      };
      document.getElementById("aa-ask-skip").onclick = () => { card.remove(); resolve(null); };
    });
  }

  async function finishExternal(next, r) {
    if (r && r.stopped === "needs_input" && r.missing && r.missing.length) {
      logLine("Needs your input — " + r.missing.length + " field(s). Saving for next time.", "warn");
      const answers = await promptMissing(r.missing);
      if (!answers) { await report(next, r, "needs_review", "Waiting for your answers"); return; }
      for (const a of answers) {
        if (a.value) { try { await api("/questions/save-answer", { method: "POST", body: JSON.stringify({ text: a.label, answer: a.value, answer_type: a.type || "text", options: a.options || null }) }); } catch (e) {} }
      }
      const fillList = answers.filter((a) => a.value).map((a) => ({ label: a.label, value: a.value }));
      await runEval("(async()=>{ return window.__jaaFillAnswers? await window.__jaaFillAnswers(" + JSON.stringify(fillList) + "):0; })()", 60000).catch(() => {});
      const sr = await runEval("(async()=>{ return window.__jaaSubmitForm? await window.__jaaSubmitForm():{stopped:'submit_unconfirmed'}; })()", 120000).catch(() => ({ stopped: "submit_unconfirmed" }));
      await reportApply(next, Object.assign({}, sr, { job: r.job }));
      return;
    }
    await reportApply(next, r);
  }
  async function runHarvest(next) {
    const ad = window.JAA_pickAdapter(next.url, next.platform);
    logLine("Harvesting · " + ad.id + " · " + (next.url || ""));
    await showBrowser();
    await navigate(next.url); await sleep(4000);
    await invoke("browser_inject", { files: ad.files });
    const includeDirect = (status.apply_types || "easy") !== "easy";
    const call = ad.id === "successfactors"
      ? "window.__jaaSFHarvest? await window.__jaaSFHarvest('',25):{error:'no harvest'}"
      : "window.__jaaHarvestJobs? await window.__jaaHarvestJobs(25, " + includeDirect + "):{error:'no harvest'}";
    const r = await runEval("(async()=>{ return " + call + "; })()", 60000);
    const urls = (r && r.urls) || [];
    await api("/applications/" + next.id + "/expanded", { method: "POST", body: JSON.stringify({ urls }) });
    logLine("→ found " + urls.length + " jobs", "ok");
  }
  async function runSession(next) {
    logLine("Session apply · " + (next.url || ""));
    await showBrowser();
    await navigate(next.url); await sleep(6000);
    await invoke("browser_inject", { files: ["linkedin.js", "linkedin_easyapply.js"] });
    const max = Math.max(1, Math.min(next.remaining || 5, 10));
    const r = await runEval("(async()=>{ return window.__jaaRunSearchSequential? await window.__jaaRunSearchSequential({autoSubmit:true, max:" + max + "}):{error:'no sequential runner'}; })()", 300000);
    const results = (r && r.results) || [];
    await api("/applications/auto-apply/session-batch", { method: "POST", body: JSON.stringify({ search_id: next.id, results, blocked: !!(r && r.blocked) }) });
    logLine("→ session done · " + results.length + " processed", "ok");
  }

  /* ---------- main tick ---------- */
  async function tick() {
    await refresh();
    if (busy) return;
    if ((status.browser_mode || "system") !== "integrated") return;
    if (!status.enabled || !status.next) return;
    const next = status.next;
    if (next.task === "apply" && status.cap_reached) return;
    const sp = SPEEDS[getSpeed()] || SPEEDS.normal;
    const isLI = (next.platform || "") === "linkedin";
    const minGap = (next.task === "harvest" || next.task === "session") ? 8000
      : isLI ? sp.min + Math.floor(Math.random() * sp.rand)   // human pacing only for LinkedIn
      : 5000;                                                  // portals: no anti-detection throttle
    if (lastRunAt && Date.now() - lastRunAt < minGap) return;
    busy = true;
    try {
      await api("/applications/auto-apply/heartbeat", { method: "POST", body: JSON.stringify({ action: (next.task === "harvest" ? "expanding" : "applying") + " · " + (next.url || "").slice(0, 60) }) }).catch(() => {});
      if (next.task === "session") await runSession(next);
      else if (next.task === "harvest") await runHarvest(next);
      else await runApply(next);
    } catch (e) { logLine("Run failed: " + (e && e.message ? e.message : e), "err"); }
    finally { lastRunAt = next.task === "harvest" ? Date.now() - 90000 : Date.now(); busy = false; }
  }

  /* ---------- heartbeat so the dashboard shows the in-app driver as connected ---------- */
  async function heartbeat() {
    if ((status.browser_mode || "system") !== "integrated") return;
    await api("/applications/auto-apply/heartbeat", { method: "POST", body: JSON.stringify({ action: busy ? "working" : "integrated idle" }) }).catch(() => {});
  }

  /* ---------- boot ---------- */
  async function boot() {
    for (let i = 0; i < 40 && !injectUI(); i++) await sleep(150);
    logLine("UI build " + JAA_UI_BUILD);
    await listen("browser-loaded", (e) => {
      browserLoaded = true;
      if (navResolve) { const f = navResolve; navResolve = null; f(e.payload); }
      if (browserVisible) revealBrowser();
    });
    await listen("jaa-run-finished", (e) => { const p = e.payload || {}; const f = pendingRun.get(p.nonce); if (f) { pendingRun.delete(p.nonce); f(p); } });
    await listen("jaa-progress", (e) => { const p = e.payload || {}; if (p.note) logLine(p.note); else setIBStatus("Step " + (p.step || "") + " · " + (p.filled || 0) + " filled"); });
    document.addEventListener("click", onDocClick, true);   // capture, so we beat the external-link handler
    await refresh();
    if (status && status.build) logLine(status.build === JAA_UI_BUILD ? "Backend build " + status.build + " ✓ (matches UI)" : "⚠ Backend build " + status.build + " ≠ UI " + JAA_UI_BUILD + " — restart backend / rebuild.", status.build === JAA_UI_BUILD ? "ok" : "warn");
    else logLine("⚠ Backend has no build stamp — it's older than this UI. Restart backend / rebuild.", "warn");
    heartbeat();
    loadManual();
    setInterval(tick, 4000);
    setInterval(heartbeat, 15000);
    setInterval(loadManual, 8000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
