"""Chat message history — single continuous thread shared by the extension
side panel and the desktop dashboard (both read the same backend DB, so the
conversation is synchronized across clients)."""
from sqlalchemy import Column, Integer, String, Text, DateTime, func
from ..database import Base


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    role = Column(String(20), nullable=False)          # "user" | "assistant"
    content = Column(Text, nullable=False)
    # Page/job context captured when the user sent the message
    context_url = Column(String(1000), nullable=True)
    context_job = Column(String(300), nullable=True)   # "Title @ Company"
    application_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
