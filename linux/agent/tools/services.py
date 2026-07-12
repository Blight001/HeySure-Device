"""systemd 服务与日志：service.status / service.control / journal.query。

service.control 是**不可逆写操作**（重启/停止服务会中断线上业务），标 destructive。
需要 root 或 sudo 权限才能真正执行 start/stop（见 README「权限」）。
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

from ..shellrun import has, run
from .base import TIMEOUT_PROP, Tool, clamp_timeout, obj_schema

# systemd 单元名白名单字符，挡掉命令注入（即便走 argv 也保持保守）。
_UNIT_RE = re.compile(r"^[A-Za-z0-9@._\-]+$")

_CONTROL_ACTIONS = {"start", "stop", "restart", "reload", "enable", "disable", "status"}


def _require_systemctl() -> None:
    if not has("systemctl"):
        raise RuntimeError("本机没有 systemctl（非 systemd 系统？）")


def _clean_unit(name: str) -> str:
    unit = str(name or "").strip()
    if not unit or not _UNIT_RE.match(unit):
        raise ValueError(f"非法的服务单元名: {name!r}")
    return unit


def service_status(args: Dict[str, Any]) -> Tuple[Any, str]:
    _require_systemctl()
    unit = _clean_unit(args.get("unit", ""))
    props = run(["systemctl", "show", unit,
                 "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStartTimestamp"],
                timeout=10)
    parsed: Dict[str, str] = {}
    for line in str(props["stdout"]).splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            parsed[key.strip()] = value.strip()
    # 附带最近若干行日志，便于判断为何异常。
    logs = run(["journalctl", "-u", unit, "-n", "20", "--no-pager", "-o", "short-iso"], timeout=10) \
        if has("journalctl") else {"stdout": ""}
    result = {
        "unit": unit,
        "load_state": parsed.get("LoadState"),
        "active_state": parsed.get("ActiveState"),
        "sub_state": parsed.get("SubState"),
        "unit_file_state": parsed.get("UnitFileState"),
        "main_pid": parsed.get("MainPID"),
        "started_at": parsed.get("ExecMainStartTimestamp") or None,
        "recent_logs": str(logs.get("stdout") or "").strip(),
    }
    active = parsed.get("ActiveState") or "unknown"
    return result, f"{unit}: {active}（{parsed.get('SubState') or '-'}）｜自启 {parsed.get('UnitFileState') or '-'}"


def service_control(args: Dict[str, Any]) -> Tuple[Any, str]:
    _require_systemctl()
    unit = _clean_unit(args.get("unit", ""))
    action = str(args.get("action", "")).strip().lower()
    if action not in _CONTROL_ACTIONS:
        raise ValueError(f"不支持的操作 {action!r}，可选: {sorted(_CONTROL_ACTIONS)}")
    timeout = clamp_timeout(args, 30)
    # 非 root 自动尝试 sudo -n（需预先配置 NOPASSWD，否则会失败并如实回报）。
    prefix: List[str] = []
    if run(["id", "-u"], timeout=5)["stdout"].strip() != "0" and has("sudo"):
        prefix = ["sudo", "-n"]
    res = run(prefix + ["systemctl", action, unit], timeout=timeout)
    result = {
        "unit": unit,
        "action": action,
        "ok": res["ok"],
        "exit_code": res["code"],
        "stderr": str(res.get("stderr") or "").strip(),
    }
    if res["ok"]:
        return result, f"已对 {unit} 执行 {action}"
    return result, f"{unit} 执行 {action} 失败：{result['stderr'] or '退出码 ' + str(res['code'])}"


def journal_query(args: Dict[str, Any]) -> Tuple[Any, str]:
    if not has("journalctl"):
        raise RuntimeError("本机没有 journalctl")
    unit = str(args.get("unit", "") or "").strip()
    if unit:
        unit = _clean_unit(unit)
    lines = max(1, min(2000, int(args.get("lines", 100) or 100)))
    cmd = ["journalctl", "-n", str(lines), "--no-pager", "-o", "short-iso"]
    if unit:
        cmd += ["-u", unit]
    # since 作为独立 argv 传入，无注入风险；仅做长度兜底，接受 "1 hour ago" / "2026-07-12" 等。
    since = str(args.get("since", "") or "").strip()
    if since:
        cmd += ["--since", since[:64]]
    priority = str(args.get("priority", "") or "").strip().lower()
    if priority in ("emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"):
        cmd += ["-p", priority]
    timeout = clamp_timeout(args, 20)
    res = run(cmd, timeout=timeout)
    text = str(res.get("stdout") or "").strip()
    scope = f"单元 {unit}" if unit else "全系统"
    return {"unit": unit or None, "lines": lines, "output": text}, \
        f"{scope}最近 {text.count(chr(10)) + 1 if text else 0} 行日志"


TOOLS: List[Tool] = [
    Tool(
        name="service.status",
        description="查询 systemd 服务状态：是否运行/开机自启、主 PID、启动时间，并附最近 20 行日志。只读。",
        input_schema=obj_schema(
            {"unit": {"type": "string", "description": "服务单元名，如 nginx、sshd、docker（.service 可省略）"}},
            required=["unit"],
        ),
        handler=service_status,
    ),
    Tool(
        name="service.control",
        description="控制 systemd 服务：start/stop/restart/reload/enable/disable。会中断或改变线上服务，属危险操作。需 root 或已配置 sudo NOPASSWD。",
        input_schema=obj_schema(
            {
                "unit": {"type": "string", "description": "服务单元名，如 nginx"},
                "action": {"type": "string", "enum": sorted(_CONTROL_ACTIONS),
                           "description": "操作：start/stop/restart/reload/enable/disable/status"},
                "timeout_seconds": TIMEOUT_PROP,
            },
            required=["unit", "action"],
        ),
        handler=service_control,
        destructive=True,
    ),
    Tool(
        name="journal.query",
        description="查询 journald 日志。可按服务单元过滤、限定条数、起始时间（如 '1 hour ago'）、最低优先级（err/warning/…）。只读。",
        input_schema=obj_schema({
            "unit": {"type": "string", "description": "服务单元名（可选，不填看全系统）"},
            "lines": {"type": "integer", "description": "返回行数（默认 100，上限 2000）", "minimum": 1, "maximum": 2000},
            "since": {"type": "string", "description": "起始时间，如 '2026-07-12' 或 '1 hour ago'（可选）"},
            "priority": {"type": "string",
                         "enum": ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"],
                         "description": "最低日志级别（可选）"},
            "timeout_seconds": TIMEOUT_PROP,
        }),
        handler=journal_query,
    ),
]
