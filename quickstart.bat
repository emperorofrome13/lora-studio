@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer from https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0launch.mjs"
set "launch_result=%errorlevel%"
if not "%launch_result%"=="0" echo Startup failed. Read the message above.
echo.
pause
exit /b %launch_result%
