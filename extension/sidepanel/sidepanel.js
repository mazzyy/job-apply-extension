const $ = s => document.querySelector(s);

function fitClass(s){ return s>=80?"good":s>=60?"warn":"bad"; }
function esc(s){ return (s||"").toString().replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

async function loadActiveCv(){
  try {
    const resp = await chrome.runtime.sendMessage({ type: "API_GET", path: "/cvs/active" });
    if (resp?.ok) $("#cv-active").textContent = `CV: ${resp.data.label}`;
  } catch {}
}

function render(r){
  const score = Math.round(r.fit_score || 0);
  const lang = r.language || {};
  const langPills = (lang.requires_other_languages || []).map(l=>`<span class="pill lang">${esc(l)} required</span>`).join("") || `<span class="pill good">English OK</span>`;
  $("#result").innerHTML = `
    <div style="display:flex;gap:14px;align-items:center;">
      <div class="score">${score}<span style="font-size:13px;color:#6b7280">/100</span></div>
      <span class="pill ${fitClass(score)}">${esc(r.fit_label||"")}</span>
    </div>
    <div style="margin-top:6px">${langPills}</div>
    <div style="margin-top:8px;font-size:12px;color:#374151">${esc(r.verdict||"")}</div>
    <h4 style="margin:10px 0 2px;font-size:12px">Strengths</h4>
    <ul>${(r.strengths||[]).map(s=>`<li>${esc(s)}</li>`).join("")||"<li>—</li>"}</ul>
    <h4 style="margin:8px 0 2px;font-size:12px">Gaps</h4>
    <ul>${(r.gaps||[]).map(s=>`<li>${esc(s)}</li>`).join("")||"<li>—</li>"}</ul>
    <h4 style="margin:8px 0 2px;font-size:12px">Recommendations</h4>
    <ul>${(r.recommendations||[]).map(s=>`<li>${esc(s)}</li>`).join("")||"<li>—</li>"}</ul>
  `;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ANALYSIS_RESULT") render(msg.data);
});

$("#autofill").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.JAA_Autofill?.fillAll(),
  });
});

$("#open-dash").addEventListener("click", () => {
  chrome.tabs.create({ url: "http://localhost:5500/index.html" });
});

(async () => {
  const { apiBase } = await chrome.storage.sync.get("apiBase");
  $("#api-base").value = apiBase || "http://localhost:8000";
})();

$("#save-settings").addEventListener("click", async () => {
  await chrome.storage.sync.set({ apiBase: $("#api-base").value.trim() });
  $("#settings-status").textContent = "Saved.";
  setTimeout(()=>$("#settings-status").textContent="", 1500);
});

loadActiveCv();
