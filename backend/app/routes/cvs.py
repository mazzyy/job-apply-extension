"""CV upload, list, set-active, delete."""
import json
import os
import shutil
from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException
from sqlalchemy.orm import Session
from ..database import get_db
from ..config import settings
from ..models import CV, Profile
from ..services.cv_parser import extract_text
from ..services.analyzer import structure_cv
from ..services.cv_match import pick_best_cv
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter(prefix="/cvs", tags=["cvs"])

@router.get("/")
def list_cvs(db: Session = Depends(get_db)):
    rows = db.query(CV).order_by(CV.created_at.desc()).all()
    return [
        {
            "id": c.id, "label": c.label, "tag": c.tag, "filename": c.filename,
            "is_active": c.is_active, "created_at": c.created_at.isoformat(),
            "preview": (c.raw_text or "")[:300],
        }
        for c in rows
    ]

@router.post("/")
async def upload_cv(
    file: UploadFile = File(...),
    label: str = Form(...),
    tag: str = Form(""),
    set_active: bool = Form(False),
    db: Session = Depends(get_db),
):
    safe_name = file.filename.replace("/", "_")
    dest = os.path.join(settings.UPLOAD_DIR, f"{safe_name}")
    # avoid overwriting
    base, ext = os.path.splitext(dest)
    i = 1
    while os.path.exists(dest):
        dest = f"{base}_{i}{ext}"
        i += 1
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    try:
        text = extract_text(dest)
    except Exception as e:
        os.remove(dest)
        raise HTTPException(400, f"Could not parse CV: {e}")
    if not text:
        raise HTTPException(400, "CV appears to be empty or unreadable.")

    structured = {}
    try:
        structured = structure_cv(text)
    except Exception:
        structured = {}

    if set_active:
        db.query(CV).update({CV.is_active: False})

    cv = CV(
        label=label,
        tag=tag or None,
        filename=file.filename,
        file_path=dest,
        raw_text=text,
        structured=json.dumps(structured, ensure_ascii=False),
        is_active=set_active,
    )
    db.add(cv)
    db.commit()
    db.refresh(cv)

    # Upsert profile from the first/active CV
    if set_active and structured:
        prof = db.query(Profile).first()
        if not prof:
            prof = Profile()
            db.add(prof)
        for field in [
            "full_name", "first_name", "last_name", "email", "phone",
            "city", "country", "linkedin_url", "github_url", "portfolio_url",
            "current_company", "current_title",
        ]:
            val = structured.get(field) or ""
            if val:
                setattr(prof, field, val)
        if isinstance(structured.get("years_experience"), int):
            prof.years_experience = structured["years_experience"]
        if structured.get("languages"):
            prof.languages = json.dumps(structured["languages"], ensure_ascii=False)
        db.commit()

    return {"id": cv.id, "label": cv.label, "is_active": cv.is_active, "structured": structured}

@router.post("/{cv_id}/activate")
def set_active(cv_id: int, db: Session = Depends(get_db)):
    cv = db.query(CV).filter(CV.id == cv_id).first()
    if not cv:
        raise HTTPException(404, "CV not found")
    db.query(CV).update({CV.is_active: False})
    cv.is_active = True
    db.commit()
    return {"ok": True, "active_id": cv_id}

@router.delete("/{cv_id}")
def delete_cv(cv_id: int, db: Session = Depends(get_db)):
    cv = db.query(CV).filter(CV.id == cv_id).first()
    if not cv:
        raise HTTPException(404, "CV not found")
    try:
        os.remove(cv.file_path)
    except OSError:
        pass
    db.delete(cv)
    db.commit()
    return {"ok": True}

@router.get("/active")
def get_active(db: Session = Depends(get_db)):
    cv = db.query(CV).filter(CV.is_active == True).first()  # noqa: E712
    if not cv:
        cv = db.query(CV).order_by(CV.created_at.desc()).first()
    if not cv:
        raise HTTPException(404, "No CV uploaded yet")
    return {
        "id": cv.id, "label": cv.label, "tag": cv.tag,
        "raw_text": cv.raw_text,
        "structured": json.loads(cv.structured or "{}"),
    }


@router.get("/{cv_id}/file")
def cv_file(cv_id: int, db: Session = Depends(get_db)):
    """Raw CV file — used by the integrated browser to attach it to a form."""
    cv = db.query(CV).filter(CV.id == cv_id).first()
    if not cv or not (cv.file_path and os.path.exists(cv.file_path)):
        raise HTTPException(404, "CV file not found")
    return FileResponse(cv.file_path, filename=cv.filename or "cv.pdf")


class BestCVIn(BaseModel):
    job_description: str | None = None


@router.post("/best")
def best_cv(body: BestCVIn, db: Session = Depends(get_db)):
    """Pick the best-matching CV for a job description (keyword overlap, no LLM).
    Falls back to the active CV when there's no JD/match."""
    cvs = db.query(CV).all()
    if not cvs:
        raise HTTPException(404, "No CV uploaded yet")
    jd = (body.job_description or "").strip()
    best = None
    if jd:
        best, _ = pick_best_cv(cvs, jd)
    if not best:
        best = next((c for c in cvs if c.is_active), None) or cvs[0]
    return {"id": best.id, "label": best.label, "filename": best.filename}
