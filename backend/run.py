"""Frozen-binary entry point. Reads JAA_DATA_DIR + PORT from env."""
import os
import sys

# Allow JAA_PORT override (defaults to 8000)
PORT = int(os.environ.get("JAA_PORT") or os.environ.get("PORT") or 8000)
HOST = os.environ.get("JAA_HOST", "127.0.0.1")

# Ensure log output isn't buffered when running as a subprocess of Tauri
os.environ.setdefault("PYTHONUNBUFFERED", "1")

if __name__ == "__main__":
    import uvicorn
    from app.main import app
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
