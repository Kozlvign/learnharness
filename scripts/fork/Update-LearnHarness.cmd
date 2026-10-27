@echo off
rem Double-click: update the fork's installed app now. Merges upstream, and
rem builds, publishes and installs a fork release when the app changed.
rem The scheduled task (install-update-task.ps1) does this on its own every
rem few minutes; this also retries a failed update at once.
title Update LearnHarness (Claude fork)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto-update.ps1" -Now
set "exitcode=%errorlevel%"
echo.
pause
exit /b %exitcode%
