"""Configuration loaded from environment variables (.env)."""
import os
from dotenv import load_dotenv

load_dotenv()

class Settings:
    AZURE_OPENAI_ENDPOINT: str = os.getenv("AZURE_OPENAI_ENDPOINT", "https://veilixdocumentextraction.openai.azure.com/")
    AZURE_OPENAI_API_KEY: str = os.getenv("AZURE_OPENAI_API_KEY", "")
    AZURE_OPENAI_DEPLOYMENT: str = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-5-mini")
    AZURE_OPENAI_API_VERSION: str = os.getenv("AZURE_OPENAI_API_VERSION", "2024-02-15-preview")
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./jobapply.db")
    UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", "./uploads")
    ALLOWED_ORIGINS: list[str] = os.getenv(
        "ALLOWED_ORIGINS",
        "chrome-extension://*,http://localhost:5173,http://localhost:3000,http://127.0.0.1:5500"
    ).split(",")

settings = Settings()
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
