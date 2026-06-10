"""Context-aware chat. One continuous thread, shared between extension and
desktop (same DB). Each user message can carry the page/job the user is
currently on; the assistant gets profile + active CV + that job as context."""
import json
import logging
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import ChatMessage, Profile, CV, Application
from ..services.analyzer import _chat

log = logging.getLogger("jaa.chat")
router = APIRouter(prefix="/chat", tags=["chat"])

HISTORY_TURNS = 20          # last N messages sent to the LLM
JD_CONTEXT_CHARS = 5000
CV_CONTEXT_CHARS = 4000


class PageContext(BaseModel):
    url: str | None = None
    job_title: str | None = None
    company: str | None = None
    job_description: str | None = None
    application_id: int | None = None


class ChatIn(BaseModel):
    message: str
    context: PageContext | None = None


def _msg_dict(m: ChatMessage) -> dict:
    return {
        "id": m.id, "role": m.role, "content": m.content,
        "context_url": m.context_url, "context_job": m.context_job,
        "application_id": m.application_id,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _system_prompt(db: Session, ctx: PageContext | None) -> str:
    parts = [
        "You are Job Apply Assistant, a concise and practical career copilot embedded "
        "in a browser extension and desktop app. You help the user evaluate jobs, "
        "prepare applications, answer screening questions, and improve their CV. "
        "Never invent experience the candidate does not have. Answer in plain text "
        "(no markdown headers), briefly unless asked for depth."
    ]

    prof = db.query(Profile).first()
    if prof:
        pf = {k: getattr(prof, k, None) for k in (
            "full_name", "email", "city", "country", "current_title",
            "current_company", "years_experience", "work_authorization",
            "salary_expectation", "notice_period")}
        pf = {k: v for k, v in pf.items() if v}
        if pf:
            parts.append("CANDIDATE PROFILE:\n" + json.dumps(pf, ensure_ascii=False))

    cv = db.query(CV).filter(CV.is_active == True).first()  # noqa: E712
    if not cv:
        cv = db.query(CV).order_by(CV.created_at.desc()).first()
    if cv and cv.raw_text:
        parts.append(f"ACTIVE CV ({cv.label}):\n" + cv.raw_text[:CV_CONTEXT_CHARS])

    if ctx:
        job_bits = []
        if ctx.job_title or ctx.company:
            job_bits.append(f"Job: {ctx.job_title or '?'} at {ctx.company or '?'}")
        if ctx.url:
            job_bits.append(f"URL: {ctx.url}")
        if ctx.application_id:
            app_row = db.query(Application).filter(Application.id == ctx.application_id).first()
            if app_row is not None:
                status = getattr(app_row, "status", None)
                fit = getattr(app_row, "fit_score", None)
                if status: job_bits.append(f"Tracked status: {status}")
                if fit is not None: job_bits.append(f"Analyzed fit score: {fit}/100")
        if ctx.job_description:
            job_bits.append("JOB DESCRIPTION:\n" + ctx.job_description[:JD_CONTEXT_CHARS])
        if job_bits:
            parts.append(
                "THE USER IS CURRENTLY LOOKING AT THIS JOB / PAGE — assume questions "
                "refer to it unless they say otherwise:\n" + "\n".join(job_bits))

    return "\n\n".join(parts)


@router.get("/")
def history(limit: int = 200, db: Session = Depends(get_db)):
    rows = (db.query(ChatMessage).order_by(ChatMessage.id.desc()).limit(limit).all())
    return [_msg_dict(m) for m in reversed(rows)]


@router.post("/")
def send(body: ChatIn, db: Session = Depends(get_db)):
    ctx = body.context
    ctx_job = None
    if ctx and (ctx.job_title or ctx.company):
        ctx_job = f"{ctx.job_title or '?'} @ {ctx.company or '?'}"

    user_msg = ChatMessage(
        role="user", content=body.message.strip(),
        context_url=(ctx.url if ctx else None),
        context_job=ctx_job,
        application_id=(ctx.application_id if ctx else None),
    )
    db.add(user_msg); db.commit(); db.refresh(user_msg)

    # Build LLM messages: system + last N turns (including the new one)
    recent = (db.query(ChatMessage).order_by(ChatMessage.id.desc())
              .limit(HISTORY_TURNS).all())
    messages = [{"role": "system", "content": _system_prompt(db, ctx)}]
    messages += [{"role": m.role, "content": m.content} for m in reversed(recent)]

    try:
        reply = _chat(messages, want_json=False, max_tokens=1500, task="chat")
        reply = (reply or "").strip() or "(no reply from model)"
    except Exception as e:
        log.error("chat LLM call failed: %s", e)
        reply = f"Sorry — the model call failed: {e}"

    asst_msg = ChatMessage(
        role="assistant", content=reply,
        context_url=user_msg.context_url, context_job=user_msg.context_job,
        application_id=user_msg.application_id,
    )
    db.add(asst_msg); db.commit(); db.refresh(asst_msg)
    return {"user": _msg_dict(user_msg), "assistant": _msg_dict(asst_msg)}


@router.delete("/")
def clear(db: Session = Depends(get_db)):
    n = db.query(ChatMessage).delete()
    db.commit()
    return {"ok": True, "deleted": n}
