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
        })
        .invoke_handler(tauri::generate_handler![
            commands::backend_status,
            commands::backend_url,
            commands::pull_model,
            commands::check_first_run,
            commands::set_provider,
            commands::open_dashboard,
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
