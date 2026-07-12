"""通用 shell 执行：shell.exec（危险，默认开启，可用 HEYSURE_ENABLE_SHELL_EXEC=false 关闭）。

read.md 0.1 一般禁止「万能工具」，但用户明确要求「管控」本机服务器，且命令行远程
(rt:*) 本就提供完整 shell —— 故保留一个受控的一次性命令执行工具，供 AI 做诊断/运维。
以 agent 进程自身的权限执行；用超时 + 输出截断兜底。是否装载由 config.enable_shell_exec 决定。
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Tuple

from ..shellrun import run
from .base import TIMEOUT_PROP, Tool, clamp_timeout, obj_schema


def shell_exec(args: Dict[str, Any]) -> Tuple[Any, str]:
    command = str(args.get("command", "") or "").strip()
    if not command:
        raise ValueError("缺少 command")
    cwd = str(args.get("cwd", "") or "").strip() or None
    if cwd and not os.path.isdir(cwd):
        raise NotADirectoryError(f"cwd 不是有效目录: {cwd}")
    timeout = clamp_timeout(args, 30)
    res = run(command, shell=True, cwd=cwd, timeout=timeout)
    result = {
        "command": command,
        "cwd": cwd,
        "exit_code": res["code"],
        "timed_out": res["timed_out"],
        "stdout": res["stdout"],
        "stderr": res["stderr"],
    }
    if res["timed_out"]:
        return result, f"命令超时（>{timeout}s）：{command[:80]}"
    status = "成功" if res["ok"] else f"退出码 {res['code']}"
    return result, f"{status}：{command[:80]}"


def build_tools(enabled: bool) -> List[Tool]:
    if not enabled:
        return []
    return [
        Tool(
            name="shell.exec",
            description=(
                "在本机执行一条 shell 命令并返回 stdout/stderr/退出码。"
                "以 agent 进程权限运行，可执行任意命令（含写操作/不可逆操作），属危险工具。"
                "耗时命令请传 timeout_seconds。"
            ),
            input_schema=obj_schema(
                {
                    "command": {"type": "string", "description": "要执行的 shell 命令，如 'df -h' 或 'systemctl list-units --failed'"},
                    "cwd": {"type": "string", "description": "工作目录（可选）"},
                    "timeout_seconds": TIMEOUT_PROP,
                },
                required=["command"],
            ),
            handler=shell_exec,
            destructive=True,
        )
    ]
