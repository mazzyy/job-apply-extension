"""Application timeline events.

Each row records a single thing that happened to one application:
analyzed, autofilled, applied, email_received, interview_scheduled,
rejected, offered, note. Renders as a per-application activity timeline.
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from datetime import datetime
from ..database import Base


class ApplicationEvent(Base):
    __tablename__ = "application_events"

    id = Column(Integer, primary_key=True, index=True)
    application_id = Column(Integer, ForeignKey("applications.id"), nullable=False, index=True)
    kind = Column(String(40), nullable=False)        # analyzed | autofilled | applied | email_received | interview_scheduled | rejected | offered | note | status_change
    title = Column(String(300), nullable=True)       # human-readable summary
    detail = Column(Text, nullable=True)             # longer body / JSON payload
    source = Column(String(50), nullable=True)       # ui | autofill | email | apply_watcher | manual
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
