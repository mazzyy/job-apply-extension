"""Parse pasted recruiter emails, classify them, and update applications."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import Application
from ..services.email_parser import classify_email, guess_application, _extract_sender_domain
from ..services.events import emit

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

    applied = False
    status_changed = False
    if app and body.apply and info.get("confidence", 0) >= 0.6:
        # Update status if we have a confident suggestion
        sug = info.get("suggested_status")
        if sug and sug != app.status:
            rank = {"analyzed": 0, "applied": 1, "interview": 2, "offer": 3, "rejected": 4}
            if rank.get(sug, 0) >= rank.get(app.status or "analyzed", 0) or sug == "rejected":
                prev = app.status
                app.status = sug
                emit(db, app.id, kind="status_change",
                     title=f"Status: {prev} → {sug} (from email)",
                     detail=info.get("summary"),
                     source="email", commit=False)
                status_changed = True
        # Always log the email itself
        kind_map = {
            "rejection": "rejected",
            "interview_invite": "interview_scheduled",
            "offer": "offered",
            "recruiter_reachout": "email_received",
            "next_step": "email_received",
            "acknowledgment": "email_received",
            "follow_up": "email_received",
        }
        ev_kind = kind_map.get(info.get("kind", ""), "email_received")
        emit(db, app.id, kind=ev_kind,
             title=info.get("summary") or "Email received",
             detail=body.text[:2000],
             source="email", commit=False)
        db.commit()
        applied = True

    return {
        **info,
        "sender_domain": sender_domain,
        "matched_application_id": app.id if app else None,
        "matched_application_title": app.job_title if app else None,
        "matched_application_company": app.company if app else None,
        "applied": applied,
        "status_changed": status_changed,
    }
