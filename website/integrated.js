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

  const SPEEDS = {
    slow:   { min: 90000, rand: 90000, label: "~90–180s between submits (safest)" },
    normal: { min: 45000, rand: 75000, label: "~45–120s between submits" },
    fast:   { min: 15000, rand: 25000, label: "~15–40s between submits (higher risk)" },
  };
  const getSpeed = () => localStorage.getItem("jaa_speed") || "normal";

  let status = {}, busy = false, lastRunAt = 0, browserVisible = false, browserLoaded = false;
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

  /* ---------- inject UI ---------- */
  function injectUI() {
    const tab = document.getElementById("tab-autoapply");
    if (!tab || document.getElementById("aa-ib-bar")) return true;
    const head = tab.querySelector(".aa-page-head");

    const style = document.createElement("style");
    style.textContent = `
      #aa-ib-bar .aa-ib-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      #aa-ib-bar .aa-ib-adv{margin-top:8px;font-size:12px;color:#6b7280}
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
      '</div>' +
      '<div id="aa-ib-host" class="aa-ib-host"></div>' +
      '<div id="aa-ib-log" class="aa-ib-log"></div>';
    if (head && head.nextSibling) head.parentNode.insertBefore(bar, head.nextSibling);
    else tab.insertBefore(bar, tab.firstChild);

    document.getElementById("aa-ib-integrated").onclick = () => setMode("integrated");
    document.getElementById("aa-ib-system").onclick = () => setMode("system");
    document.getElementById("aa-ib-signin").onclick = async () => {
      await showBrowser();
      logLine("Opening LinkedIn sign-in.");
      await navigate("https://www.linkedin.com/login").catch((e) => logLine(String(e), "err"));
    };
    document.getElementById("aa-ib-toggleview").onclick = () => (browserVisible ? hideBrowser() : showBrowser());

    const sp = document.getElementById("aa-ib-speed");
    sp.value = getSpeed();
    sp.onchange = () => { localStorage.setItem("jaa_speed", sp.value); updateSpeedNote(); };
    updateSpeedNote();
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
  async function refresh() {
    try { status = await api("/applications/auto-apply/status"); } catch { return; }
    const mode = status.browser_mode || "system";
    const i = document.getElementById("aa-ib-integrated"), s = document.getElementById("aa-ib-system");
    if (i && s) { i.classList.toggle("active", mode === "integrated"); s.classList.toggle("active", mode === "system"); }
    setIBStatus(mode === "integrated" ? (status.enabled ? "Integrated · running" : "Integrated · idle") : "System · the extension drives auto-apply");
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
  async function runApply(next) {
    const ad = window.JAA_pickAdapter(next.url, next.platform);
    logLine("Applying · " + ad.id + " · " + (next.url || ""));
    await showBrowser();
    await navigate(next.url); await sleep(6000);
    await invoke("browser_inject", { files: ad.files });
    let r;
    if (ad.autofill) {
      r = await runEval("(async()=>{ const j=window.__jaaExtractJob?window.__jaaExtractJob():null; const a=window.JAA_Autofill?await window.JAA_Autofill.fillAll():{filled:0,total:0}; return {stopped:'ready_to_submit', filled:a.filled||0, job:j}; })()");
    } else {
      const autoSub = ad.id === "successfactors" ? !!status.portal_auto_submit : true;
      const fn = ad.apply;
      r = await runEval("(async()=>{ const j=window.__jaaExtractJob?window.__jaaExtractJob():null; const rr=window." + fn + "?await window." + fn + "({autoSubmit:" + autoSub + ", applicationId:" + next.id + "}):{error:'engine not loaded'}; return Object.assign({}, rr, {job:j}); })()");
    }
    if (isCaptcha(r)) {
      logLine("Security check detected — pausing auto-apply.", "err");
      await api("/applications/auto-apply/toggle", { method: "POST", body: JSON.stringify({ enabled: false }) }).catch(() => {});
      await report(next, r, "failed", "Security check — paused"); return;
    }
    await reportApply(next, r);
  }
  async function reportApply(next, r) {
    const meta = { job_title: r.job ? r.job.job_title : null, company: r.job ? r.job.company : null, filled: r.filled || 0, cv_used: r.cv_used || null, answers: (r.answered || []).map((a) => ({ label: a.label, value: a.value })) };
    let stat = "failed", reason = r.error || r.stopped || "unknown";
    if (r.stopped === "submitted") { stat = "applied"; reason = null; }
    else if (r.stopped === "submit_unconfirmed") { stat = "applied"; reason = "submitted (confirmation not detected — verify)"; }
    else if (["needs_review", "required_field_blank", "validation_error", "ready_to_submit", "needs_account"].indexOf(r.stopped) >= 0) { stat = "needs_review"; reason = r.reason || r.stopped; }
    await api("/applications/" + next.id + "/auto-result", { method: "POST", body: JSON.stringify(Object.assign({}, meta, { status: stat, reason })) });
    logLine("→ " + stat + (reason ? " (" + reason + ")" : "") + " · " + meta.filled + " fields", stat === "applied" ? "ok" : stat === "needs_review" ? "warn" : "err");
  }
  async function report(next, r, stat, reason) {
    const meta = { job_title: r.job ? r.job.job_title : null, company: r.job ? r.job.company : null, filled: r.filled || 0 };
    await api("/applications/" + next.id + "/auto-result", { method: "POST", body: JSON.stringify(Object.assign({}, meta, { status: stat, reason })) }).catch(() => {});
  }
  async function runHarvest(next) {
    const ad = window.JAA_pickAdapter(next.url, next.platform);
    logLine("Harvesting · " + ad.id + " · " + (next.url || ""));
    await showBrowser();
    await navigate(next.url); await sleep(4000);
    await invoke("browser_inject", { files: ad.files });
    const call = ad.id === "successfactors"
      ? "window.__jaaSFHarvest? await window.__jaaSFHarvest('',25):{error:'no harvest'}"
      : "window.__jaaHarvestJobs? await window.__jaaHarvestJobs(25):{error:'no harvest'}";
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
    const minGap = next.task === "harvest" ? 8000 : next.task === "session" ? 8000 : sp.min + Math.floor(Math.random() * sp.rand);
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
    await listen("browser-loaded", (e) => {
      browserLoaded = true;
      if (navResolve) { const f = navResolve; navResolve = null; f(e.payload); }
      if (browserVisible) revealBrowser();
    });
    await listen("jaa-run-finished", (e) => { const p = e.payload || {}; const f = pendingRun.get(p.nonce); if (f) { pendingRun.delete(p.nonce); f(p); } });
    await listen("jaa-progress", (e) => { const p = e.payload || {}; setIBStatus("Step " + (p.step || "") + " · " + (p.filled || 0) + " filled"); });
    await refresh();
    heartbeat();
    setInterval(tick, 4000);
    setInterval(heartbeat, 15000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
