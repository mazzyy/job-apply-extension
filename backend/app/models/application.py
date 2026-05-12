"""Records each job the user analyzed or applied for."""
from sqlalchemy import Column, Integer, String, Text, Float, DateTime, ForeignKey
from datetime import datetime
from ..database import Base

class Application(Base):
    __tablename__ = "applications"

    id = Column(Integer, primary_key=True, index=True)
    cv_id = Column(Integer, ForeignKey("cvs.id"), nullable=True)
    job_title = Column(String(500), nullable=True)
    company = Column(String(300), nullable=True)
    location = Column(String(300), nullable=True)
    url = Column(String(1000), nullable=True)
    source = Column(String(100), nullable=True)        # linkedin | greenhouse | lever | other
    job_description = Column(Text, nullable=True)
    language = Column(String(20), nullable=True)       # detected language code e.g. "en", "de"
    requires_other_language = Column(String(200), nullable=True)  # human readable summary
    fit_score = Column(Float, nullable=True)
    strengths = Column(Text, nullable=True)            # JSON list
    gaps = Column(Text, nullable=True)                 # JSON list
    recommendations = Column(Text, nullable=True)      # JSON list
    verdict = Column(Text, nullable=True)
    status = Column(String(50), default="analyzed")    # analyzed | applied | interview | rejected | offer
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
