#!/usr/bin/env bash
cd "$(dirname "$0")"
python -m venv .venv 2>/dev/null || true
source .venv/bin/activate
pip install -q -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
