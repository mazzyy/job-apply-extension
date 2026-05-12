"""Detect language and flag non-English requirements in a job description."""
import re
from langdetect import detect, DetectorFactory, LangDetectException

DetectorFactory.seed = 0

LANG_NAMES = {
    "en": "English", "de": "German", "fr": "French", "es": "Spanish",
    "it": "Italian", "nl": "Dutch", "pt": "Portuguese", "pl": "Polish",
    "ja": "Japanese", "zh-cn": "Chinese", "ko": "Korean", "ar": "Arabic",
    "ru": "Russian", "tr": "Turkish", "sv": "Swedish", "da": "Danish",
    "no": "Norwegian", "fi": "Finnish",
}

# Phrases that signal a non-English language requirement
LANG_REQ_PATTERNS = [
    (r"\bfluent in (\w+)", "fluent"),
    (r"\bnative (\w+) speaker", "native"),
    (r"\b(\w+) language skills required", "required"),
    (r"\b(\w+) is required", "required"),
    (r"\b(\w+)\s*\(c[12]\)", "C1/C2"),
    (r"\b(\w+)\s*\(b[12]\)", "B1/B2"),
    (r"German|Deutsch|Französisch|Spanisch|Italienisch|Niederländisch", "mentioned"),
]

NON_ENGLISH_KEYWORDS = {
    "german": "German", "deutsch": "German", "französisch": "German-text/French",
    "french": "French", "spanish": "Spanish", "italian": "Italian",
    "dutch": "Dutch", "portuguese": "Portuguese", "polish": "Polish",
    "japanese": "Japanese", "mandarin": "Mandarin", "chinese": "Chinese",
    "korean": "Korean", "arabic": "Arabic", "russian": "Russian",
    "turkish": "Turkish", "swedish": "Swedish",
}

def detect_language(text: str) -> str:
    try:
        return detect(text[:4000])
    except LangDetectException:
        return "unknown"

def language_label(code: str) -> str:
    return LANG_NAMES.get(code, code)

def scan_language_requirements(text: str) -> dict:
    """Return what non-English languages (if any) the JD asks for."""
    lower = text.lower()
    detected = detect_language(text)
    found = set()
    for kw, name in NON_ENGLISH_KEYWORDS.items():
        if re.search(rf"\b{re.escape(kw)}\b", lower):
            found.add(name)

    # If the JD itself is written in non-English, surface that too
    if detected and detected != "en" and detected != "unknown":
        found.add(language_label(detected))

    # Remove English from "requires other language"
    found.discard("English")
    return {
        "jd_language": detected,
        "jd_language_name": language_label(detected),
        "requires_other_languages": sorted(found),
        "english_only": len(found) == 0,
    }
