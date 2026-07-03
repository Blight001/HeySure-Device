#!/usr/bin/env bash
# One-click packaging for the HeySure Agent Linux desktop app.
set -euo pipefail

cd "$(dirname "$0")"

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

echo "[package] Creating Linux package..."
npm run package

if [ ! -d release ]; then
  echo "[error] release/ was not generated."
  exit 1
fi

echo
echo "[done] Linux package is ready:"
pwd
echo "release/"
