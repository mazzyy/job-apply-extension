"""Singleton settings row for runtime-configurable preferences."""
from sqlalchemy import Column, Integer, String, Text, DateTime
from datetime import datetime
from ..database import Base


class AppSettings(Base):
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True, index=True)
    # cloud | local | hybrid
    llm_provider = Column(String(20), default="cloud")
    # local model id, e.g. llama3.2:3b-instruct-q4_K_M
    local_model = Column(String(120), default="llama3.2:3b")
    # base url for Ollama / any OpenAI-compatible local server
    local_base_url = Column(String(400), default="http://localhost:11434/v1")
    # JSON of per-task overrides — keys: analyze_fit, structure_cv, typed_answer,
    # cover_letter, email_classify, draft_answer, verify_model
    per_task = Column(Text, default="{}")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
