import { invoke } from "https://esm.sh/@tauri-apps/api@2/core";
import { listen } from "https://esm.sh/@tauri-apps/api@2/event";

const messageEl = document.getElementById("message");
const errorPanel = document.getElementById("error-panel");
const errorDetail = document.getElementById("error-detail");
const retryBtn = document.getElementById("retry");

function setMessage(text) { messageEl.textContent = text; }
function showError(detail) {
  errorPanel.classList.remove("hidden");
  errorDetail.textContent = detail;
}

async function boot() {
  setMessage("Starting backend…");

  // Listen for the backend-ready event the Rust side emits
  const unlistenReady = await listen("backend-ready", async (event) => {
    setMessage("Backend ready, loading dashboard…");
    const port = event.payload;
    // Check if this is a first run — if no CV yet, send to onboarding.
    try {
      const firstRun = await invoke("check_first_run");
      if (firstRun) {
        window.location.href = "./onboarding.html";
      } else {
        window.location.href = `http://127.0.0.1:${port}/dashboard/`;
      }
    } catch (e) {
      // Default: go to dashboard
      window.location.href = `http://127.0.0.1:${port}/dashboard/`;
    }
  });

  // Listen for backend errors
  await listen("backend-error", (event) => {
    showError(event.payload || "Unknown backend error");
  });

  // Already ready? (in case the event fired before we subscribed)
  try {
    const status = await invoke("backend_status");
    if (status.ready) {
      const firstRun = await invoke("check_first_run").catch(() => false);
      window.location.href = firstRun
        ? "./onboarding.html"
        : `http://127.0.0.1:${status.port}/dashboard/`;
    }
  } catch (e) { /* expected if backend not ready yet */ }
}

retryBtn.addEventListener("click", () => window.location.reload());

boot();
