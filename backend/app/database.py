"""SQLAlchemy database setup."""
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from .config import settings

engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in settings.DATABASE_URL else {},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()



def ensure_schema():
    """Best-effort additive migration for new columns added after first deploy.
    Safe to run repeatedly: ALTER TABLE ... ADD COLUMN raises if column exists,
    which we swallow."""
    import logging
    log = logging.getLogger("jaa.schema")
    add_cols = [
        ("questions", "needs_review", "INTEGER DEFAULT 0"),
        ("questions", "last_input_type", "VARCHAR(40)"),
        ("questions", "last_max_length", "INTEGER"),
        ("questions", "last_options", "TEXT"),
        ("profiles", "salutation", "VARCHAR(40)"),
        ("profiles", "nobility_title", "VARCHAR(80)"),
        ("profiles", "gender", "VARCHAR(40)"),
        ("profiles", "eu_work_auth", "VARCHAR(20)"),
        ("question_answers", "answer_type", "VARCHAR(40) DEFAULT 'text'"),
        ("app_settings", "azure_api_key", "VARCHAR(500)"),
        ("app_settings", "azure_endpoint", "VARCHAR(500)"),
        ("app_settings", "azure_deployment", "VARCHAR(120)"),
        ("app_settings", "azure_api_version", "VARCHAR(40)"),
        ("app_settings", "gmail_address", "VARCHAR(200)"),
        ("app_settings", "gmail_app_password", "VARCHAR(100)"),
        ("app_settings", "gmail_enabled", "INTEGER DEFAULT 0"),
        ("app_settings", "gmail_lookback_days", "INTEGER DEFAULT 30"),
        ("app_settings", "gmail_last_uid", "INTEGER"),
        ("app_settings", "gmail_last_sync_at", "DATETIME"),
        ("app_settings", "gmail_last_error", "TEXT"),
        ("processed_emails", "next_action", "VARCHAR(400)"),
        ("processed_emails", "snippet", "TEXT"),
        ("processed_emails", "source", "VARCHAR(20)"),
        ("chat_messages", "thread_id", "INTEGER"),
        ("app_settings", "auto_apply_enabled", "INTEGER DEFAULT 0"),
        ("app_settings", "auto_apply_daily_cap", "INTEGER DEFAULT 15"),
        ("app_settings", "auto_apply_mode", "VARCHAR(20) DEFAULT 'session'"),
        ("app_settings", "portal_auto_submit", "INTEGER DEFAULT 0"),
        ("app_settings", "browser_mode", "VARCHAR(20) DEFAULT 'system'"),
        ("app_settings", "auto_apply_external", "INTEGER DEFAULT 0"),
        ("app_settings", "apply_types", "VARCHAR(20) DEFAULT 'easy'"),
        ("app_settings", "discovery_enabled", "INTEGER DEFAULT 0"),
        ("app_settings", "discovery_keywords", "TEXT"),
        ("app_settings", "discovery_location", "VARCHAR(200)"),
        ("app_settings", "discovery_min_fit", "INTEGER DEFAULT 0"),
        ("app_settings", "discovery_max_age_days", "INTEGER DEFAULT 0"),
        ("app_settings", "discovery_companies", "TEXT"),
        ("app_settings", "discovery_last_run", "DATETIME"),
        ("app_settings", "discovery_sources", "TEXT"),
        ("profiles", "portal_password", "VARCHAR(200)"),
        ("applications", "interview_at", "DATETIME"),
    ]
    with engine.begin() as conn:
        for table, col, ddl in add_cols:
            try:
                from sqlalchemy import text as _text
                conn.execute(_text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
                log.info("Added column %s.%s", table, col)
            except Exception as e:
                if "duplicate column" in str(e).lower() or "already exists" in str(e).lower():
                    continue
                log.warning("ALTER skipped (%s.%s): %s", table, col, e)
