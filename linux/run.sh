#!/usr/bin/env bash
# HeySure Linux Agent 服务管理菜单。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="heysure-linux-agent"

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "[错误] 此操作需要 root 权限，且当前系统未安装 sudo。" >&2
    return 1
  fi
}

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "[错误] 未找到 systemctl，当前系统可能未使用 systemd。" >&2
    return 1
  fi
}

service_installed() {
  systemctl cat "$SERVICE_NAME" >/dev/null 2>&1
}

pause_menu() {
  echo
  read -r -p "按 Enter 键返回主菜单..." _ || true
}

start_service() {
  require_systemd || return

  if ! service_installed; then
    echo "[提示] 服务尚未安装。"
    read -r -p "是否立即安装并启动服务？[Y/n] " answer
    case "${answer:-Y}" in
      y|Y)
        run_as_root bash "$SCRIPT_DIR/install.sh"
        ;;
      *)
        echo "[取消] 未安装服务。"
        ;;
    esac
    return
  fi

  if run_as_root systemctl start "$SERVICE_NAME"; then
    echo "[完成] 服务已启动。"
  else
    echo "[失败] 服务启动失败，请选择“服务状态”查看详情。" >&2
  fi
}

stop_service() {
  require_systemd || return
  if ! service_installed; then
    echo "[提示] 服务尚未安装。"
    return
  fi

  if run_as_root systemctl stop "$SERVICE_NAME"; then
    echo "[完成] 服务已停止。"
  else
    echo "[失败] 服务停止失败。" >&2
  fi
}

restart_service() {
  require_systemd || return
  if ! service_installed; then
    echo "[提示] 服务尚未安装，请先选择“启动服务”完成安装。"
    return
  fi

  if run_as_root systemctl restart "$SERVICE_NAME"; then
    echo "[完成] 服务已重启。"
  else
    echo "[失败] 服务重启失败，请选择“服务状态”查看详情。" >&2
  fi
}

show_service_status() {
  require_systemd || return
  if ! service_installed; then
    echo "[提示] 服务尚未安装。"
    return
  fi

  systemctl status "$SERVICE_NAME" --no-pager --full || true
}

manage_autostart() {
  require_systemd || return
  if ! service_installed; then
    echo "[提示] 服务尚未安装，请先选择“启动服务”完成安装。"
    return
  fi

  echo
  echo "1. 启用开机自启"
  echo "2. 关闭开机自启"
  echo "3. 查看开机自启状态"
  echo "0. 返回"
  read -r -p "请选择：" choice

  case "$choice" in
    1)
      if run_as_root systemctl enable "$SERVICE_NAME"; then
        echo "[完成] 已启用开机自启。"
      fi
      ;;
    2)
      if run_as_root systemctl disable "$SERVICE_NAME"; then
        echo "[完成] 已关闭开机自启（当前服务不会被停止）。"
      fi
      ;;
    3)
      if systemctl is-enabled "$SERVICE_NAME"; then
        echo "[状态] 已启用开机自启。"
      else
        echo "[状态] 未启用开机自启。"
      fi
      ;;
    0) ;;
    *) echo "[提示] 无效选项。" ;;
  esac
}

open_port() {
  local port protocol

  echo "[提示] HeySure Linux Agent 主动连接服务器，本身通常不需要开放入站端口。"
  read -r -p "请输入要开放的端口（1-65535）：" port
  if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "[错误] 端口必须是 1-65535 之间的整数。" >&2
    return
  fi

  read -r -p "请输入协议 [tcp/udp]（默认 tcp）：" protocol
  protocol="${protocol:-tcp}"
  case "$protocol" in
    tcp|TCP) protocol="tcp" ;;
    udp|UDP) protocol="udp" ;;
    *)
      echo "[错误] 协议只能是 tcp 或 udp。" >&2
      return
      ;;
  esac

  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    if run_as_root firewall-cmd --permanent --add-port="${port}/${protocol}" \
      && run_as_root firewall-cmd --reload; then
      echo "[完成] firewalld 已开放 ${port}/${protocol}。"
    else
      echo "[失败] firewalld 端口开放失败。" >&2
    fi
  elif command -v ufw >/dev/null 2>&1; then
    if run_as_root ufw allow "${port}/${protocol}"; then
      echo "[完成] UFW 已添加 ${port}/${protocol} 放行规则。"
      if ufw status 2>/dev/null | grep -qi '^Status: inactive'; then
        echo "[提示] UFW 当前未启用，规则将在 UFW 启用后生效。"
      fi
    else
      echo "[失败] UFW 端口开放失败。" >&2
    fi
  else
    echo "[错误] 未检测到运行中的 firewalld 或 UFW，请手动配置系统防火墙。" >&2
  fi
}

show_menu() {
  echo
  echo "================================"
  echo " HeySure Linux Agent 服务管理"
  echo "================================"
  echo "1. 启动服务"
  echo "2. 停止服务"
  echo "3. 重启服务"
  echo "4. 服务状态"
  echo "5. 开机自启"
  echo "6. 端口开放"
  echo "7. 退出"
}

while true; do
  show_menu
  if ! read -r -p "请选择 [1-7]：" choice; then
    echo
    exit 0
  fi

  echo
  case "$choice" in
    1) start_service; pause_menu ;;
    2) stop_service; pause_menu ;;
    3) restart_service; pause_menu ;;
    4) show_service_status; pause_menu ;;
    5) manage_autostart; pause_menu ;;
    6) open_port; pause_menu ;;
    7) echo "已退出。"; exit 0 ;;
    *) echo "[提示] 无效选项，请输入 1-7。"; pause_menu ;;
  esac
done
