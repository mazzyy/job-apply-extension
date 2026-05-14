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
