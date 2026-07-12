"""受控的子进程执行底座：所有运维工具共用一个 run()。

统一超时、输出截断、错误规整，避免每个工具各写一份 subprocess 样板。
"""

from __future__ import annotations

import shutil
import subprocess
from typing import Dict, List, Optional, Sequence, Union

# 单个工具结果里回传的输出上限，防止 20MB 单帧上限被日志类命令撑爆（read.md 3.2）。
MAX_OUTPUT_CHARS = 60_000


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    head = text[:limit]
    return head + f"\n…[输出已截断，共 {len(text)} 字符，仅显示前 {limit}]"


def run(
    cmd: Union[str, Sequence[str]],
    *,
    timeout: float = 15.0,
    shell: bool = False,
    cwd: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    input_text: Optional[str] = None,
) -> Dict[str, object]:
    """执行一条命令，返回结构化结果。

    返回 {ok, code, stdout, stderr, timed_out}。永不抛异常（除非参数本身非法），
    让上层工具统一处理成 task:result / task:error。
    """
    try:
        proc = subprocess.run(
            cmd,
            shell=shell,
            cwd=cwd,
            env=env,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": _truncate(proc.stdout or ""),
            "stderr": _truncate(proc.stderr or ""),
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "code": None,
            "stdout": _truncate(exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")),
            "stderr": f"命令超时（>{timeout}s）",
            "timed_out": True,
        }
    except FileNotFoundError as exc:
        return {"ok": False, "code": 127, "stdout": "", "stderr": f"命令不存在: {exc}", "timed_out": False}


def has(binary: str) -> bool:
    """探测某个可执行文件是否存在（用于 CentOS/Ubuntu 命令差异分叉）。"""
    return shutil.which(binary) is not None


def first_available(*binaries: str) -> Optional[str]:
    for name in binaries:
        if has(name):
            return name
    return None
