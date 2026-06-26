@echo off
REM Run agent-browser against the active AgentVis browser runtime.
REM Usage:
REM   cmd /c browser-command.bat snapshot -i
REM   cmd /c browser-command.bat get url

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

%PYTHON_CMD% "%SCRIPT_DIR%browser_command.py" %*
exit /b %ERRORLEVEL%
