#!/usr/bin/env bash
# Launcher for the HeySure Agent Mac desktop app. Installs deps and rebuilds
# robotjs on first run, then starts the app.
set -euo pipefail

cd "$(dirname "$0")"

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
  echo "Rebuilding native modules for Electron..."
  npm run rebuild || echo "warning: robotjs rebuild failed — keyboard/mouse tools may be unavailable"
fi

echo "note: macOS may ask for Accessibility and Screen Recording permissions for full desktop control."

echo "Starting HeySure Agent (Mac desktop)..."
npm run dev
