// Job Apply Assistant — Tauri 2.x application entrypoint.
//
// Responsibilities:
//   1. Resolve the data directory (per-OS app-data folder)
//   2. Spawn the FastAPI backend as a subprocess (either bundled binary in
//      release, or `python -m uvicorn` in dev)
//   3. Spawn Ollama if needed (only when settings.llm_provider != "cloud")
//   4. Wait for the backend's /health endpoint to return 200
//   5. Navigate the main webview to http://localhost:8000/dashboard/
//   6. On exit, kill both subprocesses cleanly

mod backend;
mod ollama;
mod commands;

use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

pub struct AppState {
    pub backend: Mutex<Option<backend::BackendHandle>>,
    pub ollama: Mutex<Option<ollama::OllamaHandle>>,
    pub port: Mutex<u16>,
    pub data_dir: Mutex<std::path::PathBuf>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            backend: Mutex::new(None),
            ollama: Mutex::new(None),
            port: Mutex::new(8000),
            data_dir: Mutex::new(std::path::PathBuf::new()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::backend_status,
            commands::backend_url,
            commands::pull_model,
            commands::check_first_run,
            commands::set_provider,
            commands::open_dashboard,
            commands::ollama_status,
        ])
        .setup(|app| {
            // Resolve the writable data directory (set via env so the backend picks it up)
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Could not resolve app_data_dir");
            std::fs::create_dir_all(&data_dir).ok();
            std::env::set_var("JAA_DATA_DIR", &data_dir);
            log::info!("JAA_DATA_DIR={}", data_dir.display());
            *app.state::<AppState>().data_dir.lock().unwrap() = data_dir.clone();

            // Spawn backend on a worker thread so app boot isn't blocked
            let app_handle = app.handle().clone();
            let resource_dir = app
                .path()
                .resource_dir()
                .ok();
            tauri::async_runtime::spawn(async move {
                match backend::spawn(resource_dir, data_dir).await {
                    Ok(handle) => {
                        let port = handle.port;
                        let state = app_handle.state::<AppState>();
                        *state.port.lock().unwrap() = port;
                        *state.backend.lock().unwrap() = Some(handle);
                        let _ = app_handle.emit("backend-ready", port);
                        log::info!("Backend ready on port {}", port);
                    }
                    Err(e) => {
                        log::error!("Backend failed to start: {}", e);
                        let _ = app_handle.emit("backend-error", e.to_string());
                    }
                }
            });

            // Start (and on first launch, download) Ollama alongside the app.
            // It's killed in RunEvent::ExitRequested below, so it stops with the app.
            let ollama_handle_app = app.handle().clone();
            let ollama_data_dir = app
                .path()
                .app_data_dir()
                .expect("Could not resolve app_data_dir");
            tauri::async_runtime::spawn(async move {
                let app2 = ollama_handle_app.clone();
                let mut last_pct: i8 = -1;
                let result = ollama::ensure_running_with_install(&ollama_data_dir, move |done, total| {
                    let pct = if total > 0 { ((done * 100) / total) as i8 } else { -1 };
                    if pct != last_pct {
                        last_pct = pct;
                        let _ = app2.emit("ollama-install-progress", serde_json::json!({
                            "downloaded": done, "total": total, "percent": pct,
                        }));
                    }
                }).await;
                match result {
                    Ok(handle) => {
                        let state = ollama_handle_app.state::<AppState>();
                        *state.ollama.lock().unwrap() = Some(handle);
                        let _ = ollama_handle_app.emit("ollama-ready", true);
                        log::info!("Ollama ready");
                    }
                    Err(e) => {
                        log::warn!("Ollama not available: {}", e);
                        let _ = ollama_handle_app.emit("ollama-error", e.to_string());
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { .. } => {
                // Pull subprocess handles out of state, releasing the State borrow
                // before we call kill() on them. (Tauri State + MutexGuard lifetimes.)
                let state = app_handle.state::<AppState>();
                let backend = state.backend.lock().unwrap().take();
                let ollama = state.ollama.lock().unwrap().take();
                drop(state);
                if let Some(b) = backend { let _ = b.kill(); }
                if let Some(o) = ollama { let _ = o.kill(); }
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { .. },
                ..
            } => {
                log::info!("Window {} close requested", label);
            }
            _ => {}
        });
}
