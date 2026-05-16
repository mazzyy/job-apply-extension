@echo off
REM Build the standalone backend bundle. Run from backend\.
cd /d "%~dp0"

if not exist ".venv" (
  python -m venv .venv
)
call .venv\Scripts\activate.bat

pip install -q --upgrade pip
pip install -q -r requirements.txt

if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
pyinstaller build.spec --clean

echo.
echo + Backend bundle ready at: backend\dist\jobapply-backend\
echo   Run it with: dist\jobapply-backend\jobapply-backend.exe
