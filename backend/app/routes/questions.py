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
from ..services.typed_answer import answer_for_form, lookup_default_answer
from ..services.answer_bank import SEED_QUESTIONS
from ..services.translator import to_english, from_english, is_english
from ..services.language import detect_language

router = APIRouter(prefix="/questions", tags=["questions"])


class QuestionIn(BaseModel):
    text: str
    category: str | None = None
    tags: str | None = None


class AnswerIn(BaseModel):
    answer: str
    answer_type: str = "text"                       # number | text | textarea | select | radio
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
        "needs_review": bool(q.needs_review or 0),
        "last_input_type": q.last_input_type,
        "last_max_length": q.last_max_length,
        "last_options": q.last_options,
        "created_at": q.created_at.isoformat(),
        "last_used_at": q.last_used_at.isoformat(),
        "answers": [_a_to_dict(a) for a in answers],
    }


def _a_to_dict(a: QuestionAnswer) -> dict:
    return {
        "id": a.id, "question_id": a.question_id,
        "answer": a.answer,
        "answer_type": a.answer_type or "text",
        "is_default": bool(a.is_default),
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


@router.get("/by-id/{qid}")
def get_question(qid: int, db: Session = Depends(get_db)):
    q = db.query(Question).filter(Question.id == qid).first()
    if not q: raise HTTPException(404, "Not found")
    return _q_to_dict(q, db)


@router.delete("/by-id/{qid}")
def delete_question(qid: int, db: Session = Depends(get_db)):
    q = db.query(Question).filter(Question.id == qid).first()
    if not q: raise HTTPException(404, "Not found")
    db.query(QuestionAnswer).filter(QuestionAnswer.question_id == qid).delete()
    db.delete(q); db.commit()
    return {"ok": True}


@router.post("/by-id/{qid}/answers")
def add_answer(qid: int, body: AnswerIn, db: Session = Depends(get_db)):
    q = db.query(Question).filter(Question.id == qid).first()
    if not q: raise HTTPException(404, "Question not found")
    if body.is_default:
        db.query(QuestionAnswer).filter(QuestionAnswer.question_id == qid).update({QuestionAnswer.is_default: 0})
    a = QuestionAnswer(
        question_id=qid, answer=body.answer.strip(),
        answer_type=body.answer_type or "text",
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
    if body.answer_type:
        a.answer_type = body.answer_type
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

class FormAnswerRequest(BaseModel):
    text: str
    input_type: str = "text"           # number | text | textarea | select | radio
    max_length: int | None = None
    options: list[str] | None = None   # for select/radio
    application_id: int | None = None
    cv_id: int | None = None
    save: bool = True                  # always save the question so user can review


@router.post("/answer-for-form")
def answer_for_form_route(body: FormAnswerRequest, db: Session = Depends(get_db)):
    """Generate a shape-correct answer for one form field and always log the question.
    The question is saved with needs_review=true so the user can review/edit it in the dashboard."""
    cv = None
    if body.cv_id:
        cv = db.query(CV).filter(CV.id == body.cv_id).first()
    if not cv:
        cv = db.query(CV).filter(CV.is_active == True).first()  # noqa: E712
    if not cv:
        cv = db.query(CV).order_by(desc(CV.created_at)).first()
    if not cv:
        raise HTTPException(400, "No CV uploaded")

    prof = db.query(Profile).first()
    profile_json = "{}"
    if prof:
        profile_json = json.dumps({
            "full_name": prof.full_name, "email": prof.email,
            "current_title": prof.current_title,
            "current_company": prof.current_company,
            "years_experience": prof.years_experience,
            "city": prof.city, "country": prof.country,
            "languages": json.loads(prof.languages) if prof.languages else [],
        }, ensure_ascii=False)

    job_context = ""
    if body.application_id:
        a = db.query(Application).filter(Application.id == body.application_id).first()
        if a:
            job_context = f"\nJOB CONTEXT: Role {a.job_title} at {a.company}. JD snippet: {(a.job_description or '')[:1000]}\n"

    # Detect the form's language so we can translate back at the end
    form_lang = detect_language(body.text)
    english_question = body.text if is_english(body.text) else to_english(body.text)

    # FIRST: check the curated answer bank against the English version.
    bank_hit = lookup_default_answer(db, english_question, input_type=body.input_type)
    if bank_hit:
        value = bank_hit["value"]
        # If the form is non-English AND the answer is a long-form text (not number/select),
        # translate the saved answer to the form's language so it reads naturally.
        if body.input_type in ("text", "textarea") and form_lang not in ("en", "unknown") and isinstance(value, str) and len(value) > 30:
            try:
                value = from_english(value, form_lang)
            except Exception:
                pass
        return {
            "value": value,
            "explanation": bank_hit["explanation"] + (f" (translated to {form_lang})" if form_lang not in ("en","unknown") else ""),
            "confidence": bank_hit["confidence"],
            "needs_review": False,
            "source": "library",
            "question_id": bank_hit.get("question_id"),
            "answer_id": bank_hit.get("answer_id"),
        }

    typed = answer_for_form(
        question=body.text,
        cv_text=cv.raw_text,
        profile_json=profile_json,
        input_type=body.input_type,
        max_length=body.max_length,
        options=body.options,
        job_context=job_context,
    )

    # Save the question regardless — user reviews later.
    # Always store the ENGLISH form in the library so the user sees one canonical version.
    saved_qid = None
    saved_aid = None
    if body.save:
        text_for_library = english_question
        norm = normalize(text_for_library)
        q = db.query(Question).filter(Question.normalized == norm).first()
        if not q:
            q = Question(text=text_for_library.strip(), normalized=norm, category=classify(text_for_library))
            db.add(q); db.flush()
        q.needs_review = 1 if typed.get("needs_review", False) else (q.needs_review or 0)
        q.last_input_type = body.input_type
        q.last_max_length = body.max_length
        q.last_options = json.dumps(body.options) if body.options else None
        q.use_count = (q.use_count or 0) + 1
        q.last_used_at = datetime.utcnow()

        # Always store the rendered answer so user can edit it
        a = QuestionAnswer(
            question_id=q.id,
            answer=str(typed.get("value", "")),
            is_default=0,
            application_id=body.application_id,
            use_count=1,
        )
        db.add(a); db.commit(); db.refresh(a)
        saved_qid = q.id; saved_aid = a.id

    return {
        "value": typed.get("value"),
        "explanation": typed.get("explanation"),
        "confidence": typed.get("confidence"),
        "needs_review": typed.get("needs_review", False),
        "question_id": saved_qid,
        "answer_id": saved_aid,
    }


@router.get("/needs-review")
def list_needs_review(db: Session = Depends(get_db)):
    """Questions that were auto-answered from CV and need user verification."""
    rows = db.query(Question).filter(Question.needs_review == 1).order_by(desc(Question.last_used_at)).all()
    return [_q_to_dict(q, db) for q in rows]


@router.post("/by-id/{qid}/mark-reviewed")
def mark_reviewed(qid: int, db: Session = Depends(get_db)):
    q = db.query(Question).filter(Question.id == qid).first()
    if not q: raise HTTPException(404, "Not found")
    q.needs_review = 0
    db.commit()
    return {"ok": True}


class SeedRequest(BaseModel):
    reset: bool = False


@router.post("/seed-bank")
def seed_bank(body: SeedRequest = SeedRequest(), db: Session = Depends(get_db)):
    """Idempotently populate the question library with common application questions.
    User then opens the dashboard and fills in their answers — those become defaults
    used by Easy Apply / autofill forever after."""
    added = 0
    for text, category, input_type, options in SEED_QUESTIONS:
        norm = normalize(text)
        existing = db.query(Question).filter(Question.normalized == norm).first()
        if existing:
            # Update metadata only — don't touch user's answers
            existing.category = existing.category or category
            existing.last_input_type = existing.last_input_type or input_type
            if options and not existing.last_options:
                existing.last_options = json.dumps(options)
            continue
        q = Question(
            text=text, normalized=norm, category=category,
            last_input_type=input_type,
            last_options=json.dumps(options) if options else None,
            needs_review=0,
        )
        db.add(q)
        added += 1
    db.commit()
    return {"added": added, "total_seeded": len(SEED_QUESTIONS)}


@router.get("/unanswered")
def list_unanswered(db: Session = Depends(get_db)):
    """Seeded questions that the user hasn't answered yet — the curated bank UI."""
    rows = db.query(Question).order_by(Question.category, Question.text).all()
    out = []
    for q in rows:
        answers = db.query(QuestionAnswer).filter(QuestionAnswer.question_id == q.id).all()
        has_default = any(a.is_default for a in answers)
        if has_default:
            continue
        out.append({
            **{k: v for k, v in _q_to_dict(q, db).items()},
            "has_default": False,
        })
    return out

class QuestionUpdate(BaseModel):
    text: str | None = None
    category: str | None = None
    tags: str | None = None
    input_type: str | None = None        # number | text | textarea | select | radio
    options: list[str] | None = None     # for select/radio
    min_value: int | None = None         # for number
    max_value: int | None = None


@router.patch("/by-id/{qid}")
def update_question(qid: int, body: QuestionUpdate, db: Session = Depends(get_db)):
    q = db.query(Question).filter(Question.id == qid).first()
    if not q:
        raise HTTPException(404, "Not found")
    data = body.model_dump(exclude_unset=True)
    if "text" in data and data["text"]:
        q.text = data["text"].strip()
        q.normalized = normalize(q.text)
    if "category" in data:
        q.category = data["category"]
    if "tags" in data:
        q.tags = data["tags"]
    if "input_type" in data:
        q.last_input_type = data["input_type"]
    if "options" in data:
        q.last_options = json.dumps(data["options"]) if data["options"] else None
    db.commit(); db.refresh(q)
    return _q_to_dict(q, db)


@router.post("/custom")
def create_custom_question(body: QuestionUpdate, db: Session = Depends(get_db)):
    """Create a brand-new question with any input type + options."""
    if not body.text:
        raise HTTPException(400, "text required")
    norm = normalize(body.text)
    existing = db.query(Question).filter(Question.normalized == norm).first()
    if existing:
        # Just update its metadata if it already exists
        if body.input_type: existing.last_input_type = body.input_type
        if body.options is not None: existing.last_options = json.dumps(body.options) if body.options else None
        if body.category: existing.category = body.category
        if body.tags: existing.tags = body.tags
        db.commit(); db.refresh(existing)
        return _q_to_dict(existing, db)
    q = Question(
        text=body.text.strip(), normalized=norm,
        category=body.category or classify(body.text),
        tags=body.tags,
        last_input_type=body.input_type or "text",
        last_options=json.dumps(body.options) if body.options else None,
        needs_review=0,
    )
    db.add(q); db.commit(); db.refresh(q)
    return _q_to_dict(q, db)


@router.post("/translate-to-english")
def translate_existing_to_english(db: Session = Depends(get_db)):
    """Translate every non-English question in the library to English.
    Idempotent — already-English questions are skipped.
    Heavy operation; only run when user explicitly asks via dashboard button."""
    rows = db.query(Question).all()
    translated = 0
    skipped = 0
    for q in rows:
        if is_english(q.text):
            skipped += 1
            continue
        english = to_english(q.text)
        if english and english.strip() != q.text.strip():
            # Check if an English version already exists — merge if so
            new_norm = normalize(english)
            existing = db.query(Question).filter(Question.normalized == new_norm, Question.id != q.id).first()
            if existing:
                # Move this question's answers under the existing English question
                db.query(QuestionAnswer).filter(QuestionAnswer.question_id == q.id).update({QuestionAnswer.question_id: existing.id})
                db.delete(q)
            else:
                q.text = english
                q.normalized = new_norm
            translated += 1
    db.commit()
    return {"translated": translated, "skipped": skipped, "total": len(rows)}

