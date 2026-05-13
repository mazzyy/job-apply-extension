"""Fit analysis + CV auto-pick + cover letter generation."""
import json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import CV, Application
from ..services.events import emit
from ..services.analyzer import analyze_fit, answer_application_question, _chat
from ..services.language import scan_language_requirements
from ..services.cv_match import pick_best_cv, score_cv_against_jd

router = APIRouter(prefix="/analyze", tags=["analyze"])


class AnalyzeRequest(BaseModel):
    job_description: str
    job_title: str | None = None
    company: str | None = None
    location: str | None = None
    url: str | None = None
    source: str | None = None
    cv_id: int | None = None
    auto_select_cv: bool = True       # NEW: pick best CV automatically
    save: bool = True


class QuestionRequest(BaseModel):
    question: str
    cv_id: int | None = None


class CoverLetterRequest(BaseModel):
    job_description: str
    job_title: str | None = None
    company: str | None = None
    cv_id: int | None = None
    tone: str = "professional"        # professional | warm | enthusiastic | concise


class BestCvRequest(BaseModel):
    job_description: str


def _resolve_cv(req_cv_id, db: Session, jd_text: str, auto_select: bool):
    """Returns (cv, selection_meta). Picks by id → auto-select → active → newest."""
    all_cvs = db.query(CV).all()
    if not all_cvs:
        raise HTTPException(400, "No CV uploaded yet. Upload one in the dashboard first.")

    # 1. Explicit cv_id wins
    if req_cv_id:
        cv = db.query(CV).filter(CV.id == req_cv_id).first()
        if not cv:
            raise HTTPException(404, f"CV id {req_cv_id} not found")
        return cv, {"strategy": "explicit", "cv_id": cv.id}

    # 2. Auto-select if we have >1 CV
    if auto_select and len(all_cvs) > 1 and jd_text:
        best, scored = pick_best_cv(all_cvs, jd_text)
        if best:
            return best, {"strategy": "auto", "cv_id": best.id, "scores": scored}

    # 3. Active CV
    cv = db.query(CV).filter(CV.is_active == True).first()  # noqa: E712
    if cv:
        return cv, {"strategy": "active", "cv_id": cv.id}

    # 4. Most recent
    cv = db.query(CV).order_by(CV.created_at.desc()).first()
    return cv, {"strategy": "newest", "cv_id": cv.id}


@router.post("/")
def analyze(req: AnalyzeRequest, db: Session = Depends(get_db)):
    if not req.job_description or len(req.job_description.strip()) < 80:
        raise HTTPException(400, "Job description too short to analyze.")

    cv, selection = _resolve_cv(req.cv_id, db, req.job_description, req.auto_select_cv)

    lang_info = scan_language_requirements(req.job_description)
    fit = analyze_fit(
        cv_text=cv.raw_text,
        job_description=req.job_description,
        job_title=req.job_title or "",
        company=req.company or "",
    )

    jd_length = len(req.job_description)
    jd_warning = None
    if jd_length < 1500:
        jd_warning = f"Only {jd_length} characters of JD captured — scroll the description into view and re-analyze for a sharper result."

    result = {
        **fit,
        "language": lang_info,
        "cv_used": {"id": cv.id, "label": cv.label, "tag": cv.tag},
        "cv_selection": selection,
        "jd_length": jd_length,
        "jd_warning": jd_warning,
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
        db.commit(); db.refresh(app)
        emit(db, app.id, kind="analyzed",
             title=f"Analyzed · {int(fit.get('fit_score') or 0)}/100 · {fit.get('fit_label','')}",
             detail=fit.get("verdict"), source="analyzer")
        result["application_id"] = app.id

    return result


@router.post("/best-cv")
def best_cv(req: BestCvRequest, db: Session = Depends(get_db)):
    """Return the best-matching CV for a given JD plus per-CV scores."""
    cvs = db.query(CV).all()
    if not cvs:
        raise HTTPException(400, "No CVs uploaded.")
    if len(req.job_description.strip()) < 80:
        raise HTTPException(400, "Job description too short.")
    best, scored = pick_best_cv(cvs, req.job_description)
    return {"best_cv_id": best.id if best else None,
            "best_cv_label": best.label if best else None,
            "scores": scored}


@router.post("/cover-letter")
def cover_letter(req: CoverLetterRequest, db: Session = Depends(get_db)):
    """Draft a tailored cover letter for the role."""
    if not req.job_description or len(req.job_description.strip()) < 80:
        raise HTTPException(400, "Job description too short for a cover letter.")
    cv, _ = _resolve_cv(req.cv_id, db, req.job_description, auto_select=True)

    tone = req.tone or "professional"
    prompt = f"""Write a tailored cover letter for this role.

ROLE: {req.job_title or "(unknown)"}
COMPANY: {req.company or "(unknown)"}
TONE: {tone}

JOB DESCRIPTION:
\"\"\"
{req.job_description[:5000]}
\"\"\"

CANDIDATE CV:
\"\"\"
{cv.raw_text[:5000]}
\"\"\"

Requirements:
- 220-320 words, 3-4 short paragraphs
- Open with a specific reason this role/company is interesting (not generic)
- Cite 2-3 concrete things from the CV that match the JD's requirements
- Honest about gaps if any — never invent skills
- Close with a clear next step (e.g. happy to discuss next week)
- No clichés ("dynamic", "synergy", "team player", "passionate")
- First person, plain prose, no bullets, no markdown
- Sign as just the candidate's first name"""
    text = _chat(
        [
            {"role": "system", "content": "You write specific, honest, non-generic cover letters."},
            {"role": "user", "content": prompt},
        ],
        want_json=False,
        max_tokens=1800,
    )
    return {"cover_letter": text.strip(), "cv_used": {"id": cv.id, "label": cv.label}}


@router.post("/answer")
def answer(req: QuestionRequest, db: Session = Depends(get_db)):
    cv, _ = _resolve_cv(req.cv_id, db, "", auto_select=False)
    from ..models import Profile
    prof = db.query(Profile).first()
    profile_json = "{}"
    if prof:
        profile_json = json.dumps({
            "full_name": prof.full_name, "email": prof.email,
            "current_title": prof.current_title,
            "current_company": prof.current_company,
            "years_experience": prof.years_experience,
        }, ensure_ascii=False)
    answer = answer_application_question(req.question, cv.raw_text, profile_json)
    return {"answer": answer}
