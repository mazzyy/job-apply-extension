"""Provider/model settings used by the LLM router."""
import json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import AppSettings

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsIn(BaseModel):
    llm_provider: str | None = None       # cloud | local | hybrid
    local_model: str | None = None
    local_base_url: str | None = None
    per_task: dict | None = None          # {task_name: "cloud" | "local"}


@router.get("/")
def get_settings(db: Session = Depends(get_db)):
    row = db.query(AppSettings).first()
    if not row:
        row = AppSettings(); db.add(row); db.commit(); db.refresh(row)
    return _to_dict(row)


@router.put("/")
def update_settings(body: SettingsIn, db: Session = Depends(get_db)):
    row = db.query(AppSettings).first()
    if not row:
        row = AppSettings(); db.add(row)
    data = body.model_dump(exclude_unset=True)
    if "llm_provider" in data and data["llm_provider"] in {"cloud", "local", "hybrid"}:
        row.llm_provider = data["llm_provider"]
    if "local_model" in data and data["local_model"]:
        row.local_model = data["local_model"]
    if "local_base_url" in data and data["local_base_url"]:
        row.local_base_url = data["local_base_url"]
    if "per_task" in data and data["per_task"] is not None:
        row.per_task = json.dumps(data["per_task"])
    db.commit(); db.refresh(row)
    return _to_dict(row)


def _to_dict(row: AppSettings) -> dict:
    return {
        "llm_provider": row.llm_provider,
        "local_model": row.local_model,
        "local_base_url": row.local_base_url,
        "per_task": json.loads(row.per_task) if row.per_task else {},
    }
