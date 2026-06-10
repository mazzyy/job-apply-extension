"""Configuration.

`.env` is searched in multiple locations so it works for:
  - dev (backend/.env, next to the source)
  - installed Tauri app (~/Library/Application Support/JobApplyAssistant/.env on Mac,
                          %APPDATA%\JobApplyAssistant\.env on Windows,
                          ~/.config/JobApplyAssistant/.env on Linux)
  - manual env var overrides (always win — `AZURE_OPENAI_API_KEY=... ./jobapply-backend`)

Loading order (first match wins):
  1. ./.env (current working directory — dev mode)
  2. <backend source>/.env (also dev mode, if launched from elsewhere)
  3. JAA_DATA_DIR/.env (Tauri sets this to the per-user data dir)
  4. Per-OS user data dir / JobApplyAssistant / .env
  5. ~/.jobapply.env
"""
import os
import sys
import logging
from pathlib import Path
from dotenv import load_dotenv

log = logging.getLogger("jaa.config")


def _per_os_data_dir() -> Path:
    """Where the installed app stores user data + (optionally) .env."""
    forced = os.environ.get("JAA_DATA_DIR")
    if forced:
        return Path(forced).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "JobApplyAssistant"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", str(Path.home()))) / "JobApplyAssistant"
    xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(xdg) / "JobApplyAssistant"


def _load_dotenv_layered():
    """Search well-known locations for .env, load the first one that exists."""
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parent.parent / ".env",     # backend/.env when launched from anywhere
        _per_os_data_dir() / ".env",
        Path.home() / ".jobapply.env",
    ]
    for p in candidates:
        try:
            if p.is_file():
                load_dotenv(p, override=False)
                log.info("Loaded .env from %s", p)
                return p
        except Exception as e:
            log.warning("Could not read %s: %s", p, e)
    log.info("No .env file found in any standard location — using env vars + DB-stored credentials only")
    return None


_LOADED_ENV = _load_dotenv_layered()


_PLACEHOLDERS = {
    "", "replace", "replace-with-your-key", "your-key", "your-api-key",
    "changeme", "todo", "tbd", "your_key_here", "none",
}


def _real(value: str | None, fallback: str) -> str:
    if value is None:
        return fallback
    v = value.strip().strip('"').strip("'")
    if v.lower() in _PLACEHOLDERS or v.lower().startswith("replace"):
        return fallback
    return v


def _default_data_dir() -> Path:
    base = _per_os_data_dir() if getattr(sys, "frozen", False) or os.environ.get("JAA_DATA_DIR") else Path.cwd()
    try: base.mkdir(parents=True, exist_ok=True)
    except Exception: pass
    return base


DATA_DIR = _default_data_dir()


class Settings:
    # --- Azure OpenAI configuration (env from .env wins; empty string = no fallback) ---
    AZURE_OPENAI_ENDPOINT: str = _real(
        os.getenv("AZURE_OPENAI_ENDPOINT"),
        "https://veilixdocumentextraction.openai.azure.com/",
    )
    # No baked-in API key — users provide via .env or the Settings UI (which stores it in the DB).
    # _resolve_azure_credentials() in analyzer.py prefers DB-stored > .env > empty.
    AZURE_OPENAI_API_KEY: str = (os.getenv("AZURE_OPENAI_API_KEY") or "").strip()
    AZURE_OPENAI_DEPLOYMENT: str = _real(os.getenv("AZURE_OPENAI_DEPLOYMENT"), "gpt-5-mini")
    AZURE_OPENAI_API_VERSION: str = _real(os.getenv("AZURE_OPENAI_API_VERSION"), "2024-02-15-preview")

    # --- App paths ---
    DATABASE_URL: str = _real(
        os.getenv("DATABASE_URL"),
        f"sqlite:///{DATA_DIR / 'jobapply.db'}",
    )
    UPLOAD_DIR: str = _real(os.getenv("UPLOAD_DIR"), str(DATA_DIR / "uploads"))

    # --- Static-file dir (for serving the dashboard from FastAPI) ---
    @staticmethod
    def _website_dir() -> Path:
        # 1. Explicit override — lets an installed app serve a live website folder
        #    (dashboard updates without rebuilding the PyInstaller bundle).
        forced = os.environ.get("JAA_WEBSITE_DIR")
        if forced and Path(forced).expanduser().is_dir():
            return Path(forced).expanduser()
        if getattr(sys, "frozen", False):
            base = Path(sys._MEIPASS) if hasattr(sys, "_MEIPASS") else Path(sys.executable).parent
            return base / "website"
        return Path(__file__).resolve().parent.parent.parent / "website"

    WEBSITE_DIR: Path = _website_dir.__func__()

    # --- Where we found .env (for debugging) ---
    DOTENV_PATH: str = str(_LOADED_ENV) if _LOADED_ENV else ""


settings = Settings()
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
