"""磁盘与文件（只读）：disk.usage / file.read。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Tuple

from ..shellrun import run
from .base import TIMEOUT_PROP, Tool, clamp_timeout, obj_schema

# file.read 单文件读取上限，防止把大日志整个塞进结果（20MB 单帧上限）。
_FILE_READ_MAX_BYTES = 512 * 1024


def disk_usage(args: Dict[str, Any]) -> Tuple[Any, str]:
    df = run(["df", "-hPT"], timeout=10)
    filesystems: List[Dict[str, str]] = []
    lines = str(df.get("stdout") or "").splitlines()
    for line in lines[1:]:
        cols = line.split()
        if len(cols) >= 7:
            filesystems.append({
                "filesystem": cols[0], "type": cols[1], "size": cols[2],
                "used": cols[3], "avail": cols[4], "use%": cols[5], "mount": cols[6],
            })
    result: Dict[str, Any] = {"filesystems": filesystems}

    # 可选：对指定路径做 du，定位大目录。
    path = str(args.get("path", "") or "").strip()
    if path:
        target = Path(path)
        if not target.exists():
            raise FileNotFoundError(f"路径不存在: {path}")
        du = run(["du", "-sh", str(target)], timeout=clamp_timeout(args, 30))
        result["path_usage"] = {"path": str(target), "size": str(du.get("stdout") or "").split("\t")[0].strip()}

    worst = max(filesystems, key=lambda f: _pct(f.get("use%", "0%")), default=None)
    hint = f"｜最满 {worst['mount']} {worst['use%']}" if worst else ""
    return result, f"{len(filesystems)} 个文件系统{hint}"


def _pct(value: str) -> int:
    try:
        return int(str(value).rstrip("%"))
    except ValueError:
        return 0


def file_read(args: Dict[str, Any]) -> Tuple[Any, str]:
    path = str(args.get("path", "") or "").strip()
    if not path:
        raise ValueError("缺少 path")
    target = Path(path)
    if not target.is_file():
        raise FileNotFoundError(f"不是文件或不存在: {path}")
    size = target.stat().st_size
    max_bytes = min(_FILE_READ_MAX_BYTES, max(1024, int(args.get("max_bytes", _FILE_READ_MAX_BYTES) or _FILE_READ_MAX_BYTES)))
    tail = bool(args.get("tail", False))
    with target.open("rb") as fh:
        if tail and size > max_bytes:
            fh.seek(size - max_bytes)
        data = fh.read(max_bytes)
    text = data.decode("utf-8", errors="replace")
    truncated = size > max_bytes
    result = {
        "path": str(target),
        "size_bytes": size,
        "truncated": truncated,
        "from": "tail" if tail else "head",
        "content": text,
    }
    note = "（尾部）" if tail else ""
    return result, f"读取 {target}{note}，{len(data)}/{size} 字节{'（已截断）' if truncated else ''}"


TOOLS: List[Tool] = [
    Tool(
        name="disk.usage",
        description="查看各文件系统磁盘使用（df -hPT）。传 path 时额外 du 统计该目录占用。只读。",
        input_schema=obj_schema({
            "path": {"type": "string", "description": "可选，统计该目录/文件的总占用"},
            "timeout_seconds": TIMEOUT_PROP,
        }),
        handler=disk_usage,
    ),
    Tool(
        name="file.read",
        description="读取一个文本文件内容（默认取头部，最多 512KB）。tail=true 取尾部，适合看日志末尾。只读，不能写。",
        input_schema=obj_schema(
            {
                "path": {"type": "string", "description": "绝对路径，如 /etc/nginx/nginx.conf"},
                "tail": {"type": "boolean", "description": "true 从文件尾部读取（看最新日志），默认 false"},
                "max_bytes": {"type": "integer", "description": "最多读取字节数（上限 524288）", "minimum": 1024, "maximum": 524288},
            },
            required=["path"],
        ),
        handler=file_read,
    ),
]
