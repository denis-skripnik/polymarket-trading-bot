@echo off
setlocal enabledelayedexpansion

REM Polymarket Trading Bot - Auto Install Script (Windows)
REM Usage: Run this script in PowerShell or Command Prompt

REM Get script directory and project path
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."

REM Remove trailing backslash
set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

cd /d "%PROJECT_DIR%"

echo === Polymarket Trading Bot - Installer ===
echo.

REM Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Node.js not found. Installing via winget...
    where winget >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo Error: winget not found. Please install Node.js 22+ manually from nodejs.org
        exit /b 1
    )
    winget install OpenJS.NodeJS --accept-source-agreements --accept-package-agreements
) else (
    for /f "delims=" %%i in ('node --version') do set NODE_VERSION=%%i
    echo Node.js found: !NODE_VERSION!
)

echo.

REM Check if npm is installed
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Error: npm not found. Please reinstall Node.js.
    exit /b 1
)

for /f "delims=" %%i in ('npm --version') do set NPM_VERSION=%%i
echo npm found: !NPM_VERSION!
echo.

REM Check if already installed
if exist "node_modules" (
    if exist "package.json" (
        echo Dependencies already installed.
    ) else (
        echo Installing dependencies...
        call npm install
    )
) else (
    echo Installing dependencies...
    call npm install
)

echo.

REM Check if .env exists
if not exist ".env" (
    echo Warning: .env file not found!
    echo Please create .env from .env.example before running the bot.
    echo In PowerShell: Copy-Item .env.example .env
    echo.
    echo After creating .env, run this script again to start the bot.
    exit /b 0
)

REM Check if PM2 is installed
where pm2 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Installing PM2...
    call npm install -g pm2
)

echo.
echo === Installation complete! ===
echo.

REM Check if bot is already running
call npx pm2 describe polymarket-bot >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo Bot is already running. Restarting...
    call npx pm2 restart polymarket-bot
) else (
    echo Starting bot with PM2...
    call npx pm2 start ecosystem.config.cjs --name polymarket-bot
)

call npx pm2 save

echo.
echo Bot started! Use 'npx pm2 logs polymarket-bot' to view logs.
echo To stop: npx pm2 stop polymarket-bot
