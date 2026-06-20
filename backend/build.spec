# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Job Apply Assistant backend.

Produces a one-folder bundle at dist/jobapply-backend/.

Build:
  cd backend
  bash build.sh       # or build.bat on Windows
"""
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

block_cipher = None

ROOT = Path(SPECPATH).resolve()
WEBSITE = ROOT.parent / "website"

# ---- Hidden imports ----
# PyInstaller doesn't trace dynamic imports done by FastAPI / SQLAlchemy / uvicorn,
# so we collect them explicitly. Missing any of these = silent runtime crash.
hidden = []
hidden += collect_submodules("uvicorn")
hidden += collect_submodules("uvicorn.loops")
hidden += collect_submodules("uvicorn.protocols")
hidden += collect_submodules("uvicorn.lifespan")
hidden += collect_submodules("sqlalchemy.dialects")
hidden += collect_submodules("sqlalchemy.dialects.sqlite")
hidden += collect_submodules("sqlalchemy.sql.default_comparator")
hidden += collect_submodules("pydantic")
hidden += collect_submodules("pydantic_core")
hidden += collect_submodules("langdetect")
hidden += collect_submodules("openai")
hidden += collect_submodules("pypdf")
hidden += collect_submodules("docx")

# Things FastAPI / Starlette / aiohttp need that PyInstaller often misses
hidden += [
    "email.mime.multipart",
    "email.mime.text",
    "fastapi.staticfiles",
    "fastapi.responses",
    "fastapi.middleware.cors",
    "starlette.staticfiles",
    "starlette.responses",
    "starlette.routing",
    "starlette.middleware",
    "starlette.middleware.cors",
    "passlib.handlers.bcrypt",
    "anyio._backends._asyncio",
    "httpcore._async.connection_pool",
    "httpx",
    "h11",
    "h2",
    "multipart",
    "python_multipart",
]

# Explicit imports of our own modules — belt + suspenders for routes that get
# imported via include_router() rather than top-level import statements.
hidden += [
    "app",
    "app.main",
    "app.config",
    "app.database",
    "app.models",
    "app.models.cv",
    "app.models.application",
    "app.models.profile",
    "app.models.question",
    "app.models.event",
    "app.models.settings",
    "app.routes",
    "app.routes.cvs",
    "app.routes.analyze",
    "app.routes.applications",
    "app.routes.profile",
    "app.routes.questions",
    "app.routes.emails",
    "app.routes.analytics",
    "app.routes.settings",
    "app.routes.discovery",
    "app.services",
    "app.services.analyzer",
    "app.services.cv_parser",
    "app.services.cv_match",
    "app.services.job_discovery",
    "app.services.language",
    "app.services.question_matcher",
    "app.services.typed_answer",
    "app.services.email_parser",
    "app.services.events",
    "app.services.answer_bank",
]

# ---- Data files ----
datas = []
# Bundle the dashboard HTML/JS/CSS
if WEBSITE.exists():
    datas.append((str(WEBSITE), "website"))
# langdetect ships language-profile files as data — without these, detection silently returns 'unknown'
datas += collect_data_files("langdetect")
# Some libs check their metadata at import time
for pkg in ("fastapi", "starlette", "pydantic", "openai", "uvicorn", "anyio"):
    try:
        datas += copy_metadata(pkg)
    except Exception:
        pass

a = Analysis(
    ["run.py"],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PyQt5", "PyQt6", "PySide2", "PySide6",
              "IPython", "notebook", "pandas", "numpy.distutils"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="jobapply-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe, a.binaries, a.zipfiles, a.datas,
    strip=False, upx=False, upx_exclude=[],
    name="jobapply-backend",
)
