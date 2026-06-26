@echo off
REM Template: AgentVis Browser Runtime connector (Windows)
REM Purpose: Reuse or start a dedicated Chrome CDP runtime without closing the
REM user's normal Chrome.
REM Usage: native-chrome-connect.bat [url]

setlocal
set "SCRIPT_DIR=%~dp0..\scripts"
cmd /c "%SCRIPT_DIR%\start-chrome-debug.bat" %*
