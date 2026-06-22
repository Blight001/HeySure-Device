#!/usr/bin/env bash
# One-click packaging for the HeySure Agent Mac desktop app.
set -euo pipefail

cd "$(dirname "$0")/mac"

if ! command -v npm >/dev/null 2>&1; then
  echo "[error] npm was not found. Please install Node.js first."
  exit 1
fi

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

if [ ! -d node_modules ]; then
  echo "[setup] Installing dependencies..."
  npm install
fi

echo "[build] Compiling application..."
npm run build

echo "[package] Creating Mac package..."
npm run package

if [ ! -d release ]; then
  echo "[error] release/ was not generated."
  exit 1
fi

echo
echo "[done] Mac package is ready:"
pwd
echo "release/"
