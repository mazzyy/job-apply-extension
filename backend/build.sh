#!/usr/bin/env bash
# Build the standalone backend bundle. Run from backend/.
set -euo pipefail
cd "$(dirname "$0")"

# Create / reuse venv
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate

pip install -q --upgrade pip
pip install -q -r requirements.txt

rm -rf build dist
pyinstaller build.spec --clean

echo
echo "✓ Backend bundle ready at: backend/dist/jobapply-backend/"
echo "  Run it with: ./dist/jobapply-backend/jobapply-backend"
