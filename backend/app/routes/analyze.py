"""Fit analysis endpoint — used by the extension on every LinkedIn / Greenhouse / Lever job page."""
import json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import CV, Application
from ..services.analyzer import analyze_fit, answer_application_question
from ..services.language import scan_language_requirements

router = APIRouter(prefix="/analyze", tags=["analyze"])

class AnalyzeRequest(BaseModel):
    job_description: str
    job_title: str | None = None
    company: str | None = None
    location: str | None = None
    url: str | None = None
    source: str | None = None        # "linkedin", "greenhouse", "lever", "other"
    cv_id: int | None = None         # if None, use active CV
    save: bool = True                # whether to record this as an application row

class QuestionRequest(BaseModel):
    question: str
    cv_id: int | None = None

@router.post("/")
def analyze(req: AnalyzeRequest, db: Session = Depends(get_db)):
    cv = None
    if req.cv_id:
        cv = db.query(CV).filter(CV.id == req.cv_id).first()
    if not cv:
        cv = db.query(CV).filter(CV.is_active == True).first()  # noqa: E712
    if not cv:
        cv = db.query(CV).order_by(CV.created_at.desc()).first()
    if not cv:
        raise HTTPException(400, "No CV uploaded yet. Upload one in the dashboard first.")

    if not req.job_description or len(req.job_description.strip()) < 80:
        raise HTTPException(400, "Job description too short to analyze.")

    lang_info = scan_language_requirements(req.job_description)
    fit = analyze_fit(
        cv_text=cv.raw_text,
        job_description=req.job_description,
        job_title=req.job_title or "",
        company=req.company or "",
    )

    result = {
        **fit,
        "language": lang_info,
        "cv_used": {"id": cv.id, "label": cv.label, "tag": cv.tag},
    }

    if req.save:
        app = Application(
            cv_id=cv.id,
            job_title=req.job_title,
            company=req.company,
            location=req.location,
            url=req.url,
            source=req.source or "other",
            job_description=req.job_description[:20000],
            language=lang_info.get("jd_language"),
            requires_other_language=", ".join(lang_info.get("requires_other_languages", [])) or None,
            fit_score=float(fit.get("fit_score", 0) or 0),
            strengths=json.dumps(fit.get("strengths", []), ensure_ascii=False),
            gaps=json.dumps(fit.get("gaps", []), ensure_ascii=False),
            recommendations=json.dumps(fit.get("recommendations", []), ensure_ascii=False),
            verdict=fit.get("verdict"),
            status="analyzed",
        )
        db.add(app)
        db.commit()
        db.refresh(app)
        result["application_id"] = app.id

    return result

@router.post("/answer")
def answer(req: QuestionRequest, db: Session = Depends(get_db)):
    """Draft an answer to an open-ended application question."""
    cv = None
    if req.cv_id:
        cv = db.query(CV).filter(CV.id == req.cv_id).first()
    if not cv:
        cv = db.query(CV).filter(CV.is_active == True).first()  # noqa: E712
    if not cv:
        raise HTTPException(400, "No CV uploaded")
    from ..models import Profile
    prof = db.query(Profile).first()
    profile_json = "{}"
    if prof:
        profile_json = json.dumps({
            "full_name": prof.full_name, "email": prof.email,
            "current_title": prof.current_title, "current_company": prof.current_company,
            "years_experience": prof.years_experience,
        }, ensure_ascii=False)
    answer = answer_application_question(req.question, cv.raw_text, profile_json)
    return {"answer": answer}
