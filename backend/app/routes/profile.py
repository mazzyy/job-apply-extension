"""Profile data used by the extension to autofill forms."""
import json
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import Profile

router = APIRouter(prefix="/profile", tags=["profile"])

class ProfileIn(BaseModel):
    full_name: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    email: str | None = None
    phone: str | None = None
    city: str | None = None
    country: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None
    portfolio_url: str | None = None
    current_company: str | None = None
    current_title: str | None = None
    years_experience: int | None = None
    work_authorization: str | None = None
    languages: list | None = None
    salary_expectation: str | None = None
    notice_period: str | None = None
    salutation: str | None = None
    nobility_title: str | None = None
    gender: str | None = None
    eu_work_auth: str | None = None
    extra: dict | None = None

@router.get("/")
def get_profile(db: Session = Depends(get_db)):
    p = db.query(Profile).first()
    if not p:
        return {}
    return _serialize(p)

@router.put("/")
def upsert(body: ProfileIn, db: Session = Depends(get_db)):
    p = db.query(Profile).first()
    if not p:
        p = Profile()
        db.add(p)
    data = body.model_dump(exclude_unset=True)
    if "languages" in data and data["languages"] is not None:
        p.languages = json.dumps(data.pop("languages"), ensure_ascii=False)
    if "extra" in data and data["extra"] is not None:
        p.extra_json = json.dumps(data.pop("extra"), ensure_ascii=False)
    for k, v in data.items():
        setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return _serialize(p)

def _serialize(p: Profile) -> dict:
    return {
        "full_name": p.full_name, "first_name": p.first_name, "last_name": p.last_name,
        "email": p.email, "phone": p.phone, "city": p.city, "country": p.country,
        "linkedin_url": p.linkedin_url, "github_url": p.github_url, "portfolio_url": p.portfolio_url,
        "current_company": p.current_company, "current_title": p.current_title,
        "years_experience": p.years_experience, "work_authorization": p.work_authorization,
        "languages": json.loads(p.languages) if p.languages else [],
        "salary_expectation": p.salary_expectation, "notice_period": p.notice_period,
        "salutation": p.salutation, "nobility_title": p.nobility_title,
        "gender": p.gender, "eu_work_auth": p.eu_work_auth,
        "extra": json.loads(p.extra_json) if p.extra_json else {},
    }
