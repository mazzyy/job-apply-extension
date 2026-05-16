@echo off
REM Tauri beforeBuildCommand on Windows. Mirrors bundle-resources.sh.
cd /d "%~dp0\.."

if not exist "..\backend\dist\jobapply-backend\jobapply-backend.exe" (
  echo Backend bundle not found, building it now...
  pushd ..\backend
  call build.bat
  popd
)
if not exist "src-tauri\resources\backend" mkdir "src-tauri\resources\backend"
xcopy /E /I /Y "..\backend\dist\jobapply-backend\*" "src-tauri\resources\backend\" >nul
echo + Backend copied

if "%BUNDLE_OLLAMA%"=="1" (
  if not exist "src-tauri\resources\ollama" mkdir "src-tauri\resources\ollama"
  echo Downloading Ollama for Windows...
  powershell -Command "Invoke-WebRequest -Uri 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.exe' -OutFile 'src-tauri\resources\ollama\ollama.exe'"
  echo + Ollama bundled
)

echo Done.
