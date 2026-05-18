"""LLM service with cloud + local routing.

Supports three modes set in AppSettings.llm_provider:
- "cloud": every call hits Azure OpenAI (gpt-5-mini).
- "local": every call hits the local OpenAI-compatible server (Ollama by default).
- "hybrid": per-task routing. By default routine tasks go local, deep-reasoning
  tasks go cloud. Users can override per-task in the dashboard.
"""
import json
import logging
import re
import time
from typing import Optional
from openai import AzureOpenAI, OpenAI
from ..config import settings as cfg
from .llm_pricing import estimate_cost

log = logging.getLogger("jaa.analyzer")

# Default per-task routing in hybrid mode.
HYBRID_DEFAULTS = {
    "verify_model": "cloud",      # one-time check
    "structure_cv": "local",      # short structured extraction
    "typed_answer": "local",      # short typed Easy Apply field
    "email_classify": "local",    # short classification
    "draft_answer": "cloud",      # nuanced first-person prose
    "analyze_fit": "cloud",       # heaviest reasoning, biggest quality gap
    "cover_letter": "cloud",      # writing quality matters
}

# Module-level client cache
_clients: dict = {}


def _get_settings_row():
    """Lazy-import to avoid circular import at module load."""
    from ..database import SessionLocal
    from ..models import AppSettings
    db = SessionLocal()
    try:
        row = db.query(AppSettings).first()
        if not row:
            row = AppSettings()
            db.add(row); db.commit(); db.refresh(row)
        return row
    finally:
        db.close()


def _resolve_provider(task: str) -> tuple:
    """Returns (provider_name, model_name)."""
    row = _get_settings_row()
    mode = (row.llm_provider or "cloud").lower()
    if mode == "cloud":
        return "cloud", cfg.AZURE_OPENAI_DEPLOYMENT
    if mode == "local":
        return "local", row.local_model or "llama3.2:3b"
    # hybrid
    overrides = {}
    try: overrides = json.loads(row.per_task or "{}")
    except Exception: overrides = {}
    pick = overrides.get(task) or HYBRID_DEFAULTS.get(task, "local")
    if pick == "cloud":
        return "cloud", cfg.AZURE_OPENAI_DEPLOYMENT
    return "local", row.local_model or "llama3.2:3b"


def _cloud_client() -> AzureOpenAI:
    if "cloud" not in _clients:
        if not cfg.AZURE_OPENAI_API_KEY:
            raise RuntimeError("AZURE_OPENAI_API_KEY is empty — cannot use cloud provider.")
        _clients["cloud"] = AzureOpenAI(
            api_key=cfg.AZURE_OPENAI_API_KEY,
            api_version=cfg.AZURE_OPENAI_API_VERSION,
            azure_endpoint=cfg.AZURE_OPENAI_ENDPOINT,
        )
    return _clients["cloud"]


def _local_client() -> OpenAI:
    """Build an OpenAI client pointed at the local LLM server (Ollama by default).

    Important: passes a custom httpx.Client with trust_env=False so any HTTP_PROXY
    set on the user's system (often by VPN apps via launchd on macOS) doesn't
    intercept our localhost calls and fail them as 'Connection error'.
    """
    import httpx
    row = _get_settings_row()
    base_url = (row.local_base_url or "http://localhost:11434/v1").rstrip("/")
    if not base_url.endswith("/v1") and (":11434" in base_url or "ollama" in base_url.lower()):
        base_url = base_url + "/v1"
    key = "local::" + base_url
    if key not in _clients:
        http_client = httpx.Client(trust_env=False, timeout=60.0)
        _clients[key] = OpenAI(api_key="ollama", base_url=base_url, http_client=http_client)
    return _clients[key]


SYSTEM_RECRUITER = (
    "You are a senior technical recruiter and career coach. You give specific, "
    "honest, actionable feedback. You never invent skills the candidate does not have. "
    "Always respond with valid JSON only — no markdown fences, no commentary."
)


def _try_call(messages, *, max_tokens: int, want_json: bool, mode: str,
              provider: str, model: str):
    """One attempt against the selected provider. Returns (content, finish, usage_dict)."""
    kwargs: dict = {"model": model, "messages": messages}
    if mode == "completion_tokens":
        kwargs["max_completion_tokens"] = max_tokens
    elif mode == "max_tokens":
        kwargs["max_tokens"] = max_tokens
    if want_json:
        kwargs["response_format"] = {"type": "json_object"}

    client = _cloud_client() if provider == "cloud" else _local_client()
    resp = client.chat.completions.create(**kwargs)
    choice = resp.choices[0]
    content = (choice.message.content or "").strip()
    finish = getattr(choice, "finish_reason", None)

    # Capture token usage when available (OpenAI/Azure responses include it;
    # Ollama also reports prompt_tokens/completion_tokens via its OpenAI shim)
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0, "total_tokens": 0}
    if getattr(resp, "usage", None):
        usage["prompt_tokens"] = getattr(resp.usage, "prompt_tokens", 0) or 0
        usage["completion_tokens"] = getattr(resp.usage, "completion_tokens", 0) or 0
        usage["total_tokens"] = getattr(resp.usage, "total_tokens", 0) or 0
        details = getattr(resp.usage, "completion_tokens_details", None)
        if details:
            usage["reasoning_tokens"] = getattr(details, "reasoning_tokens", 0) or 0
    return content, finish, usage


def _chat(messages, *, want_json: bool = True, max_tokens: int = 4000,
          task: str = "analyze_fit") -> str:
    """Main entrypoint — picks provider, tries multiple call signatures, returns text.
    Logs token usage + cost to the llm_usage table after every successful call."""
    provider, model = _resolve_provider(task)
    log.info("LLM call task=%s provider=%s model=%s", task, provider, model)

    attempts = [
        ("completion_tokens", want_json),
        ("max_tokens", want_json),
        ("completion_tokens", False),
        ("max_tokens", False),
    ]
    last_err: Optional[Exception] = None
    accumulated_usage = {"prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0, "total_tokens": 0}
    started = time.time()
    for mode, json_mode in attempts:
        try:
            content, finish, usage = _try_call(
                messages, max_tokens=max_tokens,
                want_json=json_mode, mode=mode,
                provider=provider, model=model,
            )
            for k in accumulated_usage:
                accumulated_usage[k] += usage.get(k, 0)
            log.info("  mode=%s json=%s finish=%s len=%d tokens=%s",
                     mode, json_mode, finish, len(content), usage)
            if content:
                _log_usage(task, provider, model, accumulated_usage,
                           int((time.time() - started) * 1000), success=True)
                return content
            log.warning("  empty content — bumping tokens and trying next strategy")
            max_tokens = max(max_tokens, 8000)
        except Exception as e:
            last_err = e
            log.warning("  strategy mode=%s json=%s raised: %s", mode, json_mode, e)
    # All strategies failed
    _log_usage(task, provider, model, accumulated_usage,
               int((time.time() - started) * 1000), success=False,
               error=str(last_err)[:480] if last_err else "empty content")
    if last_err:
        raise last_err
    raise RuntimeError(f"Model returned empty on every strategy (task={task} provider={provider} model={model})")


def _log_usage(task: str, provider: str, model: str, usage: dict,
               latency_ms: int, *, success: bool = True, error: str | None = None):
    """Insert one row into the llm_usage table. Best-effort — never raises."""
    try:
        from ..database import SessionLocal
        from ..models import LLMUsage
        cost = 0.0
        if provider == "cloud":
            cost = estimate_cost(model,
                                 usage.get("prompt_tokens", 0),
                                 usage.get("completion_tokens", 0) + usage.get("reasoning_tokens", 0))
        db = SessionLocal()
        try:
            row = LLMUsage(
                task=task, provider=provider, model=model,
                prompt_tokens=usage.get("prompt_tokens", 0),
                completion_tokens=usage.get("completion_tokens", 0),
                reasoning_tokens=usage.get("reasoning_tokens", 0),
                total_tokens=usage.get("total_tokens", 0),
                estimated_cost_usd=cost,
                latency_ms=latency_ms,
                success=1 if success else 0,
                error=error,
            )
            db.add(row); db.commit()
        finally:
            db.close()
    except Exception as e:
        log.warning("usage logging failed: %s", e)


def _parse_json_loose(text: str) -> dict:
    if not text: return {}
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.IGNORECASE | re.MULTILINE)
    i, j = s.find("{"), s.rfind("}")
    if i != -1 and j != -1 and j > i:
        s = s[i:j+1]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        log.warning("JSON parse failed. first 400: %s", text[:400])
        return {}


def _ping_provider(provider: str, model: str) -> dict:
    """Send a tiny 'reply PONG' request to one specific provider. Returns
    {ok, provider, model, reply, error}."""
    try:
        # Build a temporary call that bypasses HYBRID_DEFAULTS routing
        kwargs: dict = {"model": model, "messages": [
            {"role": "system", "content": "You are a health check. Reply with the single word: PONG."},
            {"role": "user", "content": "ping"},
        ]}
        # Use max_completion_tokens first (newer), fall back to max_tokens
        for token_arg in ("max_completion_tokens", "max_tokens"):
            try:
                call_kwargs = dict(kwargs)
                call_kwargs[token_arg] = 200
                client = _cloud_client() if provider == "cloud" else _local_client()
                resp = client.chat.completions.create(**call_kwargs)
                content = (resp.choices[0].message.content or "").strip()
                return {
                    "ok": True, "provider": provider, "model": model,
                    "reply": content[:80] or "(empty)",
                }
            except Exception as e:
                msg = str(e).lower()
                if "max_completion_tokens" in msg or "max_tokens" in msg:
                    continue
                raise
        return {"ok": False, "provider": provider, "model": model,
                "error": "All token-argument strategies failed"}
    except Exception as e:
        return {
            "ok": False, "provider": provider, "model": model,
            "error": f"{type(e).__name__}: {e}",
        }


def verify_model() -> dict:
    """Always tests BOTH providers (cloud + local) regardless of mode.
    This lets the user verify their Ollama setup before flipping to local/hybrid."""
    row = _get_settings_row()
    mode = (row.llm_provider or "cloud").lower()
    base_info = {
        "provider_mode": mode,
        "local_model": row.local_model,
        "local_base_url": row.local_base_url,
        "cloud_endpoint": cfg.AZURE_OPENAI_ENDPOINT,
        "cloud_model": cfg.AZURE_OPENAI_DEPLOYMENT,
    }

    cloud_result = _ping_provider("cloud", cfg.AZURE_OPENAI_DEPLOYMENT)
    local_result = _ping_provider("local", row.local_model or "llama3.2:3b")

    # Top-level "ok" reflects the currently-active mode so the header dot is honest
    if mode == "cloud":
        primary = cloud_result
    elif mode == "local":
        primary = local_result
    else:  # hybrid
        if cloud_result and local_result:
            both_ok = cloud_result.get("ok") and local_result.get("ok")
            primary = {
                "ok": bool(both_ok),
                "provider": "hybrid",
                "model": f"{cloud_result.get('model')} + {local_result.get('model')}",
                "reply": f"cloud: {cloud_result.get('reply') or cloud_result.get('error')} | local: {local_result.get('reply') or local_result.get('error')}",
                "error": None if both_ok else (
                    "; ".join(filter(None, [
                        f"cloud: {cloud_result.get('error')}" if not cloud_result.get('ok') else None,
                        f"local: {local_result.get('error')}" if not local_result.get('ok') else None,
                    ]))
                ),
            }
        else:
            primary = {"ok": False, "error": "Failed to test either provider"}

    return {**base_info, **(primary or {}), "cloud_result": cloud_result, "local_result": local_result}


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
        want_json=True, max_tokens=4000, task="analyze_fit",
    )
    data = _parse_json_loose(text)
    if not data:
        text2 = _chat(
            [
                {"role": "system", "content": SYSTEM_RECRUITER},
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": text or ""},
                {"role": "user", "content": "That was not valid JSON. Output ONLY the JSON object now, no prose."},
            ],
            want_json=True, max_tokens=4000, task="analyze_fit",
        )
        data = _parse_json_loose(text2)
    try:
        data["fit_score"] = int(float(data.get("fit_score", 0) or 0))
    except (TypeError, ValueError):
        data["fit_score"] = 0
    for k in ("strengths", "gaps", "recommendations", "key_skills_in_jd", "key_skills_in_cv"):
        if not isinstance(data.get(k), list):
            data[k] = []
    if not isinstance(data.get("verdict"), str): data["verdict"] = ""
    if not isinstance(data.get("fit_label"), str): data["fit_label"] = ""
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
        want_json=True, max_tokens=4000, task="structure_cv",
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
            want_json=False, max_tokens=1200, task="draft_answer",
        )
        return text.strip()
    except Exception as e:
        log.exception("answer_application_question failed")
        return f"(could not draft an answer: {e})"
