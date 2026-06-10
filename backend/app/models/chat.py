"""Chat threads + messages — shared by the extension side panel and the desktop
dashboard (same backend DB → history is synchronized across clients)."""
from sqlalchemy import Column, Integer, String, Text, DateTime, func
from ..database import Base


class ChatThread(Base):
    __tablename__ = "chat_threads"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(120), nullable=True)          # auto-set from first message
    created_at = Column(DateTime, server_default=func.now())


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    thread_id = Column(Integer, index=True, nullable=True)
    role = Column(String(20), nullable=False)           # "user" | "assistant"
    content = Column(Text, nullable=False)
    context_url = Column(String(1000), nullable=True)
    context_job = Column(String(300), nullable=True)
    application_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
