const $ = s => document.querySelector(s);
const $all = s => Array.from(document.querySelectorAll(s));

const API = {
  get base(){
    // When the dashboard is served from FastAPI (Tauri or localhost:8000/dashboard),
    // use the same origin — works regardless of port. Fall back to localStorage
    // override or the default 8000 when opened as a file:// or different origin.
    const fromLocation = (typeof window !== "undefined" && window.location && window.location.protocol.startsWith("http"))
      ? window.location.origin : null;
    return localStorage.getItem("apiBase") || fromLocation || "http://localhost:8000";
  },
  async get(path){ const r = await fetch(this.base+path); if(!r.ok) throw new Error(await r.text()); return r.json(); },
  async post(path, body){
    const r = await fetch(this.base+path, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
    if(!r.ok) throw new Error(await r.text()); return r.json();
  },
  async put(path, body){
    const r = await fetch(this.base+path, { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
    if(!r.ok) throw new Error(await r.text()); return r.json();
  },
  async patch(path, body){
    const r = await fetch(this.base+path, { method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
    if(!r.ok) throw new Error(await r.text()); return r.json();
  },
  async del(path){
    const r = await fetch(this.base+path, { method:"DELETE" });
    if(!r.ok) throw new Error(await r.text()); return r.json();
  },
  async upload(path, formData){
    const r = await fetch(this.base+path, { method:"POST", body: formData });
    if(!r.ok) throw new Error(await r.text()); return r.json();
  },
};

function esc(s){ return (s ?? "").toString().replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

// Reliable vertical bar chart. entries: [{label, value, color?, title?}]
function barsHTML(entries, opts = {}){
  if (!entries.length) return `<div class="muted" style="padding:24px;text-align:center">${esc(opts.empty || "No data yet.")}</div>`;
  const max = Math.max(1, ...entries.map(e => e.value));
  return entries.map(e => {
    const h = Math.round((e.value / max) * 100);
    const col = e.color ? `style="height:${h}%;background:${e.color}"` : `style="height:${h}%"`;
    return `<div class="bucket" title="${esc(e.title || (e.label + ": " + e.value))}">
      <div class="bar-area"><div class="bar" ${col}><span class="bar-val">${esc(e.value)}</span></div></div>
      <label>${esc(e.label)}</label>
    </div>`;
  }).join("");
}
function fitClass(s){ s=+s||0; return s>=80?"good":s>=60?"warn":"bad"; }

// Open a URL in the system browser. In the Tauri desktop app a plain target=_blank
// would navigate the app's own webview; route those through the opener plugin.
async function openExternal(url){
  if (!url) return;
  try {
    const T = window.__TAURI__;
    if (T?.opener?.openUrl) { await T.opener.openUrl(url); return; }
    if (T?.core?.invoke) { await T.core.invoke("plugin:opener|open_url", { url }); return; }
  } catch (e) { /* fall through to window.open */ }
  window.open(url, "_blank", "noopener");
}
// Delegate clicks on any [data-ext] element to openExternal
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-ext]");
  if (el) { e.preventDefault(); openExternal(el.getAttribute("data-ext")); }
});

// Tabs
$all(".sidebar a").forEach(a => a.addEventListener("click", e => {
  e.preventDefault();
  $all(".sidebar a").forEach(x => x.classList.remove("active"));
  $all(".tab").forEach(x => x.classList.remove("active"));
  a.classList.add("active");
  $(`#tab-${a.dataset.tab}`).classList.add("active");
}));

async function checkApi(){
  try {
    const h = await API.get("/health");
    $("#api-status").textContent = `API connected`;
    const verified = h.model_verified;
    const dot = verified ? "●" : "○";
    const color = verified ? "#22c55e" : "#f59e0b";
    $("#model-status").innerHTML = `<span style="color:${color}">${dot}</span> Model: <b>${esc(h.model)}</b>${verified ? "" : " (unverified)"}`;
    const v = $("#verify-info");
    if (v) {
      v.innerHTML = verified
        ? `<span style="color:#16a34a">✓ ${esc(h.model)} verified at ${esc(h.endpoint)}</span><br/>Reply: <code>${esc(h.model_reply || "")}</code>`
        : `<span style="color:#b91c1c">✗ ${esc(h.model_error || "not verified")}</span>`;
    }
  } catch (e) {
    $("#api-status").textContent = "API unreachable — is the backend running?";
    const m = $("#model-status"); if (m) m.textContent = "Model: unreachable";
  }
}

async function loadStats(){
  try {
    const s = await API.get("/applications/stats");
    $("#stat-total").textContent = s.total;
    $("#stat-interview").textContent = s.interview;
    $("#stat-offer").textContent = s.offer;
    $("#stat-avg-fit").textContent = s.avg_fit;

    const fitColors = { "0-39": "#ef4444", "40-59": "#f59e0b", "60-79": "#3b82f6", "80-100": "#22c55e" };
    $("#fit-buckets").innerHTML = barsHTML(
      Object.entries(s.fit_buckets).map(([k,v]) => ({ label: k, value: v, color: fitColors[k] })),
      { empty: "No analyzed jobs yet." });
    $("#by-source").innerHTML = barsHTML(
      Object.entries(s.by_source || {}).map(([k,v]) => ({ label: (k || "other").replace("auto-apply:", "auto·"), value: v })),
      { empty: "No applications yet." });

    // Pipeline funnel — proportional horizontal bars
    const stages = [
      { label: "Analyzed / applied", value: s.total || 0, color: "#6366f1" },
      { label: "Interviewing", value: s.interview || 0, color: "#3b82f6" },
      { label: "Offers", value: s.offer || 0, color: "#22c55e" },
    ];
    const pmax = Math.max(1, ...stages.map(x => x.value));
    const pipe = $("#pipeline");
    if (pipe) pipe.innerHTML = stages.map(st => {
      const pct = Math.round((st.value / pmax) * 100);
      const conv = stages[0].value ? Math.round((st.value / stages[0].value) * 100) : 0;
      return `<div class="pipe-row">
        <div class="pipe-label">${esc(st.label)}</div>
        <div class="pipe-track"><div class="pipe-fill" style="width:${Math.max(pct,3)}%;background:${st.color}"></div></div>
        <div class="pipe-val">${st.value}<span class="pipe-conv">${st.label.startsWith("Analyzed") ? "" : " · " + conv + "%"}</span></div>
      </div>`;
    }).join("");
  } catch {}
}

async function loadApps(){
  const rows = await API.get("/applications/?limit=500").catch(()=>[]);
  window.__apps = rows;
  renderApps();
  // Recent
  $("#recent").innerHTML = rows.slice(0, 6).map(a => `
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9">
      <div>
        <b>${esc(a.job_title || "—")}</b> · ${esc(a.company || "—")}
        <div class="muted">${esc(a.source)} · ${new Date(a.created_at).toLocaleString()}</div>
      </div>
      <div><span class="fit-pill ${fitClass(a.fit_score)}">${Math.round(a.fit_score||0)}</span></div>
    </div>`).join("") || `<div class="muted">Open a job page in the extension to start.</div>`;
}

function renderApps(){
  const q = $("#filter-search").value.toLowerCase();
  const status = $("#filter-status").value;
  const filtered = (window.__apps||[]).filter(a => {
    if (status && a.status !== status) return false;
    if (q && !((a.job_title||"").toLowerCase().includes(q) || (a.company||"").toLowerCase().includes(q))) return false;
    return true;
  });
  $("#apps-body").innerHTML = filtered.map(a => `
    <tr data-id="${a.id}">
      <td>${esc(a.job_title || "—")}</td>
      <td>${esc(a.company || "—")}</td>
      <td>${esc(a.source || "")}</td>
      <td><span class="fit-pill ${fitClass(a.fit_score)}">${Math.round(a.fit_score||0)}</span></td>
      <td>${a.requires_other_language ? `<span class="lang-tag">${esc(a.requires_other_language)}</span>` : `<span class="muted">English</span>`}</td>
      <td>${esc(a.status)}</td>
      <td>${new Date(a.created_at).toLocaleDateString()}</td>
    </tr>`).join("");
  $all("#apps-body tr").forEach(tr => tr.addEventListener("click", () => openApp(+tr.dataset.id)));
  renderBoard();
}
$("#filter-search").addEventListener("input", renderApps);
$("#filter-status").addEventListener("change", renderApps);

const BOARD_COLS = [
  { label: "Applied",             match: (a) => a.status === "applied" },
  { label: "Waiting for response", match: (a) => a.status === "analyzed" },
  { label: "Interview",           match: (a) => a.status === "interview" },
  { label: "Offer",               match: (a) => a.status === "offer" },
  { label: "Rejected",            match: (a) => a.status === "rejected" },
];
function renderBoard(){
  const host = $("#apps-board"); if (!host) return;
  const apps = window.__apps || [];
  host.innerHTML = BOARD_COLS.map(col => {
    const items = apps.filter(col.match);
    return `<div class="board-col"><div class="board-col-h">${col.label}<span class="board-count">${items.length}</span></div>
      <div class="board-cards">${items.map(a => `
        <div class="board-card" data-id="${a.id}">
          <div class="board-card-title">${esc(a.job_title||"—")}</div>
          <div class="board-card-sub">${esc(a.company||"")}</div>
          ${a.interview_at ? `<div class="board-card-date">📅 ${new Date(a.interview_at).toLocaleString([], {dateStyle:"medium", timeStyle:"short"})}</div>` : ""}
        </div>`).join("") || `<div class="board-empty">—</div>`}</div></div>`;
  }).join("");
  host.querySelectorAll(".board-card").forEach(c => c.addEventListener("click", () => openApp(+c.dataset.id)));
}

function toLocalInput(iso){ try{ const d=new Date(iso); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}catch(e){return "";} }
function gcalUrl(a){
  if (!a.interview_at) return "#";
  const start = new Date(a.interview_at), end = new Date(start.getTime()+3600000);
  const fmt = (d)=> d.toISOString().replace(/[-:]/g,"").split(".")[0]+"Z";
  const text = encodeURIComponent("Interview: " + (a.job_title||"") + (a.company? " @ "+a.company : ""));
  const details = encodeURIComponent((a.url||"") + "\n\nvia Job Apply Assistant");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${fmt(start)}/${fmt(end)}&details=${details}`;
}
async function loadCalendar(){
  let rows = []; try { rows = await API.get("/applications/calendar"); } catch {}
  const now = Date.now();
  const sorted = rows.slice().sort((x,y)=> new Date(x.interview_at)-new Date(y.interview_at));
  const up = $("#cal-upcoming");
  if (up) {
    up.innerHTML = `<h3>Upcoming interviews (${sorted.length})</h3>` + (sorted.length ? sorted.map(a => {
      const d = new Date(a.interview_at);
      return `<div class="cal-item ${d.getTime()<now?'past':''}">
        <div><b>${esc(a.job_title||"—")}</b> · ${esc(a.company||"")}</div>
        <div class="muted">${d.toLocaleString([], {weekday:"short", dateStyle:"medium", timeStyle:"short"})}</div>
        <div class="cal-item-actions"><a class="btn" data-ext="${gcalUrl(a)}" href="${gcalUrl(a)}">Add to Google Calendar</a>
        <button class="btn secondary cal-open" data-id="${a.id}">Open</button></div></div>`;
    }).join("") : `<div class="muted">No interview dates yet — they appear automatically when an interview email arrives, or set one on an application.</div>`);
    up.querySelectorAll(".cal-open").forEach(b => b.addEventListener("click", ()=> openApp(+b.dataset.id)));
  }
  const grid = $("#cal-grid");
  if (grid) {
    const t = new Date(), y=t.getFullYear(), m=t.getMonth();
    const startDow = (new Date(y,m,1).getDay()+6)%7, days=new Date(y,m+1,0).getDate();
    const byDay = {};
    rows.forEach(a => { const d=new Date(a.interview_at); if(d.getFullYear()===y&&d.getMonth()===m){(byDay[d.getDate()]=byDay[d.getDate()]||[]).push(a);} });
    let cells = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=>`<div class="cal-dow">${d}</div>`).join("");
    for(let i=0;i<startDow;i++) cells += `<div class="cal-cell empty"></div>`;
    for(let day=1; day<=days; day++){
      const items = byDay[day]||[];
      cells += `<div class="cal-cell ${day===t.getDate()?'today':''}"><div class="cal-daynum">${day}</div>${items.map(a=>`<div class="cal-ev" data-id="${a.id}" title="${esc((a.job_title||'')+' @ '+(a.company||''))}">${esc((a.company||a.job_title||'').slice(0,14))}</div>`).join("")}</div>`;
    }
    grid.innerHTML = `<h3 style="margin:18px 0 8px">${new Date(y,m,1).toLocaleString([], {month:"long", year:"numeric"})}</h3><div class="cal-month">${cells}</div>`;
    grid.querySelectorAll(".cal-ev").forEach(b => b.addEventListener("click", ()=> openApp(+b.dataset.id)));
  }
}

async function openApp(id){
  const a = await API.get(`/applications/${id}`);
  $("#app-detail-body").innerHTML = `
    <h2 style="margin-top:0">${esc(a.job_title || "—")} <span style="font-weight:400;color:#6b7280">at ${esc(a.company || "—")}</span></h2>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      <span class="fit-pill ${fitClass(a.fit_score)}">${Math.round(a.fit_score||0)} / 100</span>
      <span class="muted">${esc(a.source)} · ${new Date(a.created_at).toLocaleString()}</span>
      ${a.requires_other_language ? `<span class="lang-tag">${esc(a.requires_other_language)} required</span>` : ""}
    </div>
    <p>${esc(a.verdict || "")}</p>
    ${a.notes ? `<div style="background:#f5f3ff;border:1px solid #e9e3ff;border-radius:8px;padding:8px 10px;margin:8px 0;font-size:13px"><b>Notes / latest response</b><br>${esc(a.notes).replace(/\n/g,"<br>")}</div>` : ""}
    <h3>Strengths</h3><ul>${(a.strengths||[]).map(s=>`<li>${esc(s)}</li>`).join("")||"<li>—</li>"}</ul>
    <h3>Gaps</h3><ul>${(a.gaps||[]).map(s=>`<li>${esc(s)}</li>`).join("")||"<li>—</li>"}</ul>
    <h3>Recommendations</h3><ul>${(a.recommendations||[]).map(s=>`<li>${esc(s)}</li>`).join("")||"<li>—</li>"}</ul>

    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
      <button data-status="applied">Mark applied</button>
      <button data-status="interview">Interviewing</button>
      <button data-status="offer">Got offer</button>
      <button class="danger" data-status="rejected">Rejected</button>
      <button class="secondary" id="close-dlg">Close</button>
      <button class="danger" id="del-app">Delete</button>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap">
      <label class="muted" style="font-size:13px">Interview date
        <input type="datetime-local" id="iv-date" value="${a.interview_at ? toLocalInput(a.interview_at) : ""}" />
      </label>
      <button class="secondary" id="iv-save">Save date</button>
      ${a.interview_at ? `<a class="btn" data-ext="${gcalUrl(a)}" href="${gcalUrl(a)}">Add to Google Calendar</a>` : ""}
    </div>
    ${a.url ? `<p class="muted" style="margin-top:14px"><a href="#" data-ext="${esc(a.url)}">Open original job posting →</a></p>` : ""}
  `;
  $("#app-detail").showModal();
  $all("#app-detail-body button[data-status]").forEach(b => b.addEventListener("click", async (e) => {
    e.preventDefault();
    await API.patch(`/applications/${a.id}`, { status: b.dataset.status });
    $("#app-detail").close();
    await Promise.all([loadStats(), loadApps()]);
  }));
  $("#iv-save")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const v = $("#iv-date").value;
    await API.patch(`/applications/${a.id}`, { interview_at: v ? v : "" });
    $("#app-detail").close();
    await Promise.all([loadApps(), loadCalendar()]);
  });
  $("#close-dlg").addEventListener("click", () => $("#app-detail").close());
  $("#del-app").addEventListener("click", async (e) => {
    e.preventDefault();
    if (!confirm("Delete this record?")) return;
    await API.del(`/applications/${a.id}`);
    $("#app-detail").close();
    await Promise.all([loadStats(), loadApps()]);
  });
}

// CVs
$("#cv-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  fd.set("set_active", e.target.set_active.checked ? "true" : "false");
  $("#cv-status").textContent = "Uploading & parsing…";
  try {
    await API.upload("/cvs/", fd);
    $("#cv-status").textContent = "Uploaded.";
    e.target.reset();
    await loadCvs();
    await loadProfile();
  } catch (e) {
    $("#cv-status").textContent = "Failed: " + e.message;
  }
});

async function loadCvs(){
  const list = await API.get("/cvs/").catch(()=>[]);
  $("#cv-list").innerHTML = list.map(c => `
    <div class="cv-card">
      <div class="label">${esc(c.label)} ${c.is_active ? '<span class="active">● active</span>' : ''}</div>
      ${c.tag ? `<div class="tag">${esc(c.tag)}</div>` : ""}
      <div class="preview">${esc(c.preview)}…</div>
      <div>
        ${!c.is_active ? `<button data-id="${c.id}" class="btn activate">Make active</button>` : ""}
        <button data-id="${c.id}" class="btn secondary del" style="color:#dc2626">Delete</button>
      </div>
    </div>`).join("") || `<div class="muted">No CVs yet. Upload one above.</div>`;
  $all(".activate").forEach(b => b.addEventListener("click", async () => {
    await API.post(`/cvs/${b.dataset.id}/activate`, {});
    await loadCvs();
  }));
  $all(".del").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Delete this CV?")) return;
    await API.del(`/cvs/${b.dataset.id}`);
    await loadCvs();
  }));
}

// Profile
async function loadProfile(){
  const p = await API.get("/profile/").catch(()=>({}));
  for (const [k, v] of Object.entries(p)) {
    if (k === "portal_password") continue;   // masked — never populate the field
    const el = document.querySelector(`#profile-form [name="${k}"]`);
    if (el && typeof v !== "object") el.value = v ?? "";
  }
  const hint = document.getElementById("portal-pw-hint");
  if (hint) hint.textContent = p.portal_password_set ? "✓ saved — leave blank to keep" : "not set";
}
$("#profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {};
  fd.forEach((v, k) => body[k] = v || null);
  if (body.years_experience) body.years_experience = +body.years_experience;
  if (!body.portal_password) delete body.portal_password;   // blank = keep existing
  $("#profile-status").textContent = "Saving…";
  await API.put("/profile/", body);
  $("#profile-status").textContent = "Saved.";
});

// Settings
$("#api-base").value = API.base;
$("#save-api").addEventListener("click", () => {
  localStorage.setItem("apiBase", $("#api-base").value.trim());
  $("#api-status").textContent = "Saved — reloading…";
  setTimeout(()=>location.reload(), 500);
});

(async function init(){
  await checkApi();
  await Promise.all([loadStats(), loadApps(), loadCvs(), loadProfile()]);
})();

$("#reverify")?.addEventListener("click", async () => {
  const v = $("#verify-info"); if (v) v.textContent = "Pinging deployment…";
  try {
    const r = await API.post("/verify-model", {});
    if (r.ok) {
      if (v) v.innerHTML = `<span style="color:#16a34a">✓ ${esc(r.deployment)} verified.</span> Reply: <code>${esc(r.reply || "")}</code>`;
    } else {
      if (v) v.innerHTML = `<span style="color:#b91c1c">✗ ${esc(r.error || "failed")}</span>`;
    }
    await checkApi();
  } catch (e) {
    if (v) v.textContent = "Error: " + e.message;
  }
});

/* ============================== Analytics ============================== */
async function loadAnalytics(){
  let o, ins;
  try {
    [o, ins] = await Promise.all([
      API.get("/analytics/overview"),
      API.get("/analytics/insights"),
    ]);
  } catch (e) { return; }

  $("#analytics-insights").innerHTML = (ins.notes || []).length
    ? '<h3 style="margin-top:0">Insights</h3>' + ins.notes.map(n => `<div class="note">${esc(n)}</div>`).join("")
    : '<h3 style="margin-top:0">Insights</h3><div class="muted">Analyze a few more roles to unlock insights.</div>';

  const f = o.funnel || {};
  const r = o.rates || {};
  $("#analytics-funnel").innerHTML = `
    <div class="stat"><span>${f.analyzed||0}</span><label>Analyzed/applied</label></div>
    <div class="stat"><span>${f.interview||0}</span><label>Interviewing</label></div>
    <div class="stat"><span>${f.offer||0}</span><label>Offers</label></div>
    <div class="stat"><span>${r.response_rate||0}%</span><label>Response rate</label></div>`;

  // Fit by outcome
  const fits = o.avg_fit_by_outcome || {};
  $("#fit-by-outcome").innerHTML = barsHTML(
    ["all","interview","rejected","offer"].map(k => ({ label: k, value: fits[k]||0 })),
    { empty: "No outcomes yet." });

  // Response time
  const rt = o.response_times_days || {};
  $("#response-time").innerHTML = rt.count > 0
    ? `<div style="display:flex;gap:14px;flex-wrap:wrap">
        <div><b>${rt.avg_days}</b> days <span class="muted">avg</span></div>
        <div><b>${rt.median_days}</b> <span class="muted">median</span></div>
        <div><b>${rt.fastest_days}</b> <span class="muted">fastest</span></div>
        <div><b>${rt.slowest_days}</b> <span class="muted">slowest</span></div>
        <div class="muted">based on ${rt.count} responses</div></div>`
    : '<div class="muted">No responses tracked yet. Paste a recruiter email in Inbox to log one.</div>';

  // Top gaps
  $("#top-gaps").innerHTML = (o.top_gaps||[]).length
    ? (o.top_gaps||[]).map(g => `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #f1f5f9">
        <span>${esc(g.gap)}</span><b>${g.count}×</b></div>`).join("")
    : '<div class="muted">No gaps recorded yet.</div>';

  // CV performance
  $("#cv-perf-body").innerHTML = (o.cv_performance||[]).map(p=>`
    <tr><td>${esc(p.cv_label)}</td><td>${p.used}</td>
        <td>${p.interview_rate}%</td><td>${p.avg_fit}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No data yet.</td></tr>`;

  // Source effectiveness
  $("#source-perf-body").innerHTML = (o.source_effectiveness||[]).map(p=>`
    <tr><td>${esc(p.source)}</td><td>${p.total}</td>
        <td>${p.interview_rate}%</td><td>${p.offer_rate}%</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No data yet.</td></tr>`;

  // Language demand
  const lang = o.language_demand?.by_language || {};
  $("#lang-demand").innerHTML = barsHTML(
    Object.entries(lang).map(([k,v]) => ({ label: k, value: v })),
    { empty: "All English so far." });
}

/* ============================== Question library ============================== */
async function loadQuestions(){
  const rows = await API.get("/questions/").catch(()=>[]);
  if (!rows.length) {
    $("#q-list").innerHTML = '<div class="muted">No saved questions yet. Add one above, or use the extension on an application form to capture questions automatically.</div>';
    return;
  }
  $("#q-list").innerHTML = rows.map(q => `
    <div class="q-card" data-qid="${q.id}">
      <div class="q-text">${esc(q.text)}</div>
      <div class="q-meta">${esc(q.category || "other")} · used ${q.use_count}× · ${q.answers.length} answer${q.answers.length===1?"":"s"}</div>
      <div class="a-list">${
        q.answers.map(a => `
          <div class="a-item">
            ${a.is_default ? '<span class="fit-pill good" style="font-size:10px;margin-right:6px">default</span>' : ''}
            ${esc(a.answer).replace(/\n/g,'<br/>')}
            <div class="a-actions">
              <button class="secondary copy-a" data-text="${esc(a.answer)}">Copy</button>
              ${!a.is_default ? `<button class="secondary make-default" data-aid="${a.id}">Make default</button>` : ''}
              <button class="danger del-a" data-aid="${a.id}">Delete</button>
            </div>
          </div>`).join("") || '<div class="muted">No answers yet — add one below.</div>'
      }</div>
      <div class="add-a">
        <textarea placeholder="Write a new answer or draft with AI…"></textarea>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="save-a">Save</button>
          <button class="draft-a secondary">Draft with AI</button>
          <button class="del-q danger">Delete Q</button>
        </div>
      </div>
    </div>`).join("");

  $all(".q-card").forEach(card => {
    const qid = +card.dataset.qid;
    card.querySelectorAll(".copy-a").forEach(b => b.addEventListener("click", () => {
      navigator.clipboard.writeText(b.dataset.text);
      b.textContent = "Copied"; setTimeout(()=>b.textContent="Copy", 1200);
    }));
    card.querySelectorAll(".make-default").forEach(b => b.addEventListener("click", async () => {
      await API.patch(`/questions/answers/${b.dataset.aid}`, { answer: b.parentElement.parentElement.childNodes[2].textContent.trim(), is_default: true });
      loadQuestions();
    }));
    card.querySelectorAll(".del-a").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this answer?")) return;
      await API.del(`/questions/answers/${b.dataset.aid}`); loadQuestions();
    }));
    card.querySelector(".save-a").addEventListener("click", async (e) => {
      e.preventDefault();
      const ta = card.querySelector(".add-a textarea");
      if (!ta.value.trim()) return;
      await API.post(`/questions/by-id/${qid}/answers`, { answer: ta.value.trim(), is_default: false });
      ta.value = ""; loadQuestions();
    });
    card.querySelector(".draft-a").addEventListener("click", async (e) => {
      e.preventDefault();
      const ta = card.querySelector(".add-a textarea");
      ta.value = "Drafting…";
      const q = rows.find(r => r.id === qid);
      const r = await API.post("/questions/draft", { text: q.text, save: false });
      ta.value = r.answer || "";
    });
    card.querySelector(".del-q").addEventListener("click", async (e) => {
      e.preventDefault();
      if (!confirm("Delete this question and all its answers?")) return;
      await API.del(`/questions/by-id/${qid}`); loadQuestions();
    });
  });
}

$("#q-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await API.post("/questions/", { text: fd.get("text"), tags: fd.get("tags") || null });
  e.target.reset(); loadQuestions();
});

/* ============================== Inbox · email parser ============================== */
$("#parse-email")?.addEventListener("click", async () => {
  const text = $("#email-text").value.trim();
  const res = $("#email-result");
  if (!text) { res.innerHTML = '<div class="muted">Paste an email first.</div>'; return; }
  res.innerHTML = '<div class="muted">Classifying…</div>';
  try {
    const r = await API.post("/emails/parse", { text, apply: true });
    res.innerHTML = `
      <div class="res-card">
        <div class="kv"><b>Kind:</b> ${esc(r.kind || "—")} <span class="muted">(conf ${Math.round((r.confidence||0)*100)}%)</span></div>
        <div class="kv"><b>Summary:</b> ${esc(r.summary || "—")}</div>
        ${r.matched_application_id
          ? `<div class="kv"><b>Matched:</b> <a href="#" data-id="${r.matched_application_id}" class="open-app">${esc(r.matched_application_title || "")} · ${esc(r.matched_application_company || "")}</a></div>`
          : `<div class="kv"><b>Matched:</b> <span class="muted">No application found — add it first.</span></div>`}
        ${r.suggested_status ? `<div class="kv"><b>Suggested status:</b> ${esc(r.suggested_status)}</div>` : ''}
        ${r.interview_datetime ? `<div class="kv"><b>Interview:</b> ${esc(r.interview_datetime)}</div>` : ''}
        ${r.salary_mentioned ? `<div class="kv"><b>Salary mentioned:</b> ${esc(r.salary_mentioned)}</div>` : ''}
        ${r.next_action ? `<div class="kv"><b>Next action:</b> ${esc(r.next_action)}</div>` : ''}
        <div class="kv"><b>Applied to record?</b> ${r.applied ? "Yes" : "No"}${r.status_changed ? " · status updated" : ""}</div>
      </div>`;
    $all(".open-app").forEach(el => el.addEventListener("click", (e) => { e.preventDefault(); openApp(+el.dataset.id); }));
    if (r.applied) { await Promise.all([loadStats(), loadApps()]); }
  } catch (e) {
    res.innerHTML = `<div class="muted" style="color:#b91c1c">Error: ${esc(e.message)}</div>`;
  }
});

/* ============================== Activity timeline in app detail ============================== */
async function appendTimelineToDetail(appId){
  try {
    const events = await API.get(`/applications/${appId}/events`);
    if (!events.length) return;
    const html = `
      <h3 style="margin-top:14px">Activity</h3>
      <div class="timeline">
        ${events.map(e => `
          <div class="ev ${esc(e.kind)}">
            <div class="ev-title">${esc(e.title || e.kind)}</div>
            ${e.detail ? `<div class="ev-detail">${esc(e.detail.slice(0,400))}${e.detail.length>400?"…":""}</div>` : ""}
            <div class="ev-when">${new Date(e.created_at).toLocaleString()} · ${esc(e.source || "")}</div>
          </div>`).join("")}
      </div>`;
    const body = $("#app-detail-body");
    if (body) body.insertAdjacentHTML("beforeend", html);
  } catch {}
}

// Wrap openApp to also fetch the timeline
const _origOpenApp = openApp;
openApp = async function(id) {
  await _origOpenApp(id);
  await appendTimelineToDetail(id);
};

/* ============================== Tab change hooks ============================== */
document.querySelectorAll(".sidebar a").forEach(a => a.addEventListener("click", async () => {
  if (a.dataset.tab === "analytics") loadAnalytics();
  if (a.dataset.tab === "questions") loadQuestions();
  if (a.dataset.tab === "calendar") loadCalendar();
}));

/* ============================== Pending review queue ============================== */
async function loadNeedsReview(){
  const rows = await API.get("/questions/needs-review").catch(()=>[]);
  const card = $("#needs-review-card");
  const list = $("#needs-review-list");
  if (!card || !list) return;
  if (!rows.length) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  list.innerHTML = rows.map(q => {
    const ans = q.answers[q.answers.length - 1];  // most recent
    return `
      <div class="q-card" data-qid="${q.id}" style="background:#fffefa;border-color:#fde68a">
        <div class="q-text">${esc(q.text)}</div>
        <div class="q-meta">type: <b>${esc(q.last_input_type || "text")}</b>${q.last_options ? ` · options: ${esc(q.last_options)}` : ""}</div>
        <textarea class="nr-answer" rows="3" style="margin-top:8px">${esc(ans?.answer || "")}</textarea>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="nr-save">Save as default & mark reviewed</button>
          <button class="secondary nr-skip">Mark reviewed (keep as-is)</button>
          <button class="danger nr-delete">Delete question</button>
        </div>
      </div>`;
  }).join("");

  $all("#needs-review-list .q-card").forEach(card => {
    const qid = +card.dataset.qid;
    const ta = card.querySelector(".nr-answer");
    card.querySelector(".nr-save").addEventListener("click", async () => {
      // Add the edited answer as default and mark reviewed
      const row = rows.find(r => r.id === qid);
      const ans = row?.answers?.[row.answers.length - 1];
      if (ans) {
        await API.patch(`/questions/answers/${ans.id}`, { answer: ta.value, is_default: true });
      } else {
        await API.post(`/questions/by-id/${qid}/answers`, { answer: ta.value, is_default: true });
      }
      await API.post(`/questions/by-id/${qid}/mark-reviewed`, {});
      loadNeedsReview(); loadQuestions();
    });
    card.querySelector(".nr-skip").addEventListener("click", async () => {
      await API.post(`/questions/by-id/${qid}/mark-reviewed`, {});
      loadNeedsReview(); loadQuestions();
    });
    card.querySelector(".nr-delete").addEventListener("click", async () => {
      if (!confirm("Delete this question entirely?")) return;
      await API.del(`/questions/by-id/${qid}`);
      loadNeedsReview(); loadQuestions();
    });
  });
}

// Hook into tab change
document.querySelectorAll(".sidebar a").forEach(a => a.addEventListener("click", async () => {
  if (a.dataset.tab === "questions") loadNeedsReview();
}));

/* ============================== My answers (curated bank) ============================== */
let _bankRows = [];

async function loadAnswerBank(){
  _bankRows = await API.get("/questions/").catch(()=>[]);
  renderBank();
}

function renderBank(){
  const search = ($("#bank-search")?.value || "").toLowerCase();
  const catFilter = $("#bank-cat-filter")?.value || "";
  const rows = _bankRows.filter(q => {
    if (catFilter && (q.category || "other") !== catFilter) return false;
    if (search && !q.text.toLowerCase().includes(search)) return false;
    return true;
  });
  if (!rows.length) {
    $("#bank-categories").innerHTML = '<div class="muted">No matching questions. Click "Load 280+ common questions" above, or add a custom one.</div>';
    return;
  }
  const byCat = {};
  rows.forEach(q => {
    const c = q.category || "other";
    (byCat[c] = byCat[c] || []).push(q);
  });
  const order = ["technical", "logistics", "salary", "motivation", "behavioral", "diversity", "other"];
  const sortedCats = Object.keys(byCat).sort((a,b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));

  $("#bank-categories").innerHTML = sortedCats.map(cat => `
    <div class="card" style="margin-bottom:14px">
      <h3 style="text-transform:capitalize">${esc(cat)} <span class="muted" style="font-weight:400;font-size:12px">(${byCat[cat].length})</span></h3>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${byCat[cat].map(q => renderBankRow(q)).join("")}
      </div>
    </div>`).join("");

  wireBankRows();
}

function renderBankRow(q){
  const opts = q.last_options ? JSON.parse(q.last_options) : null;
  const inputType = q.last_input_type || "text";

  // Group existing answers by answer_type so the row can show both a number variant AND a text variant
  const answers = q.answers || [];
  const byType = {
    number: answers.find(a => (a.answer_type || "text") === "number"),
    text:   answers.find(a => (a.answer_type || "text") === "text"),
    textarea: answers.find(a => (a.answer_type || "text") === "textarea"),
    select: answers.find(a => (a.answer_type || "text") === "select"),
    radio:  answers.find(a => (a.answer_type || "text") === "radio"),
  };
  const hasAny = answers.length > 0;

  // Which variants make sense for this question? Always include the declared type
  // plus "number" and "text" so the user can save both flavours.
  const offered = new Set([inputType, "number", "text"]);
  if (opts) { offered.add("select"); offered.add("radio"); }

  const variantsHtml = Array.from(offered).map(t => {
    const a = byType[t];
    const val = a?.answer || "";
    const inputHtml = renderAnswerInput(q.id, t, opts, val);
    return `<div class="variant-row" data-qid="${q.id}" data-type="${t}" data-aid="${a?.id || ''}" style="display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap">
      <span style="min-width:60px;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase">${esc(t)}</span>
      <div class="variant-input" style="flex:1;min-width:160px">${inputHtml}</div>
      <button class="secondary save-variant">Save</button>
      ${a ? `<button class="ghost del-variant" style="background:none;border:none;cursor:pointer;color:#dc2626;font-size:11px">×</button>` : ''}
    </div>`;
  }).join("");

  // Compact preview of the saved answer (default first), shown when collapsed
  const previewAns = (byType.text || byType.number || answers[0]);
  const previewTxt = previewAns ? String(previewAns.answer).replace(/\s+/g, " ").slice(0, 70) : "";

  return `<div class="bank-row collapsed" data-qid="${q.id}">
    <div class="bank-head">
      <span class="bank-chevron">›</span>
      <span class="bank-status ${hasAny ? 'ok' : 'todo'}">${hasAny ? '✓' : '!'}</span>
      <span class="bank-qtext">${esc(q.text)}</span>
      <span class="bank-preview">${esc(previewTxt)}</span>
      <span class="bank-type">${esc(inputType)}</span>
      <button class="danger del-bank" data-qid="${q.id}" title="Delete question">delete</button>
    </div>
    <div class="bank-body">
      <div class="bank-q-view" style="font-size:12px;margin-bottom:6px">
        <button class="ghost edit-q" style="background:none;border:none;color:#6b7280;cursor:pointer;font-size:11px;padding:2px 6px">✎ edit question</button>
        <span class="muted" style="font-size:11px">type: ${esc(inputType)}${opts ? ` · ${opts.length} opts` : ''}</span>
      </div>
      <div class="bank-q-edit hidden" style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">
        <input class="eq-text" value="${esc(q.text)}" style="flex:1;min-width:240px"/>
        <select class="eq-type" style="max-width:140px">
          ${["number","text","textarea","select","radio"].map(t => `<option ${t===inputType?'selected':''}>${t}</option>`).join("")}
        </select>
        <input class="eq-options" placeholder="opts (comma-sep)" value="${esc(opts?opts.join(", "):'')}" style="flex:1;min-width:200px"/>
        <button class="eq-save secondary">Save</button>
        <button class="eq-cancel ghost" style="background:none;border:none;cursor:pointer;color:#6b7280">cancel</button>
      </div>
      <div class="variant-stack">
        ${variantsHtml}
      </div>
    </div>
  </div>`;
}

function renderAnswerInput(qid, inputType, opts, value){
  if (inputType === "select" || (opts && opts.length && inputType === "select")) {
    return `<select data-qid="${qid}" class="bank-input">
      <option value="">— pick —</option>
      ${(opts||[]).map(o => `<option ${o===value?'selected':''}>${esc(o)}</option>`).join("")}
    </select>`;
  }
  if (inputType === "radio" && opts && opts.length) {
    return `<div data-qid="${qid}" class="bank-input" style="display:flex;gap:10px;flex-wrap:wrap">
      ${opts.map((o,i) => `<label style="display:flex;gap:4px;align-items:center;font-size:12px">
        <input type="radio" name="r_${qid}" value="${esc(o)}" ${o===value?'checked':''}/>${esc(o)}</label>`).join("")}
    </div>`;
  }
  if (inputType === "number") {
    return `<input data-qid="${qid}" class="bank-input" type="number" min="0" max="99" value="${esc(value)}" placeholder="enter a number…" style="max-width:140px"/>`;
  }
  if (inputType === "textarea") {
    return `<textarea data-qid="${qid}" class="bank-input" rows="3" placeholder="(your answer)">${esc(value)}</textarea>`;
  }
  return `<input data-qid="${qid}" class="bank-input" type="text" value="${esc(value)}" placeholder="(your answer)"/>`;
}

function wireBankRows(){
  // Collapse/expand each question row on header click (ignore buttons)
  $all(".bank-head").forEach(h => h.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    h.closest(".bank-row").classList.toggle("collapsed");
  }));
  // New: save / delete individual variants
  $all(".save-variant").forEach(b => b.addEventListener("click", async () => {
    const row = b.closest(".variant-row");
    const qid = +row.dataset.qid;
    const type = row.dataset.type;
    const aid = row.dataset.aid;
    const input = row.querySelector(".variant-input");
    let val;
    const inner = input.querySelector("input, textarea, select, [type=radio]:checked");
    if (input.querySelector("input[type=radio]")) {
      const picked = input.querySelector("input[type=radio]:checked");
      val = picked ? picked.value : "";
    } else {
      val = inner ? inner.value : "";
    }
    if (!val) { b.textContent = "empty"; setTimeout(()=>b.textContent="Save", 1200); return; }
    if (aid) {
      await API.patch(`/questions/answers/${aid}`, { answer: val, answer_type: type, is_default: true });
    } else {
      await API.post(`/questions/by-id/${qid}/answers`, { answer: val, answer_type: type, is_default: true });
    }
    b.textContent = "saved ✓"; setTimeout(loadAnswerBank, 500);
  }));
  $all(".del-variant").forEach(b => b.addEventListener("click", async () => {
    const row = b.closest(".variant-row");
    const aid = row.dataset.aid;
    if (!aid) return;
    if (!confirm("Delete this answer variant?")) return;
    await API.del(`/questions/answers/${aid}`);
    loadAnswerBank();
  }));

  $all(".save-bank").forEach(b => b.addEventListener("click", async () => {
    const qid = b.dataset.qid; const aid = b.dataset.aid;
    const row = b.parentElement;
    const input = row.querySelector(".bank-input");
    let val;
    if (input.tagName === "DIV") {
      // radio group
      const picked = input.querySelector("input[type=radio]:checked");
      val = picked?.value || "";
    } else {
      val = input.value;
    }
    if (!val) { b.textContent = "empty"; setTimeout(()=>b.textContent="Save", 1200); return; }
    if (aid) {
      await API.patch(`/questions/answers/${aid}`, { answer: val, is_default: true });
    } else {
      await API.post(`/questions/by-id/${qid}/answers`, { answer: val, is_default: true });
    }
    b.textContent = "saved ✓"; setTimeout(loadAnswerBank, 500);
  }));

  $all(".del-bank").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Delete this question and its saved answers?")) return;
    await API.del(`/questions/by-id/${b.dataset.qid}`);
    loadAnswerBank();
  }));

  $all(".edit-q").forEach(b => b.addEventListener("click", () => {
    const row = b.closest(".bank-row");
    row.querySelector(".bank-q-view").classList.add("hidden");
    row.querySelector(".bank-q-edit").classList.remove("hidden");
  }));

  $all(".eq-cancel").forEach(b => b.addEventListener("click", () => {
    const row = b.closest(".bank-row");
    row.querySelector(".bank-q-view").classList.remove("hidden");
    row.querySelector(".bank-q-edit").classList.add("hidden");
  }));

  $all(".eq-save").forEach(b => b.addEventListener("click", async () => {
    const row = b.closest(".bank-row");
    const qid = row.dataset.qid;
    const text = row.querySelector(".eq-text").value.trim();
    const input_type = row.querySelector(".eq-type").value;
    const optsRaw = row.querySelector(".eq-options").value.trim();
    const options = optsRaw ? optsRaw.split(",").map(o => o.trim()).filter(Boolean) : null;
    if (!text) return;
    await API.patch(`/questions/by-id/${qid}`, { text, input_type, options });
    loadAnswerBank();
  }));
}

/* ----- Search + filter ----- */
$("#bank-search")?.addEventListener("input", renderBank);
$("#bank-cat-filter")?.addEventListener("change", renderBank);

/* ----- Custom question form ----- */
function renderCustomAnswerInput(){
  const t = $("#ct-type").value;
  const optsWrap = $("#ct-options-wrap");
  const optsRaw = optsWrap.querySelector("input")?.value || "";
  const opts = optsRaw.split(",").map(o => o.trim()).filter(Boolean);
  const needOpts = (t === "select" || t === "radio");
  optsWrap.style.display = needOpts ? "block" : "none";
  const ansWrap = $("#ct-answer-wrap");
  if (t === "number") ansWrap.innerHTML = '<input id="ct-answer" type="number" min="0" max="99" placeholder="years / score"/>';
  else if (t === "textarea") ansWrap.innerHTML = '<textarea id="ct-answer" rows="3" placeholder="(your answer)"></textarea>';
  else if (needOpts && opts.length) ansWrap.innerHTML = `<select id="ct-answer"><option value="">— pick —</option>${opts.map(o=>`<option>${esc(o)}</option>`).join("")}</select>`;
  else ansWrap.innerHTML = '<input id="ct-answer" type="text" placeholder="(your answer)"/>';
}
$("#ct-type")?.addEventListener("change", renderCustomAnswerInput);
document.addEventListener("DOMContentLoaded", () => renderCustomAnswerInput());

document.addEventListener("input", (e) => {
  if (e.target?.closest("#ct-options-wrap")) renderCustomAnswerInput();
});

$("#custom-q-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const text = fd.get("text"); if (!text) return;
  const category = fd.get("category");
  const input_type = fd.get("input_type");
  const optsRaw = fd.get("options") || "";
  const options = optsRaw.split(",").map(o => o.trim()).filter(Boolean);
  $("#custom-status").textContent = "Creating…";
  try {
    const r = await API.post("/questions/custom", { text, category, input_type, options: options.length ? options : null });
    // Save the answer too if user filled one in
    const answer = $("#ct-answer")?.value;
    if (answer) await API.post(`/questions/by-id/${r.id}/answers`, { answer, is_default: true });
    $("#custom-status").textContent = "Added ✓";
    e.target.reset();
    renderCustomAnswerInput();
    loadAnswerBank();
  } catch (err) {
    $("#custom-status").textContent = "Error: " + err.message;
  }
});

$("#seed-bank-btn")?.addEventListener("click", async () => {
  $("#seed-status").textContent = "Loading…";
  const r = await API.post("/questions/seed-bank", {});
  $("#seed-status").textContent = `Added ${r.added} new (${r.total_seeded} total).`;
  loadAnswerBank();
});

document.querySelectorAll(".sidebar a").forEach(a => a.addEventListener("click", () => {
  if (a.dataset.tab === "answers") loadAnswerBank();
}));

/* ============================== Provider settings ============================== */
const TASK_LABELS = {
  "analyze_fit": "Fit analysis",
  "structure_cv": "CV parsing",
  "typed_answer": "Easy Apply field",
  "cover_letter": "Cover letter",
  "draft_answer": "Draft application answer",
  "email_classify": "Email classification",
  "verify_model": "Model verification",
};

async function loadProviderSettings(){
  const s = await API.get("/settings/").catch(()=>({}));
  if (!s) return;
  const mode = s.llm_provider || "cloud";
  document.querySelectorAll("input[name=provider]").forEach(r => {
    r.checked = (r.value === mode);
  });
  if ($("#local-base-url")) $("#local-base-url").value = s.local_base_url || "http://localhost:11434/v1";
  // Local-model dropdown is populated by loadLocalModels(). We pass the currently-saved
  // model so it stays selected once the real list loads.
  await loadLocalModels(s.local_model);

  // Build per-task grid
  const grid = $("#per-task-grid");
  if (grid) {
    const overrides = s.per_task || {};
    grid.innerHTML = Object.entries(TASK_LABELS).map(([key, label]) => `
      <label>
        <span>${esc(label)}</span>
        <select data-task="${key}">
          <option value="" ${!overrides[key]?'selected':''}>(default)</option>
          <option value="cloud" ${overrides[key]==='cloud'?'selected':''}>Cloud</option>
          <option value="local" ${overrides[key]==='local'?'selected':''}>Local</option>
        </select>
      </label>
    `).join("");
  }
  applyProviderVisibility(mode);
}

function applyProviderVisibility(mode){
  // Cloud key relevant for cloud + hybrid; local model relevant for local + hybrid.
  const cloud = $("#cloud-config"), local = $("#local-config");
  if (cloud) cloud.classList.toggle("hidden", mode === "local");
  if (local) local.classList.toggle("hidden", mode === "cloud");
}

document.querySelectorAll("input[name=provider]").forEach(r => r.addEventListener("change", () => {
  if (r.checked) applyProviderVisibility(r.value);
}));

$("#azure-advanced-toggle")?.addEventListener("click", (e) => {
  e.preventDefault();
  $("#azure-advanced")?.classList.toggle("hidden");
});

$("#save-provider")?.addEventListener("click", async () => {
  const provider = document.querySelector("input[name=provider]:checked")?.value || "cloud";
  const local_model = $("#local-model")?.value || "llama3.2:3b";
  const local_base_url = $("#local-base-url")?.value || "http://localhost:11434/v1";
  const per_task = {};
  document.querySelectorAll("#per-task-grid select").forEach(sel => {
    if (sel.value) per_task[sel.dataset.task] = sel.value;
  });
  $("#provider-status").textContent = "Saving…";
  const payload = { llm_provider: provider, local_model, local_base_url, per_task };
  // Fold Azure credentials into the same Save (empty fields = leave unchanged)
  const ak = $("#azure-api-key")?.value.trim();
  const ad = $("#azure-deployment")?.value.trim();
  const ae = $("#azure-endpoint")?.value.trim();
  const av = $("#azure-api-version")?.value.trim();
  if (ak) payload.azure_api_key = ak;
  if (ad) payload.azure_deployment = ad;
  if (ae) payload.azure_endpoint = ae;
  if (av) payload.azure_api_version = av;
  await API.put("/settings/", payload);
  if ($("#azure-api-key")) $("#azure-api-key").value = "";
  $("#provider-status").textContent = "✓ Saved.";
  setTimeout(() => $("#provider-status").textContent = "", 2000);
  await checkApi();
  await loadProviderSettings();
});

$("#test-connection")?.addEventListener("click", async () => {
  const out = $("#provider-status");
  out.textContent = "Pinging…";
  try {
    const r = await API.post("/verify-model", {});
    const rows = [];
    if (r.cloud_result) {
      const c = r.cloud_result;
      rows.push(c.ok
        ? `<div style="color:#16a34a">✓ <b>Cloud</b> · ${esc(c.model)} → ${esc(c.reply)}</div>`
        : `<div style="color:#b91c1c">✗ <b>Cloud</b> · ${esc(c.model)} — ${esc(c.error)}</div>`);
    }
    if (r.local_result) {
      const l = r.local_result;
      rows.push(l.ok
        ? `<div style="color:#16a34a">✓ <b>Local</b> · ${esc(l.model)} → ${esc(l.reply)}</div>`
        : `<div style="color:#b91c1c">✗ <b>Local</b> · ${esc(l.model)} — ${esc(l.error)}<br/><span style="font-size:11px">Is Ollama running? Run <code>ollama serve</code> and <code>ollama pull ${esc(l.model||"llama3.2:3b")}</code></span></div>`);
    }
    // Fallback for cloud-only response
    if (!rows.length) {
      rows.push(r.ok
        ? `<div style="color:#16a34a">✓ ${esc(r.provider||'?')} · ${esc(r.model||'?')} → ${esc(r.reply||'')}</div>`
        : `<div style="color:#b91c1c">✗ ${esc(r.error||'failed')}</div>`);
    }
    out.innerHTML = rows.join("");
  } catch (e) {
    out.innerHTML = `<span style="color:#b91c1c">Error: ${esc(e.message)}</span>`;
  }
});

// Load when Settings tab activates
document.querySelectorAll(".sidebar a").forEach(a => a.addEventListener("click", () => {
  if (a.dataset.tab === "settings") loadProviderSettings();
}));

/* ============================== Overview timeframes ============================== */
async function loadTimeframes(){
  try {
    const o = await API.get("/analytics/overview");
    const tf = (id, val) => { const el = $(id); if (el) el.textContent = val || 0; };
    // Applied can't be detected reliably — show one combined analyzed/applied count.
    const both = t => (t?.analyzed ?? 0);
    tf("#tf-today-count", both(o.today));
    tf("#tf-yest-count",  both(o.yesterday));
    tf("#tf-week-count",  both(o.week));
    tf("#tf-month-count", both(o.month));

    // Build a simple 30-day bar chart
    const chart = $("#daily-chart");
    if (chart) {
      const series = o.daily_activity || [];
      if (!series.length) {
        chart.innerHTML = '<div class="muted" style="padding:20px;text-align:center">No activity in the last 30 days yet.</div>';
      } else {
        chart.innerHTML = barsHTML(series.map(d => ({ label: d.date.slice(5), value: d.count, title: d.date + ": " + d.count })));
      }
    }
  } catch {}
}

/* ============================== LLM usage on Analytics tab ============================== */
async function loadLLMUsage(){
  try {
    const u = await API.get("/analytics/llm-usage");
    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set("#usage-cost", `$${(u.total_cost_usd || 0).toFixed(4)}`);
    set("#usage-tokens", (u.total_tokens || 0).toLocaleString());
    set("#usage-calls", (u.total_calls || 0).toLocaleString());
    set("#usage-latency", `${u.avg_latency_ms || 0}ms`);

    const tf = (sel, b) => {
      const el = $(sel); if (!el) return;
      el.innerHTML = `${b.calls || 0} calls · ${(b.tokens||0).toLocaleString()} tokens · $${(b.cost||0).toFixed(4)}`;
    };
    tf("#usage-today", u.today || {});
    tf("#usage-week",  u.week  || {});
    tf("#usage-month", u.month || {});

    const provBody = $("#usage-by-provider");
    if (provBody) {
      provBody.innerHTML = (u.by_provider || []).map(p => `
        <tr><td>${esc(p.provider)}</td><td>${p.calls}</td><td>${(p.tokens||0).toLocaleString()}</td><td>$${(p.cost||0).toFixed(4)}</td></tr>
      `).join("") || `<tr><td colspan="4" class="muted">No data yet.</td></tr>`;
    }
    const taskBody = $("#usage-by-task");
    if (taskBody) {
      taskBody.innerHTML = (u.by_task || []).map(t => `
        <tr><td>${esc(t.task)}</td><td>${t.calls}</td><td>${(t.tokens||0).toLocaleString()}</td><td>$${(t.cost||0).toFixed(4)}</td></tr>
      `).join("") || `<tr><td colspan="4" class="muted">No data yet.</td></tr>`;
    }
  } catch {}
}

// Hook loaders into existing init + tab changes
const _origLoadStats = loadStats;
loadStats = async function() {
  await _origLoadStats();
  await loadTimeframes();
};

document.querySelectorAll(".sidebar a").forEach(a => a.addEventListener("click", () => {
  if (a.dataset.tab === "analytics") loadLLMUsage();
}));

// Also call on first load
loadTimeframes();

/* ============================== Translate existing questions to English ============================== */
$("#translate-bank-btn")?.addEventListener("click", async () => {
  if (!confirm("Translate every non-English question in your library to English? This calls the LLM once per non-English question and may take a minute on large libraries.")) return;
  $("#seed-status").textContent = "Translating…";
  try {
    const r = await API.post("/questions/translate-to-english", {});
    $("#seed-status").textContent = `Translated ${r.translated} of ${r.total} questions (${r.skipped} already in English).`;
    loadAnswerBank();
  } catch (e) {
    $("#seed-status").textContent = "Error: " + e.message;
  }
});


async function loadLocalModels(preferred = null){
  const sel = $("#local-model");
  const hint = $("#local-models-hint");
  if (!sel) return;
  sel.innerHTML = `<option value="">loading…</option>`;
  try {
    const r = await API.get("/settings/local-models");
    if (!r.available) {
      sel.innerHTML = `<option value="">— Ollama not reachable —</option>`;
      if (preferred) {
        const opt = document.createElement("option");
        opt.value = preferred; opt.textContent = preferred + " (last used)";
        opt.selected = true;
        sel.appendChild(opt);
      }
      const diag = r.diagnostics ? `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:10px">diagnostic details</summary><pre style="font-size:10px;background:#f1f5f9;padding:6px;border-radius:4px;white-space:pre-wrap;word-break:break-word">${esc(JSON.stringify(r.diagnostics, null, 2))}</pre></details>` : "";
      if (hint) hint.innerHTML = `<span style="color:#b91c1c">Couldn't reach Ollama. <b>Error:</b> ${esc(r.error || "(unknown)")}.<br/>Tried: <code>${esc(r.base_url||"")}</code></span>${diag}`;
      return;
    }
    if (!r.models.length) {
      sel.innerHTML = `<option value="">— no models installed —</option>`;
      if (hint) hint.innerHTML = `Pull a model from a terminal: <code>ollama pull llama3.2:3b</code>`;
      return;
    }
    sel.innerHTML = "";
    r.models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      const sz = m.size_gb ? ` (${m.size_gb} GB)` : "";
      opt.textContent = m.name + sz;
      if (preferred && m.id === preferred) opt.selected = true;
      sel.appendChild(opt);
    });
    // If saved preferred isn't in the list anymore, add it as "(not installed)"
    if (preferred && !r.models.some(m => m.id === preferred)) {
      const opt = document.createElement("option");
      opt.value = preferred;
      opt.textContent = preferred + " (not installed — pull it first)";
      opt.selected = true;
      sel.insertBefore(opt, sel.firstChild);
    }
    if (hint) hint.textContent = `${r.models.length} model${r.models.length===1?"":"s"} installed locally.`;
  } catch (e) {
    sel.innerHTML = `<option value="">error</option>`;
    if (hint) hint.textContent = "Error: " + e.message;
  }
}

$("#refresh-models")?.addEventListener("click", () => loadLocalModels($("#local-model")?.value || null));

/* ============================== Azure credentials ============================== */
async function loadAzureFields(){
  try {
    const s = await API.get("/settings/");
    if ($("#azure-endpoint")) $("#azure-endpoint").value = s.azure_endpoint || "";
    if ($("#azure-deployment")) $("#azure-deployment").value = s.azure_deployment || "";
    if ($("#azure-api-version")) $("#azure-api-version").value = s.azure_api_version || "";
    const keyStatus = $("#azure-key-status");
    if (keyStatus) {
      keyStatus.textContent = s.azure_api_key_set
        ? `· stored ${esc(s.azure_api_key_preview)}`
        : "· not set — using config.py default if any";
      keyStatus.style.color = s.azure_api_key_set ? "#16a34a" : "#92400e";
    }
    // Leave the password input EMPTY by default so it doesn't display the previous value.
    // We send an empty string only when user explicitly clears; otherwise leave key unchanged.
    if ($("#azure-api-key")) $("#azure-api-key").value = "";
  } catch (e) {
    console.warn("loadAzureFields failed", e);
  }
}

$("#save-azure")?.addEventListener("click", async () => {
  const body = {
    azure_endpoint: $("#azure-endpoint")?.value.trim() || null,
    azure_deployment: $("#azure-deployment")?.value.trim() || null,
    azure_api_version: $("#azure-api-version")?.value.trim() || null,
  };
  const k = $("#azure-api-key")?.value;
  // Only send the key field if user actually typed something — empty string means "no change"
  if (k && k.trim()) body.azure_api_key = k.trim();

  $("#azure-save-status").textContent = "Saving…";
  try {
    await API.put("/settings/", body);
    $("#azure-save-status").innerHTML = '<span style="color:#16a34a">Saved — cloud client will reload on next call.</span>';
    await loadAzureFields();
    setTimeout(() => { $("#azure-save-status").textContent = ""; }, 3000);
  } catch (e) {
    $("#azure-save-status").innerHTML = `<span style="color:#b91c1c">${esc(e.message)}</span>`;
  }
});

$("#clear-azure")?.addEventListener("click", async () => {
  if (!confirm("Clear the saved Azure API key? The app will fall back to whatever's in config.py or AZURE_OPENAI_API_KEY env var.")) return;
  await API.put("/settings/", { azure_api_key: null });
  $("#azure-save-status").textContent = "Cleared.";
  await loadAzureFields();
});

// Load Azure fields whenever Settings tab is opened — append to the existing tab-load hook
document.querySelectorAll(".sidebar a").forEach(a => a.addEventListener("click", () => {
  if (a.dataset.tab === "settings") loadAzureFields();
}));
// Also on first init
loadAzureFields();


/* ---------- Chat (ChatGPT-style sidebar + streaming) ---------- */
let chatPollTimer = null;
let chatLastId = 0;
let dashThreadId = null;
let chatStreaming = false;   // poll must not re-render while a reply is streaming
let chatThreadsCache = [];
let chatSearchQ = "";

function renderChat(msgs){
  const box = $("#chat-messages");
  if (!box) return;
  const empty = $("#chat-empty");
  if (empty) empty.style.display = msgs.length ? "none" : "";
  box.style.display = msgs.length ? "" : "none";
  box.innerHTML = msgs.map(m => `
    <div class="chat-msg ${m.role === "user" ? "user" : "assistant"}">${esc(m.content)}${
      m.role === "user" && m.context_job ? `<span class="chat-job">${esc(m.context_job)}</span>` : ""
    }</div>`).join("");
  if (msgs.length) chatLastId = msgs[msgs.length - 1].id;
  box.scrollTop = box.scrollHeight;
}

function renderThreadList(){
  const box = $("#chat-list");
  if (!box) return;
  let threads = chatThreadsCache;
  if (chatSearchQ) {
    const q = chatSearchQ.toLowerCase();
    threads = threads.filter(t =>
      (t.title || "").toLowerCase().includes(q) ||
      (t.last_message || "").toLowerCase().includes(q));
  }
  if (!threads.length) {
    box.innerHTML = `<div class="chat-list-empty">${chatSearchQ ? "No chats match." : "No chats yet."}</div>`;
    return;
  }
  box.innerHTML = threads.map(t => `
    <div class="chat-item ${t.id === dashThreadId ? "active" : ""}" data-tid="${t.id}" title="${esc(t.last_message || t.title)}">
      <span class="t">${esc(t.title)}</span>
      ${chatThreadsCache.length > 1 ? `<button class="x" data-del="${t.id}" title="Delete chat">✕</button>` : ""}
    </div>`).join("");
  $all(".chat-item[data-tid]").forEach(item => item.addEventListener("click", async e => {
    if (e.target.closest("[data-del]")) return;
    dashThreadId = +item.dataset.tid;
    renderThreadList();
    updateChatTitle();
    loadChatMessages();
  }));
  $all(".chat-item .x").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Delete this chat?")) return;
    try { await API.del("/chat/threads/" + b.dataset.del); } catch {}
    if (+b.dataset.del === dashThreadId) dashThreadId = null;
    await loadChatThreads();
    loadChatMessages();
  }));
}

function updateChatTitle(){
  const t = chatThreadsCache.find(x => x.id === dashThreadId);
  $("#chat-title").textContent = t ? t.title : "Chat";
}

async function loadChatThreads(){
  try { chatThreadsCache = await API.get("/chat/threads"); } catch { return; }
  if (dashThreadId === null && chatThreadsCache.length) dashThreadId = chatThreadsCache[0].id;
  renderThreadList();
  updateChatTitle();
}

async function loadChatMessages(){
  try {
    const r = await API.get("/chat/?limit=200" + (dashThreadId ? "&thread_id=" + dashThreadId : ""));
    dashThreadId = r.thread_id;
    renderChat(r.messages || []);
  } catch {}
}

async function loadChatTab(){
  await loadChatThreads();
  loadChatMessages();
}

async function streamDashChat(payload, onMeta, onDelta){
  const resp = await fetch(API.base + "/chat/stream", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!chunk.startsWith("data: ")) continue;
      let d; try { d = JSON.parse(chunk.slice(6)); } catch { continue; }
      if (d.thread_id) onMeta?.(d);
      if (d.delta) onDelta(d.delta);
      if (d.done && d.message?.id) chatLastId = d.message.id;
    }
  }
}

async function sendDashboardChat(){
  const input = $("#chat-input");
  const text = (input.value || "").trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  const box = $("#chat-messages");
  box.style.display = "";
  const empty = $("#chat-empty"); if (empty) empty.style.display = "none";
  box.insertAdjacentHTML("beforeend", `<div class="chat-msg user">${esc(text)}</div>`);
  box.insertAdjacentHTML("beforeend", `<div class="chat-msg assistant" id="dash-chat-live">…</div>`);
  const live = document.getElementById("dash-chat-live");
  box.scrollTop = box.scrollHeight;
  $("#chat-send").disabled = true;
  chatStreaming = true;
  const payload = { message: text, thread_id: dashThreadId, context: null };
  let acc = "";
  try {
    await streamDashChat(payload,
      meta => { if (meta.thread_id) dashThreadId = meta.thread_id; },
      delta => { acc += delta; live.textContent = acc; box.scrollTop = box.scrollHeight; });
  } catch (e) {
    try {
      const r = await API.post("/chat/", payload);
      dashThreadId = r.thread_id;
      live.textContent = r.assistant?.content || "";
      if (r.assistant?.id) chatLastId = r.assistant.id;
    } catch (e2) { live.textContent = "Error: " + e2.message; }
  } finally {
    chatStreaming = false;
    live.removeAttribute("id");
    $("#chat-send").disabled = false;
    input.focus();
    loadChatThreads();   // pick up auto-title in the sidebar
  }
}

$("#chat-new")?.addEventListener("click", async () => {
  const r = await API.post("/chat/threads", {});
  dashThreadId = r.id;
  await loadChatThreads();
  renderChat([]);
  $("#chat-input")?.focus();
});

let chatSearchTimer = null;
$("#chat-search")?.addEventListener("input", e => {
  clearTimeout(chatSearchTimer);
  chatSearchTimer = setTimeout(() => { chatSearchQ = e.target.value.trim(); renderThreadList(); }, 150);
});

$("#chat-send")?.addEventListener("click", sendDashboardChat);
$("#chat-input")?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDashboardChat(); }
});
$("#chat-input")?.addEventListener("input", e => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
});
$("#chat-clear")?.addEventListener("click", async () => {
  if (!confirm("Clear this conversation?")) return;
  try {
    await API.del("/chat/" + (dashThreadId ? "?thread_id=" + dashThreadId : ""));
    renderChat([]); loadChatThreads();
  } catch {}
});

// Poll for messages sent from the extension while the Chat tab is open
function startChatPoll(){
  stopChatPoll();
  chatPollTimer = setInterval(async () => {
    if (chatStreaming || document.getElementById("dash-chat-live")) return;
    try {
      const r = await API.get("/chat/?limit=200" + (dashThreadId ? "&thread_id=" + dashThreadId : ""));
      const msgs = r.messages || [];
      if (msgs.length && msgs[msgs.length - 1].id !== chatLastId) renderChat(msgs);
    } catch {}
  }, 5000);
}
function stopChatPoll(){ if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; } }

$all(".sidebar a").forEach(a => a.addEventListener("click", () => {
  if (a.dataset.tab === "chat") { loadChatTab(); startChatPoll(); }
  else stopChatPoll();
}));

/* ============================== Gmail · job responses ============================== */
const KIND_LABELS = {
  rejection: "Rejected", interview_invite: "Interview", offer: "Offer",
  recruiter_reachout: "Recruiter", next_step: "Next step",
  acknowledgment: "Received", follow_up: "Follow-up",
};
const AVATAR_COLORS = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ef4444","#8b5cf6","#14b8a6","#f43f5e"];

function senderName(s){ return (s || "?").replace(/<.*>/, "").replace(/"/g, "").trim() || "?"; }
function avatarFor(name){
  const c = AVATAR_COLORS[(name.charCodeAt(0) || 0) % AVATAR_COLORS.length];
  return `<div class="mail-avatar" style="background:${c}">${esc(name[0].toUpperCase())}</div>`;
}
function timeAgo(iso){
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0) return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  if (days === 1) return "yesterday";
  if (days < 7) return days + "d ago";
  return d.toLocaleDateString();
}

async function refreshGmail(){
  let st;
  try { st = await API.get("/emails/gmail/status"); } catch { return; }
  const badge = $("#gmail-badge");
  $("#gmail-connect-form").style.display = st.connected ? "none" : "";
  $("#gmail-connected-box").style.display = st.connected ? "" : "none";
  $("#gmail-sync-now").style.display = st.connected ? "" : "none";
  $("#gmail-rescan").style.display = st.connected ? "" : "none";
  $("#gmail-disconnect").style.display = st.connected ? "" : "none";
  if (st.connected) {
    badge.innerHTML = `<span style="color:#16a34a">●</span> ${esc(st.address)}` +
      (st.last_sync_at ? ` · synced ${esc(timeAgo(st.last_sync_at))}` : " · first sync runs automatically");
    if (st.last_error) $("#gmail-status").textContent = "Last error: " + st.last_error;
    try { renderInboxSummary(await API.get("/emails/gmail/summary")); } catch {}
    loadGmailEmails();
  } else {
    badge.innerHTML = `<span style="color:#94a3b8">○</span> not connected`;
  }
}

const inboxFilter = { source: "", q: "", company: "", kind: "" };

function renderInboxSummary(sum){
  const box = $("#inbox-summary");
  if (!box) return;
  const k = sum.by_kind || {};
  const cards = [
    { n: k.interview_invite || 0, l: "Interviews", tone: "green", kind: "interview_invite" },
    { n: k.offer || 0, l: "Offers", tone: "green", kind: "offer" },
    { n: k.rejection || 0, l: "Rejections", tone: "red", kind: "rejection" },
    { n: (k.recruiter_reachout || 0) + (k.next_step || 0), l: "Recruiter & next steps", tone: "blue", kind: "recruiter_reachout" },
    { n: sum.this_week || 0, l: "This week", tone: "", kind: "" },
  ];
  box.innerHTML = cards.map(c => `
    <div class="sum-card tone-${c.tone} ${inboxFilter.kind === c.kind && c.kind ? "active" : ""}" data-kind="${c.kind}">
      <div class="sum-n">${c.n}</div><div class="sum-l">${c.l}</div>
    </div>`).join("");
  $all(".sum-card").forEach(c => c.addEventListener("click", () => {
    inboxFilter.kind = (inboxFilter.kind === c.dataset.kind) ? "" : c.dataset.kind;
    refreshGmail();
  }));

  // Company dropdown (preserve selection)
  const sel = $("#inbox-company");
  const cur = inboxFilter.company;
  sel.innerHTML = '<option value="">All companies</option>' +
    (sum.companies || []).map(c =>
      `<option value="${esc(c.name)}" ${c.name === cur ? "selected" : ""}>${esc(c.name)} (${c.count})</option>`).join("");
}

async function loadGmailEmails(){
  let rows;
  const params = new URLSearchParams({ limit: 100 });
  if (inboxFilter.q) params.set("q", inboxFilter.q);
  if (inboxFilter.source) params.set("source", inboxFilter.source);
  if (inboxFilter.company) params.set("company", inboxFilter.company);
  if (inboxFilter.kind) params.set("kind", inboxFilter.kind);
  try { rows = await API.get("/emails/gmail/processed?" + params); } catch { return; }
  const box = $("#gmail-emails");
  if (!rows.length) {
    const filtered = inboxFilter.q || inboxFilter.source || inboxFilter.company || inboxFilter.kind;
    box.innerHTML = `<div class="mail-empty">${filtered
      ? "Nothing matches these filters."
      : `No job responses yet.<br><span style="font-size:12px;">When a company replies to one of your applications, it shows up here and the application status updates automatically.</span>`}</div>`;
    return;
  }
  const important = rows.filter(r => !["acknowledgment", "follow_up"].includes(r.kind));
  const acks = rows.filter(r => ["acknowledgment", "follow_up"].includes(r.kind));
  const render = r => {
    const name = senderName(r.sender);
    const label = KIND_LABELS[r.kind] || r.kind || "?";
    return `<div class="mail-row" data-id="${r.id}">
      ${avatarFor(name)}
      <div class="mail-main">
        <div class="mail-top">
          <span class="mail-sender">${esc(name)}</span>
          <span class="mail-time">${esc(timeAgo(r.received_at))}</span>
        </div>
        <div class="mail-subject">${esc(r.subject || "(no subject)")}</div>
        <div class="mail-snippet">${esc(r.snippet || r.summary || "")}</div>
        <div class="mail-meta">
          <span class="mail-chip chip-${esc(r.kind)}">${esc(label)}</span>
          ${r.application ? `<span class="mail-app">${esc(r.application)}</span>` : ""}
          ${r.status_changed ? `<span class="mail-updated">✓ status updated</span>` : ""}
          <button class="mail-dismiss" data-dismiss="${r.id}" title="Dismiss — not a job response">✕</button>
        </div>
        <div class="mail-detail">
          ${r.summary ? `<div><b>Summary:</b> ${esc(r.summary)}</div>` : ""}
          ${r.next_action ? `<div style="margin-top:4px;"><b>Suggested next step:</b> ${esc(r.next_action)}</div>` : ""}
          ${r.application_id ? `<div style="margin-top:4px;"><a href="#applications" onclick="document.querySelector('[data-tab=applications]').click()">Open application →</a></div>` : ""}
        </div>
      </div>
    </div>`;
  };

  let html = important.map(render).join("");
  if (!important.length) {
    html += `<div class="mail-empty" style="padding:20px 12px;">Nothing needs your attention — no rejections, interviews, or offers yet.</div>`;
  }
  if (acks.length) {
    html += `<details class="mail-acks"${important.length ? "" : " open"}>
      <summary>Application confirmations &amp; receipts (${acks.length})</summary>
      ${acks.map(render).join("")}
    </details>`;
  }
  box.innerHTML = html;

  $all(".mail-row").forEach(row => row.addEventListener("click", e => {
    if (e.target.closest("[data-dismiss]") || e.target.closest("a")) return;
    row.classList.toggle("open");
  }));
  $all("[data-dismiss]").forEach(b => b.addEventListener("click", async () => {
    try { await API.del("/emails/gmail/processed/" + b.dataset.dismiss); } catch {}
    b.closest(".mail-row")?.remove();
    if (!$("#gmail-emails .mail-row")) loadGmailEmails();
  }));
}

$("#gmail-connect")?.addEventListener("click", async () => {
  const status = $("#gmail-status");
  status.textContent = "Testing login…";
  try {
    await API.post("/emails/gmail/connect", {
      address: $("#gmail-address").value,
      app_password: $("#gmail-password").value,
      lookback_days: +$("#gmail-lookback").value,
    });
    status.textContent = "Connected. Running first scan — this can take a minute…";
    refreshGmail();
    const r = await API.post("/emails/gmail/sync", {});
    status.textContent = r.ok
      ? `Scan done — ${r.classified} job-related of ${r.fetched} emails checked, ${r.status_changes} status updates.`
      : (r.error === "Sync already running" ? "First scan is running in the background…" : "Sync error: " + (r.error || "unknown"));
    refreshGmail();
  } catch (e) { status.textContent = "Failed: " + e.message; }
});

$("#gmail-sync-now")?.addEventListener("click", async () => {
  const status = $("#gmail-status");
  status.textContent = "Checking for new mail…";
  try {
    const r = await API.post("/emails/gmail/sync", {});
    if (r.ok) status.textContent = r.fetched
      ? `${r.fetched} new emails checked — ${r.classified} job-related, ${r.status_changes} status updates.`
      : "No new mail.";
    else status.textContent = r.error === "Sync already running"
      ? "A sync is already running — results appear shortly." : "Error: " + (r.error || "unknown");
    refreshGmail();
  } catch (e) { status.textContent = "Failed: " + e.message; }
});

$("#gmail-rescan")?.addEventListener("click", async () => {
  const status = $("#gmail-status");
  status.textContent = "Re-scanning the whole window with current rules — this can take a minute…";
  try {
    const r = await API.post("/emails/gmail/rescan", {});
    status.textContent = r.ok
      ? `Re-scan done — ${r.classified} job-related of ${r.fetched} emails, ${r.status_changes} status updates.`
      : "Error: " + (r.error || "unknown");
    refreshGmail();
  } catch (e) { status.textContent = "Failed: " + e.message; }
});

$("#gmail-disconnect")?.addEventListener("click", async () => {
  try { await API.post("/emails/gmail/disconnect", {}); } catch {}
  $("#gmail-status").textContent = "Disconnected.";
  refreshGmail();
});

$all(".inbox-tab").forEach(t => t.addEventListener("click", () => {
  $all(".inbox-tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  inboxFilter.source = t.dataset.source;
  loadGmailEmails();
}));

let inboxSearchTimer = null;
$("#inbox-search")?.addEventListener("input", e => {
  clearTimeout(inboxSearchTimer);
  inboxSearchTimer = setTimeout(() => {
    inboxFilter.q = e.target.value.trim();
    loadGmailEmails();
  }, 250);
});

$("#inbox-company")?.addEventListener("change", e => {
  inboxFilter.company = e.target.value;
  loadGmailEmails();
});

$all(".sidebar a").forEach(a => a.addEventListener("click", () => {
  if (a.dataset.tab === "inbox") refreshGmail();
}));


/* ============================== Auto-apply ============================== */
let aaEnabled = false;
let aaPollTimer = null;
let aaPlatform = "";   // "" = all, "linkedin", "successfactors"

async function refreshAutoApply(){
  let st;
  try { st = await API.get("/applications/auto-apply/status"); } catch { return; }
  aaEnabled = st.enabled;
  const btn = $("#aa-toggle");
  btn.textContent = st.enabled ? "Stop" : "Start";
  btn.className = st.enabled ? "btn secondary" : "btn";
  $("#aa-cap").value = st.daily_cap;
  if (st.mode) $("#aa-mode").value = st.mode;
  if (typeof st.portal_auto_submit !== "undefined") $("#aa-portal-submit").value = st.portal_auto_submit ? "1" : "0";
  $("#aa-pills").innerHTML = st.enabled
    ? `<span class="aa-badge aa-applied">running</span>`
    : `<span class="aa-badge aa-queued">stopped</span>`;
  $("#aa-stats").innerHTML = `
    <div class="aa-stat"><b>${st.queued}</b><div class="aa-stat-label">queued jobs</div></div>
    <div class="aa-stat"><b>${st.searches || 0}</b><div class="aa-stat-label">searches to expand</div></div>
    <div class="aa-stat"><b>${st.applied_today}</b><div class="aa-stat-label">applied today${st.cap_reached ? " · <span style='color:#b91c1c'>cap reached</span>" : ""}</div></div>`;
  const w = $("#aa-worker");
  if (st.worker_online) {
    w.className = "aa-worker on";
    w.innerHTML = `<span class="dot"></span> Extension connected${
      st.worker_action && st.worker_action !== "idle"
        ? " — " + esc(st.worker_action) : st.enabled ? " — waiting for next slot (runs every minute)" : ""}`;
  } else if (st.worker_age_sec === null) {
    // Genuinely never seen — likely the extension isn't loaded or backend was just restarted.
    w.className = "aa-worker off";
    w.innerHTML = `<span class="dot"></span> Waiting for the extension… If this stays red for a minute, open <b>chrome://extensions</b>, reload Job Apply Assistant, and keep Chrome open.`;
  } else {
    // Seen before but went quiet (worker asleep) — soft warning, not an error.
    w.className = "aa-worker idle";
    w.innerHTML = `<span class="dot"></span> Extension idle (last active ${st.worker_age_sec}s ago) — it wakes on the next check.`;
  }
  loadAutoApplyLog();
}

async function loadAutoApplyLog(){
  let rows;
  try { rows = await API.get("/applications/auto-apply/log?limit=80" + (aaPlatform ? "&platform=" + aaPlatform : "")); } catch { return; }
  const box = $("#aa-log");
  if (!rows.length) { box.innerHTML = '<div class="muted">Nothing yet — queue some jobs above.</div>'; return; }
  const statusText = { queued_search: "search", expanded: "expanded", needs_review: "needs review" };
  function shortTitle(r){
    if (r.job_title) return r.job_title;
    if (r.is_search) {
      try { const u = new URL(r.url); return "Search: " + (u.searchParams.get("keywords") || "LinkedIn jobs"); }
      catch { return "LinkedIn search"; }
    }
    return r.url ? r.url.replace(/^https?:\/\/(www\.)?linkedin\.com/, "").slice(0, 50) : "?";
  }
  const platLabel = { linkedin: "LinkedIn", successfactors: "SuccessFactors", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", personio: "Personio", smartrecruiters: "SmartRecruiters", workable: "Workable", recruitee: "Recruitee", workday: "Workday", manual: "External" };
  box.innerHTML = rows.map(r => `
    <div class="aa-row" data-id="${r.id}">
      <div class="aa-row-top">
        <span class="aa-title">${esc(shortTitle(r))}${r.company ? " · " + esc(r.company) : ""}</span>
        ${r.platform ? `<span class="aa-plat">${esc(platLabel[r.platform] || r.platform)}</span>` : ""}
        <span class="aa-badge aa-${esc(r.status)}">${esc(statusText[r.status] || r.status)}</span>
      </div>
      <div class="aa-meta">
        ${r.is_search
          ? "search task" + (r.status === "expanded" ? " · done" : " · waiting to expand")
          : (r.filled ? r.filled + " fields filled" : "not filled yet") + (r.cv_used ? " · CV: " + esc(r.cv_used) : "")}
        ${r.reason ? " · " + esc(r.reason) : ""}${r.updated_at ? " · " + new Date(r.updated_at).toLocaleDateString() : ""}
      </div>
      <div class="aa-detail">
        ${r.url ? `<div style="margin-bottom:6px;"><a href="#" data-ext="${esc(r.url)}">Open job in browser →</a></div>` : ""}
        ${r.is_search ? '<span class="muted">This search auto-queues every Easy-Apply job it finds.</span>'
          : (r.answers || []).length ? `<table>${r.answers.map(a =>
              `<tr><td>${esc(a.label)}</td><td>${esc(String(a.value))}</td></tr>`).join("")}</table>`
            : '<span class="muted">No screening answers were needed.</span>'}
      </div>
    </div>`).join("");
  $all(".aa-row").forEach(row => row.addEventListener("click", e => {
    if (e.target.closest("a") || e.target.closest("[data-ext]")) return;
    row.classList.toggle("open");
  }));
}

$("#aa-toggle")?.addEventListener("click", async () => {
  try {
    await API.post("/applications/auto-apply/toggle", {
      enabled: !aaEnabled, daily_cap: +$("#aa-cap").value || 15,
      mode: $("#aa-mode").value,
      portal_auto_submit: $("#aa-portal-submit").value === "1",
    });
  } catch {}
  refreshAutoApply();
});

$("#aa-queue")?.addEventListener("click", async () => {
  const urls = $("#aa-urls").value.split("\n").map(u => u.trim()).filter(Boolean);
  if (!urls.length) return;
  const st = $("#aa-queue-status");
  try {
    const r = await API.post("/applications/queue", { urls, time_range: $("#aa-time-range")?.value || "any" });
    st.textContent = `${r.queued} added${r.skipped ? `, ${r.skipped} skipped` : ""}. Searches expand into individual jobs once automation runs.`;
    $("#aa-urls").value = "";
    refreshAutoApply();
  } catch (e) { st.textContent = "Failed: " + e.message; }
});

$("#aa-mode")?.addEventListener("change", async () => {
  try { await API.post("/applications/auto-apply/toggle", { enabled: aaEnabled, mode: $("#aa-mode").value }); } catch {}
});
$("#aa-portal-submit")?.addEventListener("change", async () => {
  try { await API.post("/applications/auto-apply/toggle", { enabled: aaEnabled, portal_auto_submit: $("#aa-portal-submit").value === "1" }); } catch {}
});

$("#aa-clear-queue")?.addEventListener("click", async () => {
  if (!confirm("Remove all queued jobs and pending searches?")) return;
  try {
    const r = await API.post("/applications/auto-apply/clear-queue", {});
    $("#aa-queue-status").textContent = `${r.removed} removed from queue.`;
  } catch (e) { $("#aa-queue-status").textContent = "Failed: " + e.message; }
  refreshAutoApply();
});

$all(".aa-chip").forEach(c => c.addEventListener("click", () => {
  const ta = $("#aa-urls");
  ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + c.dataset.fill;
  ta.focus();
}));

$all(".aa-plat-tab").forEach(t => t.addEventListener("click", () => {
  $all(".aa-plat-tab").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  aaPlatform = t.dataset.plat;
  loadAutoApplyLog();
}));

function startAaPoll(){ stopAaPoll(); aaPollTimer = setInterval(refreshAutoApply, 5000); }
function stopAaPoll(){ if (aaPollTimer) { clearInterval(aaPollTimer); aaPollTimer = null; } }

$all(".sidebar a").forEach(a => a.addEventListener("click", () => {
  if (a.dataset.tab === "autoapply") { refreshAutoApply(); startAaPoll(); }
  else stopAaPoll();
}));
