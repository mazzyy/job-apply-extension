//! Integrated browser — a single child webview overlaid on the dashboard window.
//!
//! The dashboard (the website, shown in the "main" webview) stays the only UI /
//! sidebar. This module adds ONE extra webview ("browser") to that same window
//! and lets the dashboard show/position/hide it over the Auto-apply tab's content
//! area. The job engines are injected into it and run there.
//!
//! Multi-webview needs Tauri's `unstable` Cargo feature.
//!
//! Security: every command rejects calls coming FROM the browser webview, so a
//! remote job page can't drive the app even though it has minimal event IPC.

use std::path::PathBuf;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

const MAIN_LABEL: &str = "main";
const BROWSER_LABEL: &str = "browser";
const OFFSCREEN_X: f64 = -100000.0;

const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

fn automation_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        for c in [
            res.join("resources").join("automation"),
            res.join("automation"),
            res.join("_up_").join("resources").join("automation"),
        ] {
            if c.join("jaa_bridge.js").exists() {
                return Some(c);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut p = exe.parent()?.to_path_buf();
        for _ in 0..8 {
            let c = p.join("src-tauri").join("resources").join("automation");
            if c.join("jaa_bridge.js").exists() {
                return Some(c);
            }
            let c2 = p.join("resources").join("automation");
            if c2.join("jaa_bridge.js").exists() {
                return Some(c2);
            }
            p = p.parent()?.to_path_buf();
        }
    }
    None
}

fn read_automation(app: &AppHandle, file: &str) -> Result<String, String> {
    let dir = automation_dir(app).ok_or_else(|| "automation resources not found".to_string())?;
    std::fs::read_to_string(dir.join(file)).map_err(|e| format!("read {}: {}", file, e))
}

fn backend_port(app: &AppHandle) -> u16 {
    *app.state::<crate::AppState>().port.lock().unwrap()
}

/// Reject calls coming from the (untrusted, remote) browser webview.
fn guard(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() == BROWSER_LABEL {
        Err("forbidden".into())
    } else {
        Ok(())
    }
}

/// Lazily create the browser webview as a child of the dashboard window.
fn ensure_browser(app: &AppHandle) -> Result<tauri::Webview, String> {
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        return Ok(wv);
    }
    let win = app
        .get_window(MAIN_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;
    let port = backend_port(app);
    let bridge = read_automation(app, "jaa_bridge.js")?.replace("__PORT__", &port.to_string());

    let app_for_load = app.clone();
    let wv = win
        .add_child(
            WebviewBuilder::new(
                BROWSER_LABEL,
                WebviewUrl::External(Url::parse("about:blank").unwrap()),
            )
            .user_agent(CHROME_UA)
            .initialization_script(bridge.as_str())
            .on_page_load(move |_w, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    let _ = app_for_load.emit("browser-loaded", payload.url().to_string());
                }
            }),
            LogicalPosition::new(OFFSCREEN_X, 0.0),
            LogicalSize::new(800.0, 600.0),
        )
        .map_err(|e| format!("create browser webview: {}", e))?;
    Ok(wv)
}

#[tauri::command]
pub async fn browser_show(
    app: AppHandle,
    webview: tauri::Webview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    guard(&webview)?;
    let wv = ensure_browser(&app)?;
    let _ = wv.set_size(LogicalSize::new(width.max(50.0), height.max(50.0)));
    let _ = wv.set_position(LogicalPosition::new(x, y));
    Ok(())
}

#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    webview: tauri::Webview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    guard(&webview)?;
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        let _ = wv.set_size(LogicalSize::new(width.max(50.0), height.max(50.0)));
        let _ = wv.set_position(LogicalPosition::new(x, y));
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_hide(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    guard(&webview)?;
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        let _ = wv.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    webview: tauri::Webview,
    url: String,
) -> Result<(), String> {
    guard(&webview)?;
    let wv = ensure_browser(&app)?;
    let parsed = Url::parse(&url).map_err(|e| format!("bad url '{}': {}", url, e))?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_eval(
    app: AppHandle,
    webview: tauri::Webview,
    js: String,
) -> Result<(), String> {
    guard(&webview)?;
    let wv = ensure_browser(&app)?;
    wv.eval(js.as_str()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_inject(
    app: AppHandle,
    webview: tauri::Webview,
    files: Vec<String>,
) -> Result<(), String> {
    guard(&webview)?;
    let wv = ensure_browser(&app)?;
    for f in files {
        let safe = std::path::Path::new(&f)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if safe.is_empty() || !safe.ends_with(".js") {
            continue;
        }
        let code = read_automation(&app, safe)?;
        wv.eval(code.as_str()).map_err(|e| e.to_string())?;
    }
    Ok(())
}
