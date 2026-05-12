"""FastAPI entrypoint."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .database import Base, engine
from .config import settings
from .routes import cvs, analyze, applications, profile

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Job Apply Assistant API", version="0.1.0")

# Allow the extension (chrome-extension://...) and the dashboard origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # locked down later with extension key
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"status": "ok", "service": "job-apply-assistant"}

@app.get("/health")
def health():
    return {"status": "ok", "model": settings.AZURE_OPENAI_DEPLOYMENT}

app.include_router(cvs.router)
app.include_router(analyze.router)
app.include_router(applications.router)
app.include_router(profile.router)
