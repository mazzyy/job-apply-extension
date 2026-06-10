//! Tauri `invoke()` commands callable from the frontend JS.

use crate::{ollama, AppState};
use serde::Serialize;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use futures_util::StreamExt;

#[derive(Serialize)]
pub struct BackendStatus {
    pub ready: bool,
    pub port: u16,
    pub url: String,
}

#[tauri::command]
pub async fn backend_status(state: State<'_, AppState>) -> Result<BackendStatus, String> {
    let port = *state.port.lock().unwrap();
    let ready = state.backend.lock().unwrap().is_some();
    Ok(BackendStatus {
        ready,
        port,
        url: format!("http://127.0.0.1:{}", port),
    })
}

#[tauri::command]
pub async fn backend_url(state: State<'_, AppState>) -> Result<String, String> {
    let port = *state.port.lock().unwrap();
    Ok(format!("http://127.0.0.1:{}", port))
}

#[tauri::command]
pub async fn check_first_run(state: State<'_, AppState>) -> Result<bool, String> {
    let port = *state.port.lock().unwrap();
    let url = format!("http://127.0.0.1:{}/cvs/", port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let cvs: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let empty = cvs.as_array().map(|a| a.is_empty()).unwrap_or(true);
    Ok(empty)
}

#[derive(Serialize, Clone)]
pub struct PullProgress {
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub percent: Option<u8>,
}

/// Pull a model via Ollama's HTTP API, streaming progress events to the
/// frontend. Returns when the pull completes or fails.
#[tauri::command]
pub async fn pull_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    // Ensure Ollama is running first
    let data_dir = state.data_dir.lock().unwrap().clone();
    let handle = ollama::ensure_running(&data_dir).await?;
    *state.ollama.lock().unwrap() = Some(handle);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60 * 30))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({ "name": name, "stream": true });
    let resp = client
        .post("http://127.0.0.1:11434/api/pull")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ollama pull request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("ollama returned HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim();
            if line.is_empty() { continue; }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                let status = v.get("status")
                    .and_then(|s| s.as_str()).unwrap_or("").to_string();
                let completed = v.get("completed").and_then(|x| x.as_u64());
                let total = v.get("total").and_then(|x| x.as_u64());
                let percent = match (completed, total) {
                    (Some(c), Some(t)) if t > 0 => Some(((c * 100) / t) as u8),
                    _ => None,
                };
                let progress = PullProgress { status, completed, total, percent };
                let _ = app.emit("pull-progress", progress);
            }
        }
    }
    let _ = app.emit("pull-progress", PullProgress {
        status: "done".to_string(),
        completed: None, total: None, percent: Some(100),
    });
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct ProviderInput {
    pub provider: String,
    pub local_model: Option<String>,
}

#[tauri::command]
pub async fn set_provider(
    state: State<'_, AppState>,
    input: ProviderInput,
) -> Result<(), String> {
    let port = *state.port.lock().unwrap();
    let url = format!("http://127.0.0.1:{}/settings/", port);
    let body = serde_json::json!({
        "llm_provider": input.provider,
        "local_model": input.local_model,
    });
    let client = reqwest::Client::new();
    client.put(&url).json(&body).send().await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_dashboard(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let port = *state.port.lock().unwrap();
    let url = format!("http://127.0.0.1:{}/dashboard/", port);
    let window = app.get_webview_window("main").ok_or("main window missing")?;
    window.eval(&format!("window.location.href = '{}'", url)).map_err(|e| e.to_string())?;
    Ok(())
}


#[derive(Serialize)]
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub managed: bool,
}

#[tauri::command]
pub async fn ollama_status(state: State<'_, AppState>) -> Result<OllamaStatus, String> {
    let managed = state.ollama.lock().unwrap().is_some();
    Ok(OllamaStatus {
        installed: ollama::is_installed() || managed,
        running: ollama::is_running().await,
        managed,
    })
}
