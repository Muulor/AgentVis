@echo off
REM Usage:
REM   cmd /c start-chrome-debug.bat [url]
REM   cmd /c start-chrome-debug.bat ensure --url https://example.com
REM   cmd /c start-chrome-debug.bat status
REM
REM Compatibility wrapper for the AgentVis browser runtime.
REM This script intentionally does NOT kill the user's Chrome. It reuses an
REM existing AgentVis CDP runtime when possible, or starts a dedicated Chrome
REM profile with a local CDP endpoint.

setlocal
set "SCRIPT_DIR=%~dp0"

set "PYTHON_CMD="
set "AGENTVIS_PYTHON=%APPDATA%\com.agentvis.app\runtime\python-v1\.venv\Scripts\python.exe"
if exist "%AGENTVIS_PYTHON%" (
    set "PYTHON_CMD=%AGENTVIS_PYTHON%"
) else (
    where python >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=python"
)

if "%PYTHON_CMD%"=="" (
    where py >nul 2>&1
    if errorlevel 1 (
        echo [AgentVis Browser Runtime] error: Python not found. Please install Python or initialize AgentVis Python runtime.
        exit /b 1
    )
    set "PYTHON_CMD=py -3"
)

%PYTHON_CMD% "%SCRIPT_DIR%browser_runtime.py" %*
exit /b %ERRORLEVEL%
