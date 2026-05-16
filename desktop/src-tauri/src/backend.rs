//! Backend supervision.
//!
//! Dev-friendly flow:
//!   1. If a backend is already healthy on port 8000 (e.g. `bash run.sh` is
//!      running in another terminal), reuse it. No child process spawned.
//!   2. Otherwise, try to spawn one ourselves:
//!        - release: run the PyInstaller binary in <resource_dir>/backend/
//!        - dev:     run `python3 -m uvicorn app.main:app` from ../backend/
//!   3. Either way, wait for /health 200 before declaring ready.
//!
//! On Mac/Windows, subprocesses spawned by Tauri inherit a stripped-down PATH
//! that may not include Conda or pyenv. If the spawn fails, surface the
//! child's stderr to the Tauri terminal (lines prefixed `[backend]`).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub struct BackendHandle {
    pub port: u16,
    /// Only Some() when we spawned the backend ourselves; None when we reused
    /// an externally-managed backend (don't kill it on exit).
    child: Option<Child>,
}

impl BackendHandle {
    pub fn kill(mut self) -> std::io::Result<()> {
        if let Some(mut c) = self.child.take() {
            log::info!("Killing backend (pid {})", c.id());
            let _ = c.kill();
            let _ = c.wait();
        } else {
            log::info!("Reused external backend — leaving it running");
        }
        Ok(())
    }
}

async fn is_healthy(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(format!("http://127.0.0.1:{}/health", port))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn find_free_port() -> u16 {
    for port in 8000..8100 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    0
}

fn resolve_bundled_binary(resource_dir: &Option<PathBuf>) -> Option<PathBuf> {
    let resource_dir = resource_dir.as_ref()?;
    let exe_name = if cfg!(windows) {
        "jobapply-backend.exe"
    } else {
        "jobapply-backend"
    };
    let candidate = resource_dir.join("backend").join(exe_name);
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

fn resolve_dev_backend() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?;
    let mut p = exe_dir.parent()?.to_path_buf();
    for _ in 0..8 {
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
    let bundled = resolve_bundled_binary(&resource_dir);

    // --- 1. Reuse an already-running backend ONLY in dev mode (no bundled binary).
    //        In release / installed mode, always spawn our own bundled backend
    //        so the user isn't dependent on an external process they can't see. ---
    if bundled.is_none() {
        for port in [8000_u16, 8001, 8002] {
            if is_healthy(port).await {
                log::info!("Dev mode — reusing existing backend on port {}", port);
                return Ok(BackendHandle { port, child: None });
            }
        }
    }

    // --- 2. Spawn our own. Prefer 8000 (matches the Chrome extension's default). ---
    let port = find_free_port();
    if port == 0 {
        return Err("No free port 8000–8100 available".into());
    }

    let mut command = if let Some(bin) = bundled {
        log::info!("Starting bundled backend: {}", bin.display());
        let mut c = Command::new(&bin);
        if let Some(parent) = bin.parent() {
            c.current_dir(parent);
        }
        c
    } else {
        let backend_dir = resolve_dev_backend().ok_or_else(|| {
            "Could not find bundled backend or dev backend/. Either build the bundle (cd backend && bash build.sh) or start a backend manually with `bash run.sh` in another terminal — Tauri will detect and reuse it.".to_string()
        })?;
        log::info!("Dev mode — spawning uvicorn from {}", backend_dir.display());
        let python = if cfg!(windows) { "python" } else { "python3" };
        let mut c = Command::new(python);
        c.arg("-m")
            .arg("uvicorn")
            .arg("app.main:app")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string());
        c.current_dir(backend_dir);
        c
    };

    command
        .env("JAA_DATA_DIR", &data_dir)
        .env("JAA_PORT", port.to_string())
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("spawn failed: {} (is python3 in PATH?)", e))?;

    // Tee stdout + stderr to our log
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().flatten() {
                log::info!("[backend] {}", line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
                log::warn!("[backend] {}", line);
            }
        });
    }

    // Poll /health for up to 60s; check for child exit too so we don't spin forever
    let url = format!("http://127.0.0.1:{}/health", port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    loop {
        if let Ok(Some(exit_status)) = child.try_wait() {
            return Err(format!(
                "Backend process exited early with status: {}. Check the Tauri terminal for [backend] lines.",
                exit_status
            ));
        }
        if start.elapsed() > Duration::from_secs(60) {
            let _ = child.kill();
            return Err("Backend health-check timed out after 60s. Likely Python or dependencies missing — try `pip install -r requirements.txt` in backend/, then start it with `bash run.sh` in another terminal and relaunch the app.".into());
        }
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                log::info!("Backend healthy on port {}", port);
                return Ok(BackendHandle {
                    port,
                    child: Some(child),
                });
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
