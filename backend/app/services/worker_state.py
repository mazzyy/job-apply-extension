"""Shared liveness state for the browser extension.
Updated on every request carrying the X-JAA-Client: extension header, so the
dashboard can show whether the extension is alive regardless of MV3 worker sleep."""
import time

_state = {"last_seen": 0.0, "last_action": None}

def mark(action: str | None = None):
    _state["last_seen"] = time.time()
    if action:
        _state["last_action"] = action

def status():
    age = (time.time() - _state["last_seen"]) if _state["last_seen"] else None
    return {
        "online": age is not None and age < 150,
        "age_sec": int(age) if age is not None else None,
        "action": _state["last_action"],
    }
