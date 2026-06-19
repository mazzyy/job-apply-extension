"""Gmail IMAP sync — fetches new mail, prefilters, classifies job-related
messages with the existing email pipeline, and auto-updates applications.

Auth: Gmail app password (requires 2FA on the Google account).
Incremental: tracks the highest processed IMAP UID; first run scans
`gmail_lookback_days` back. A module lock prevents overlapping syncs.
"""
import email
import email.header
import email.utils
import imaplib
import logging
import re
import threading
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from ..models import AppSettings, Application, ProcessedEmail
from .email_parser import classify_email, guess_application, _extract_sender_domain
from .events import emit

log = logging.getLogger("jaa.gmail")

IMAP_HOST = "imap.gmail.com"
MAX_PER_SYNC = 200            # bound runtime + LLM cost per sync
BODY_CHARS = 6000

_sync_lock = threading.Lock()

# Cheap prefilter — only emails passing this go to the LLM classifier.
_JOB_KEYWORDS = re.compile(
    r"(applicat|interview|recruit|position|role|candidat|offer|hiring|talent|"
    r"opportunit|job|career|resume|cv\b|screening|assessment|"
    r"thank you for applying|next step|"
    r"bewerbung|vorstellungsgespräch|stelle\b|kandidat)", re.I)
# Job-board alert blasts and marketing — never real responses to YOUR application.
_BULK_HINTS = re.compile(
    r"(unsubscribe|newsletter|view in browser|daily digest|job alert|jobs for you|"
    r"recommended jobs|new jobs match|"
    # German job-board alert phrasing (Stepstone, Instaffo, XING, Indeed…)
    r"und \d+ andere (firmen|unternehmen)|firmen suchen|unternehmen suchen|"
    r"karriereschritt wartet|jobempfehlung|passende jobs|neue jobs|dein tagesupdate|"
    r"jobs f[üu]r dich|top.?jobs|stellenangebote f[üu]r)", re.I)
# Senders that only ever send alert blasts, never individual responses
_BULK_SENDERS = re.compile(
    r"(jobalerts|jobs?-noreply|alerts?@|notifications?@|digest@|news@|"
    r"mailings?@|marketing@|info@(stepstone|indeed|glassdoor|xing|instaffo))", re.I)
# A real response to the user's own application — overrides bulk hints
_DIRECT_RESPONSE = re.compile(
    r"(your application|ihre bewerbung|deine bewerbung|thank you for applying|"
    r"application status|interview|vorstellungsgespr[äa]ch|assessment|offer letter)", re.I)


def _decode(value: str | None) -> str:
    if not value:
        return ""
    parts = email.header.decode_header(value)
    out = []
    for data, enc in parts:
        if isinstance(data, bytes):
            out.append(data.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(data)
    return "".join(out).strip()


def _body_text(msg: email.message.Message) -> str:
    """Prefer text/plain; fall back to tag-stripped HTML."""
    plain, html = "", ""
    for part in msg.walk():
        ctype = part.get_content_type()
        if part.get("Content-Disposition", "").startswith("attachment"):
            continue
        if ctype not in ("text/plain", "text/html"):
            continue
        try:
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except Exception:
            continue
        if ctype == "text/plain" and not plain:
            plain = text
        elif ctype == "text/html" and not html:
            html = text
    if plain:
        return plain[:BODY_CHARS]
    if html:
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s{2,}", " ", text)
        return text[:BODY_CHARS]
    return ""


def _looks_job_related(db: Session, subject: str, body: str, sender: str) -> bool:
    haystack = f"{subject}\n{body[:2000]}"
    direct = _DIRECT_RESPONSE.search(haystack)
    if not direct:
        if _BULK_SENDERS.search(sender or ""):
            return False
        if _BULK_HINTS.search(haystack):
            return False
    if direct or _JOB_KEYWORDS.search(haystack):
        return True
    # Sender domain matches a tracked company / job URL → relevant even without keywords
    domain = _extract_sender_domain(f"From: <{sender}>") or ""
    if domain:
        base = domain.split(".")[-2] if "." in domain else domain
        if len(base) >= 3:
            for a in db.query(Application).all():
                if (a.url and base in a.url.lower()) or (a.company and base in a.company.lower()):
                    return True
    return False


def apply_classification(db: Session, app_row: Application | None, info: dict,
                         raw_text: str, min_confidence: float = 0.6) -> tuple[bool, bool]:
    """Write status/event to the matched application. Returns (logged, status_changed).
    Shared by /emails/parse (paste) and Gmail sync."""
    if not app_row or info.get("confidence", 0) < min_confidence:
        return False, False
    status_changed = False
    sug = info.get("suggested_status")
    if sug and sug != app_row.status:
        rank = {"analyzed": 0, "applied": 1, "interview": 2, "offer": 3, "rejected": 4}
        if rank.get(sug, 0) >= rank.get(app_row.status or "analyzed", 0) or sug == "rejected":
            prev = app_row.status
            app_row.status = sug
            emit(db, app_row.id, kind="status_change",
                 title=f"Status: {prev} → {sug} (from email)",
                 detail=info.get("summary"), source="email", commit=False)
            status_changed = True
    kind_map = {
        "rejection": "rejected", "interview_invite": "interview_scheduled",
        "offer": "offered", "recruiter_reachout": "email_received",
        "next_step": "email_received", "acknowledgment": "email_received",
        "follow_up": "email_received",
    }
    emit(db, app_row.id, kind=kind_map.get(info.get("kind", ""), "email_received"),
         title=info.get("summary") or "Email received",
         detail=raw_text[:2000], source="email", commit=False)
    idt = info.get("interview_datetime")
    if idt and isinstance(idt, str):
        try:
            import re as _re
            from datetime import datetime as _d
            s = _re.sub(r"[+-]\d{2}:?\d{2}$", "", idt.strip().replace("Z", "")).strip()
            app_row.interview_at = _d.fromisoformat(s)
        except Exception:
            pass
    db.commit()
    return True, status_changed


def _friendly_imap_error(e: Exception) -> str:
    msg = str(e)
    if "Application-specific password required" in msg:
        return ("Google requires an app password for IMAP — your normal Gmail password "
                "won't work. Turn on 2-Step Verification, then create one at "
                "myaccount.google.com/apppasswords and paste the 16-character code here.")
    if "Invalid credentials" in msg or "AUTHENTICATIONFAILED" in msg.upper():
        return ("Login rejected. Double-check the address and make sure you're using a "
                "16-character app password from myaccount.google.com/apppasswords, "
                "not your normal Gmail password.")
    if "Web login required" in msg:
        return ("Google blocked the sign-in attempt. Open gmail.com in your browser once, "
                "approve any security prompt, then try connecting again.")
    return msg


def test_login(address: str, app_password: str) -> str | None:
    """Returns None on success, friendly error string on failure."""
    try:
        conn = imaplib.IMAP4_SSL(IMAP_HOST, timeout=15)
        conn.login(address, app_password)
        conn.logout()
        return None
    except Exception as e:
        return _friendly_imap_error(e)


def rescan(db: Session) -> dict:
    """Forget all processed emails and the UID cursor, then re-sync from the
    lookback window with the current filtering/classification rules."""
    row = db.query(AppSettings).first()
    if not row:
        return {"ok": False, "error": "No settings row"}
    db.query(ProcessedEmail).delete()
    row.gmail_last_uid = None
    db.commit()
    return sync(db)


def sync(db: Session) -> dict:
    """Run one sync pass. Returns a summary dict."""
    if not _sync_lock.acquire(blocking=False):
        return {"ok": False, "error": "Sync already running"}
    try:
        return _sync_inner(db)
    finally:
        _sync_lock.release()


def _sync_inner(db: Session) -> dict:
    row = db.query(AppSettings).first()
    if not row or not row.gmail_enabled or not row.gmail_address or not row.gmail_app_password:
        return {"ok": False, "error": "Gmail not connected — add your address and app password in Settings."}

    summary = {"ok": True, "fetched": 0, "classified": 0, "matched": 0,
               "status_changes": 0, "skipped": 0}
    try:
        conn = imaplib.IMAP4_SSL(IMAP_HOST, timeout=30)
        conn.login(row.gmail_address, row.gmail_app_password)
        conn.select("INBOX", readonly=True)

        if row.gmail_last_uid:
            typ, data = conn.uid("SEARCH", None, f"UID {row.gmail_last_uid + 1}:*")
        else:
            since = (datetime.utcnow() - timedelta(days=row.gmail_lookback_days or 30))
            typ, data = conn.uid("SEARCH", None, f'SINCE {since.strftime("%d-%b-%Y")}')
        if typ != "OK":
            raise RuntimeError(f"IMAP search failed: {typ}")

        uids = [int(u) for u in (data[0].split() if data and data[0] else [])]
        # Gmail quirk: "UID n:*" returns the last message even if its UID < n
        if row.gmail_last_uid:
            uids = [u for u in uids if u > row.gmail_last_uid]
        uids = sorted(uids)[:MAX_PER_SYNC]

        max_uid = row.gmail_last_uid or 0
        for uid in uids:
            typ, msg_data = conn.uid("FETCH", str(uid), "(BODY.PEEK[])")
            if typ != "OK" or not msg_data or msg_data[0] is None:
                continue
            raw = msg_data[0][1]
            msg = email.message_from_bytes(raw)
            max_uid = max(max_uid, uid)
            summary["fetched"] += 1

            message_id = (msg.get("Message-ID") or "").strip()[:500]
            if message_id and db.query(ProcessedEmail).filter(
                    ProcessedEmail.message_id == message_id).first():
                continue  # already processed (e.g. lookback overlap)

            subject = _decode(msg.get("Subject"))[:600]
            sender = _decode(msg.get("From"))[:300]
            try:
                received_at = email.utils.parsedate_to_datetime(msg.get("Date")).replace(tzinfo=None)
            except Exception:
                received_at = None
            body = _body_text(msg)

            rec = ProcessedEmail(imap_uid=uid, message_id=message_id or None,
                                 subject=subject, sender=sender, received_at=received_at,
                                 snippet=re.sub(r"\s+", " ", body)[:240] or None,
                                 source="linkedin" if "linkedin" in sender.lower() else "other")

            if not body or not _looks_job_related(db, subject, body, sender):
                rec.kind = "skipped_prefilter"
                db.add(rec); db.commit()
                summary["skipped"] += 1
                continue

            full_text = f"From: {sender}\nSubject: {subject}\n\n{body}"
            try:
                info = classify_email(full_text)
            except Exception as e:
                log.warning("classify failed for uid %s: %s", uid, e)
                rec.kind = "classify_error"; rec.summary = str(e)[:600]
                db.add(rec); db.commit()
                continue
            summary["classified"] += 1

            rec.kind = info.get("kind")
            rec.confidence = info.get("confidence")
            rec.summary = (info.get("summary") or "")[:600]
            rec.suggested_status = info.get("suggested_status")
            rec.next_action = (info.get("next_action") or "")[:400] or None

            if info.get("kind") not in (None, "unrelated"):
                app_row = guess_application(db, full_text, _extract_sender_domain(full_text),
                                            company_hint=info.get("sender_company"))
                if app_row:
                    rec.application_id = app_row.id
                    summary["matched"] += 1
                    _, changed = apply_classification(db, app_row, info, full_text)
                    if changed:
                        rec.status_changed = 1
                        summary["status_changes"] += 1
            db.add(rec); db.commit()

        conn.logout()
        row.gmail_last_uid = max_uid or row.gmail_last_uid
        row.gmail_last_sync_at = datetime.utcnow()
        row.gmail_last_error = None
        db.commit()
        log.info("Gmail sync done: %s", summary)
        return summary
    except Exception as e:
        log.error("Gmail sync failed: %s", e)
        friendly = _friendly_imap_error(e)
        row.gmail_last_error = friendly[:1000]
        db.commit()
        return {"ok": False, "error": friendly}
