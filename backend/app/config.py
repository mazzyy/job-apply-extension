"""Configuration.

Reads from `.env`, but ignores obvious placeholder strings so a leftover
.env.example value can't silently override working defaults.

When packaged as a desktop app, the Tauri shell sets JAA_DATA_DIR to a
per-user writable location (e.g. ~/Library/Application Support/JobApplyAssistant/
on macOS, %APPDATA%\JobApplyAssistant\ on Windows). Without it we fall back to
the working directory (developer mode).
"""
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()


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
    """Per-OS sensible default. Overridden by JAA_DATA_DIR env var."""
    forced = os.environ.get("JAA_DATA_DIR")
    if forced:
        p = Path(forced).expanduser()
        p.mkdir(parents=True, exist_ok=True)
        return p
    # Frozen by PyInstaller? Use OS-appropriate user data dir
    if getattr(sys, "frozen", False):
        if sys.platform == "darwin":
            base = Path.home() / "Library" / "Application Support" / "JobApplyAssistant"
        elif sys.platform == "win32":
            base = Path(os.environ.get("APPDATA", str(Path.home()))) / "JobApplyAssistant"
        else:
            xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
            base = Path(xdg) / "JobApplyAssistant"
        base.mkdir(parents=True, exist_ok=True)
        return base
    # Dev mode — use working dir
    return Path.cwd()


DATA_DIR = _default_data_dir()


class Settings:
    # --- Locked Azure OpenAI configuration (env overrides only if non-placeholder) ---
    AZURE_OPENAI_ENDPOINT: str = _real(
        os.getenv("AZURE_OPENAI_ENDPOINT"),
        "https://veilixdocumentextraction.openai.azure.com/",
    )
    AZURE_OPENAI_API_KEY: str = _real(
        os.getenv("AZURE_OPENAI_API_KEY"),
        "replace-with-your-key",
    )
    AZURE_OPENAI_DEPLOYMENT: str = _real(os.getenv("AZURE_OPENAI_DEPLOYMENT"), "gpt-5-mini")
    AZURE_OPENAI_API_VERSION: str = _real(os.getenv("AZURE_OPENAI_API_VERSION"), "2024-02-15-preview")

    # --- App paths (use DATA_DIR so installer-bundled app has writable storage) ---
    DATABASE_URL: str = _real(
        os.getenv("DATABASE_URL"),
        f"sqlite:///{DATA_DIR / 'jobapply.db'}",
    )
    UPLOAD_DIR: str = _real(os.getenv("UPLOAD_DIR"), str(DATA_DIR / "uploads"))

    # --- Static-file dir (for serving the dashboard from FastAPI) ---
    # When frozen, PyInstaller copies website/ next to the executable.
    # When dev, the website/ folder is alongside backend/.
    @staticmethod
    def _website_dir() -> Path:
        if getattr(sys, "frozen", False):
            base = Path(sys._MEIPASS) if hasattr(sys, "_MEIPASS") else Path(sys.executable).parent
            return base / "website"
        return Path(__file__).resolve().parent.parent.parent / "website"

    WEBSITE_DIR: Path = _website_dir.__func__()


settings = Settings()
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
