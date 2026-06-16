/*
 * automation.js — the Auto-Apply cockpit + orchestrator. Runs in the trusted
 * "panel" webview. This is a port of the Chrome extension's service-worker
 * auto-apply runner: it polls the backend queue and drives the "browser"
 * webview (navigate → inject engines → run → report), with the same guardrails
 * (enabled toggle, daily cap, 45–120s human-like gap, captcha-abort).
 */
import { invoke } from "https://esm.sh/@tauri-apps/api@2/core";
import { listen } from "https://esm.sh/@tauri-apps/api@2/event";

const $ = (s) => document.querySelector(s);

let BASE = "http://127.0.0.1:8000";
let status = {};
let busy = false;
let lastRunAt = 0;
const pendingRun = new Map();     // nonce -> resolve
let navResolve = null;

/* ---------------- utilities ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg, kind) {
  const el = $("#log");
  const line = document.createElement("div");
  line.className = "log-line" + (kind ? " " + kind : "");
  line.textContent = new Date().toLocaleTimeString() + "  " + msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 300) el.removeChild(el.firstChild);
}
function setAction(t) { $("#current-action").textContent = t || ""; }
function setConn(ok) {
  const d = $("#conn");
  d.className = "dot " + (ok ? "on" : "off");
  d.title = ok ? "Backend connected" : "Backend offline";
}

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json", "X-JAA-Client": "desktop-panel" },
    ...opts,
  });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(d.detail || d.error || ("HTTP " + r.status));
  return d;
}

/* ---------------- boot ---------------- */
async function boot() {
  try { const s = await invoke("backend_status"); if (s && s.url) BASE = s.url; } catch {}

  await listen("browser-loaded", (e) => {
    if (navResolve) { const f = navResolve; navResolve = null; f(e.payload); }
  });
  await listen("jaa-run-finished", (e) => {
    const p = e.payload || {};
    const f = pendingRun.get(p.nonce);
    if (f) { pendingRun.delete(p.nonce); f(p); }
  });
  await listen("jaa-progress", (e) => {
    const p = e.payload || {};
    setAction(`Step ${p.step || ""} · ${p.filled || 0} filled${p.note ? " · " + String(p.note).slice(0, 40) : ""}`);
  });

  wireUI();
  await refresh();
  setInterval(tick, 4000);
}

/* ---------------- status ---------------- */
async function refresh() {
  try { status = await api("/applications/auto-apply/status"); }
  catch { setConn(false); return; }
  setConn(true);
  renderStatus();
}

function renderStatus() {
  $("#stat-applied").textContent = status.applied_today ?? 0;
  $("#stat-cap").textContent = status.daily_cap ?? "–";
  $("#stat-queued-li").textContent = status.queued_linkedin ?? 0;
  $("#stat-queued-portal").textContent = status.queued_portal ?? 0;

  const mode = status.browser_mode || "system";
  $("#mode-integrated").classList.toggle("active", mode === "integrated");
  $("#mode-system").classList.toggle("active", mode === "system");
  $("#mode-note").textContent = mode === "integrated"
    ? "Integrated browser is the active driver."
    : "System browser (extension) is the driver — integrated browser is idle.";

  const run = $("#toggle-run");
  run.textContent = status.enabled ? "Stop auto-apply" : "Start auto-apply";
  run.classList.toggle("on", !!status.enabled);
}

/* ---------------- main tick (port of runAutoApplyTick) ---------------- */
async function tick() {
  await refresh();
  if (busy) return;
  if ((status.browser_mode || "system") !== "integrated") return;   // not our turn
  if (!status.enabled || !status.next) return;

  const next = status.next;
  if (next.task === "apply" && status.cap_reached) return;

  const minGap = next.task === "harvest" ? 8000
    : next.task === "session" ? 8000
    : 45000 + Math.floor(Math.random() * 75000);  // 45–120s between real submits
  if (lastRunAt && Date.now() - lastRunAt < minGap) return;

  busy = true;
  try {
    await api("/applications/auto-apply/heartbeat", {
      method: "POST",
      body: JSON.stringify({ action: (next.task === "harvest" ? "expanding" : "applying") + " · " + (next.url || "").slice(0, 60) }),
    }).catch(() => {});
    if (next.task === "session") await runSession(next);
    else if (next.task === "harvest") await runHarvest(next);
    else await runApply(next);
  } catch (e) {
    log("Run failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    lastRunAt = next.task === "harvest" ? Date.now() - 90000 : Date.now();
    busy = false;
    setAction("");
  }
}

/* ---------------- browser-pane control ---------------- */
async function navigate(url) {
  const p = new Promise((res) => {
    navResolve = res;
    setTimeout(() => { if (navResolve) { navResolve = null; res(null); } }, 30000);
  });
  await invoke("browser_navigate", { url });
  await p;
}

// Eval an async expression in the browser webview and await its result via the
// jaa-run-finished event the bridge emits. `asyncExpr` must evaluate to a Promise.
async function runEval(asyncExpr, timeout = 120000) {
  const nonce = "n" + Math.random().toString(36).slice(2);
  const js =
    "(async function(){ try{ const __r = await (" + asyncExpr + ");" +
    " window.__jaaEmit('jaa-run-finished',{nonce:'" + nonce + "',ok:true,result:__r}); }" +
    " catch(e){ window.__jaaEmit('jaa-run-finished',{nonce:'" + nonce + "',ok:false,error:String(e&&e.message||e)}); } })()";
  const waiter = new Promise((res) => {
    pendingRun.set(nonce, res);
    setTimeout(() => { if (pendingRun.has(nonce)) { pendingRun.delete(nonce); res(null); } }, timeout);
  });
  await invoke("browser_eval", { js });
  const ev = await waiter;
  if (!ev) throw new Error("run timed out");
  if (!ev.ok) throw new Error(ev.error || "run failed");
  return ev.result;
}

function isCaptcha(r) {
  const s = (r && (r.error || r.message)) || "";
  return /captcha|security check|checkpoint|are you a human/i.test(s);
}

/* ---------------- task runners (port of service_worker) ---------------- */
async function runApply(next) {
  const ad = window.JAA_pickAdapter(next.url, next.platform);
  log("Applying · " + ad.id + " · " + (next.url || ""));
  await navigate(next.url);
  await sleep(6000);                       // let the SPA hydrate
  await invoke("browser_inject", { files: ad.files });

  let r;
  if (ad.autofill) {
    r = await runEval(
      "(async()=>{ const j=window.__jaaExtractJob?window.__jaaExtractJob():null;" +
      " const a=window.JAA_Autofill?await window.JAA_Autofill.fillAll():{filled:0,total:0};" +
      " return {stopped:'ready_to_submit', filled:a.filled||0, job:j}; })()"
    );
  } else {
    const autoSub = ad.id === "successfactors" ? !!status.portal_auto_submit : true;
    const fn = ad.apply;
    r = await runEval(
      "(async()=>{ const j=window.__jaaExtractJob?window.__jaaExtractJob():null;" +
      " const rr=window." + fn + "?await window." + fn + "({autoSubmit:" + autoSub + ", applicationId:" + next.id + "}):{error:'engine not loaded'};" +
      " return Object.assign({}, rr, {job:j}); })()"
    );
  }

  if (isCaptcha(r)) {
    log("Security check detected — pausing auto-apply to protect the account.", "err");
    await api("/applications/auto-apply/toggle", { method: "POST", body: JSON.stringify({ enabled: false }) }).catch(() => {});
    await report(next, r, "failed", "Security check — paused");
    return;
  }
  await reportApply(next, r);
}

async function reportApply(next, r) {
  const meta = {
    job_title: r.job ? r.job.job_title : null,
    company: r.job ? r.job.company : null,
    filled: r.filled || 0,
    cv_used: r.cv_used || null,
    answers: (r.answered || []).map((a) => ({ label: a.label, value: a.value })),
  };
  let stat = "failed", reason = r.error || r.stopped || "unknown";
  if (r.stopped === "submitted") { stat = "applied"; reason = null; }
  else if (r.stopped === "submit_unconfirmed") { stat = "applied"; reason = "submitted (confirmation not detected — verify)"; }
  else if (["needs_review", "required_field_blank", "validation_error", "ready_to_submit", "needs_account"].indexOf(r.stopped) >= 0) {
    stat = "needs_review"; reason = r.reason || r.stopped;
  }
  await api("/applications/" + next.id + "/auto-result", {
    method: "POST", body: JSON.stringify(Object.assign({}, meta, { status: stat, reason })),
  });
  log("→ " + stat + (reason ? " (" + reason + ")" : "") + " · " + meta.filled + " fields",
      stat === "applied" ? "ok" : stat === "needs_review" ? "warn" : "err");
}

async function report(next, r, stat, reason) {
  const meta = { job_title: r.job ? r.job.job_title : null, company: r.job ? r.job.company : null, filled: r.filled || 0 };
  await api("/applications/" + next.id + "/auto-result", {
    method: "POST", body: JSON.stringify(Object.assign({}, meta, { status: stat, reason })),
  }).catch(() => {});
}

async function runHarvest(next) {
  const ad = window.JAA_pickAdapter(next.url, next.platform);
  log("Harvesting · " + ad.id + " · " + (next.url || ""));
  await navigate(next.url);
  await sleep(4000);
  await invoke("browser_inject", { files: ad.files });
  const call = ad.id === "successfactors"
    ? "window.__jaaSFHarvest? await window.__jaaSFHarvest('',25):{error:'no harvest'}"
    : "window.__jaaHarvestJobs? await window.__jaaHarvestJobs(25):{error:'no harvest'}";
  const r = await runEval("(async()=>{ return " + call + "; })()", 60000);
  const urls = (r && r.urls) || [];
  await api("/applications/" + next.id + "/expanded", { method: "POST", body: JSON.stringify({ urls }) });
  log("→ found " + urls.length + " jobs", "ok");
}

async function runSession(next) {
  log("Session apply · " + (next.url || ""));
  await navigate(next.url);
  await sleep(6000);
  await invoke("browser_inject", { files: ["linkedin.js", "linkedin_easyapply.js"] });
  const max = Math.max(1, Math.min(next.remaining || 5, 10));
  const r = await runEval(
    "(async()=>{ return window.__jaaRunSearchSequential? await window.__jaaRunSearchSequential({autoSubmit:true, max:" + max + "}):{error:'no sequential runner'}; })()",
    300000
  );
  const results = (r && r.results) || [];
  await api("/applications/auto-apply/session-batch", {
    method: "POST", body: JSON.stringify({ search_id: next.id, results, blocked: !!(r && r.blocked) }),
  });
  log("→ session done · " + results.length + " processed", "ok");
}

/* ---------------- UI wiring ---------------- */
function wireUI() {
  $("#toggle-run").onclick = async () => {
    try { await api("/applications/auto-apply/toggle", { method: "POST", body: JSON.stringify({ enabled: !status.enabled }) }); await refresh(); }
    catch (e) { log(e.message, "err"); }
  };
  $("#mode-integrated").onclick = () => setMode("integrated");
  $("#mode-system").onclick = () => setMode("system");
  $("#btn-signin").onclick = () => { invoke("browser_navigate", { url: "https://www.linkedin.com/login" }); log("Opening LinkedIn sign-in in the browser pane."); };
  $("#btn-dashboard").onclick = () => { invoke("browser_navigate", { url: BASE + "/dashboard/" }); };

  const widths = [320, 380, 460];
  let wi = 1;
  $("#btn-width").onclick = () => { wi = (wi + 1) % widths.length; invoke("browser_set_split", { panelWidth: widths[wi] }).catch(() => {}); };
}

async function setMode(mode) {
  try {
    await api("/settings/", { method: "PUT", body: JSON.stringify({ browser_mode: mode }) });
    await refresh();
    if (mode === "system") { invoke("browser_navigate", { url: BASE + "/dashboard/" }); log("Switched to System browser — the extension drives auto-apply."); }
    else { log("Switched to Integrated browser."); }
  } catch (e) { log(e.message, "err"); }
}

boot();
