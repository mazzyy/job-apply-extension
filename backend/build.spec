# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Job Apply Assistant backend.

Produces a one-folder bundle at dist/jobapply-backend/ containing:
  - jobapply-backend  (the entrypoint binary)
  - _internal/        (Python runtime + deps)
  - website/          (bundled dashboard HTML/JS/CSS)

Build with:
  cd backend
  pyinstaller build.spec --clean
"""
import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

ROOT = Path(SPECPATH).resolve()
WEBSITE = ROOT.parent / "website"

# Hidden imports — uvicorn workers, sqlalchemy dialects, langdetect data tables,
# pydantic submodules. Without these the frozen binary fails at runtime.
hidden = []
hidden += collect_submodules("uvicorn")
hidden += collect_submodules("sqlalchemy.dialects")
hidden += collect_submodules("pydantic")
hidden += ["email.mime.multipart", "email.mime.text", "passlib.handlers.bcrypt"]
hidden += ["fastapi.staticfiles", "starlette.staticfiles"]

datas = []
# Bundle the website so FastAPI's static mount can serve it
if WEBSITE.exists():
    datas.append((str(WEBSITE), "website"))
# Bundle langdetect's profile data
datas += collect_data_files("langdetect")

a = Analysis(
    ["run.py"],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PyQt5", "PyQt6", "PySide2", "PySide6"],
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
    console=True,                 # keep stdout visible for Tauri to read
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe, a.binaries, a.zipfiles, a.datas,
    strip=False, upx=False, upx_exclude=[],
    name="jobapply-backend",
)
