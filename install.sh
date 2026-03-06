#!/bin/bash

# check and install utils
for pkg in git curl; do
  if ! command -v "$pkg" >/dev/null 2>&1; then
    sudo apt update && sudo apt install -y "$pkg"
  fi
done

# Download and install nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# in lieu of restarting the shell
\. "$HOME/.nvm/nvm.sh"

# Download and install Node.js:
nvm install 25

# Verify the Node.js version:
node -v # Should print "v25.8.0".

# Verify npm version:
npm -v # Should print "11.11.0".

# clone the repository
git clone https://github.com/denis-skripnik/polymarket-trading-bot
cd ./polymarket-trading-bot
npm install
cp .env.example .env
