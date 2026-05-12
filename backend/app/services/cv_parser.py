"""Extract plain text from PDF or DOCX CV uploads."""
from pathlib import Path
from pypdf import PdfReader
from docx import Document

def extract_text(file_path: str) -> str:
    p = Path(file_path)
    suffix = p.suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(file_path)
    if suffix in {".docx", ".doc"}:
        return _extract_docx(file_path)
    if suffix in {".txt", ".md"}:
        return p.read_text(encoding="utf-8", errors="ignore")
    raise ValueError(f"Unsupported CV format: {suffix}")

def _extract_pdf(path: str) -> str:
    reader = PdfReader(path)
    parts = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            continue
    return "\n".join(parts).strip()

def _extract_docx(path: str) -> str:
    doc = Document(path)
    return "\n".join(p.text for p in doc.paragraphs).strip()
