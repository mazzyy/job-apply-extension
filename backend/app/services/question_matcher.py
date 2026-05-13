"""Forgiving question similarity. Uses character n-grams + token overlap.
Works well for short, paraphrased recruiter questions which often differ
in surface words but share intent."""
import math
import re
from collections import Counter

_STOP = set("""
a an the and or of in on at to for with by from is are was were be been being
this that these those it its as our your you we they i me my his her him she he them
do does did done has have had not no s t and/or
""".split())

# Common stems / synonyms to bridge paraphrases
SYNS = {
    "work": ["working", "works", "job", "role"],
    "interest": ["interested", "interesting", "interests", "passion", "passionate"],
    "company": ["companies", "organization", "team", "employer"],
    "want": ["wants", "wanted", "wanting", "wish", "would like"],
    "why": ["reason", "what", "how"],
    "experience": ["experiences", "experienced", "background"],
    "skill": ["skills", "skilled", "ability", "abilities"],
    "challenge": ["challenges", "difficult", "hard", "tough"],
    "strength": ["strengths", "strong", "good at"],
    "weakness": ["weaknesses", "weak", "improve"],
    "salary": ["pay", "compensation", "expectation", "wage"],
    "available": ["availability", "start date", "notice period"],
}

# Build reverse map: every synonym → canonical stem
_REVERSE = {}
for stem, alts in SYNS.items():
    _REVERSE[stem] = stem
    for a in alts:
        for w in a.split():
            _REVERSE[w] = stem


def normalize(text: str) -> str:
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9\s]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def tokens(text: str) -> list:
    """Tokenize and map to canonical stems."""
    out = []
    for t in normalize(text).split():
        if t in _STOP or len(t) < 2:
            continue
        out.append(_REVERSE.get(t, t))
    return out


def vector(text: str) -> Counter:
    return Counter(tokens(text))


def char_ngrams(text: str, n: int = 3) -> Counter:
    s = normalize(text).replace(" ", "_")
    return Counter(s[i:i+n] for i in range(len(s)-n+1))


def cosine(a: Counter, b: Counter) -> float:
    common = set(a) & set(b)
    if not common: return 0.0
    dot = sum(a[t]*b[t] for t in common)
    na = math.sqrt(sum(v*v for v in a.values()))
    nb = math.sqrt(sum(v*v for v in b.values()))
    return dot/(na*nb) if na and nb else 0.0


def similarity(a: str, b: str) -> float:
    """Blend token-cosine (semantic-ish via stems) with char-ngram (typo-robust)."""
    tok = cosine(vector(a), vector(b))
    char = cosine(char_ngrams(a, 3), char_ngrams(b, 3))
    return round(0.65 * tok + 0.35 * char, 4)


def classify(text: str) -> str:
    t = normalize(text)
    if any(k in t for k in ["salary", "compensation", "pay", "wage", "rate"]): return "salary"
    if any(k in t for k in ["notice period", "start date", "available", "availability"]): return "logistics"
    if any(k in t for k in ["why", "interest", "passion", "want to work"]): return "motivation"
    if any(k in t for k in ["weakness", "strength", "tell me about", "describe a time", "challenge"]): return "behavioral"
    if any(k in t for k in ["technical", "code", "design", "architecture", "stack"]): return "technical"
    if any(k in t for k in ["legal", "authorized", "visa", "sponsorship", "work permit"]): return "logistics"
    if any(k in t for k in ["referral", "how did you hear"]): return "logistics"
    return "other"
