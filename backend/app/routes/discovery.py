"""Automated job discovery — settings, preview, and run."""
import json
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import AppSettings
from ..services import job_discovery

router = APIRouter(prefix="/discovery", tags=["discovery"])


def _row(db: Session) -> AppSettings:
    r = db.query(AppSettings).first()
    if not r:
        r = AppSettings(); db.add(r); db.commit(); db.refresh(r)
    return r


class DiscoverySettingsIn(BaseModel):
    enabled: bool | None = None
    keywords: str | None = None
    location: str | None = None
    min_fit: int | None = None
    max_age_days: int | None = None
    companies: list | None = None    # [{"ats": "greenhouse"|"lever", "slug": "acme"}]
    sources: dict | None = None      # {jooble:{enabled,key,limit}, rapidapi:{enabled,key,limit,country}}


def _to_dict(r: AppSettings) -> dict:
    try:
        companies = json.loads(r.discovery_companies or "[]")
    except Exception:
        companies = []
    return {
        "enabled": bool(getattr(r, "discovery_enabled", 0)),
        "keywords": r.discovery_keywords or "",
        "location": r.discovery_location or "",
        "min_fit": r.discovery_min_fit or 0,
        "max_age_days": getattr(r, "discovery_max_age_days", 0) or 0,
        "companies": companies,
        "last_run": r.discovery_last_run.isoformat() if getattr(r, "discovery_last_run", None) else None,
        "sources": _masked_sources(r),
    }


def _masked_sources(r) -> dict:
    out = {}
    for name, s in job_discovery.load_sources(r).items():
        k = s.get("key") or ""
        out[name] = {
            "enabled": bool(s.get("enabled")), "limit": s.get("limit", 0),
            "used": s.get("used", 0), "month": s.get("month", ""),
            "country": s.get("country", "de"),
            "key_set": bool(k), "key_preview": ("…" + k[-4:]) if len(k) >= 4 else "",
        }
    return out


@router.get("/settings")
def get_settings(db: Session = Depends(get_db)):
    return _to_dict(_row(db))


@router.put("/settings")
def put_settings(body: DiscoverySettingsIn, db: Session = Depends(get_db)):
    r = _row(db)
    d = body.model_dump(exclude_unset=True)
    if d.get("enabled") is not None: r.discovery_enabled = 1 if d["enabled"] else 0
    if d.get("keywords") is not None: r.discovery_keywords = d["keywords"]
    if d.get("location") is not None: r.discovery_location = d["location"]
    if d.get("min_fit") is not None: r.discovery_min_fit = max(0, min(100, int(d["min_fit"])))
    if d.get("max_age_days") is not None: r.discovery_max_age_days = max(0, int(d["max_age_days"]))
    if d.get("companies") is not None: r.discovery_companies = json.dumps(d["companies"])
    if d.get("sources") is not None:
        cur = job_discovery.load_sources(r)
        for name, upd in d["sources"].items():
            if name not in cur:
                continue
            s = cur[name]
            if "enabled" in upd: s["enabled"] = bool(upd["enabled"])
            if upd.get("key"): s["key"] = upd["key"].strip()   # only set when non-empty (masked saves keep it)
            if upd.get("limit") is not None: s["limit"] = max(0, int(upd["limit"]))
            if upd.get("country"): s["country"] = upd["country"].strip().lower()
            cur[name] = s
        r.discovery_sources = json.dumps(cur)
    db.commit(); db.refresh(r)
    return _to_dict(r)


@router.post("/preview")
def preview(db: Session = Depends(get_db)):
    """Search + filter + fit-score, without queueing — for the UI."""
    stats = {}
    jobs = job_discovery.gather(db, _row(db), stats)
    return {"count": len(jobs), "jobs": jobs, "stats": stats}


@router.post("/run")
def run(db: Session = Depends(get_db)):
    """Discover and queue new matches into the apply pipeline."""
    return job_discovery.discover_and_queue(db)
