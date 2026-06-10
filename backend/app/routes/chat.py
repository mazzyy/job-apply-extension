"""Context-aware chat with threads (tabs) and SSE streaming.

Threads: each tab is a ChatThread; messages belong to a thread. Legacy
messages (pre-threads) are backfilled into a "General" thread on first access.
Streaming: POST /chat/stream emits Server-Sent Events {delta}…{done}.
"""
import json
import logging
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db, SessionLocal
from ..models import ChatMessage, ChatThread, Profile, CV, Application
from ..services.analyzer import _chat, _chat_stream

log = logging.getLogger("jaa.chat")
router = APIRouter(prefix="/chat", tags=["chat"])

HISTORY_TURNS = 20
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
    thread_id: int | None = None
    context: PageContext | None = None


class ThreadIn(BaseModel):
    title: str | None = None


def _msg_dict(m: ChatMessage) -> dict:
    return {
        "id": m.id, "thread_id": m.thread_id, "role": m.role, "content": m.content,
        "context_url": m.context_url, "context_job": m.context_job,
        "application_id": m.application_id,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _backfill_legacy(db: Session):
    """Assign pre-thread messages to a 'General' thread (runs once)."""
    if db.query(ChatMessage).filter(ChatMessage.thread_id == None).count() == 0:  # noqa: E711
        return
    t = ChatThread(title="General")
    db.add(t); db.commit(); db.refresh(t)
    db.query(ChatMessage).filter(ChatMessage.thread_id == None).update(  # noqa: E711
        {ChatMessage.thread_id: t.id})
    db.commit()


def _resolve_thread(db: Session, thread_id: int | None) -> ChatThread:
    _backfill_legacy(db)
    if thread_id:
        t = db.query(ChatThread).filter(ChatThread.id == thread_id).first()
        if t:
            return t
    t = db.query(ChatThread).order_by(ChatThread.id.desc()).first()
    if not t:
        t = ChatThread(title=None)
        db.add(t); db.commit(); db.refresh(t)
    return t


def _auto_title(db: Session, thread: ChatThread, message: str, ctx: PageContext | None):
    if thread.title:
        return
    if ctx and (ctx.job_title or ctx.company):
        thread.title = f"{ctx.job_title or '?'} @ {ctx.company or '?'}"[:120]
    else:
        thread.title = (message.strip().replace("\n", " ")[:48] or "New chat")
    db.commit()


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
                if getattr(app_row, "status", None):
                    job_bits.append(f"Tracked status: {app_row.status}")
                if getattr(app_row, "fit_score", None) is not None:
                    job_bits.append(f"Analyzed fit score: {app_row.fit_score}/100")
        if ctx.job_description:
            job_bits.append("JOB DESCRIPTION:\n" + ctx.job_description[:JD_CONTEXT_CHARS])
        if job_bits:
            parts.append(
                "THE USER IS CURRENTLY LOOKING AT THIS JOB / PAGE — assume questions "
                "refer to it unless they say otherwise:\n" + "\n".join(job_bits))
    return "\n\n".join(parts)


def _store_user_message(db: Session, body: ChatIn) -> tuple[ChatThread, ChatMessage, list]:
    thread = _resolve_thread(db, body.thread_id)
    ctx = body.context
    ctx_job = None
    if ctx and (ctx.job_title or ctx.company):
        ctx_job = f"{ctx.job_title or '?'} @ {ctx.company or '?'}"
    user_msg = ChatMessage(
        thread_id=thread.id, role="user", content=body.message.strip(),
        context_url=(ctx.url if ctx else None), context_job=ctx_job,
        application_id=(ctx.application_id if ctx else None),
    )
    db.add(user_msg); db.commit(); db.refresh(user_msg)
    _auto_title(db, thread, body.message, ctx)

    recent = (db.query(ChatMessage).filter(ChatMessage.thread_id == thread.id)
              .order_by(ChatMessage.id.desc()).limit(HISTORY_TURNS).all())
    messages = [{"role": "system", "content": _system_prompt(db, ctx)}]
    messages += [{"role": m.role, "content": m.content} for m in reversed(recent)]
    return thread, user_msg, messages


# ---------------- Threads ----------------

@router.get("/threads")
def list_threads(db: Session = Depends(get_db)):
    _backfill_legacy(db)
    threads = db.query(ChatThread).order_by(ChatThread.id.desc()).all()
    out = []
    for t in threads:
        last = (db.query(ChatMessage).filter(ChatMessage.thread_id == t.id)
                .order_by(ChatMessage.id.desc()).first())
        out.append({
            "id": t.id, "title": t.title or "New chat",
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "last_message": (last.content[:80] if last else None),
            "last_at": (last.created_at.isoformat() if last and last.created_at else None),
            "message_count": db.query(ChatMessage).filter(ChatMessage.thread_id == t.id).count(),
        })
    return out


@router.post("/threads")
def create_thread(body: ThreadIn = ThreadIn(), db: Session = Depends(get_db)):
    t = ChatThread(title=(body.title or None))
    db.add(t); db.commit(); db.refresh(t)
    return {"id": t.id, "title": t.title or "New chat"}


@router.patch("/threads/{thread_id}")
def rename_thread(thread_id: int, body: ThreadIn, db: Session = Depends(get_db)):
    t = db.query(ChatThread).filter(ChatThread.id == thread_id).first()
    if not t:
        raise HTTPException(404, "Thread not found")
    t.title = (body.title or "").strip()[:120] or t.title
    db.commit()
    return {"ok": True}


@router.delete("/threads/{thread_id}")
def delete_thread(thread_id: int, db: Session = Depends(get_db)):
    t = db.query(ChatThread).filter(ChatThread.id == thread_id).first()
    if not t:
        raise HTTPException(404, "Thread not found")
    db.query(ChatMessage).filter(ChatMessage.thread_id == thread_id).delete()
    db.delete(t); db.commit()
    return {"ok": True}


# ---------------- Messages ----------------

@router.get("/")
def history(thread_id: int | None = None, limit: int = 200, db: Session = Depends(get_db)):
    thread = _resolve_thread(db, thread_id)
    rows = (db.query(ChatMessage).filter(ChatMessage.thread_id == thread.id)
            .order_by(ChatMessage.id.desc()).limit(limit).all())
    return {"thread_id": thread.id, "messages": [_msg_dict(m) for m in reversed(rows)]}


@router.post("/")
def send(body: ChatIn, db: Session = Depends(get_db)):
    """Non-streaming send (kept for compatibility / fallback)."""
    thread, user_msg, messages = _store_user_message(db, body)
    try:
        reply = _chat(messages, want_json=False, max_tokens=1500, task="chat")
        reply = (reply or "").strip() or "(no reply from model)"
    except Exception as e:
        log.error("chat LLM call failed: %s", e)
        reply = f"Sorry — the model call failed: {e}"
    asst = ChatMessage(thread_id=thread.id, role="assistant", content=reply,
                       context_url=user_msg.context_url, context_job=user_msg.context_job,
                       application_id=user_msg.application_id)
    db.add(asst); db.commit(); db.refresh(asst)
    return {"thread_id": thread.id, "user": _msg_dict(user_msg), "assistant": _msg_dict(asst)}


@router.post("/stream")
def send_stream(body: ChatIn, db: Session = Depends(get_db)):
    """SSE streaming send: data:{delta}… then data:{done, message…}."""
    thread, user_msg, messages = _store_user_message(db, body)
    thread_id = thread.id
    ctx_url, ctx_job, app_id = user_msg.context_url, user_msg.context_job, user_msg.application_id

    def gen():
        parts = []
        yield f"data: {json.dumps({'thread_id': thread_id, 'user_id': user_msg.id})}\n\n"
        try:
            for delta in _chat_stream(messages, max_tokens=1500, task="chat"):
                parts.append(delta)
                yield f"data: {json.dumps({'delta': delta})}\n\n"
        except Exception as e:
            log.error("chat stream failed: %s", e)
            err = f"Sorry — the model call failed: {e}"
            parts = [err]
            yield f"data: {json.dumps({'delta': err})}\n\n"
        reply = "".join(parts).strip() or "(no reply from model)"
        # Fresh session — the request-scoped one may be torn down mid-stream.
        s = SessionLocal()
        try:
            asst = ChatMessage(thread_id=thread_id, role="assistant", content=reply,
                               context_url=ctx_url, context_job=ctx_job, application_id=app_id)
            s.add(asst); s.commit(); s.refresh(asst)
            yield f"data: {json.dumps({'done': True, 'message': _msg_dict(asst)})}\n\n"
        finally:
            s.close()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.delete("/")
def clear(thread_id: int | None = None, db: Session = Depends(get_db)):
    """Clear one thread's messages (thread itself is kept)."""
    thread = _resolve_thread(db, thread_id)
    n = db.query(ChatMessage).filter(ChatMessage.thread_id == thread.id).delete()
    thread.title = None
    db.commit()
    return {"ok": True, "deleted": n, "thread_id": thread.id}
