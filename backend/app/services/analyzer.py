"""Azure OpenAI-powered fit analysis and CV structuring."""
import json
from openai import AzureOpenAI
from ..config import settings

_client: AzureOpenAI | None = None

def client() -> AzureOpenAI:
    global _client
    if _client is None:
        _client = AzureOpenAI(
            api_key=settings.AZURE_OPENAI_API_KEY,
            api_version=settings.AZURE_OPENAI_API_VERSION,
            azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
        )
    return _client

SYSTEM_RECRUITER = (
    "You are a senior technical recruiter and career coach. You give specific, "
    "honest, actionable feedback. You never invent skills the candidate does not have. "
    "Always respond with valid JSON only."
)

def analyze_fit(cv_text: str, job_description: str, job_title: str = "", company: str = "") -> dict:
    """Compare CV against JD; return fit score, strengths, gaps, recommendations."""
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

Respond with this exact JSON schema:
{{
  "fit_score": <integer 0-100>,
  "fit_label": "<one of: Excellent fit | Strong fit | Possible fit | Weak fit | Not a fit>",
  "strengths": ["<specific matching skill/experience>", ...],
  "gaps": ["<specific missing skill/experience>", ...],
  "recommendations": ["<actionable suggestion to close a gap or strengthen application>", ...],
  "must_haves_met": <integer count>,
  "must_haves_total": <integer count>,
  "verdict": "<one to two sentence honest summary>",
  "key_skills_in_jd": ["<top skills the JD asks for>", ...],
  "key_skills_in_cv": ["<top skills the candidate has>", ...]
}}
Keep arrays focused (3-6 items each). Be specific, not generic."""
    resp = client().chat.completions.create(
        model=settings.AZURE_OPENAI_DEPLOYMENT,
        messages=[
            {"role": "system", "content": SYSTEM_RECRUITER},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
    )
    content = resp.choices[0].message.content or "{}"
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return {"error": "Model returned invalid JSON", "raw": content}

def structure_cv(cv_text: str) -> dict:
    """Parse a CV into structured fields useful for autofill."""
    prompt = f"""Extract structured profile data from this CV. Return JSON only.

CV TEXT:
\"\"\"
{cv_text[:8000]}
\"\"\"

JSON schema:
{{
  "full_name": "",
  "first_name": "",
  "last_name": "",
  "email": "",
  "phone": "",
  "city": "",
  "country": "",
  "linkedin_url": "",
  "github_url": "",
  "portfolio_url": "",
  "current_company": "",
  "current_title": "",
  "years_experience": 0,
  "skills": [],
  "languages": [{{"language": "", "level": ""}}],
  "education": [{{"school": "", "degree": "", "field": "", "year": ""}}],
  "experience": [{{"company": "", "title": "", "start": "", "end": "", "summary": ""}}]
}}
Use empty strings or empty arrays when unknown. Do not invent data."""
    resp = client().chat.completions.create(
        model=settings.AZURE_OPENAI_DEPLOYMENT,
        messages=[
            {"role": "system", "content": "You extract structured data from resumes. Output strict JSON only."},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
    )
    try:
        return json.loads(resp.choices[0].message.content or "{}")
    except json.JSONDecodeError:
        return {}

def answer_application_question(question: str, cv_text: str, profile_json: str) -> str:
    """Draft an answer to an application question (cover-letter style, 'why this role', etc.)."""
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
    resp = client().chat.completions.create(
        model=settings.AZURE_OPENAI_DEPLOYMENT,
        messages=[
            {"role": "system", "content": "You write honest, specific job application answers in first person."},
            {"role": "user", "content": prompt},
        ],
    )
    return (resp.choices[0].message.content or "").strip()
