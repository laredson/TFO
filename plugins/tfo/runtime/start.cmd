@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo TFO requires Node.js 20 or newer. Install Node.js, then restart Codex Desktop.
  exit /b 1
)
node "%~dp0server.mjs"
