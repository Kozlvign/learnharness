@echo off
rem Double-click: merge upstream, build, publish a fork release and install it.
title Update LearnHarness (Claude fork)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0release-windows.ps1" -Install %*
set "exitcode=%errorlevel%"
echo.
pause
exit /b %exitcode%
