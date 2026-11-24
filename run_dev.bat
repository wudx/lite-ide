@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing dependencies...
  call pnpm install || exit /b 1
)
call pnpm tauri:dev
