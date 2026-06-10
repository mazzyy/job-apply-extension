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


# Job platforms / ATS providers. Emails from these domains are sent ON BEHALF of
# the actual company — never match applications by these domains, otherwise every
# LinkedIn/Workday notification matches a random "linkedin" application.
PLATFORM_NAMES = {
    "linkedin", "workday", "myworkday", "myworkdayjobs", "greenhouse", "lever",
    "ashbyhq", "smartrecruiters", "personio", "softgarden", "indeed", "stepstone",
    "xing", "successfactors", "icims", "taleo", "bamboohr", "teamtailor", "join",
    "otta", "glassdoor", "monster", "recruitee", "workable", "jobvite",
}


def _is_platform(name: str | None) -> bool:
    if not name:
        return False
    n = name.strip().lower()
    return any(p in n for p in PLATFORM_NAMES)


def guess_application(db: Session, email_text: str, sender_domain: str | None,
                      company_hint: str | None = None) -> Application | None:
    """Best-effort match: company hint (from classifier) > sender domain > name in body.
    Platform domains (linkedin.com, myworkday.com, …) and platform-named applications
    are excluded — they would match everything."""
    rows = db.query(Application).all()
    candidates = [a for a in rows if not _is_platform(a.company)]

    # 0. Company hint from the classifier ("your application was sent to ACME")
    if company_hint and not _is_platform(company_hint):
        hint = company_hint.strip().lower()
        if len(hint) >= 3:
            best, best_len = None, 0
            for a in candidates:
                cname = (a.company or "").strip().lower()
                if not cname:
                    continue
                if (cname in hint or hint in cname) and len(cname) > best_len:
                    best, best_len = a, len(cname)
            if best:
                return best

    # 1. Domain match against application URL/company — skip platform domains
    if sender_domain:
        base = sender_domain.split(".")[-2] if "." in sender_domain else sender_domain
        if not _is_platform(base) and not _is_platform(sender_domain):
            for a in candidates:
                if a.url and base in a.url.lower():
                    return a
                if a.company and base in a.company.lower():
                    return a

    # 2. Company name substring match in the email text
    lower = email_text.lower()
    best, best_len = None, 0
    for a in candidates:
        cname = (a.company or "").strip().lower()
        if len(cname) >= 3 and cname in lower and len(cname) > best_len:
            best, best_len = a, len(cname)
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
IMPORTANT rules:
- Submission confirmations ("your application was sent to X", "we received your
  application", "Danke für deine Bewerbung", "thank you for applying") are
  "acknowledgment" with suggested_status "applied". Set sender_company to the COMPANY
  APPLIED TO (named in subject/body), never the platform (LinkedIn, Workday, …).
- Account housekeeping (verify your candidate account, set your password, confirm
  your email) is "acknowledgment" with suggested_status null — not a next step.
- Job-board alert blasts (Stepstone/Indeed/LinkedIn/XING/Instaffo "N companies are looking
  for you", "recommended jobs", newsletters, salary/marketing mails) are "unrelated" —
  they are NOT recruiter outreach, even if they mention jobs.
- "recruiter_reachout" is ONLY a personal message written to this specific candidate
  about a specific role.
- Only classify as a response kind (rejection/interview_invite/offer/next_step/acknowledgment)
  if the email responds to the candidate's OWN application.
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
