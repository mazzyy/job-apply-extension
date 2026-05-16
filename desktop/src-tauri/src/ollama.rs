//! Optional Ollama supervision.
//!
//! Strategy:
//!   1. If Ollama is already running on :11434, do nothing.
//!   2. If `ollama` is in PATH but not running, spawn `ollama serve`.
//!   3. If `ollama` is not installed, return Err — the frontend wizard then
//!      prompts the user to install it.

use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub struct OllamaHandle {
    child: Option<Child>,
}

impl OllamaHandle {
    pub fn kill(mut self) -> std::io::Result<()> {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        Ok(())
    }
}

pub fn is_installed() -> bool {
    which::which("ollama").is_ok()
}

pub async fn is_running() -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build();
    if let Ok(client) = client {
        client.get("http://127.0.0.1:11434/api/tags").send().await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    } else {
        false
    }
}

pub async fn ensure_running() -> Result<OllamaHandle, String> {
    if is_running().await {
        log::info!("Ollama already running on :11434");
        return Ok(OllamaHandle { child: None });
    }
    if !is_installed() {
        return Err("Ollama is not installed. Install from https://ollama.com/download".into());
    }
    log::info!("Starting `ollama serve`");
    let child = Command::new("ollama")
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn ollama: {}", e))?;

    // Wait up to 15s for Ollama to come up
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        if is_running().await {
            log::info!("Ollama serve healthy");
            return Ok(OllamaHandle { child: Some(child) });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("Ollama failed to come up within 15 seconds".into())
}
