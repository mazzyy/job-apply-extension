const $ = s => document.querySelector(s);
const $all = s => Array.from(document.querySelectorAll(s));

const API = {
  get base(){ return localStorage.getItem("apiBase") || "http://localhost:8000"; },
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
function fitClass(s){ s=+s||0; return s>=80?"good":s>=60?"warn":"bad"; }

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
    $("#stat-applied").textContent = s.applied;
    $("#stat-interview").textContent = s.interview;
    $("#stat-offer").textContent = s.offer;
    $("#stat-avg-fit").textContent = s.avg_fit;

    const total = Math.max(1, Math.max(...Object.values(s.fit_buckets)));
    $("#fit-buckets").innerHTML = Object.entries(s.fit_buckets).map(([k,v]) => `
      <div class="bucket"><span>${v}</span>
        <div class="bar" style="height:${(v/total)*100}%"></div>
        <label>${k}</label>
      </div>`).join("");

    const maxS = Math.max(1, ...Object.values(s.by_source || {0:1}));
    $("#by-source").innerHTML = Object.entries(s.by_source || {}).map(([k,v]) => `
      <div class="bucket"><span>${v}</span>
        <div class="bar" style="height:${(v/maxS)*100}%"></div>
        <label>${esc(k || "other")}</label>
      </div>`).join("") || `<div class="muted">No applications yet.</div>`;
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
}
$("#filter-search").addEventListener("input", renderApps);
$("#filter-status").addEventListener("change", renderApps);

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
    ${a.url ? `<p class="muted" style="margin-top:14px"><a href="${esc(a.url)}" target="_blank">Open original job posting →</a></p>` : ""}
  `;
  $("#app-detail").showModal();
  $all("#app-detail-body button[data-status]").forEach(b => b.addEventListener("click", async (e) => {
    e.preventDefault();
    await API.patch(`/applications/${a.id}`, { status: b.dataset.status });
    $("#app-detail").close();
    await Promise.all([loadStats(), loadApps()]);
  }));
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
      <div style="margin-top:8px">
        ${!c.is_active ? `<button data-id="${c.id}" class="activate">Make active</button>` : ""}
        <button data-id="${c.id}" class="danger del">Delete</button>
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
    const el = document.querySelector(`#profile-form [name="${k}"]`);
    if (el && typeof v !== "object") el.value = v ?? "";
  }
}
$("#profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {};
  fd.forEach((v, k) => body[k] = v || null);
  if (body.years_experience) body.years_experience = +body.years_experience;
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
    <div class="stat"><span>${f.analyzed||0}</span><label>Analyzed</label></div>
    <div class="stat"><span>${f.applied||0}</span><label>Applied</label></div>
    <div class="stat"><span>${f.interview||0}</span><label>Interviewing</label></div>
    <div class="stat"><span>${f.offer||0}</span><label>Offers</label></div>
    <div class="stat"><span>${r.response_rate||0}%</span><label>Response rate</label></div>`;

  // Fit by outcome
  const fits = o.avg_fit_by_outcome || {};
  const keys = ["all","interview","rejected","offer"];
  const maxF = Math.max(1, ...keys.map(k=>fits[k]||0));
  $("#fit-by-outcome").innerHTML = keys.map(k=>`
    <div class="bucket"><span>${fits[k]||0}</span>
      <div class="bar" style="height:${((fits[k]||0)/maxF)*100}%"></div>
      <label>${esc(k)}</label></div>`).join("");

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
  const langMax = Math.max(1, ...Object.values(lang));
  $("#lang-demand").innerHTML = Object.keys(lang).length
    ? Object.entries(lang).map(([k,v])=>`<div class="bucket"><span>${v}</span><div class="bar" style="height:${(v/langMax)*100}%"></div><label>${esc(k)}</label></div>`).join("")
    : '<div class="muted">All English so far.</div>';
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
  const def = (q.answers || []).find(a => a.is_default);
  const opts = q.last_options ? JSON.parse(q.last_options) : null;
  const inputType = q.last_input_type || "text";
  const value = def?.answer || "";
  const inputHtml = renderAnswerInput(q.id, inputType, opts, value);
  return `<div class="bank-row" data-qid="${q.id}" style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed #f1f5f9">
    <div style="flex:1;min-width:0">
      <div class="bank-q-view" style="font-size:13px;${def?'':'color:#92400e'}">
        ${esc(q.text)}${def?' <span style="color:#16a34a">✓</span>':''}
        <button class="ghost edit-q" style="background:none;border:none;color:#6b7280;cursor:pointer;font-size:11px;padding:2px 6px;margin-left:6px">edit</button>
        <span class="muted" style="font-size:11px">[${esc(inputType)}${opts ? ` · ${opts.length} opts` : ''}]</span>
      </div>
      <div class="bank-q-edit hidden" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        <input class="eq-text" value="${esc(q.text)}" style="flex:1;min-width:240px"/>
        <select class="eq-type" style="max-width:140px">
          ${["number","text","textarea","select","radio"].map(t => `<option ${t===inputType?'selected':''}>${t}</option>`).join("")}
        </select>
        <input class="eq-options" placeholder="opts (comma-sep)" value="${esc(opts?opts.join(", "):'')}" style="flex:1;min-width:200px"/>
        <button class="eq-save secondary">Save</button>
        <button class="eq-cancel ghost" style="background:none;border:none;cursor:pointer;color:#6b7280">cancel</button>
      </div>
      <div class="bank-input-wrap" style="margin-top:2px">${inputHtml}</div>
    </div>
    <button class="secondary save-bank" data-qid="${q.id}" data-aid="${def?.id || ''}">Save</button>
    <button class="danger del-bank" data-qid="${q.id}" title="Delete question" style="padding:6px 8px">×</button>
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
  if ($("#local-model")) $("#local-model").value = s.local_model || "llama3.2:3b";
  if ($("#local-base-url")) $("#local-base-url").value = s.local_base_url || "http://localhost:11434/v1";

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
  // Show/hide local config based on mode
  const localCfg = $("#local-config");
  if (localCfg) localCfg.style.opacity = (mode === "cloud") ? "0.5" : "1";
}

document.querySelectorAll("input[name=provider]").forEach(r => r.addEventListener("change", () => {
  const localCfg = $("#local-config");
  if (localCfg) localCfg.style.opacity = (r.value === "cloud") ? "0.5" : "1";
}));

$("#save-provider")?.addEventListener("click", async () => {
  const provider = document.querySelector("input[name=provider]:checked")?.value || "cloud";
  const local_model = $("#local-model")?.value || "llama3.2:3b";
  const local_base_url = $("#local-base-url")?.value || "http://localhost:11434/v1";
  const per_task = {};
  document.querySelectorAll("#per-task-grid select").forEach(sel => {
    if (sel.value) per_task[sel.dataset.task] = sel.value;
  });
  $("#provider-status").textContent = "Saving…";
  await API.put("/settings/", { llm_provider: provider, local_model, local_base_url, per_task });
  $("#provider-status").textContent = "Saved.";
  setTimeout(() => $("#provider-status").textContent = "", 1800);
  await checkApi();
});

$("#test-connection")?.addEventListener("click", async () => {
  $("#provider-status").textContent = "Pinging deployment…";
  try {
    const r = await API.post("/verify-model", {});
    if (r.ok) {
      $("#provider-status").innerHTML = `<span style="color:#16a34a">✓ ${esc(r.provider||'?')} · ${esc(r.model||'?')} replied: ${esc(r.reply||'')}</span>`;
    } else {
      $("#provider-status").innerHTML = `<span style="color:#b91c1c">✗ ${esc(r.error||'failed')}</span>`;
    }
  } catch (e) {
    $("#provider-status").innerHTML = `<span style="color:#b91c1c">Error: ${esc(e.message)}</span>`;
  }
});

// Load when Settings tab activates
document.querySelectorAll(".sidebar a").forEach(a => a.addEventListener("click", () => {
  if (a.dataset.tab === "settings") loadProviderSettings();
}));
