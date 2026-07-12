"""系统画像与实时指标（只读）：system.info / system.metrics / process.list。"""

from __future__ import annotations

import os
import platform
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from ..shellrun import run
from .base import Tool, obj_schema

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover - 依赖缺失时降级
    psutil = None  # type: ignore


def _distro() -> Dict[str, str]:
    """读取 /etc/os-release，兼容 CentOS / Ubuntu 等发行版。"""
    info: Dict[str, str] = {}
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if "=" in line:
                key, _, value = line.partition("=")
                info[key.strip()] = value.strip().strip('"')
    except Exception:
        pass
    return {
        "name": info.get("PRETTY_NAME") or info.get("NAME") or platform.system(),
        "id": info.get("ID", ""),
        "version": info.get("VERSION_ID", ""),
    }


def _require_psutil() -> None:
    if psutil is None:
        raise RuntimeError("psutil 未安装，无法采集实时指标；请 pip install psutil")


def system_info(_: Dict[str, Any]) -> Tuple[Any, str]:
    distro = _distro()
    uname = platform.uname()
    boot = psutil.boot_time() if psutil else None
    uptime_s = int(time.time() - boot) if boot else None
    result: Dict[str, Any] = {
        "hostname": uname.node,
        "distro": distro,
        "kernel": uname.release,
        "arch": uname.machine,
        "python": platform.python_version(),
        "cpu_logical": os.cpu_count(),
        "boot_time": datetime.fromtimestamp(boot, timezone.utc).isoformat() if boot else None,
        "uptime_seconds": uptime_s,
    }
    if psutil:
        vm = psutil.virtual_memory()
        result["memory_total_mb"] = round(vm.total / 1024 / 1024)
        result["cpu_physical"] = psutil.cpu_count(logical=False)
        try:
            result["load_avg_1_5_15"] = [round(x, 2) for x in os.getloadavg()]
        except (OSError, AttributeError):
            pass
    days = (uptime_s or 0) // 86400
    return result, f"{distro['name']}｜内核 {uname.release}｜{uname.machine}｜已运行 {days} 天"


def system_metrics(_: Dict[str, Any]) -> Tuple[Any, str]:
    _require_psutil()
    cpu_pct = psutil.cpu_percent(interval=0.4)
    vm = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disks: List[Dict[str, Any]] = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        disks.append({
            "mount": part.mountpoint,
            "fstype": part.fstype,
            "used_gb": round(usage.used / 1024**3, 1),
            "total_gb": round(usage.total / 1024**3, 1),
            "percent": usage.percent,
        })
    result = {
        "cpu_percent": cpu_pct,
        "load_avg_1_5_15": [round(x, 2) for x in os.getloadavg()] if hasattr(os, "getloadavg") else None,
        "memory": {
            "used_mb": round(vm.used / 1024**2),
            "total_mb": round(vm.total / 1024**2),
            "percent": vm.percent,
        },
        "swap": {"used_mb": round(swap.used / 1024**2), "total_mb": round(swap.total / 1024**2), "percent": swap.percent},
        "disks": disks,
    }
    return result, f"CPU {cpu_pct}%｜内存 {vm.percent}%｜交换 {swap.percent}%"


def process_list(args: Dict[str, Any]) -> Tuple[Any, str]:
    _require_psutil()
    limit = max(1, min(100, int(args.get("limit", 15) or 15)))
    sort_by = str(args.get("sort_by", "cpu")).lower()
    name_filter = str(args.get("name", "") or "").strip().lower()
    key = "memory_percent" if sort_by in ("mem", "memory") else "cpu_percent"

    procs: List[Dict[str, Any]] = []
    for p in psutil.process_iter(["pid", "name", "username", "cpu_percent", "memory_percent", "cmdline"]):
        try:
            info = p.info
            if name_filter and name_filter not in str(info.get("name") or "").lower():
                cmd = " ".join(info.get("cmdline") or [])
                if name_filter not in cmd.lower():
                    continue
            procs.append({
                "pid": info["pid"],
                "name": info.get("name"),
                "user": info.get("username"),
                "cpu_percent": round(info.get("cpu_percent") or 0.0, 1),
                "memory_percent": round(info.get("memory_percent") or 0.0, 1),
                "cmd": " ".join(info.get("cmdline") or [])[:200],
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs.sort(key=lambda x: x.get(key, 0), reverse=True)
    top = procs[:limit]
    scope = f"匹配 “{name_filter}” 的 " if name_filter else ""
    return {"count": len(procs), "sorted_by": key, "processes": top}, \
        f"共 {len(procs)} 个{scope}进程，按 {key} 取前 {len(top)}"


TOOLS: List[Tool] = [
    Tool(
        name="system.info",
        description="查询本机静态画像：发行版（CentOS/Ubuntu 等）、内核版本、架构、CPU 核数、总内存、开机时间与运行时长。只读。",
        input_schema=obj_schema({}),
        handler=system_info,
    ),
    Tool(
        name="system.metrics",
        description="采集本机实时资源占用：CPU%、负载、内存/交换使用、各挂载点磁盘使用率。约耗时 0.5s。只读。",
        input_schema=obj_schema({}),
        handler=system_metrics,
    ),
    Tool(
        name="process.list",
        description="列出进程，默认按 CPU 排序取前 15。可按名称过滤、切换按内存排序、调整数量。只读。",
        input_schema=obj_schema({
            "limit": {"type": "integer", "description": "返回条数（默认 15，上限 100）", "minimum": 1, "maximum": 100},
            "sort_by": {"type": "string", "enum": ["cpu", "memory"], "description": "排序维度，默认 cpu"},
            "name": {"type": "string", "description": "按进程名/命令行子串过滤（可选）"},
        }),
        handler=process_list,
    ),
]
