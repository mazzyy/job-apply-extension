"""Application question library + matcher + LLM draft."""
import json
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import desc
from ..database import get_db
from ..models import Question, QuestionAnswer, CV, Profile, Application, ApplicationEvent
from ..services.question_matcher import normalize, similarity, classify
from ..services.analyzer import answer_application_question

router = APIRouter(prefix="/questions", tags=["questions"])


class QuestionIn(BaseModel):
    text: str
    category: str | None = None
    tags: str | None = None


class AnswerIn(BaseModel):
    answer: str
    is_default: bool = False
    application_id: int | None = None


class MatchRequest(BaseModel):
    text: str
    top_k: int = 3
    min_score: float = 0.30


class DraftRequest(BaseModel):
    text: str
    application_id: int | None = None
    cv_id: int | None = None
    save: bool = False                  # if True, store the drafted answer
    save_as_default: bool = False


def _q_to_dict(q: Question, db: Session) -> dict:
    answers = (
        db.query(QuestionAnswer)
        .filter(QuestionAnswer.question_id == q.id)
        .order_by(desc(QuestionAnswer.is_default), desc(QuestionAnswer.last_used_at))
        .all()
    )
    return {
        "id": q.id, "text": q.text, "category": q.category, "tags": q.tags,
        "use_count": q.use_count,
        "created_at": q.created_at.isoformat(),
        "last_used_at": q.last_used_at.isoformat(),
        "answers": [_a_to_dict(a) for a in answers],
    }


def _a_to_dict(a: QuestionAnswer) -> dict:
    return {
        "id": a.id, "question_id": a.question_id,
        "answer": a.answer, "is_default": bool(a.is_default),
        "application_id": a.application_id,
        "use_count": a.use_count,
        "created_at": a.created_at.isoformat(),
        "last_used_at": a.last_used_at.isoformat(),
    }


@router.get("/")
def list_questions(category: str | None = None, db: Session = Depends(get_db)):
    q = db.query(Question)
    if category:
        q = q.filter(Question.category == category)
    rows = q.order_by(desc(Question.last_used_at)).all()
    return [_q_to_dict(r, db) for r in rows]


@router.post("/")
def create_question(body: QuestionIn, db: Session = Depends(get_db)):
    norm = normalize(body.text)
    if not norm:
        raise HTTPException(400, "Question text required")
    # If a question with same normalized text exists, return it
    existing = db.query(Question).filter(Question.normalized == norm).first()
    if existing:
        return _q_to_dict(existing, db)
    q = Question(
        text=body.text.strip(),
        normalized=norm,
        category=body.category or classify(body.text),
        tags=body.tags,
    )
    db.add(q); db.commit(); db.refresh(q)
    return _q_to_dict(q, db)


@router.get("/{qid}")
def get_question(qid: int, db: Session = Depends(get_db)):
    q = db.query(Question).filter(Question.id == qid).first()
    if not q: raise HTTPException(404, "Not found")
    return _q_to_dict(q, db)


@router.delete("/{qid}")
def delete_question(qid: int, db: Session = Depends(get_db)):
    q = db.query(Question).filter(Question.id == qid).first()
    if not q: raise HTTPException(404, "Not found")
    db.query(QuestionAnswer).filter(QuestionAnswer.question_id == qid).delete()
    db.delete(q); db.commit()
    return {"ok": True}


@router.post("/{qid}/answers")
def add_answer(qid: int, body: AnswerIn, db: Session = Depends(get_db)):
    q = db.query(Question).filter(Question.id == qid).first()
    if not q: raise HTTPException(404, "Question not found")
    if body.is_default:
        db.query(QuestionAnswer).filter(QuestionAnswer.question_id == qid).update({QuestionAnswer.is_default: 0})
    a = QuestionAnswer(
        question_id=qid, answer=body.answer.strip(),
        is_default=1 if body.is_default else 0,
        application_id=body.application_id,
    )
    db.add(a)
    q.use_count = (q.use_count or 0) + 1
    q.last_used_at = datetime.utcnow()
    db.commit(); db.refresh(a)
    return _a_to_dict(a)


@router.patch("/answers/{aid}")
def update_answer(aid: int, body: AnswerIn, db: Session = Depends(get_db)):
    a = db.query(QuestionAnswer).filter(QuestionAnswer.id == aid).first()
    if not a: raise HTTPException(404, "Not found")
    a.answer = body.answer.strip()
    if body.is_default:
        db.query(QuestionAnswer).filter(QuestionAnswer.question_id == a.question_id).update({QuestionAnswer.is_default: 0})
        a.is_default = 1
    db.commit(); db.refresh(a)
    return _a_to_dict(a)


@router.delete("/answers/{aid}")
def delete_answer(aid: int, db: Session = Depends(get_db)):
    a = db.query(QuestionAnswer).filter(QuestionAnswer.id == aid).first()
    if not a: raise HTTPException(404, "Not found")
    db.delete(a); db.commit()
    return {"ok": True}


@router.post("/match")
def match_question(body: MatchRequest, db: Session = Depends(get_db)):
    """Return saved questions most similar to the given text, with their answers."""
    if not body.text or len(body.text.strip()) < 4:
        raise HTTPException(400, "Question too short")
    rows = db.query(Question).all()
    scored = []
    for q in rows:
        s = similarity(body.text, q.text)
        if s >= body.min_score:
            scored.append((s, q))
    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[: body.top_k]
    return {
        "matches": [
            {"score": round(s, 3), **_q_to_dict(q, db)} for s, q in top
        ],
        "best_score": round(top[0][0], 3) if top else 0,
        "category_hint": classify(body.text),
    }


@router.post("/draft")
def draft_answer(body: DraftRequest, db: Session = Depends(get_db)):
    """LLM-draft an answer to a question, using CV + profile + (optionally) job context.
    If `save=True`, the question and answer get stored in the library."""
    # Resolve CV
    cv = None
    if body.cv_id:
        cv = db.query(CV).filter(CV.id == body.cv_id).first()
    if not cv:
        cv = db.query(CV).filter(CV.is_active == True).first()  # noqa: E712
    if not cv:
        cv = db.query(CV).order_by(desc(CV.created_at)).first()
    if not cv:
        raise HTTPException(400, "No CV uploaded")

    # Build context
    prof = db.query(Profile).first()
    profile_json = "{}"
    if prof:
        profile_json = json.dumps({
            "full_name": prof.full_name, "email": prof.email,
            "current_title": prof.current_title,
            "current_company": prof.current_company,
            "years_experience": prof.years_experience,
            "city": prof.city, "country": prof.country,
        }, ensure_ascii=False)

    job_context = ""
    if body.application_id:
        a = db.query(Application).filter(Application.id == body.application_id).first()
        if a:
            job_context = f"\nJOB CONTEXT (the candidate is applying to):\nRole: {a.job_title}\nCompany: {a.company}\nJD snippet: {(a.job_description or '')[:1500]}\n"

    prompt_question = body.text.strip() + ("\n\n" + job_context if job_context else "")
    drafted = answer_application_question(prompt_question, cv.raw_text, profile_json)

    result = {"answer": drafted, "saved": False}
    if body.save and drafted and not drafted.startswith("(could not"):
        norm = normalize(body.text)
        q = db.query(Question).filter(Question.normalized == norm).first()
        if not q:
            q = Question(text=body.text.strip(), normalized=norm, category=classify(body.text))
            db.add(q); db.commit(); db.refresh(q)
        if body.save_as_default:
            db.query(QuestionAnswer).filter(QuestionAnswer.question_id == q.id).update({QuestionAnswer.is_default: 0})
        a = QuestionAnswer(
            question_id=q.id, answer=drafted,
            is_default=1 if body.save_as_default else 0,
            application_id=body.application_id,
        )
        db.add(a)
        q.use_count = (q.use_count or 0) + 1
        q.last_used_at = datetime.utcnow()
        db.commit(); db.refresh(a)
        result["saved"] = True
        result["question_id"] = q.id
        result["answer_id"] = a.id
    return result


@router.post("/answers/{aid}/use")
def record_use(aid: int, db: Session = Depends(get_db)):
    """Bump usage counters when an answer is pasted into an application form."""
    a = db.query(QuestionAnswer).filter(QuestionAnswer.id == aid).first()
    if not a: raise HTTPException(404, "Not found")
    a.use_count = (a.use_count or 0) + 1
    a.last_used_at = datetime.utcnow()
    q = db.query(Question).filter(Question.id == a.question_id).first()
    if q:
        q.use_count = (q.use_count or 0) + 1
        q.last_used_at = datetime.utcnow()
    db.commit()
    return {"ok": True}
