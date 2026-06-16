"""Provider/model settings used by the LLM router."""
import json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import AppSettings

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsIn(BaseModel):
    llm_provider: str | None = None       # cloud | local | hybrid
    local_model: str | None = None
    local_base_url: str | None = None
    per_task: dict | None = None          # {task_name: "cloud" | "local"}
    azure_api_key: str | None = None
    azure_endpoint: str | None = None
    azure_deployment: str | None = None
    azure_api_version: str | None = None
    browser_mode: str | None = None       # system | integrated
    auto_apply_external: bool | None = None
    apply_types: str | None = None        # easy | direct | both


@router.get("/")
def get_settings(db: Session = Depends(get_db)):
    row = db.query(AppSettings).first()
    if not row:
        row = AppSettings(); db.add(row); db.commit(); db.refresh(row)
    return _to_dict(row)


@router.put("/")
def update_settings(body: SettingsIn, db: Session = Depends(get_db)):
    row = db.query(AppSettings).first()
    if not row:
        row = AppSettings(); db.add(row)
    data = body.model_dump(exclude_unset=True)
    if "llm_provider" in data and data["llm_provider"] in {"cloud", "local", "hybrid"}:
        row.llm_provider = data["llm_provider"]
    if "local_model" in data and data["local_model"]:
        row.local_model = data["local_model"]
    if "local_base_url" in data and data["local_base_url"]:
        row.local_base_url = data["local_base_url"]
    if "per_task" in data and data["per_task"] is not None:
        row.per_task = json.dumps(data["per_task"])
    if "browser_mode" in data and data["browser_mode"] in {"system", "integrated"}:
        row.browser_mode = data["browser_mode"]
    if "auto_apply_external" in data and data["auto_apply_external"] is not None:
        row.auto_apply_external = 1 if data["auto_apply_external"] else 0
    if "apply_types" in data and data["apply_types"] in {"easy", "direct", "both"}:
        row.apply_types = data["apply_types"]
    # Azure credentials — treat empty string as "do not change", explicit None as clear,
    # and any other value as set. This avoids the UI accidentally clearing the saved key
    # when the user just toggles other settings.
    for key in ("azure_api_key", "azure_endpoint", "azure_deployment", "azure_api_version"):
        if key in data:
            v = data[key]
            if v is None:
                # Explicit null = clear it
                setattr(row, key, None)
            elif v == "":
                # Empty string = no change (UI sent an empty masked field)
                pass
            else:
                setattr(row, key, v.strip())
    db.commit(); db.refresh(row)
    # Tell the analyzer to drop its cached cloud client so the new key takes effect
    try:
        from ..services import analyzer
        analyzer._clients.pop("cloud", None)
    except Exception:
        pass
    return _to_dict(row)


def _to_dict(row: AppSettings) -> dict:
    key = row.azure_api_key or ""
    return {
        "llm_provider": row.llm_provider,
        "local_model": row.local_model,
        "local_base_url": row.local_base_url,
        "browser_mode": getattr(row, "browser_mode", None) or "system",
        "auto_apply_external": bool(getattr(row, "auto_apply_external", 0)),
        "apply_types": getattr(row, "apply_types", None) or "easy",
        "per_task": json.loads(row.per_task) if row.per_task else {},
        # Mask the key — show only whether it's set and the last 4 chars for verification
        "azure_api_key_set": bool(key),
        "azure_api_key_preview": ("…" + key[-4:]) if len(key) >= 4 else "",
        "azure_endpoint": row.azure_endpoint or "",
        "azure_deployment": row.azure_deployment or "",
        "azure_api_version": row.azure_api_version or "",
    }


@router.get("/local-models")
def list_local_models(db: Session = Depends(get_db)):
    """Return the models actually installed in the user's Ollama.
    Tries both localhost and 127.0.0.1 to bypass IPv4/IPv6 + DNS issues, and
    disables proxy environment variables so a system VPN/proxy doesn't intercept
    the localhost call."""
    import httpx, os
    row = db.query(AppSettings).first()
    if not row:
        row = AppSettings(); db.add(row); db.commit(); db.refresh(row)
    saved = (row.local_base_url or "http://localhost:11434/v1").rstrip("/")
    if not saved.endswith("/v1") and (":11434" in saved or "ollama" in saved.lower()):
        saved = saved + "/v1"

    # Build candidates: try the user's URL first, then a couple of fallbacks.
    candidates = [saved]
    if "localhost" in saved:
        candidates.append(saved.replace("localhost", "127.0.0.1"))
    elif "127.0.0.1" in saved:
        candidates.append(saved.replace("127.0.0.1", "localhost"))

    # trust_env=False disables HTTP_PROXY / HTTPS_PROXY system vars that VPN apps
    # often set on Mac via launchd; those would otherwise try to proxy our
    # localhost calls through the VPN and fail.
    errors = []
    for base in candidates:
        url = base + "/models"
        try:
            with httpx.Client(timeout=4.0, trust_env=False) as client:
                resp = client.get(url)
            if resp.status_code != 200:
                errors.append(f"{url} → HTTP {resp.status_code}")
                continue
            data = resp.json()
            models = []
            for m in data.get("data", []):
                mid = m.get("id") or m.get("name")
                if mid: models.append({"id": mid, "name": mid})
            # Best-effort: enrich with sizes from Ollama's native API
            try:
                base_root = base.rsplit("/v1", 1)[0]
                with httpx.Client(timeout=2.0, trust_env=False) as client:
                    tags = client.get(base_root + "/api/tags").json()
                size_by_name = {t["name"]: t.get("size", 0) for t in tags.get("models", [])}
                for m in models:
                    m["size_bytes"] = size_by_name.get(m["id"], 0)
                    if m["size_bytes"]:
                        m["size_gb"] = round(m["size_bytes"] / 1024 / 1024 / 1024, 2)
            except Exception:
                pass
            return {"available": True, "base_url": base, "models": models,
                    "diagnostics": {"tried": candidates, "succeeded": base}}
        except Exception as e:
            errors.append(f"{url} → {type(e).__name__}: {e}")
    return {"available": False, "base_url": saved, "models": [],
            "error": " | ".join(errors),
            "diagnostics": {"tried": candidates, "proxy_env": {
                k: os.environ.get(k) for k in ("HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY",
                                                "http_proxy","https_proxy","all_proxy","no_proxy")
                if os.environ.get(k)
            }}}

