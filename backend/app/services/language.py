"""Detect language and flag non-English requirements in a job description.

v2: a language is only flagged as "required" when it appears in a REQUIREMENT
CONTEXT (fluent in X, native X, X required, C1, "speak X", ...). A bare mention
of a language word — site footers ("Français"), location names, "Spanish-speaking
market" in marketing copy — no longer triggers a false positive.
"""
import re
from langdetect import detect_langs, DetectorFactory, LangDetectException

DetectorFactory.seed = 0

LANG_NAMES = {
    "en": "English", "de": "German", "fr": "French", "es": "Spanish",
    "it": "Italian", "nl": "Dutch", "pt": "Portuguese", "pl": "Polish",
    "ja": "Japanese", "zh-cn": "Chinese", "ko": "Korean", "ar": "Arabic",
    "ru": "Russian", "tr": "Turkish", "sv": "Swedish", "da": "Danish",
    "no": "Norwegian", "fi": "Finnish",
}

# Language words (English + native + German exonyms) → canonical English name.
LANGUAGE_WORDS = {
    "german": "German", "deutsch": "German",
    "french": "French", "français": "French", "francais": "French", "französisch": "French",
    "spanish": "Spanish", "español": "Spanish", "espanol": "Spanish", "spanisch": "Spanish",
    "italian": "Italian", "italiano": "Italian", "italienisch": "Italian",
    "dutch": "Dutch", "nederlands": "Dutch", "niederländisch": "Dutch",
    "portuguese": "Portuguese", "português": "Portuguese", "portugiesisch": "Portuguese",
    "polish": "Polish", "polski": "Polish", "polnisch": "Polish",
    "japanese": "Japanese", "japanisch": "Japanese",
    "mandarin": "Mandarin", "chinese": "Chinese", "chinesisch": "Chinese",
    "korean": "Korean", "koreanisch": "Korean",
    "arabic": "Arabic", "arabisch": "Arabic",
    "russian": "Russian", "russisch": "Russian",
    "turkish": "Turkish", "türkisch": "Turkish",
    "swedish": "Swedish", "schwedisch": "Swedish",
}

# Words that signal the language is an actual JOB REQUIREMENT when they appear
# near the language word (same ~sentence window).
_REQ_CONTEXT = re.compile(
    r"(fluen\w*|native|proficien\w*|requir\w*|mandatory|must|essential|"
    r"speak\w*|spoken|written|verbal|bilingual|"
    r"language skills?|knowledge of|working knowledge|skills? in|"
    r"\bc1\b|\bc2\b|\bb1\b|\bb2\b|\ba2\b|level|"
    r"sprachkenntnisse|kenntnisse|sprech\w*|fließend|fliessend|"
    r"verhandlungssicher|muttersprach\w*|erforderlich|vorausgesetzt|zwingend)",
    re.I,
)

# How far around the language word we look for requirement context (chars).
_CONTEXT_WINDOW = 100
# Minimum JD length before whole-text language detection is trusted.
_MIN_DETECT_LEN = 300
# Minimum langdetect probability to claim the JD is written in a non-English language.
_MIN_DETECT_PROB = 0.90


def detect_language(text: str) -> str:
    """Detect the dominant language, returning 'unknown' when unsure."""
    if not text or len(text.strip()) < _MIN_DETECT_LEN:
        return "unknown"
    try:
        candidates = detect_langs(text[:4000])
    except LangDetectException:
        return "unknown"
    if not candidates:
        return "unknown"
    top = candidates[0]
    # English needs no confidence gate (false "en" is harmless); non-English does.
    if top.lang != "en" and top.prob < _MIN_DETECT_PROB:
        return "unknown"
    return top.lang


def language_label(code: str) -> str:
    return LANG_NAMES.get(code, code)


def _required_languages(lower_text: str) -> set:
    """Language words that appear within a requirement context window."""
    found = set()
    for kw, name in LANGUAGE_WORDS.items():
        if name in found:
            continue
        for m in re.finditer(rf"\b{re.escape(kw)}\b", lower_text):
            start = max(0, m.start() - _CONTEXT_WINDOW)
            end = min(len(lower_text), m.end() + _CONTEXT_WINDOW)
            if _REQ_CONTEXT.search(lower_text[start:end]):
                found.add(name)
                break
    return found


def scan_language_requirements(text: str) -> dict:
    """Return what non-English languages (if any) the JD asks for."""
    lower = (text or "").lower()
    detected = detect_language(text or "")
    found = _required_languages(lower)

    # If the JD itself is confidently written in a non-English language, surface that too.
    if detected not in ("en", "unknown"):
        found.add(language_label(detected))

    found.discard("English")
    return {
        "jd_language": detected,
        "jd_language_name": language_label(detected),
        "requires_other_languages": sorted(found),
        "english_only": len(found) == 0,
    }
