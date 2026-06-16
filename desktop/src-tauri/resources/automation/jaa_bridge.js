/*
 * jaa_bridge.js — initialization script injected into the integrated browser
 * webview BEFORE any page script runs (on every navigation).
 *
 * It lets the existing Chrome-extension content engines (linkedin_easyapply.js,
 * successfactors.js, autofill.js, …) run UNCHANGED inside the Tauri webview by:
 *   1. exposing the backend base URL (window.__JAA_API_BASE),
 *   2. shimming the parts of the chrome.* API the engines use
 *      (chrome.runtime.sendMessage / onMessage, chrome.storage.*),
 *   3. providing window.__jaaEmit() to send results/progress back to the
 *      trusted panel webview over the Tauri event bus.
 *
 * Rust replaces __PORT__ with the live backend port when it injects this file.
 */
;(function () {
  if (window.__jaaBridgeLoaded) return;
  window.__jaaBridgeLoaded = true;

  var API_BASE = "http://127.0.0.1:__PORT__";
  window.__JAA_API_BASE = API_BASE;

  /* ---- event channel back to the panel (Tauri event bus) ---- */
  function rawEmit(event, payload) {
    try {
      if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit) {
        return window.__TAURI__.event.emit(event, payload);
      }
    } catch (e) {}
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        return window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: event, payload: payload });
      }
    } catch (e) {}
    // last resort: stash so a poll could read it (debug aid)
    try { window.__jaaLastEvent = { event: event, payload: payload, at: Date.now() }; } catch (e) {}
  }
  window.__jaaEmit = rawEmit;

  /* ---- backend fetch helper ---- */
  function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json", "X-JAA-Client": "desktop-browser" };
    if (opts.headers) for (var k in opts.headers) headers[k] = opts.headers[k];
    return fetch(API_BASE + path, { method: opts.method || "GET", headers: headers, body: opts.body })
      .then(function (r) {
        return r.text().then(function (t) {
          var d; try { d = JSON.parse(t); } catch (e) { d = { raw: t }; }
          if (!r.ok) throw new Error((d && (d.detail || d.error)) || ("HTTP " + r.status));
          return d;
        });
      });
  }
  window.__jaaApi = api;

  /* ---- chrome.* compatibility shim ---- */
  var chrome = window.chrome = window.chrome || {};
  chrome.runtime = chrome.runtime || {};
  if (!chrome.runtime.id) chrome.runtime.id = "jaa-integrated";

  chrome.runtime.sendMessage = function (msg, cb) {
    var p = (async function () {
      try {
        if (!msg || !msg.type) return { ok: false, error: "no message type" };
        switch (msg.type) {
          case "API_GET":     return { ok: true, data: await api(msg.path) };
          case "API_POST":    return { ok: true, data: await api(msg.path, { method: "POST",   body: JSON.stringify(msg.body || {}) }) };
          case "API_PATCH":   return { ok: true, data: await api(msg.path, { method: "PATCH",  body: JSON.stringify(msg.body || {}) }) };
          case "API_DELETE":  return { ok: true, data: await api(msg.path, { method: "DELETE" }) };
          case "ANALYZE_JOB": return { ok: true, data: await api("/analyze/", { method: "POST", body: JSON.stringify(msg.payload || {}) }) };
          case "EASYAPPLY_PROGRESS": rawEmit("jaa-progress", msg); return { ok: true };
          case "ANALYSIS_RESULT":    rawEmit("jaa-analysis", msg.data); return { ok: true };
          default: return { ok: false, error: "unhandled message type: " + msg.type };
        }
      } catch (e) { return { ok: false, error: (e && e.message) ? e.message : String(e) }; }
    })();
    if (typeof cb === "function") { p.then(cb); return true; }
    return p;
  };

  chrome.runtime.onMessage = {
    addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; },
  };
  chrome.runtime.getURL = function (p) { return p; };

  function storageArea(area) {
    function getOne(key) {
      try { var v = localStorage.getItem(area + ":" + key); return v == null ? undefined : JSON.parse(v); }
      catch (e) { return undefined; }
    }
    return {
      get: function (keys, cb) {
        var out = {};
        if (keys == null) {
          for (var i = 0; i < localStorage.length; i++) {
            var lk = localStorage.key(i);
            if (lk && lk.indexOf(area + ":") === 0) {
              var kk = lk.slice(area.length + 1), vv = getOne(kk);
              if (vv !== undefined) out[kk] = vv;
            }
          }
        } else if (typeof keys === "string") {
          var v = getOne(keys); if (v !== undefined) out[keys] = v;
        } else if (Array.isArray(keys)) {
          keys.forEach(function (k) { var v = getOne(k); if (v !== undefined) out[k] = v; });
        } else if (typeof keys === "object") {
          for (var k in keys) { var v = getOne(k); out[k] = (v === undefined ? keys[k] : v); }
        }
        if (typeof cb === "function") { cb(out); return; }
        return Promise.resolve(out);
      },
      set: function (obj, cb) {
        try { for (var k in obj) localStorage.setItem(area + ":" + k, JSON.stringify(obj[k])); } catch (e) {}
        if (typeof cb === "function") { cb(); return; }
        return Promise.resolve();
      },
      remove: function (keys, cb) {
        var arr = Array.isArray(keys) ? keys : [keys];
        try { arr.forEach(function (k) { localStorage.removeItem(area + ":" + k); }); } catch (e) {}
        if (typeof cb === "function") { cb(); return; }
        return Promise.resolve();
      },
    };
  }
  chrome.storage = { sync: storageArea("sync"), local: storageArea("local"), session: storageArea("session") };

  rawEmit("jaa-bridge-ready", { url: location.href });
})();
