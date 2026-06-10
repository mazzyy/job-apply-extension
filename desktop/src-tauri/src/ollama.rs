//! Ollama supervision with auto-install.
//!
//! Strategy:
//!   1. If Ollama is already running on :11434, reuse it (don't kill on exit).
//!   2. Resolve a binary: system `ollama` in PATH, else our managed copy in
//!      <data_dir>/ollama/, else DOWNLOAD the official standalone build into
//!      <data_dir>/ollama/ (first launch only).
//!   3. Spawn `ollama serve` from the resolved binary.
//!   4. The handle is killed by lib.rs on app exit — Ollama stops with the app.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use futures_util::StreamExt;

pub struct OllamaHandle {
    child: Option<Child>,
}

impl OllamaHandle {
    pub fn kill(mut self) -> std::io::Result<()> {
        if let Some(mut c) = self.child.take() {
            log::info!("Stopping managed Ollama (pid {})", c.id());
            let _ = c.kill();
            let _ = c.wait();
        } else {
            log::info!("Ollama was externally managed — leaving it running");
        }
        Ok(())
    }
}

pub fn is_installed() -> bool {
    which::which("ollama").is_ok()
}

fn managed_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("ollama")
}

fn managed_binary(data_dir: &Path) -> PathBuf {
    let dir = managed_dir(data_dir);
    if cfg!(windows) { dir.join("ollama.exe") } else { dir.join("ollama") }
}

/// The official standalone archive for this OS/arch.
fn download_url() -> Result<&'static str, String> {
    if cfg!(target_os = "macos") {
        Ok("https://ollama.com/download/ollama-darwin.tgz")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Ok("https://ollama.com/download/ollama-linux-amd64.tgz")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Ok("https://ollama.com/download/ollama-linux-arm64.tgz")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok("https://ollama.com/download/ollama-windows-amd64.zip")
    } else {
        Err("Unsupported platform for Ollama auto-install".into())
    }
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

/// Resolve a usable ollama binary path: system PATH > managed copy > None.
fn resolve_binary(data_dir: &Path) -> Option<PathBuf> {
    if let Ok(p) = which::which("ollama") {
        return Some(p);
    }
    let managed = managed_binary(data_dir);
    if managed.is_file() { return Some(managed); }
    None
}

/// Download + extract the standalone Ollama build into <data_dir>/ollama/.
/// `progress` is called with (downloaded_bytes, total_bytes).
pub async fn install(data_dir: &Path, mut progress: impl FnMut(u64, u64)) -> Result<PathBuf, String> {
    let url = download_url()?;
    let dir = managed_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;

    log::info!("Downloading Ollama from {}", url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1800))
        .build().map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| format!("download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("download returned HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let archive_path = dir.join(if url.ends_with(".zip") { "ollama-download.zip" } else { "ollama-download.tgz" });
    {
        let mut file = std::fs::File::create(&archive_path).map_err(|e| e.to_string())?;
        let mut stream = resp.bytes_stream();
        let mut done: u64 = 0;
        use std::io::Write;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download stream error: {}", e))?;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            done += chunk.len() as u64;
            progress(done, total);
        }
    }

    log::info!("Extracting {}", archive_path.display());
    if archive_path.extension().and_then(|e| e.to_str()) == Some("zip") {
        let f = std::fs::File::open(&archive_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("bad zip: {}", e))?;
        zip.extract(&dir).map_err(|e| format!("unzip failed: {}", e))?;
    } else {
        let f = std::fs::File::open(&archive_path).map_err(|e| e.to_string())?;
        let gz = flate2::read::GzDecoder::new(f);
        let mut tar = tar::Archive::new(gz);
        tar.unpack(&dir).map_err(|e| format!("untar failed: {}", e))?;
    }
    let _ = std::fs::remove_file(&archive_path);

    // tgz layouts differ: darwin = ./ollama at root, linux = ./bin/ollama.
    let candidates = [
        managed_binary(data_dir),
        dir.join("bin").join("ollama"),
    ];
    let mut bin = None;
    for c in &candidates {
        if c.is_file() { bin = Some(c.clone()); break; }
    }
    let bin = bin.ok_or("Ollama binary not found after extraction")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
    }
    log::info!("Ollama installed at {}", bin.display());
    Ok(bin)
}

/// Ensure Ollama is installed (downloading if necessary) and running.
/// Returns a handle that kills the process on app exit (None child = external).
pub async fn ensure_running_with_install(
    data_dir: &Path,
    progress: impl FnMut(u64, u64),
) -> Result<OllamaHandle, String> {
    if is_running().await {
        log::info!("Ollama already running on :11434");
        return Ok(OllamaHandle { child: None });
    }

    let bin = match resolve_binary(data_dir) {
        Some(b) => b,
        None => install(data_dir, progress).await?,
    };

    log::info!("Starting `{} serve`", bin.display());
    let child = Command::new(&bin)
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn ollama: {}", e))?;

    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(20) {
        if is_running().await {
            log::info!("Ollama serve healthy");
            return Ok(OllamaHandle { child: Some(child) });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("Ollama failed to come up within 20 seconds".into())
}

/// Back-compat wrapper used by pull_model: no auto-install, PATH/managed only.
pub async fn ensure_running(data_dir: &Path) -> Result<OllamaHandle, String> {
    if is_running().await {
        return Ok(OllamaHandle { child: None });
    }
    let bin = resolve_binary(data_dir)
        .ok_or("Ollama is not installed yet — it downloads automatically on app start, or install from https://ollama.com/download")?;
    let child = Command::new(&bin)
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn ollama: {}", e))?;
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        if is_running().await {
            return Ok(OllamaHandle { child: Some(child) });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("Ollama failed to come up within 15 seconds".into())
}
