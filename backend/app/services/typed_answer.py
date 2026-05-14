"""Generate shape-correct answers for application form fields.

Distinguishes between:
- number    → integer extracted from CV (years of X, etc.)
- select    → one of the provided options
- radio     → typically Yes/No, returns one of the options
- short text → ≤ 60 char single-line answer
- textarea  → free-form prose grounded in CV
"""
import json
import re
import logging
from .analyzer import _chat, _parse_json_loose

log = logging.getLogger("jaa.typed")


def _looks_like_years_question(text: str) -> bool:
    t = text.lower()
    return bool(re.search(
        r"(years?|jahre)\s+(of\s+)?(experience|erfahrung)|wie viele jahre|how many years",
        t,
    ))


def _skill_from_question(text: str) -> str | None:
    """Pull the skill being asked about from 'How many years of experience with X?'."""
    m = re.search(r"experience\s+(?:in|with|using)\s*[:\-]?\s*([A-Za-z0-9 .+#/_-]{2,60})", text, re.I)
    if m: return m.group(1).strip(" ?.,")
    m = re.search(r"experience\s+haben sie mit\s*[:\-]?\s*([A-Za-zÄÖÜäöü0-9 .+#/_-]{2,60})", text, re.I)
    if m: return m.group(1).strip(" ?.,")
    m = re.search(r"mit:\s*([A-Za-zÄÖÜäöü0-9 .+#/_-]{2,60})\?", text)
    if m: return m.group(1).strip(" ?.,")
    return None




LANG_PROFICIENCY_OPTIONS = {
    # Common LinkedIn variants. We map the user's CEFR / self-rating to the
    # closest visible option.
    "native": ["native", "muttersprache", "muttersprachler", "native or bilingual"],
    "fluent": ["fluent", "fließend", "fliessend", "c2", "c1", "advanced", "full professional"],
    "professional": ["professional", "business", "geschäftsfließend", "b2", "professional working"],
    "intermediate": ["intermediate", "konversationssicher", "konversation", "limited working", "b1", "good"],
    "basic": ["basic", "grundkenntnisse", "elementary", "a1", "a2", "limited", "elementary proficiency"],
    "none": ["none", "gar nicht", "no", "not at all"],
}

CEFR_RANK = {"native": 6, "c2": 5, "c1": 5, "b2": 4, "b1": 3, "a2": 2, "a1": 1, "fluent": 5, "professional": 4, "intermediate": 3, "basic": 2, "none": 0}


def _looks_like_language_question(text: str) -> str | None:
    """Returns the language name if this is a 'how well do you speak X?' question."""
    t = text.lower()
    for lang in ("german", "deutsch", "english", "englisch", "french", "französisch", "spanish", "spanisch",
                 "italian", "italienisch", "dutch", "niederländisch", "polish", "polnisch", "portuguese"):
        if lang in t and any(k in t for k in ["beherrschen", "speak", "language", "sprachkenntnisse", "wie gut", "how well", "proficiency", "kenntnisse"]):
            # normalize to English name
            return {
                "deutsch": "german", "englisch": "english", "französisch": "french",
                "spanisch": "spanish", "italienisch": "italian",
                "niederländisch": "dutch", "polnisch": "polish",
            }.get(lang, lang)
    return None


def _pick_lang_option(level_text: str, options: list) -> tuple:
    """Given a candidate's level string (e.g. 'C1', 'fluent', 'Muttersprache') and the
    visible options on the form, return (best_option, confidence)."""
    if not options:
        return None, 0.0
    norm = (level_text or "").strip().lower()
    # Find which canonical bucket the user belongs to
    user_bucket = None
    for bucket, aliases in LANG_PROFICIENCY_OPTIONS.items():
        if any(a in norm for a in aliases):
            user_bucket = bucket; break
    if not user_bucket:
        return None, 0.0
    user_rank = CEFR_RANK.get(user_bucket, 0)

    # Score every option by its proximity to the user bucket
    scored = []
    for opt in options:
        opt_norm = opt.lower()
        opt_bucket = None
        for bucket, aliases in LANG_PROFICIENCY_OPTIONS.items():
            if any(a in opt_norm for a in aliases):
                opt_bucket = bucket; break
        opt_rank = CEFR_RANK.get(opt_bucket, -10)
        scored.append((opt, opt_rank, opt_bucket))
    if not scored:
        return None, 0.0
    # Pick the option with the smallest non-negative gap to the user (prefer matching or one-below)
    scored.sort(key=lambda x: (abs(x[1] - user_rank), -x[1]))
    pick = scored[0]
    confidence = 0.9 if pick[1] == user_rank else 0.65
    return pick[0], confidence


def answer_for_form(question: str, cv_text: str, profile_json: str,
                    input_type: str = "text", max_length: int | None = None,
                    options: list | None = None,
                    job_context: str = "") -> dict:
    # Short-circuit: language-proficiency dropdowns answered directly from profile.languages
    lang_asked = _looks_like_language_question(question)
    if lang_asked and input_type in ("select", "radio") and options:
        try:
            prof = json.loads(profile_json or "{}")
            langs = prof.get("languages") or []
            for L in langs:
                if not isinstance(L, dict): continue
                name = (L.get("language") or "").lower()
                level = (L.get("level") or "").lower()
                if lang_asked in name or name in lang_asked:
                    pick, conf = _pick_lang_option(level, options)
                    if pick:
                        return {
                            "value": pick,
                            "explanation": f"Matched profile.languages: {L.get('language')} = {L.get('level')}",
                            "confidence": conf,
                            "needs_review": conf < 0.85,
                        }
            # Language not listed in profile → don't guess "Gar nicht" silently; needs user review
            # Pick the median option as a reasonable placeholder and flag for review
            mid = options[len(options) // 2] if options else None
            return {
                "value": mid,
                "explanation": f"Your profile doesn't list {lang_asked.capitalize()} — please verify in the review queue.",
                "confidence": 0.2,
                "needs_review": True,
            }
        except Exception as e:
            log.warning("language shortcut failed: %s", e)
    """Return a {"value": <typed>, "explanation": str, "confidence": 0-1}.
    Output is shape-correct for the form: int for number, an option string for select/radio,
    short string for short text, longer prose for textarea."""

    opts_str = ""
    if options:
        opts_str = "\n\nALLOWED OPTIONS (pick exactly one):\n" + "\n".join(f"- {o}" for o in options)

    length_hint = ""
    if input_type == "number":
        length_hint = "\n\nThe form expects a single INTEGER. Return an integer only — no words, no units."
    elif input_type == "select" or input_type == "radio":
        length_hint = f"\n\nThe form expects ONE of the allowed options EXACTLY as written.{opts_str}"
    elif input_type == "text":
        ml = max_length or 60
        length_hint = f"\n\nThe form is a single-line text field, max {ml} characters. Be brief — no full sentences if not needed."
    elif input_type == "textarea":
        length_hint = "\n\nThe form is a textarea. Write 1-3 short sentences, first person, grounded in the candidate's CV. No clichés."

    skill_hint = ""
    if input_type == "number" and _looks_like_years_question(question):
        skill = _skill_from_question(question) or ""
        skill_hint = f"""

The question asks YEARS OF EXPERIENCE with: {skill or '(see question text)'}.

GROUNDING RULES (mandatory):
1. Search the CV for explicit mentions of the skill or close variants (e.g. "Docker-Produkte" → match "Docker", "containerization", "Containers", "Containerd").
2. Find every role/project where the skill was hands-on used. Use the date ranges (e.g. "2022-present", "Jan 2020 – Jun 2022") to compute years.
3. Sum non-overlapping date ranges. Return the integer number of years.
4. If the skill is NOT mentioned anywhere in the CV: return 0 and set needs_review=true.
5. If the skill appears as a one-line bullet (e.g. "Skills: Docker") without dated usage: return at most 1 and set needs_review=true.
6. NEVER inflate. NEVER fabricate. Confidence < 0.5 means you guessed — that MUST set needs_review=true.

In the "explanation" field, cite the specific CV lines/dates you used. Example: "2022-present at Siemens (3 years) using Docker for AKS pipelines."
"""

    prompt = f"""Answer this application form field for the candidate. Return strict JSON only.

QUESTION: {question}
INPUT_TYPE: {input_type}
{job_context}
CANDIDATE CV:
\"\"\"
{cv_text[:4500]}
\"\"\"

CANDIDATE PROFILE:
{profile_json[:1200]}
{length_hint}{skill_hint}

JSON schema:
{{
  "value": <the answer — type matches input_type; integer for number, one of the options for select/radio, short string for text, prose for textarea>,
  "explanation": "<one sentence: which CV line or profile field this came from>",
  "confidence": <0.0-1.0>,
  "needs_review": <true if you guessed or extrapolated, false if directly stated in CV/profile>
}}"""
    text = _chat(
        [
            {"role": "system", "content": "You return shape-correct JSON answers to job application form fields. You ground every answer in the CV; if it's not in the CV you mark needs_review=true."},
            {"role": "user", "content": prompt},
        ],
        want_json=True,
        max_tokens=1200,
    )
    data = _parse_json_loose(text)

    val = data.get("value")
    # Coerce by input type
    if input_type == "number":
        if isinstance(val, (int, float)):
            data["value"] = int(val)
        else:
            # extract first integer from whatever was returned
            m = re.search(r"-?\d+", str(val or ""))
            data["value"] = int(m.group(0)) if m else 0
            data["needs_review"] = True
    elif input_type in {"select", "radio"} and options:
        v = str(val or "").strip()
        # try exact match, then case-insensitive, then substring
        match = next((o for o in options if o == v), None)
        if not match:
            match = next((o for o in options if o.lower() == v.lower()), None)
        if not match:
            match = next((o for o in options if v.lower() in o.lower() or o.lower() in v.lower()), None)
        data["value"] = match or options[0]   # fallback to first option but mark needs_review
        if not match:
            data["needs_review"] = True
    elif input_type == "text":
        ml = max_length or 60
        data["value"] = str(val or "")[:ml]
    else:  # textarea
        data["value"] = str(val or "").strip()

    # Coerce other fields
    try:
        data["confidence"] = float(data.get("confidence") or 0)
    except (TypeError, ValueError):
        data["confidence"] = 0.0
    data["needs_review"] = bool(data.get("needs_review"))
    data["explanation"] = str(data.get("explanation") or "")

    # Defense in depth: any numeric answer with low confidence or no explanation
    # forces needs_review=true so the user catches inflated/guessed numbers.
    if input_type == "number":
        if data.get("confidence", 0) < 0.6:
            data["needs_review"] = True
        if not data.get("explanation"):
            data["needs_review"] = True
    return data
