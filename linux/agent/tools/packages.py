"""软件包查询（只读）：package.query。自动识别 dpkg(Ubuntu/Debian) 或 rpm(CentOS/RHEL)。"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

from ..shellrun import has, run
from .base import Tool, obj_schema

_NAME_RE = re.compile(r"^[A-Za-z0-9@._+\-]+$")


def _manager() -> str:
    if has("dpkg-query") or has("dpkg"):
        return "dpkg"
    if has("rpm"):
        return "rpm"
    return ""


def package_query(args: Dict[str, Any]) -> Tuple[Any, str]:
    name = str(args.get("name", "") or "").strip()
    if not name or not _NAME_RE.match(name):
        raise ValueError(f"非法的包名: {name!r}")
    mgr = _manager()
    if not mgr:
        raise RuntimeError("未找到 dpkg 或 rpm，无法查询软件包")

    if mgr == "dpkg":
        res = run(["dpkg-query", "-W", "-f=${Package}\t${Version}\t${Status}\n", name], timeout=10)
        installed = res["ok"] and "install ok installed" in str(res.get("stdout") or "")
        version = ""
        if installed:
            parts = str(res["stdout"]).split("\t")
            version = parts[1] if len(parts) > 1 else ""
    else:  # rpm
        res = run(["rpm", "-q", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n", name], timeout=10)
        installed = res["ok"] and "is not installed" not in str(res.get("stdout") or "")
        version = str(res["stdout"]).split("\t")[1].strip() if installed and "\t" in str(res["stdout"]) else ""

    result = {"manager": mgr, "package": name, "installed": installed, "version": version or None}
    return result, f"{name}: {'已安装 ' + version if installed else '未安装'}（{mgr}）"


TOOLS: List[Tool] = [
    Tool(
        name="package.query",
        description="查询软件包是否已安装及版本。自动识别 dpkg（Ubuntu/Debian）或 rpm（CentOS/RHEL）。只读。",
        input_schema=obj_schema(
            {"name": {"type": "string", "description": "软件包名，如 nginx、docker-ce、openssh-server"}},
            required=["name"],
        ),
        handler=package_query,
    ),
]
