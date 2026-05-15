"""Classify recruiter emails and map them to applications."""
import json
import re
from sqlalchemy.orm import Session
from sqlalchemy import or_
from ..models import Application
from .analyzer import _chat, _parse_json_loose


def _extract_sender_domain(headers_text: str) -> str | None:
    if not headers_text:
        return None
    m = re.search(r"From:\s*[^<\n]*<?([\w\.\-_+]+)@([\w\.\-_]+)>?", headers_text, re.I)
    if m:
        return m.group(2).lower()
    m = re.search(r"\b[\w\.\-_+]+@([\w\.\-_]+\.[a-z]{2,})\b", headers_text, re.I)
    return m.group(1).lower() if m else None


def guess_application(db: Session, email_text: str, sender_domain: str | None) -> Application | None:
    """Best-effort: match by company name in subject/body, then by sender domain."""
    # 1. Domain match against application URL
    if sender_domain:
        base = sender_domain.split(".")[-2] if "." in sender_domain else sender_domain
        rows = db.query(Application).all()
        for a in rows:
            if a.url and base in a.url.lower():
                return a
            if a.company and base in a.company.lower():
                return a

    # 2. Company name substring match
    lower = email_text.lower()
    rows = db.query(Application).filter(Application.company != None).all()
    best = None
    best_len = 0
    for a in rows:
        if not a.company:
            continue
        cname = a.company.strip().lower()
        if len(cname) >= 3 and cname in lower and len(cname) > best_len:
            best = a; best_len = len(cname)
    return best


def classify_email(email_text: str) -> dict:
    """Use the model to classify a recruiter email."""
    prompt = f"""Classify this email related to a job application. Return JSON only.

EMAIL:
\"\"\"
{email_text[:6000]}
\"\"\"

JSON schema:
{{
  "kind": "<rejection | interview_invite | offer | recruiter_reachout | next_step | acknowledgment | follow_up | unrelated>",
  "confidence": 0.0-1.0,
  "summary": "<one-line description>",
  "suggested_status": "<applied | interview | offer | rejected | null>",
  "sender_name": "",
  "sender_company": "",
  "interview_datetime": "<ISO datetime if mentioned, else null>",
  "salary_mentioned": "<extracted salary string if any, else null>",
  "next_action": "<what the user should do next>"
}}
Be conservative — only set confidence > 0.7 if very clear."""
    text = _chat(
        [
            {"role": "system", "content": "You classify job-application emails. Output strict JSON only."},
            {"role": "user", "content": prompt},
        ],
        want_json=True,
        max_tokens=900,
        task="email_classify",
    )
    data = _parse_json_loose(text)
    # Coerce fields
    try:
        data["confidence"] = float(data.get("confidence", 0) or 0)
    except (TypeError, ValueError):
        data["confidence"] = 0.0
    for k in ("kind", "summary", "suggested_status", "sender_name", "sender_company",
              "interview_datetime", "salary_mentioned", "next_action"):
        v = data.get(k)
        if v in ("null", "None"): data[k] = None
        elif not isinstance(v, (str, type(None))): data[k] = None
    return data
