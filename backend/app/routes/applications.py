"""List and update job applications, plus dashboard stats."""
import json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func
from ..database import get_db
from ..models import Application

router = APIRouter(prefix="/applications", tags=["applications"])

class StatusUpdate(BaseModel):
    status: str
    notes: str | None = None

@router.get("/")
def list_apps(limit: int = 200, db: Session = Depends(get_db)):
    rows = db.query(Application).order_by(Application.created_at.desc()).limit(limit).all()
    return [_to_dict(a) for a in rows]

@router.get("/stats")
def stats(db: Session = Depends(get_db)):
    total = db.query(func.count(Application.id)).scalar() or 0
    applied = db.query(func.count(Application.id)).filter(Application.status == "applied").scalar() or 0
    interview = db.query(func.count(Application.id)).filter(Application.status == "interview").scalar() or 0
    offer = db.query(func.count(Application.id)).filter(Application.status == "offer").scalar() or 0
    rejected = db.query(func.count(Application.id)).filter(Application.status == "rejected").scalar() or 0
    avg_fit = db.query(func.avg(Application.fit_score)).scalar() or 0
    by_source = dict(
        db.query(Application.source, func.count(Application.id)).group_by(Application.source).all()
    )
    # Fit score buckets
    rows = db.query(Application.fit_score).all()
    buckets = {"0-39": 0, "40-59": 0, "60-79": 0, "80-100": 0}
    for (s,) in rows:
        if s is None:
            continue
        if s < 40: buckets["0-39"] += 1
        elif s < 60: buckets["40-59"] += 1
        elif s < 80: buckets["60-79"] += 1
        else: buckets["80-100"] += 1
    return {
        "total": total, "applied": applied, "interview": interview,
        "offer": offer, "rejected": rejected,
        "avg_fit": round(float(avg_fit), 1),
        "by_source": by_source, "fit_buckets": buckets,
    }

@router.get("/{app_id}")
def get_app(app_id: int, db: Session = Depends(get_db)):
    a = db.query(Application).filter(Application.id == app_id).first()
    if not a:
        raise HTTPException(404, "Not found")
    return _to_dict(a, include_full=True)

@router.patch("/{app_id}")
def update_status(app_id: int, body: StatusUpdate, db: Session = Depends(get_db)):
    a = db.query(Application).filter(Application.id == app_id).first()
    if not a:
        raise HTTPException(404, "Not found")
    a.status = body.status
    if body.notes is not None:
        a.notes = body.notes
    db.commit()
    return _to_dict(a)

@router.delete("/{app_id}")
def delete_app(app_id: int, db: Session = Depends(get_db)):
    a = db.query(Application).filter(Application.id == app_id).first()
    if not a:
        raise HTTPException(404, "Not found")
    db.delete(a)
    db.commit()
    return {"ok": True}

def _to_dict(a: Application, include_full: bool = False) -> dict:
    d = {
        "id": a.id, "cv_id": a.cv_id,
        "job_title": a.job_title, "company": a.company,
        "location": a.location, "url": a.url, "source": a.source,
        "language": a.language, "requires_other_language": a.requires_other_language,
        "fit_score": a.fit_score, "verdict": a.verdict, "status": a.status,
        "created_at": a.created_at.isoformat(),
        "strengths": _safe(a.strengths), "gaps": _safe(a.gaps),
        "recommendations": _safe(a.recommendations),
    }
    if include_full:
        d["job_description"] = a.job_description
        d["notes"] = a.notes
    return d

def _safe(s):
    if not s: return []
    try: return json.loads(s)
    except Exception: return []
