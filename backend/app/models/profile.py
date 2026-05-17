"""User profile data used to power autofill across job boards."""
from sqlalchemy import Column, Integer, String, Text, DateTime
from datetime import datetime
from ..database import Base

class Profile(Base):
    __tablename__ = "profiles"

    id = Column(Integer, primary_key=True, index=True)
    full_name = Column(String(200))
    first_name = Column(String(100))
    last_name = Column(String(100))
    email = Column(String(200))
    phone = Column(String(50))
    city = Column(String(100))
    country = Column(String(100))
    linkedin_url = Column(String(500))
    github_url = Column(String(500))
    portfolio_url = Column(String(500))
    current_company = Column(String(200))
    current_title = Column(String(200))
    years_experience = Column(Integer)
    work_authorization = Column(String(200))           # e.g. "EU citizen", "US citizen", "needs sponsorship"
    languages = Column(Text)                            # JSON list of {lang, level}
    salary_expectation = Column(String(200))
    notice_period = Column(String(100))
    salutation = Column(String(40))                    # Mr / Ms / Mx / Dr / Prof / ...
    nobility_title = Column(String(80))                # e.g. Dr., Prof. Dr.
    gender = Column(String(40))                        # Male / Female / Non-binary / Prefer not to say
    eu_work_auth = Column(String(20))                  # Yes / No — EU work authorization specific
    extra_json = Column(Text)                          # catch-all for custom field answers
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
