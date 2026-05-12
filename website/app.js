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
    $("#api-status").textContent = `API connected · model ${h.model}`;
  } catch (e) {
    $("#api-status").textContent = "API unreachable — is the backend running?";
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
