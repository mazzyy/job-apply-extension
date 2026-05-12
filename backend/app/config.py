"""Configuration.

Reads from `.env`, but treats obvious placeholder strings as "unset" so a
leftover .env.example value can't silently override the working defaults baked
into this file.
"""
import os
from dotenv import load_dotenv

load_dotenv()

# Strings that mean "I didn't actually fill this in" — treated as unset.
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

    # --- App ---
    DATABASE_URL: str = _real(os.getenv("DATABASE_URL"), "sqlite:///./jobapply.db")
    UPLOAD_DIR: str = _real(os.getenv("UPLOAD_DIR"), "./uploads")


settings = Settings()
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
