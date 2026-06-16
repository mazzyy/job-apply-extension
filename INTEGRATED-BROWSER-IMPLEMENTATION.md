# Integrated Browser — Implementation Notes (v2: folded into the dashboard)

The integrated browser now lives **inside the existing dashboard** — one sidebar,
no separate cockpit pane. On the **Auto-apply** tab you get a control bar
(Integrated ↔ System toggle · Sign in to LinkedIn · Show/Hide browser) and the
embedded browser appears right there in the tab. The in-app driver applies to
jobs in that browser; the **System** mode hands auto-apply back to the extension.

## How it fits together
- **`website/integrated.js`** (new) — desktop-only (`window.__TAURI__` guard). Injects the control bar + a browser "host" area into `#tab-autoapply`, runs the auto-apply orchestrator (port of the extension's runner), and shows/positions the native browser webview over the host. No-op in a plain browser, so the dashboard still works everywhere.
- **`website/registry.js`** (new) — portal adapter registry (LinkedIn, SuccessFactors=Siemens/T-Systems/SAP, Greenhouse/Lever/Ashby, generic). Add a portal = one row.
- **`desktop/src-tauri/src/browser.rs`** (new) — adds ONE child webview ("browser") to the dashboard window via Tauri's `unstable` multi-webview. Commands: `browser_show/{x,y,w,h}`, `browser_set_bounds`, `browser_hide` (off-screen), `browser_navigate`, `browser_inject`, `browser_eval`. Lazily created; emits `browser-loaded`; rejects any call coming from the browser webview itself.
- **`desktop/src-tauri/resources/automation/jaa_bridge.js`** (new) — injected into the browser webview: backend URL + `chrome.*` shim + `__jaaEmit` event channel, so the existing engines run unchanged.
- **`desktop/src-tauri/resources/automation/*.js`** — the content engines, mirrored from `extension/content/` by the bundle scripts.
- **`desktop/src-tauri/capabilities/browser-pane.json`** (new) — minimal event-only IPC for the remote browser pane.

## Modified
- `website/index.html` — loads `registry.js` + `integrated.js`.
- Backend: `models/settings.py`, `database.py` (additive `browser_mode`), `routes/settings.py`, `routes/applications.py` (`browser_mode` in `/auto-apply/status`).
- `extension/background/service_worker.js` — stands down when `browser_mode != "system"` (no double-apply).
- `desktop/src-tauri/src/lib.rs` — `mod browser` + registers the 6 commands.
- `desktop/src-tauri/Cargo.toml` — `unstable` feature.
- `desktop/src-tauri/capabilities/default.json` — grants the dashboard (`http://127.0.0.1:*`, `localhost`) IPC so `integrated.js` can drive the browser.
- `desktop/scripts/{bundle-automation.sh,bundle-resources.sh}` + `tauri.conf.json` (`beforeDevCommand`) — sync engines.
- `desktop/src/shell.js` — reverted to load the dashboard directly (the browser is created on demand from inside it).

## What your screenshot issues map to
- **One sidebar** — the separate black cockpit pane is gone; controls live on the dashboard's Auto-apply tab.
- **View the browser** — "Show browser" (and any active run) reveals it inside the tab; leaving the tab hides it.
- **Login** — "Sign in to LinkedIn" shows the browser and navigates it to LinkedIn's login (Google/email options are on that page).

## Run it (dev)
```bash
cd backend && bash run.sh                 # backend on :8000
cd desktop && npm install && npm run tauri dev
```
Auto-apply tab → keep **Integrated** → **Sign in to LinkedIn** (log in once) → queue jobs → **Start**.

## Verified here
All JS `node --check` ✓ · capability/conf JSON valid ✓ · backend `py_compile` ✓ · `browser.rs` brace/paren balanced + commands match `lib.rs` + `integrated.js` invokes ✓. (No Rust compiler in this environment — see below.)

## Needs a build pass on your machine
- **Rust can't be compiled here.** `browser.rs` is reviewed by hand against the Tauri 2 `unstable` multi-webview API. Most likely first-build tweaks: `app.get_window("main")` returning the dashboard window, and `set_size/set_position` arg types. All native code is in `browser.rs`, so fixes are localized.
- **Overlay alignment:** the browser is a native webview positioned over the `#aa-ib-host` div via `getBoundingClientRect`; if it's misaligned or doesn't follow scroll perfectly, the `hostRect()`/`syncBounds()` logic in `integrated.js` is the one place to adjust.
- **`__TAURI__` on the dashboard origin:** results return via Tauri events emitted from the pane (granted in `browser-pane.json`). If results don't come back on macOS/Linux, check that first (the bridge has a `__TAURI_INTERNALS__` fallback).

## Caveats / cleanup
- Detection: integrated browser = OS webview (WebView2≈Chrome on Windows; WKWebView/WebKitGTK elsewhere). Keep the pane visible/attended; the extension fallback covers anyone blocked.
- Default `browser_mode` is `system`, so extension-only users are unaffected until they pick Integrated.
- **Unused now:** `desktop/src/automation.{html,css,js}` and `desktop/src/registry.js` were the old separate-pane cockpit — no longer referenced (couldn't delete from here; safe to remove).
- Please `rm ".__wtest"` in the repo root (stray empty file from a write-permission probe I couldn't delete).
