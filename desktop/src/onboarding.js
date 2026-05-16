import { invoke } from "https://esm.sh/@tauri-apps/api@2/core";
import { listen } from "https://esm.sh/@tauri-apps/api@2/event";

const screens = {
  welcome: document.getElementById("screen-welcome"),
  mode: document.getElementById("screen-mode"),
  download: document.getElementById("screen-download"),
};
const trackSteps = document.querySelectorAll(".progress-track .step");
let currentMode = "hybrid";

function show(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle("active", k === name));
  trackSteps.forEach(s => s.classList.toggle("active", s.dataset.step === name));
}

// Navigation buttons
document.querySelectorAll("[data-next]").forEach(b => b.addEventListener("click", () => {
  show(b.dataset.next);
}));

// Mode "Continue" sets the chosen mode + advances
document.getElementById("mode-next").addEventListener("click", () => {
  currentMode = document.querySelector("input[name=mode]:checked").value;
  show("download");
  configureDownloadScreen();
});

function configureDownloadScreen() {
  const cloudOnly = document.getElementById("dl-cloud-only");
  const localFlow = document.getElementById("dl-local-flow");
  if (currentMode === "cloud") {
    cloudOnly.classList.remove("hidden");
    localFlow.classList.add("hidden");
    document.getElementById("dl-heading").textContent = "You're all set";
    document.getElementById("dl-lede").textContent = "Cloud mode doesn't need any downloads.";
    document.getElementById("finish").textContent = "Open dashboard →";
  } else {
    cloudOnly.classList.add("hidden");
    localFlow.classList.remove("hidden");
    document.getElementById("dl-heading").textContent = "Pick a local model";
    document.getElementById("dl-lede").textContent = "We'll download it now (~2–4 GB). One-time setup.";
    document.getElementById("finish").textContent = "Download & finish →";
  }
}

// Progress events from the Rust pull_model command
listen("pull-progress", (event) => {
  const p = event.payload || {};
  const fill = document.getElementById("progress-fill");
  const text = document.getElementById("progress-text");
  if (p.percent != null) fill.style.width = p.percent + "%";
  let msg = p.status || "working…";
  if (p.completed && p.total) {
    const mbDone = (p.completed / 1048576).toFixed(0);
    const mbTotal = (p.total / 1048576).toFixed(0);
    msg += ` — ${mbDone} / ${mbTotal} MB`;
  }
  if (p.percent != null) msg += `  (${p.percent}%)`;
  text.textContent = msg;
});

document.getElementById("finish").addEventListener("click", async () => {
  const btn = document.getElementById("finish");
  btn.disabled = true;

  try {
    if (currentMode === "cloud") {
      await invoke("set_provider", { input: { provider: "cloud", local_model: null } });
      goToDashboard();
      return;
    }

    const model = document.querySelector("input[name=model]:checked").value;

    // Persist mode + model first so even if download fails the user can retry from Settings
    await invoke("set_provider", { input: { provider: currentMode, local_model: model } });

    document.getElementById("dl-progress").classList.remove("hidden");
    document.getElementById("progress-text").textContent = "Starting download…";

    try {
      await invoke("pull_model", { name: model });
      goToDashboard();
    } catch (e) {
      // Probably Ollama isn't installed
      const isMissing = String(e).toLowerCase().includes("not installed");
      if (isMissing) {
        document.getElementById("ollama-missing").classList.remove("hidden");
        document.getElementById("dl-progress").classList.add("hidden");
        btn.textContent = "I've installed Ollama — retry";
        btn.disabled = false;
      } else {
        document.getElementById("progress-text").textContent = "Error: " + e;
        btn.textContent = "Retry";
        btn.disabled = false;
      }
    }
  } catch (e) {
    document.getElementById("progress-text") &&
      (document.getElementById("progress-text").textContent = "Error: " + e);
    btn.disabled = false;
  }
});

async function goToDashboard() {
  try {
    const { url } = await invoke("backend_status");
    window.location.href = url + "/dashboard/";
  } catch {
    window.location.href = "http://127.0.0.1:8000/dashboard/";
  }
}

// Boot
show("welcome");
configureDownloadScreen();
