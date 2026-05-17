"""Lightweight translation utilities.
Used to keep the question library English-only regardless of the form's language.
"""
import logging
from .language import detect_language
from .analyzer import _chat

log = logging.getLogger("jaa.translator")


def is_english(text: str) -> bool:
    """Heuristic — saves an LLM call when the input is obviously English."""
    if not text or len(text.strip()) < 4:
        return True
    code = detect_language(text)
    return code in ("en", "unknown")


def to_english(text: str) -> str:
    """Translate `text` to English. Returns original if already English or on failure."""
    if is_english(text):
        return text.strip()
    try:
        out = _chat(
            [
                {"role": "system", "content": "You translate short job application questions to clear, simple English. Return ONLY the translation, nothing else. No quotes, no commentary."},
                {"role": "user", "content": text.strip()},
            ],
            want_json=False, max_tokens=300, task="email_classify",   # reuse the cheap-task lane
        )
        cleaned = (out or "").strip().strip('"').strip("'").strip()
        if cleaned and len(cleaned) < len(text) * 3:
            return cleaned
    except Exception as e:
        log.warning("Translate-to-english failed: %s", e)
    return text.strip()


def from_english(text: str, target_lang_code: str) -> str:
    """Translate `text` from English to the target language code (e.g. 'de', 'fr').
    Returns original if target is English or on failure."""
    if not text or target_lang_code in ("en", "unknown", "", None):
        return text
    try:
        target_name = {
            "de": "German", "fr": "French", "es": "Spanish", "it": "Italian",
            "nl": "Dutch", "pt": "Portuguese", "pl": "Polish",
            "sv": "Swedish", "no": "Norwegian", "da": "Danish",
            "ja": "Japanese", "zh-cn": "Chinese", "ko": "Korean",
        }.get(target_lang_code, target_lang_code)
        out = _chat(
            [
                {"role": "system", "content": f"You translate short text from English to {target_name}. Return ONLY the translation, nothing else."},
                {"role": "user", "content": text.strip()},
            ],
            want_json=False, max_tokens=400, task="email_classify",
        )
        cleaned = (out or "").strip().strip('"').strip("'").strip()
        if cleaned:
            return cleaned
    except Exception as e:
        log.warning("Translate-from-english failed: %s", e)
    return text
