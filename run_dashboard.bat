@echo off
REM DrillDash launcher: builds the data store on first run (if the Volve data is present), then starts the dashboard.
REM Without data or a downloaded store it shows the bundled demo wells.
cd /d "%~dp0"

set "PY=python"
if exist "%LOCALAPPDATA%\anaconda3\python.exe" set "PY=%LOCALAPPDATA%\anaconda3\python.exe"
if exist "%USERPROFILE%\anaconda3\python.exe" set "PY=%USERPROFILE%\anaconda3\python.exe"

"%PY%" -W ignore ingest.py --auto
if errorlevel 1 (
  echo Ingest failed. See messages above.
  pause
  exit /b 1
)

echo Starting DrillDash at http://localhost:8050  (close this window to stop)
"%PY%" server.py
pause
