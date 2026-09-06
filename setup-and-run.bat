@echo off
title Nexora AI - setup and run
cd /d "%~dp0"

echo ================================================
echo   Nexora AI - technical interview assistant
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js was not found on this machine.
  echo     Install the LTS build from https://nodejs.org  then run this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo [ok] Node %%v
echo.

if exist node_modules (
  echo [1/2] Dependencies already present - checking for updates...
) else (
  echo [1/2] Installing dependencies. The first run downloads Electron ^(~100 MB^),
  echo       so this can take a few minutes. Leave this window open.
)
echo.

call npm install
if errorlevel 1 (
  echo.
  echo [X] npm install failed. Scroll up for the reason.
  echo     A proxy or antivirus blocking the Electron download is the usual cause.
  echo.
  pause
  exit /b 1
)

rem VS Code's integrated terminal exports ELECTRON_RUN_AS_NODE=1, which makes
rem Electron start as plain Node and fail on startup. Clear it for this window.
set "ELECTRON_RUN_AS_NODE="

echo.
echo [2/2] Starting Nexora AI...
echo       The window opens on top of your other windows.
echo       Add a Gemini or OpenAI API key in Settings, then close this window when done.
echo.

call npm start

echo.
echo Nexora AI has exited.
pause
