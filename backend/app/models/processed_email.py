"""Emails fetched from Gmail and run through the classifier — dedupe + audit log."""
from sqlalchemy import Column, Integer, String, Text, Float, DateTime
from datetime import datetime
from ..database import Base


class ProcessedEmail(Base):
    __tablename__ = "processed_emails"

    id = Column(Integer, primary_key=True, index=True)
    imap_uid = Column(Integer, index=True, nullable=True)
    message_id = Column(String(500), index=True, nullable=True)  # RFC Message-ID for dedupe
    subject = Column(String(600), nullable=True)
    sender = Column(String(300), nullable=True)
    received_at = Column(DateTime, nullable=True)

    kind = Column(String(40), nullable=True)        # classifier output, or "skipped_prefilter"
    confidence = Column(Float, nullable=True)
    summary = Column(String(600), nullable=True)
    suggested_status = Column(String(40), nullable=True)
    source = Column(String(20), nullable=True)         # "linkedin" | "other"
    next_action = Column(String(400), nullable=True)   # "what should I do" from classifier
    snippet = Column(Text, nullable=True)              # first chars of the body (mail preview)
    application_id = Column(Integer, nullable=True) # matched application (if any)
    status_changed = Column(Integer, default=0)     # 0/1 — did we auto-update the application

    created_at = Column(DateTime, default=datetime.utcnow, index=True)
