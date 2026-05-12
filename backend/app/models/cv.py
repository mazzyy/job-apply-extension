"""CV model — supports multiple CVs per user, tagged by domain/role."""
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean
from datetime import datetime
from ..database import Base

class CV(Base):
    __tablename__ = "cvs"

    id = Column(Integer, primary_key=True, index=True)
    label = Column(String(200), nullable=False)        # e.g. "Senior Backend CV"
    tag = Column(String(100), nullable=True)           # e.g. "backend", "ml", "management"
    filename = Column(String(500), nullable=False)
    file_path = Column(String(1000), nullable=False)
    raw_text = Column(Text, nullable=False)            # extracted text used by the LLM
    structured = Column(Text, nullable=True)           # JSON dump of parsed sections
    is_active = Column(Boolean, default=False)         # active CV used by the extension
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
