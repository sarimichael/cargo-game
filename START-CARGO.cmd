@echo off
setlocal
cd /d "%~dp0"
set "CARGO_NODE=node"
where node >nul 2>&1
if errorlevel 1 (
  set "CARGO_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if "%CARGO_NODE%"=="node" goto ready
if exist "%CARGO_NODE%" goto ready
echo Cargo needs Node.js 24 or newer.
echo Install the LTS version from https://nodejs.org/en/download
echo Then double-click START-CARGO again.
pause
exit /b 1
:ready
"%CARGO_NODE%" server\index.js --open
pause
