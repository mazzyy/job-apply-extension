"""Application question + saved answer library.

A `Question` is a canonical question prompt (e.g. "Why do you want to work here?").
A `QuestionAnswer` is one specific answer the user has used or saved for a question.
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Float
from datetime import datetime
from ..database import Base


class Question(Base):
    __tablename__ = "questions"

    id = Column(Integer, primary_key=True, index=True)
    text = Column(Text, nullable=False)               # the exact question text
    normalized = Column(Text, nullable=False)         # lowercased, punctuation-stripped for matching
    category = Column(String(50), nullable=True)      # motivation | behavioral | salary | technical | other
    tags = Column(String(300), nullable=True)         # comma-separated tags
    use_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_used_at = Column(DateTime, default=datetime.utcnow)


class QuestionAnswer(Base):
    __tablename__ = "question_answers"

    id = Column(Integer, primary_key=True, index=True)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False)
    answer = Column(Text, nullable=False)
    is_default = Column(Integer, default=0)           # 0/1 flag for the user's go-to answer
    application_id = Column(Integer, ForeignKey("applications.id"), nullable=True)  # which app it was used in
    use_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_used_at = Column(DateTime, default=datetime.utcnow)
