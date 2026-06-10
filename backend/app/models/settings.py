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

    # Azure OpenAI credentials (UI-editable, overrides config.py defaults).
    # Stored plain in SQLite — fine for personal/single-user. Encrypt if distributing.
    azure_api_key = Column(String(500), nullable=True)
    azure_endpoint = Column(String(500), nullable=True)
    azure_deployment = Column(String(120), nullable=True)
    azure_api_version = Column(String(40), nullable=True)

    # Gmail (IMAP + app password). Plain in SQLite — single-user local app.
    gmail_address = Column(String(200), nullable=True)
    gmail_app_password = Column(String(100), nullable=True)
    gmail_enabled = Column(Integer, default=0)          # 0/1
    gmail_lookback_days = Column(Integer, default=30)   # first-sync window
    gmail_last_uid = Column(Integer, nullable=True)     # incremental sync cursor
    gmail_last_sync_at = Column(DateTime, nullable=True)
    gmail_last_error = Column(Text, nullable=True)

    # Auto-apply (LinkedIn Easy Apply automation)
    auto_apply_enabled = Column(Integer, default=0)     # 0/1
    auto_apply_daily_cap = Column(Integer, default=15)

    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
