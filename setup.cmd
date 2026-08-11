@echo off
REM Hated WoW MCP — one-shot setup. Run from anywhere; paths are relative.
cd /d "%~dp0"
call npm install || exit /b 1
call npm run build || exit /b 1
call npm run sync-all || exit /b 1
call npm test || exit /b 1
echo.
echo Setup complete. Register dist\index.js with your MCP client.
echo Full path to use in your config:
echo   %~dp0dist\index.js
