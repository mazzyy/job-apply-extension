"""List and update job applications, plus dashboard stats."""
import json
from fastapi import APIRouter, Request, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func
from ..database import get_db
from ..models import Application, ApplicationEvent
from ..services.events import emit

router = APIRouter(prefix="/applications", tags=["applications"])

JAA_BUILD = "2026-06-16-ask-save"  # bump on every change; surfaced in /auto-apply/status

class LogRequest(BaseModel):
    """Used when the user triggers Autofill on a page without analyzing first.
    We create a lightweight Application row so the dashboard tallies it."""
    job_title: str | None = None
    company: str | None = None
    location: str | None = None
    url: str | None = None
    source: str | None = None
    fields_filled: int | None = None
    status: str = "applied"

@router.post("/log")
def log_action(body: LogRequest, db: Session = Depends(get_db)):
    """Idempotent: if a row exists for the same URL within last 30 minutes,
    update its status instead of creating a new one."""
    from datetime import datetime, timedelta
    cutoff = datetime.utcnow() - timedelta(minutes=30)

    existing = None
    if body.url:
        existing = (
            db.query(Application)
            .filter(Application.url == body.url)
            .filter(Application.created_at >= cutoff)
            .order_by(Application.created_at.desc())
            .first()
        )

    if existing:
        rank = {"analyzed": 0, "applied": 1, "interview": 2, "offer": 3, "rejected": 1}
        prev = existing.status or "analyzed"
        if rank.get(body.status, 0) >= rank.get(prev, 0):
            existing.status = body.status
        note_parts = []
        if existing.notes:
            note_parts.append(existing.notes)
        if body.fields_filled:
            note_parts.append(f"Autofilled {body.fields_filled} fields at {datetime.utcnow().isoformat()}")
        existing.notes = " | ".join(note_parts) if note_parts else existing.notes
        emit(db, existing.id, kind="autofilled",
             title=f"Autofilled {body.fields_filled or 0} fields",
             source="autofill", commit=False)
        if prev != existing.status:
            emit(db, existing.id, kind="status_change",
                 title=f"Status: {prev} → {existing.status}",
                 source="autofill", commit=False)
        db.commit()
        return {"id": existing.id, "deduped": True, "status": existing.status}

    # Create new row
    app = Application(
        job_title=body.job_title or "(unknown role)",
        company=body.company or "(unknown company)",
        location=body.location,
        url=body.url,
        source=body.source or "autofill",
        status=body.status,
        notes=f"Logged via autofill ({body.fields_filled or 0} fields filled)" if body.fields_filled else "Logged via autofill",
    )
    db.add(app)
    db.commit(); db.refresh(app)
    emit(db, app.id, kind="applied",
         title=f"Applied via autofill — {body.fields_filled or 0} fields filled",
         source="autofill")
    return {"id": app.id, "deduped": False, "status": app.status}


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
    prev = a.status
    a.status = body.status
    if body.notes is not None:
        a.notes = body.notes
    if prev != body.status:
        emit(db, a.id, kind="status_change",
             title=f"Status: {prev} → {body.status}",
             detail=body.notes or None, source="ui", commit=False)
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

@router.get("/{app_id}/events")
def list_events(app_id: int, db: Session = Depends(get_db)):
    a = db.query(Application).filter(Application.id == app_id).first()
    if not a:
        raise HTTPException(404, "Not found")
    events = (
        db.query(ApplicationEvent)
        .filter(ApplicationEvent.application_id == app_id)
        .order_by(ApplicationEvent.created_at.asc())
        .all()
    )
    return [
        {"id": e.id, "kind": e.kind, "title": e.title, "detail": e.detail,
         "source": e.source, "created_at": e.created_at.isoformat()}
        for e in events
    ]


@router.post("/{app_id}/events")
def add_event(app_id: int, body: dict, db: Session = Depends(get_db)):
    a = db.query(Application).filter(Application.id == app_id).first()
    if not a:
        raise HTTPException(404, "Not found")
    e = emit(db, app_id,
             kind=body.get("kind", "note"),
             title=body.get("title"),
             detail=body.get("detail"),
             source=body.get("source", "ui"))
    return {"id": e.id}


# ============================== Auto-apply ==============================
import time as _time
from ..services import worker_state as _ws
import json as _json
import re as _re
from datetime import datetime as _dt, timedelta as _td
from pydantic import BaseModel as _BM
from ..models import AppSettings, ApplicationEvent


class QueueIn(_BM):
    urls: list[str]
    time_range: str | None = "any"        # 24h | week | month | any


class ToggleIn(_BM):
    enabled: bool
    daily_cap: int | None = None
    mode: str | None = None        # session | tabs
    portal_auto_submit: bool | None = None


class AutoResultIn(_BM):
    status: str                      # applied | needs_review | failed
    reason: str | None = None
    filled: int = 0
    answers: list | None = None      # [{label, value}]
    cv_used: str | None = None
    job_title: str | None = None
    company: str | None = None


# LinkedIn "date posted" filter values (f_TPR)
_TPR = {"24h": "r86400", "week": "r604800", "month": "r2592000", "any": ""}


def _build_search_url(keyword: str, time_range: str = "any", apply_types: str = "easy") -> str:
    from urllib.parse import quote
    tpr = _TPR.get(time_range or "any", "")
    url = f"https://www.linkedin.com/jobs/search/?keywords={quote(keyword)}"
    if apply_types == "easy":
        url += "&f_AL=true"   # Easy Apply filter; omit to include direct/external jobs
    if tpr:
        url += f"&f_TPR={tpr}"
    return url


_SF_HOST = ("successfactors", "sapsf")


def _is_sf(low: str) -> bool:
    return any(h in low for h in _SF_HOST)


def _manual_platform(low: str) -> str:
    if "greenhouse.io" in low: return "greenhouse"
    if "lever.co" in low: return "lever"
    if "ashbyhq.com" in low: return "ashby"
    if "personio." in low: return "personio"
    if "smartrecruiters.com" in low: return "smartrecruiters"
    if "workable.com" in low: return "workable"
    if "recruitee.com" in low: return "recruitee"
    if "myworkdayjobs.com" in low or "workday" in low: return "workday"
    return "manual"


def _classify_queue_entry(entry: str, time_range: str = "any", apply_types: str = "easy"):
    """Returns (url, task, label, platform). task is 'apply' or 'harvest'."""
    e = entry.strip()
    if not e:
        return None
    low = e.lower()
    # Recognize URLs pasted WITHOUT a scheme (e.g. "boards.greenhouse.io/acme/123",
    # "www.company.com/jobs", "aplitrak.com/?adid=…") so a real job link is never
    # mistaken for a keyword search.
    if not low.startswith("http") and (
        low.startswith("www.") or (" " not in low and "/" in low and "." in low)
    ):
        e = "https://" + e
        low = e.lower()
    if low.startswith("http"):
        if _is_sf(low):
            # SF job detail vs. a search/results listing
            if any(k in low for k in ("/job/", "jobdetail", "requisition")):
                return (e, "apply", "SuccessFactors job", "successfactors")
            return (e, "harvest", "SuccessFactors search", "successfactors")
        if "linkedin.com/jobs" in low:
            if "/jobs/view/" in low and "/search" not in low:
                return (e, "apply", None, "linkedin")
            label = "Search: " + e.split("keywords=")[-1].split("&")[0][:40] if "keywords=" in low else "LinkedIn search"
            return (e, "harvest", label, "linkedin")
        # Any other career-site URL → a MANUAL job (we assist, you submit).
        return (e, "manual", None, _manual_platform(low))
    # Plain text → LinkedIn Easy-Apply keyword search with the chosen date filter
    return (_build_search_url(e, time_range, apply_types), "harvest", f'Search: "{e}"', "linkedin")


@router.post("/queue")
def queue_jobs(body: QueueIn, db: Session = Depends(get_db)):
    """Queue entries: a Easy-Apply job URL applies directly; a search URL or a
    plain keyword becomes a 'harvest' task that scrapes all Easy-Apply jobs and
    queues each one."""
    created, skipped = [], 0
    _row = db.query(AppSettings).first()
    _apply_types = (getattr(_row, "apply_types", None) or "easy") if _row else "easy"
    for entry in body.urls:
        c = _classify_queue_entry(entry, body.time_range or "any", _apply_types)
        if not c:
            skipped += 1
            continue
        url, task, label, platform = c
        status = "queued_search" if task == "harvest" else ("queued_manual" if task == "manual" else "queued")
        if task in ("apply", "manual"):
            base_url = url.split("?")[0].rstrip("/")
            exists = db.query(Application).filter(Application.url.like(base_url + "%")).first()
            if exists and exists.status in ("queued", "applied"):
                skipped += 1
                continue
        a = Application(url=url, source="auto-apply:" + platform, status=status, job_title=label)
        db.add(a); db.commit(); db.refresh(a)
        created.append(a.id)
    return {"queued": len(created), "skipped": skipped, "ids": created}


@router.get("/auto-apply/status")
def auto_apply_status(db: Session = Depends(get_db)):
    row = db.query(AppSettings).first()
    if not row:
        row = AppSettings(); db.add(row); db.commit(); db.refresh(row)
    today_start = _dt.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    applied_today = (db.query(ApplicationEvent)
                     .filter(ApplicationEvent.kind == "auto_applied",
                             ApplicationEvent.created_at >= today_start).count())
    queued = db.query(Application).filter(Application.status == "queued").count()
    searches = db.query(Application).filter(Application.status == "queued_search").count()
    cap = row.auto_apply_daily_cap or 15
    enabled = bool(row.auto_apply_enabled)
    _ext_on = bool(getattr(row, "auto_apply_external", 0))
    _apply_types = getattr(row, "apply_types", None) or "easy"

    mode = (row.auto_apply_mode or "session")
    nxt = None
    if enabled:
        srow = (db.query(Application).filter(Application.status == "queued_search")
                .order_by(Application.id.asc()).first())
        arow = (db.query(Application).filter(Application.status == "queued")
                .order_by(Application.id.asc()).first())
        def _plat(a):
            return (a.source or "").split(":")[-1] if a and ":" in (a.source or "") else "linkedin"
        if mode == "session" and _apply_types == "easy" and srow and applied_today < cap and _plat(srow) == "linkedin":
            nxt = {"id": srow.id, "url": srow.url, "task": "session",
                   "platform": "linkedin", "remaining": cap - applied_today}
        elif srow:
            nxt = {"id": srow.id, "url": srow.url, "task": "harvest", "platform": _plat(srow)}
        elif arow and applied_today < cap:
            nxt = {"id": arow.id, "url": arow.url, "task": "apply", "platform": _plat(arow)}
        elif _ext_on and applied_today < cap:
            mrow = (db.query(Application).filter(Application.status == "queued_manual")
                    .order_by(Application.id.asc()).first())
            if mrow:
                nxt = {"id": mrow.id, "url": mrow.url, "task": "apply", "platform": _plat(mrow)}
    li_queued = sum(1 for a in db.query(Application).filter(Application.status.in_(("queued","queued_search"))).all()
                    if _platform_of(a) == "linkedin")
    sf_queued = queued + searches - li_queued
    _wstat = _ws.status()
    return {
        "enabled": enabled,
        "daily_cap": cap,
        "applied_today": applied_today,
        "queued": queued,
        "searches": searches,
        "queued_linkedin": li_queued,
        "queued_portal": sf_queued,
        "cap_reached": applied_today >= cap,
        "mode": mode,
        "portal_auto_submit": bool(row.portal_auto_submit),
        "browser_mode": (row.browser_mode or "system"),
        "auto_apply_external": _ext_on,
        "apply_types": _apply_types,
        "build": JAA_BUILD,
        "next": nxt,
        "worker_online": _wstat["online"],
        "worker_age_sec": _wstat["age_sec"],
        "worker_action": _wstat["action"],
    }


@router.post("/auto-apply/heartbeat")
async def auto_apply_heartbeat(request: Request):
    """Explicit ping (the header middleware also marks liveness on every call).
    Body is optional — accept anything, never 422."""
    action = "heartbeat"
    try:
        body = await request.json()
        if isinstance(body, dict) and body.get("action"):
            action = body["action"]
    except Exception:
        pass
    _ws.mark(action)
    return {"ok": True}


@router.post("/auto-apply/toggle")
def auto_apply_toggle(body: ToggleIn, db: Session = Depends(get_db)):
    row = db.query(AppSettings).first()
    if not row:
        row = AppSettings(); db.add(row)
    row.auto_apply_enabled = 1 if body.enabled else 0
    if body.daily_cap:
        row.auto_apply_daily_cap = max(1, min(body.daily_cap, 100))
    if body.mode in ("session", "tabs"):
        row.auto_apply_mode = body.mode
    if body.portal_auto_submit is not None:
        row.portal_auto_submit = 1 if body.portal_auto_submit else 0
    db.commit()
    return {"ok": True, "enabled": bool(row.auto_apply_enabled)}


@router.post("/{app_id}/auto-result")
def auto_apply_result(app_id: int, body: AutoResultIn, db: Session = Depends(get_db)):
    """Record the outcome of one automated application run."""
    a = db.query(Application).filter(Application.id == app_id).first()
    if not a:
        raise HTTPException(404, "Application not found")
    if body.job_title: a.job_title = body.job_title
    if body.company: a.company = body.company
    a.status = {"applied": "applied", "needs_review": "needs_review", "failed": "failed"}.get(body.status, "failed")
    detail = _json.dumps({
        "answers": body.answers or [], "cv_used": body.cv_used,
        "filled": body.filled, "reason": body.reason,
    }, ensure_ascii=False)
    ev = ApplicationEvent(
        application_id=a.id,
        kind="auto_applied" if body.status == "applied" else "auto_apply_" + body.status,
        title=(f"Auto-applied · {body.filled} fields · CV: {body.cv_used or '—'}"
               if body.status == "applied" else f"Auto-apply {body.status}: {body.reason or ''}"[:290]),
        detail=detail, source="auto-apply",
    )
    db.add(ev); db.commit()
    return {"ok": True, "status": a.status}


class ExpandIn(_BM):
    urls: list[str]


@router.post("/{app_id}/expanded")
def auto_apply_expanded(app_id: int, body: ExpandIn, db: Session = Depends(get_db)):
    """A harvest task finished: queue each found job, mark the search row done."""
    a = db.query(Application).filter(Application.id == app_id).first()
    if not a:
        raise HTTPException(404, "Search task not found")
    res = queue_jobs(QueueIn(urls=body.urls), db)
    a.status = "expanded"
    a.job_title = (a.job_title or "Search") + f" → {res['queued']} jobs"
    ev = ApplicationEvent(application_id=a.id, kind="search_expanded",
                          title=f"Found {res['queued']} Easy-Apply jobs", source="auto-apply")
    db.add(ev); db.commit()
    return {"ok": True, **res}


@router.post("/auto-apply/clear-queue")
def auto_apply_clear_queue(db: Session = Depends(get_db)):
    """Remove everything not yet applied (queued jobs + pending searches)."""
    n = (db.query(Application)
         .filter(Application.status.in_(("queued", "queued_search")))
         .delete(synchronize_session=False))
    db.commit()
    return {"ok": True, "removed": n}


class SessionResult(_BM):
    url: str | None = None
    job_title: str | None = None
    company: str | None = None
    status: str = "failed"
    filled: int = 0
    cv_used: str | None = None
    answers: list | None = None
    reason: str | None = None


class SessionBatchIn(_BM):
    search_id: int | None = None
    results: list[SessionResult]
    blocked: bool = False


@router.post("/auto-apply/session-batch")
def auto_apply_session_batch(body: SessionBatchIn, db: Session = Depends(get_db)):
    """Record every application made during one same-tab session run."""
    counts = {"applied": 0, "needs_review": 0, "failed": 0}
    for res in body.results:
        a = Application(
            url=res.url, source="auto-apply:linkedin",
            job_title=res.job_title, company=res.company,
            status={"applied": "applied", "needs_review": "needs_review"}.get(res.status, "failed"),
        )
        db.add(a); db.commit(); db.refresh(a)
        ev = ApplicationEvent(
            application_id=a.id,
            kind="auto_applied" if res.status == "applied" else "auto_apply_" + res.status,
            title=(f"Auto-applied · {res.filled} fields · CV: {res.cv_used or '—'}"
                   if res.status == "applied" else f"Auto-apply {res.status}: {res.reason or ''}"[:290]),
            detail=_json.dumps({"answers": res.answers or [], "cv_used": res.cv_used,
                                "filled": res.filled, "reason": res.reason}, ensure_ascii=False),
            source="auto-apply")
        db.add(ev); db.commit()
        counts[res.status if res.status in counts else "failed"] += 1
    # Mark the search row done
    if body.search_id:
        srow = db.query(Application).filter(Application.id == body.search_id).first()
        if srow:
            srow.status = "expanded"
            srow.job_title = (srow.job_title or "Search") + f" → {counts['applied']} applied"
            db.commit()
    if body.blocked:
        r = db.query(AppSettings).first()
        if r: r.auto_apply_enabled = 0; db.commit()
    return {"ok": True, **counts, "blocked": body.blocked}


def _platform_of(a) -> str:
    src = a.source or ""
    if ":" in src:
        return src.split(":")[-1]
    if a.url and "successfactors" in (a.url or "").lower():
        return "successfactors"
    return "linkedin"


@router.get("/manual-queue")
def manual_queue(db: Session = Depends(get_db)):
    """Jobs that need a human to finish & submit: external portals (queued_manual)
    plus anything auto-apply flagged as needs_review."""
    rows = (db.query(Application)
            .filter(Application.status.in_(("queued_manual", "needs_review")))
            .order_by(Application.id.asc()).all())
    return [{
        "id": a.id, "url": a.url, "job_title": a.job_title, "company": a.company,
        "platform": _platform_of(a), "status": a.status,
    } for a in rows]


class ManualResultIn(BaseModel):
    status: str = "applied"        # applied | skipped
    job_title: str | None = None
    company: str | None = None


@router.post("/{app_id}/manual-result")
def manual_result(app_id: int, body: ManualResultIn, db: Session = Depends(get_db)):
    a = db.query(Application).filter(Application.id == app_id).first()
    if not a:
        raise HTTPException(404, "Application not found")
    if body.job_title: a.job_title = body.job_title
    if body.company: a.company = body.company
    a.status = "applied" if body.status == "applied" else "skipped"
    ev = ApplicationEvent(
        application_id=a.id,
        kind="applied" if a.status == "applied" else "skipped",
        title="Applied manually" if a.status == "applied" else "Skipped",
        source="manual",
    )
    db.add(ev); db.commit()
    return {"ok": True, "status": a.status}


@router.get("/auto-apply/log")
def auto_apply_log(limit: int = 80, platform: str = "", db: Session = Depends(get_db)):
    """Everything auto-apply has touched, newest first, with per-job fill details.
    platform: 'linkedin' | 'successfactors' | '' (all)."""
    rows = (db.query(Application)
            .filter(Application.source.like("auto-apply%") |
                    Application.status.in_(("queued", "queued_manual", "queued_search", "expanded", "needs_review", "failed")))
            .order_by(Application.id.desc()).limit(300).all())
    if platform == "linkedin":
        rows = [a for a in rows if _platform_of(a) == "linkedin"]
    elif platform:
        # "Portals" tab → everything that isn't LinkedIn (SuccessFactors + Greenhouse/Lever/Ashby/Personio/…)
        rows = [a for a in rows if _platform_of(a) != "linkedin"]
    rows = rows[:limit]
    out = []
    for a in rows:
        ev = (db.query(ApplicationEvent)
              .filter(ApplicationEvent.application_id == a.id,
                      ApplicationEvent.kind.in_(("auto_applied", "auto_apply_needs_review", "auto_apply_failed")))
              .order_by(ApplicationEvent.id.desc()).first())
        detail = {}
        if ev and ev.detail:
            try: detail = _json.loads(ev.detail)
            except Exception: detail = {}
        is_search = a.status in ("queued_search", "expanded")
        out.append({
            "id": a.id, "job_title": a.job_title, "company": a.company,
            "url": a.url, "status": a.status, "is_search": is_search,
            "platform": _platform_of(a),
            "updated_at": a.updated_at.isoformat() if a.updated_at else None,
            "filled": detail.get("filled", 0),
            "cv_used": detail.get("cv_used"),
            "answers": detail.get("answers", []),
            "reason": detail.get("reason"),
        })
    return out
