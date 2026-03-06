#!/bin/bash

# Polymarket Trading Bot - Auto Install Script (Linux)
# Usage: ./install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== Polymarket Trading Bot - Installer ==="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Installing..."
    
    # Detect OS and install Node.js
    if command -v apt-get &> /dev/null; then
        # Debian/Ubuntu
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v yum &> /dev/null; then
        # RHEL/CentOS
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo yum install -y nodejs
    elif command -v dnf &> /dev/null; then
        # Fedora
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo dnf install -y nodejs
    else
        echo "Error: Cannot detect package manager. Please install Node.js 22+ manually."
        exit 1
    fi
else
    echo "Node.js found: $(node --version)"
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "Error: npm not found. Please install npm."
    exit 1
fi

echo "npm found: $(npm --version)"
echo ""

# Check if already installed
if [ -d "node_modules" ] && [ -f "package.json" ]; then
    echo "Dependencies already installed."
else
    echo "Installing dependencies..."
    npm install
fi

# Check if .env exists
if [ ! -f ".env" ]; then
    echo ""
    echo "Warning: .env file not found!"
    echo "Please create .env from .env.example before running the bot."
    echo "cp .env.example .env"
    echo ""
    echo "After creating .env, run this script again to start the bot."
    exit 0
fi

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    npm install -g pm2
fi

echo ""
echo "=== Installation complete! ==="
echo ""

# Check if bot is already running
if pm2 describe polymarket-bot &> /dev/null; then
    echo "Bot is already running. Restarting..."
    pm2 restart polymarket-bot
else
    echo "Starting bot with PM2..."
    pm2 start ecosystem.config.cjs --name polymarket-bot
fi

pm2 save

echo ""
echo "Bot started! Use 'pm2 logs polymarket-bot' to view logs."
echo "To stop: pm2 stop polymarket-bot"
