"""Helpers for emitting application timeline events."""
from datetime import datetime
from sqlalchemy.orm import Session
from ..models import ApplicationEvent


def emit(db: Session, application_id: int, kind: str,
         title: str | None = None, detail: str | None = None,
         source: str | None = None, commit: bool = True) -> ApplicationEvent:
    ev = ApplicationEvent(
        application_id=application_id, kind=kind,
        title=title, detail=detail, source=source,
        created_at=datetime.utcnow(),
    )
    db.add(ev)
    if commit:
        db.commit(); db.refresh(ev)
    return ev
