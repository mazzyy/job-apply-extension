"""Log of every LLM call: tokens, cost, latency.

One row per chat-completion call. Used by the analytics dashboard to show
total cost, token usage by task/provider, and cost trends over time.
"""
from sqlalchemy import Column, Integer, String, Float, DateTime
from datetime import datetime
from ..database import Base


class LLMUsage(Base):
    __tablename__ = "llm_usage"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    task = Column(String(40), nullable=False)              # analyze_fit | cover_letter | typed_answer | ...
    provider = Column(String(20), nullable=False)          # cloud | local
    model = Column(String(120), nullable=False)            # gpt-5-mini | llama3.2:3b | ...

    prompt_tokens = Column(Integer, default=0)
    completion_tokens = Column(Integer, default=0)
    reasoning_tokens = Column(Integer, default=0)          # gpt-5 reasoning models expose this
    total_tokens = Column(Integer, default=0)

    estimated_cost_usd = Column(Float, default=0.0)        # 0 for local

    latency_ms = Column(Integer, default=0)
    success = Column(Integer, default=1)                   # 0 on error
    error = Column(String(500), nullable=True)
