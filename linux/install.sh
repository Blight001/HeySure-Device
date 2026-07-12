#!/usr/bin/env bash
# 生产部署：在 CentOS / Ubuntu 服务器上把 agent 装成 systemd 服务。
#
#   sudo ./install.sh
#
# 幂等：可重复执行以更新代码/依赖。会：
#   1. 用当前目录作为 APP_DIR（就地运行，便于 git pull 更新）
#   2. 建 .venv 装依赖
#   3. 校验 .env 存在
#   4. 生成 /etc/systemd/system/heysure-linux-agent.service 并 enable + start
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="heysure-linux-agent"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
PYTHON="${PYTHON:-python3}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo ./install.sh" >&2
  exit 1
fi

echo "[install] APP_DIR=$APP_DIR"

# 1) 依赖工具
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "[install] 未找到 $PYTHON，请先安装 Python 3.8+：" >&2
  echo "          Ubuntu: apt install -y python3 python3-venv python3-pip" >&2
  echo "          CentOS: yum install -y python3 python3-pip" >&2
  exit 1
fi

# 2) venv + 依赖
if [ ! -d "$APP_DIR/.venv" ]; then
  echo "[install] 创建虚拟环境"
  "$PYTHON" -m venv "$APP_DIR/.venv"
fi
"$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# 3) .env
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "[install] 已生成 $APP_DIR/.env —— 请编辑填写 HEYSURE_SERVER / 账号 / 密码，然后重跑本脚本或 systemctl restart $SERVICE_NAME" >&2
fi

# 4) systemd 单元
echo "[install] 写入 $UNIT_PATH"
sed "s#__APP_DIR__#${APP_DIR}#g" "$APP_DIR/systemd/${SERVICE_NAME}.service" > "$UNIT_PATH"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

echo
echo "[install] 完成。常用命令："
echo "  systemctl status  $SERVICE_NAME     # 查看状态"
echo "  journalctl -u $SERVICE_NAME -f       # 跟踪日志（应看到「已注册」）"
echo "  systemctl restart $SERVICE_NAME      # 改完 .env 后重启"
echo
echo "接下来：到网页控制台作坊面板给本服务分配 AI，并在 MCP 权限里勾选工具。"
