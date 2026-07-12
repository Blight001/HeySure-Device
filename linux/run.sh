#!/usr/bin/env bash
# 开发/手动运行：建 venv、装依赖、前台跑 agent。
# 生产部署用 systemd，见 install.sh。
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
VENV_DIR="${VENV_DIR:-.venv}"

if [ ! -d "$VENV_DIR" ]; then
  echo "[run] 创建虚拟环境 $VENV_DIR"
  "$PYTHON" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

if [ ! -f .env ]; then
  echo "[run] 未发现 .env —— 请先 cp .env.example .env 并填写账号密码" >&2
  exit 1
fi

echo "[run] 启动 agent（Ctrl-C 退出）"
exec python -m agent.main
