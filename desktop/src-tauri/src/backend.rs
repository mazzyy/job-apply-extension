//! Spawns and supervises the FastAPI backend.
//!
//! In **release builds**, runs the PyInstaller-bundled binary located at
//! `<resource_dir>/backend/jobapply-backend(.exe)`.
//!
//! In **debug builds**, looks for `../../backend/run.py` relative to the
//! desktop crate and runs `python3 -m uvicorn app.main:app` so devs don't
//! have to rebuild the bundle on every code change.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use std::io::{BufRead, BufReader};

pub struct BackendHandle {
    pub port: u16,
    child: Child,
}

impl BackendHandle {
    pub fn kill(mut self) -> std::io::Result<()> {
        log::info!("Killing backend (pid {})", self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        Ok(())
    }
}

fn find_free_port() -> u16 {
    // Try 8000 first (matches the Chrome extension's default), then walk up.
    for port in 8000..8100 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    0
}

fn resolve_bundled_binary(resource_dir: &Option<PathBuf>) -> Option<PathBuf> {
    let resource_dir = resource_dir.as_ref()?;
    let exe_name = if cfg!(windows) { "jobapply-backend.exe" } else { "jobapply-backend" };
    let candidate = resource_dir.join("backend").join(exe_name);
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

fn resolve_dev_backend() -> Option<PathBuf> {
    // From desktop/src-tauri/ go up two levels to project root, then backend/
    let exe_dir = std::env::current_exe().ok()?;
    let mut p = exe_dir.parent()?.to_path_buf();
    for _ in 0..6 {
        let candidate = p.join("backend").join("run.py");
        if candidate.exists() {
            return Some(p.join("backend"));
        }
        p = p.parent()?.to_path_buf();
    }
    None
}

pub async fn spawn(
    resource_dir: Option<PathBuf>,
    data_dir: PathBuf,
) -> Result<BackendHandle, String> {
    let port = find_free_port();
    if port == 0 {
        return Err("No free port 8000-8100 available".into());
    }

    let bundled = resolve_bundled_binary(&resource_dir);
    let mut command = if let Some(bin) = bundled {
        log::info!("Starting bundled backend: {}", bin.display());
        let mut c = Command::new(&bin);
        c.current_dir(bin.parent().unwrap());
        c
    } else {
        // Dev fallback
        let backend_dir = resolve_dev_backend()
            .ok_or_else(|| "Could not locate bundled backend OR dev backend/ folder".to_string())?;
        log::info!("Dev mode — running uvicorn from {}", backend_dir.display());
        let python = if cfg!(windows) { "python" } else { "python3" };
        let mut c = Command::new(python);
        c.arg("-m").arg("uvicorn").arg("app.main:app")
            .arg("--host").arg("127.0.0.1")
            .arg("--port").arg(port.to_string());
        c.current_dir(backend_dir);
        c
    };

    command
        .env("JAA_DATA_DIR", &data_dir)
        .env("JAA_PORT", port.to_string())
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| format!("spawn failed: {}", e))?;

    // Tee stdout/stderr to our log so errors are visible
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            let r = BufReader::new(out);
            for line in r.lines().flatten() {
                log::info!("[backend] {}", line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            let r = BufReader::new(err);
            for line in r.lines().flatten() {
                log::warn!("[backend] {}", line);
            }
        });
    }

    // Poll /health until 200 or 60s timeout
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{}/health", port);
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(60) {
            let _ = child.kill();
            return Err("Backend health-check timed out after 60s".into());
        }
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                log::info!("Backend healthy on port {}", port);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Ok(BackendHandle { port, child })
}
