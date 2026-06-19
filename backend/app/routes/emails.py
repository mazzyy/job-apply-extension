"""Parse pasted recruiter emails, classify them, and update applications."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import Application, AppSettings, ProcessedEmail
from ..services.email_parser import classify_email, guess_application, _extract_sender_domain
from ..services.events import emit
from ..services import gmail_sync

router = APIRouter(prefix="/emails", tags=["emails"])


class EmailIn(BaseModel):
    text: str                    # paste of email body (and optionally headers)
    application_id: int | None = None  # override the auto-match
    apply: bool = True           # if True, write status/event to the matched application


@router.post("/parse")
def parse_email(body: EmailIn, db: Session = Depends(get_db)):
    if not body.text or len(body.text.strip()) < 40:
        raise HTTPException(400, "Email body too short.")
    sender_domain = _extract_sender_domain(body.text)
    info = classify_email(body.text)

    # Match application
    app = None
    if body.application_id:
        app = db.query(Application).filter(Application.id == body.application_id).first()
    if not app:
        app = guess_application(db, body.text, sender_domain)
    if not app and body.apply and info.get("kind") in ("interview_invite", "rejection", "offer") and (info.get("confidence") or 0) >= 0.6:
        app = gmail_sync.create_application_from_email(db, info, body.text)

    applied = False
    status_changed = False
    if body.apply:
        applied, status_changed = gmail_sync.apply_classification(db, app, info, body.text)

    return {
        **info,
        "sender_domain": sender_domain,
        "matched_application_id": app.id if app else None,
        "matched_application_title": app.job_title if app else None,
        "matched_application_company": app.company if app else None,
        "applied": applied,
        "status_changed": status_changed,
    }


# ============================== Gmail (IMAP) ==============================

class GmailConnectIn(BaseModel):
    address: str
    app_password: str
    lookback_days: int = 30


@router.get("/gmail/status")
def gmail_status(db: Session = Depends(get_db)):
    row = db.query(AppSettings).first()
    if not row:
        row = AppSettings(); db.add(row); db.commit(); db.refresh(row)
    return {
        "connected": bool(row.gmail_enabled and row.gmail_address and row.gmail_app_password),
        "address": row.gmail_address or "",
        "lookback_days": row.gmail_lookback_days or 30,
        "last_sync_at": row.gmail_last_sync_at.isoformat() if row.gmail_last_sync_at else None,
        "last_error": row.gmail_last_error,
        "processed_count": db.query(ProcessedEmail).count(),
    }


@router.post("/gmail/connect")
def gmail_connect(body: GmailConnectIn, db: Session = Depends(get_db)):
    addr = body.address.strip()
    pwd = body.app_password.replace(" ", "").strip()   # Google shows it in groups of 4
    if not addr or "@" not in addr:
        raise HTTPException(400, "Enter a valid Gmail address.")
    if len(pwd) < 16:
        raise HTTPException(400, "App passwords are 16 characters — generate one at myaccount.google.com/apppasswords (requires 2-step verification).")
    err = gmail_sync.test_login(addr, pwd)
    if err:
        raise HTTPException(400, f"Gmail login failed: {err}")
    row = db.query(AppSettings).first()
    if not row:
        row = AppSettings(); db.add(row)
    row.gmail_address = addr
    row.gmail_app_password = pwd
    row.gmail_enabled = 1
    row.gmail_lookback_days = max(1, min(body.lookback_days, 365))
    row.gmail_last_error = None
    db.commit()
    return {"ok": True, "address": addr}


@router.post("/gmail/disconnect")
def gmail_disconnect(db: Session = Depends(get_db)):
    row = db.query(AppSettings).first()
    if row:
        row.gmail_enabled = 0
        row.gmail_app_password = None
        db.commit()
    return {"ok": True}


@router.post("/gmail/sync")
def gmail_sync_now(db: Session = Depends(get_db)):
    return gmail_sync.sync(db)


@router.post("/gmail/rescan")
def gmail_rescan(db: Session = Depends(get_db)):
    """Clear the feed and re-classify the whole lookback window with current rules."""
    return gmail_sync.rescan(db)


RESPONSE_KINDS = ("rejection", "interview_invite", "offer", "recruiter_reachout",
                  "next_step", "acknowledgment", "follow_up")


def _email_source(r: ProcessedEmail) -> str:
    if r.source:
        return r.source
    return "linkedin" if "linkedin" in (r.sender or "").lower() else "other"


def _email_dict(r: ProcessedEmail, apps: dict) -> dict:
    a = apps.get(r.application_id)
    return {
        "id": r.id, "subject": r.subject, "sender": r.sender,
        "received_at": r.received_at.isoformat() if r.received_at else None,
        "kind": r.kind, "confidence": r.confidence, "summary": r.summary,
        "suggested_status": r.suggested_status,
        "application_id": r.application_id,
        "application": f"{a.job_title} @ {a.company}" if a else None,
        "company": a.company if a else None,
        "source": _email_source(r),
        "status_changed": bool(r.status_changed),
        "next_action": r.next_action,
        "snippet": r.snippet,
    }


@router.get("/gmail/processed")
def gmail_processed(limit: int = 100, all: bool = False, q: str = "",
                    company: str = "", source: str = "", kind: str = "",
                    db: Session = Depends(get_db)):
    query = db.query(ProcessedEmail)
    if not all:
        query = query.filter(ProcessedEmail.kind.in_(RESPONSE_KINDS))
    else:
        query = query.filter(ProcessedEmail.kind != "skipped_prefilter")
    rows = query.order_by(ProcessedEmail.id.desc()).limit(500).all()
    apps = {a.id: a for a in db.query(Application).all()}

    out = [_email_dict(r, apps) for r in rows]
    if kind:
        out = [r for r in out if r["kind"] == kind]
    if source in ("linkedin", "other"):
        out = [r for r in out if r["source"] == source]
    if company:
        cl = company.lower()
        out = [r for r in out if (r["company"] or "").lower() == cl]
    if q:
        ql = q.lower()
        out = [r for r in out if any(ql in (r[f] or "").lower()
               for f in ("subject", "sender", "snippet", "summary", "application"))]
    return out[:limit]


@router.get("/gmail/summary")
def gmail_summary(db: Session = Depends(get_db)):
    """Aggregates for the inbox header: counts by kind/source, companies, this week."""
    from datetime import datetime, timedelta
    rows = (db.query(ProcessedEmail)
            .filter(ProcessedEmail.kind.in_(RESPONSE_KINDS)).all())
    apps = {a.id: a for a in db.query(Application).all()}
    week_ago = datetime.utcnow() - timedelta(days=7)

    by_kind, by_source, companies = {}, {"linkedin": 0, "other": 0}, {}
    this_week = 0
    for r in rows:
        by_kind[r.kind] = by_kind.get(r.kind, 0) + 1
        by_source[_email_source(r)] = by_source.get(_email_source(r), 0) + 1
        a = apps.get(r.application_id)
        if a and a.company:
            companies[a.company] = companies.get(a.company, 0) + 1
        if r.received_at and r.received_at >= week_ago:
            this_week += 1
    needs_attention = sum(by_kind.get(k, 0) for k in
                          ("rejection", "interview_invite", "offer", "recruiter_reachout", "next_step"))
    return {
        "total": len(rows),
        "this_week": this_week,
        "needs_attention": needs_attention,
        "by_kind": by_kind,
        "by_source": by_source,
        "companies": sorted(
            [{"name": c, "count": n} for c, n in companies.items()],
            key=lambda x: -x["count"]),
    }


@router.delete("/gmail/processed/{email_id}")
def gmail_dismiss(email_id: int, db: Session = Depends(get_db)):
    """Dismiss a row from the feed (e.g. misclassified). Kept as 'dismissed' for dedupe."""
    r = db.query(ProcessedEmail).filter(ProcessedEmail.id == email_id).first()
    if not r:
        raise HTTPException(404, "Not found")
    r.kind = "dismissed"
    db.commit()
    return {"ok": True}
