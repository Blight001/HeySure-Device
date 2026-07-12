"""网络画像（只读）：network.info。"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from ..shellrun import first_available, run
from .base import Tool, obj_schema

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover
    psutil = None  # type: ignore


def _interfaces() -> List[Dict[str, Any]]:
    if psutil is None:
        return []
    out: List[Dict[str, Any]] = []
    stats = psutil.net_if_stats()
    for name, addrs in psutil.net_if_addrs().items():
        ipv4 = [a.address for a in addrs if a.address and a.address.count(".") == 3]
        st = stats.get(name)
        out.append({
            "name": name,
            "ipv4": ipv4,
            "up": bool(st.isup) if st else None,
            "speed_mbps": st.speed if st else None,
        })
    return out


def _listening_ports() -> List[Dict[str, Any]]:
    """优先用 ss，回退 netstat；都没有就用 psutil。跳过表头，兼容 CentOS7/Ubuntu。"""
    tool = first_available("ss", "netstat")
    ports: List[Dict[str, Any]] = []
    if tool == "ss":
        # 不用 -H（老版 ss 无此选项），自行跳过表头行（以 Netid/State 开头）。
        res = run(["ss", "-tuln"], timeout=10)
        for line in str(res.get("stdout") or "").splitlines():
            cols = line.split()
            if len(cols) >= 5 and cols[0].lower() not in ("netid", "state"):
                ports.append({"proto": cols[0], "local": cols[4]})
    elif tool == "netstat":
        res = run(["netstat", "-tuln"], timeout=10)
        for line in str(res.get("stdout") or "").splitlines():
            if "LISTEN" in line or line.strip().lower().startswith("udp"):
                cols = line.split()
                if len(cols) >= 4:
                    ports.append({"proto": cols[0], "local": cols[3]})
    elif psutil is not None:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status == "LISTEN" and conn.laddr:
                ports.append({"proto": "tcp", "local": f"{conn.laddr.ip}:{conn.laddr.port}"})
    return ports[:200]


def network_info(_: Dict[str, Any]) -> Tuple[Any, str]:
    interfaces = _interfaces()
    listening = _listening_ports()
    result = {"interfaces": interfaces, "listening": listening}
    ips = [ip for iface in interfaces for ip in iface.get("ipv4", []) if not ip.startswith("127.")]
    return result, f"{len(interfaces)} 个网卡，{len(listening)} 个监听端口｜IP: {', '.join(ips[:4]) or '无'}"


TOOLS: List[Tool] = [
    Tool(
        name="network.info",
        description="查看网络画像：各网卡 IPv4 地址与状态、正在监听的端口（ss/netstat）。只读。",
        input_schema=obj_schema({}),
        handler=network_info,
    ),
]
