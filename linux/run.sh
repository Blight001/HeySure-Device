#!/usr/bin/env bash
# Launcher for the HeySure Agent Linux desktop app. Installs deps and rebuilds
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

for bin in wmctrl xdotool; do
  command -v "$bin" >/dev/null 2>&1 || echo "note: '$bin' not found — install it for full window/input support: sudo apt install $bin"
done

echo "Starting HeySure Agent (Linux desktop)..."
npm run dev
