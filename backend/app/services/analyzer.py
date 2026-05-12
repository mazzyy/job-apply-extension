"""Azure OpenAI fit-analysis + CV structuring service.
Locked to the gpt-5-mini deployment defined in config.py.
"""
import json
import logging
import re
from openai import AzureOpenAI
from ..config import settings

log = logging.getLogger("jaa.analyzer")
_client: AzureOpenAI | None = None


def client() -> AzureOpenAI:
    global _client
    if _client is None:
        if not settings.AZURE_OPENAI_API_KEY:
            raise RuntimeError("AZURE_OPENAI_API_KEY is empty")
        _client = AzureOpenAI(
            api_key=settings.AZURE_OPENAI_API_KEY,
            api_version=settings.AZURE_OPENAI_API_VERSION,
            azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
        )
    return _client


SYSTEM_RECRUITER = (
    "You are a senior technical recruiter and career coach. You give specific, "
    "honest, actionable feedback. You never invent skills the candidate does not have. "
    "Always respond with valid JSON only — no markdown fences, no commentary."
)


def _try_call(messages, *, max_tokens: int, want_json: bool, mode: str):
    """One attempt. Returns (content, finish_reason, usage_dict) or raises."""
    deployment = settings.AZURE_OPENAI_DEPLOYMENT
    kwargs: dict = {"model": deployment, "messages": messages}
    if mode == "completion_tokens":
        kwargs["max_completion_tokens"] = max_tokens
    elif mode == "max_tokens":
        kwargs["max_tokens"] = max_tokens
    if want_json:
        kwargs["response_format"] = {"type": "json_object"}
    resp = client().chat.completions.create(**kwargs)
    choice = resp.choices[0]
    content = (choice.message.content or "").strip()
    finish = getattr(choice, "finish_reason", None)
    usage = {}
    if getattr(resp, "usage", None):
        usage = {
            "prompt": resp.usage.prompt_tokens,
            "completion": resp.usage.completion_tokens,
            "total": resp.usage.total_tokens,
        }
        # reasoning models expose this nested object
        details = getattr(resp.usage, "completion_tokens_details", None)
        if details and getattr(details, "reasoning_tokens", None) is not None:
            usage["reasoning"] = details.reasoning_tokens
    return content, finish, usage


def _chat(messages, *, want_json: bool = True, max_tokens: int = 4000) -> str:
    """Call the deployment robustly. Considers empty content a soft failure
    and retries with the next strategy. Bumps tokens on length-cutoffs."""
    attempts = [
        ("completion_tokens", want_json),
        ("max_tokens", want_json),
        ("completion_tokens", False),
        ("max_tokens", False),
    ]
    last_err = None
    for mode, json_mode in attempts:
        try:
            content, finish, usage = _try_call(
                messages, max_tokens=max_tokens, want_json=json_mode, mode=mode,
            )
            log.info("chat: mode=%s json=%s finish=%s usage=%s len(content)=%d",
                     mode, json_mode, finish, usage, len(content))
            if content:
                return content
            # Empty content — usually means model spent budget on reasoning.
            # Bump tokens hard and try the next strategy.
            log.warning("Empty content from mode=%s finish=%s — retrying with more tokens", mode, finish)
            max_tokens = max(max_tokens, 8000)
        except Exception as e:
            last_err = e
            log.warning("Strategy mode=%s json=%s raised: %s", mode, json_mode, e)
    if last_err:
        raise last_err
    raise RuntimeError("Model returned empty content on every strategy")


def _parse_json_loose(text: str) -> dict:
    if not text:
        return {}
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.IGNORECASE | re.MULTILINE)
    i, j = s.find("{"), s.rfind("}")
    if i != -1 and j != -1 and j > i:
        s = s[i:j+1]
    try:
        return json.loads(s)
    except json.JSONDecodeError as e:
        log.warning("JSON parse failed (%s). First 500 chars of body: %s", e, text[:500])
        return {}


def verify_model() -> dict:
    info = {
        "endpoint": settings.AZURE_OPENAI_ENDPOINT,
        "deployment": settings.AZURE_OPENAI_DEPLOYMENT,
        "api_version": settings.AZURE_OPENAI_API_VERSION,
        "api_key_set": bool(settings.AZURE_OPENAI_API_KEY),
    }
    try:
        reply = _chat(
            [
                {"role": "system", "content": "You are a health check. Reply with the single word: PONG."},
                {"role": "user", "content": "ping"},
            ],
            want_json=False,
            max_tokens=200,
        )
        info["ok"] = True
        info["reply"] = (reply or "").strip()[:80]
        return info
    except Exception as e:
        info["ok"] = False
        info["error"] = f"{type(e).__name__}: {e}"
        return info


def analyze_fit(cv_text: str, job_description: str, job_title: str = "", company: str = "") -> dict:
    prompt = f"""Analyze the candidate's fit for this role.

JOB TITLE: {job_title or "(unknown)"}
COMPANY: {company or "(unknown)"}

JOB DESCRIPTION:
\"\"\"
{job_description[:6000]}
\"\"\"

CANDIDATE CV:
\"\"\"
{cv_text[:6000]}
\"\"\"

Respond with this exact JSON schema and NOTHING else:
{{
  "fit_score": 0-100,
  "fit_label": "Excellent fit | Strong fit | Possible fit | Weak fit | Not a fit",
  "strengths": ["..."],
  "gaps": ["..."],
  "recommendations": ["..."],
  "must_haves_met": 0,
  "must_haves_total": 0,
  "verdict": "one to two sentence honest summary",
  "key_skills_in_jd": ["..."],
  "key_skills_in_cv": ["..."]
}}
Keep arrays focused (3-6 items each). Be specific."""
    text = _chat(
        [
            {"role": "system", "content": SYSTEM_RECRUITER},
            {"role": "user", "content": prompt},
        ],
        want_json=True,
        max_tokens=4000,
    )
    log.info("analyze_fit raw (first 400): %s", text[:400])
    data = _parse_json_loose(text)

    # If parse failed, retry once with an explicit "you returned invalid JSON" nudge.
    if not data:
        log.warning("First parse empty; nudging model to repair JSON.")
        text2 = _chat(
            [
                {"role": "system", "content": SYSTEM_RECRUITER},
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": text or ""},
                {"role": "user", "content": "That was not valid JSON. Output ONLY the JSON object now, no prose."},
            ],
            want_json=True,
            max_tokens=4000,
        )
        log.info("analyze_fit retry raw (first 400): %s", text2[:400])
        data = _parse_json_loose(text2)

    # Coerce types
    try:
        data["fit_score"] = int(float(data.get("fit_score", 0) or 0))
    except (TypeError, ValueError):
        data["fit_score"] = 0
    for k in ("strengths", "gaps", "recommendations", "key_skills_in_jd", "key_skills_in_cv"):
        if not isinstance(data.get(k), list):
            data[k] = []
    if not isinstance(data.get("verdict"), str):
        data["verdict"] = ""
    if not isinstance(data.get("fit_label"), str):
        data["fit_label"] = ""
    return data


def structure_cv(cv_text: str) -> dict:
    prompt = f"""Extract structured profile data from this CV. Return JSON only.

CV TEXT:
\"\"\"
{cv_text[:8000]}
\"\"\"

JSON schema:
{{
  "full_name": "", "first_name": "", "last_name": "",
  "email": "", "phone": "", "city": "", "country": "",
  "linkedin_url": "", "github_url": "", "portfolio_url": "",
  "current_company": "", "current_title": "",
  "years_experience": 0,
  "skills": [],
  "languages": [{{"language": "", "level": ""}}],
  "education": [{{"school": "", "degree": "", "field": "", "year": ""}}],
  "experience": [{{"company": "", "title": "", "start": "", "end": "", "summary": ""}}]
}}
Use empty strings / empty arrays when unknown. Do not invent data."""
    text = _chat(
        [
            {"role": "system", "content": "You extract structured data from resumes. Output strict JSON only."},
            {"role": "user", "content": prompt},
        ],
        want_json=True,
        max_tokens=4000,
    )
    return _parse_json_loose(text)


def answer_application_question(question: str, cv_text: str, profile_json: str) -> str:
    prompt = f"""You are helping a candidate fill out an application form.
Write a concise, honest answer in first person. No fluff, no buzzwords. 80-160 words.

QUESTION: {question}

CANDIDATE PROFILE JSON:
{profile_json[:2000]}

CANDIDATE CV:
\"\"\"
{cv_text[:4000]}
\"\"\"

Answer:"""
    try:
        text = _chat(
            [
                {"role": "system", "content": "You write honest, specific job application answers in first person."},
                {"role": "user", "content": prompt},
            ],
            want_json=False,
            max_tokens=1200,
        )
        return text.strip()
    except Exception as e:
        log.exception("answer_application_question failed")
        return f"(could not draft an answer: {e})"
