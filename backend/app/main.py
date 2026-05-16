"""FastAPI entrypoint. Locked to the gpt-5-mini Azure deployment.
Performs a startup self-check against the deployment so failures show immediately."""
import logging
import traceback
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from .database import Base, engine, ensure_schema
from .config import settings
from .routes import cvs, analyze, applications, profile, questions, emails, analytics, settings as settings_router
from .services.analyzer import verify_model

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("jaa")

Base.metadata.create_all(bind=engine)
ensure_schema()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup verification — runs once when uvicorn boots.
    log.info("Verifying Azure OpenAI deployment '%s' at %s …",
             settings.AZURE_OPENAI_DEPLOYMENT, settings.AZURE_OPENAI_ENDPOINT)
    info = verify_model()
    if info.get("ok"):
        log.info("✓ Model reachable. Reply: %r", info.get("reply"))
    else:
        log.error("✗ Model verification FAILED: %s", info.get("error"))
        log.error("  → Check AZURE_OPENAI_DEPLOYMENT/API_KEY/API_VERSION in backend/.env")
    app.state.model_status = info
    yield


app = FastAPI(title="Job Apply Assistant API", version="0.2.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=False,
    allow_methods=["*"], allow_headers=["*"],
)


@app.exception_handler(Exception)
async def all_exception_handler(request: Request, exc: Exception):
    log.error("Unhandled error on %s %s:\n%s",
              request.method, request.url.path, traceback.format_exc())
    return JSONResponse(
        status_code=500,
        content={"detail": f"{type(exc).__name__}: {exc}"},
    )


@app.get("/")
def root():
    return {"status": "ok", "service": "job-apply-assistant",
            "model": settings.AZURE_OPENAI_DEPLOYMENT}


@app.get("/health")
def health(request: Request):
    status = getattr(request.app.state, "model_status", None) or {}
    return {
        "status": "ok",
        "model": settings.AZURE_OPENAI_DEPLOYMENT,
        "endpoint": settings.AZURE_OPENAI_ENDPOINT,
        "api_version": settings.AZURE_OPENAI_API_VERSION,
        "api_key_set": bool(settings.AZURE_OPENAI_API_KEY),
        "model_verified": status.get("ok", False),
        "model_error": status.get("error"),
        "model_reply": status.get("reply"),
    }


@app.post("/verify-model")
def verify_now(request: Request):
    """Force a fresh verification (e.g. after editing .env)."""
    info = verify_model()
    request.app.state.model_status = info
    return info


app.include_router(cvs.router)
app.include_router(analyze.router)
app.include_router(applications.router)
app.include_router(profile.router)
app.include_router(questions.router)
app.include_router(emails.router)
app.include_router(analytics.router)
app.include_router(settings_router.router)

# Serve the dashboard alongside the API so the Tauri shell can load it from one origin.
import os
_website = settings.WEBSITE_DIR if hasattr(settings, "WEBSITE_DIR") else None
if _website and os.path.isdir(str(_website)):
    app.mount("/dashboard", StaticFiles(directory=str(_website), html=True), name="dashboard")

    @app.get("/", include_in_schema=False)
    def root_redirect():
        return RedirectResponse(url="/dashboard/")
