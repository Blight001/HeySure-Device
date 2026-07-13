"""配置契约（device/read.md 0.3）。

凭据与地址一律走环境变量，不得硬编码。支持从工作目录下的 .env 读取
（部署时通常由 systemd 的 EnvironmentFile 提供，见 systemd/heysure-linux-agent.service）。
"""

from __future__ import annotations

import logging
import os
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

logger = logging.getLogger("heysure.config")


def _load_dotenv() -> None:
    """尽力加载 .env（存在才加载；已在真实环境里的变量优先，不覆盖）。

    优先用 python-dotenv；没装则用极简解析器，保证零依赖也能跑。
    """
    env_path = Path(os.getenv("HEYSURE_ENV_FILE", ".env"))
    if not env_path.is_file():
        return
    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv(dotenv_path=env_path, override=False)
        return
    except Exception:
        pass
    for raw in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on", "y")


def _default_service_id() -> str:
    """稳定唯一的逻辑 ID：优先 machine-id（跨重装才变），回退 hostname。

    绑定 / 权限 / 任务队列都按这个 ID 落库，重启/重连必须不变（read.md 4）。
    """
    host = socket.gethostname() or "server"
    try:
        machine_id = Path("/etc/machine-id").read_text(encoding="utf-8").strip()
        if machine_id:
            return f"linux-{host}-{machine_id[:8]}"
    except Exception:
        pass
    return f"linux-{host}"


@dataclass
class Config:
    server: str
    account: str
    password: str
    service_id: str
    service_name: str
    icon: str = ""
    # 命令行远程（rt:*）：真人在控制台驱动本机交互式 shell。
    enable_remote_terminal: bool = True
    # 万能 shell.exec 工具：默认开启（用户要求「管控」本机），可关成只读画像。
    enable_shell_exec: bool = True
    # 持久化交互式控制台工具（console.*）：让 AI 应付安装程序的确认/选择等交互式提示。
    enable_console: bool = True
    # PTY / shell.exec 的默认 shell。
    default_shell: str = ""
    log_level: str = "INFO"
    hostname: str = field(default_factory=lambda: socket.gethostname() or "server")

    @classmethod
    def load(cls) -> "Config":
        _load_dotenv()
        account = os.getenv("HEYSURE_ACCOUNT", "").strip()
        password = os.getenv("HEYSURE_PASSWORD", "")
        missing = [
            name
            for name, value in (("HEYSURE_ACCOUNT", account), ("HEYSURE_PASSWORD", password))
            if not value
        ]
        if missing:
            raise SystemExit(
                "缺少必填环境变量：" + ", ".join(missing) +
                "。请参照 .env.example 配置账号密码（与网页控制台同一账号）。"
            )
        host = socket.gethostname() or "server"
        return cls(
            server=os.getenv("HEYSURE_SERVER", "http://127.0.0.1:3000").rstrip("/"),
            account=account,
            password=password,
            service_id=os.getenv("HEYSURE_SERVICE_ID", "").strip() or _default_service_id(),
            service_name=os.getenv("HEYSURE_SERVICE_NAME", "").strip() or f"Linux 服务器 ({host})",
            icon=os.getenv("HEYSURE_ICON", "").strip(),
            enable_remote_terminal=_bool("HEYSURE_ENABLE_REMOTE_TERMINAL", True),
            enable_shell_exec=_bool("HEYSURE_ENABLE_SHELL_EXEC", True),
            enable_console=_bool("HEYSURE_ENABLE_CONSOLE", True),
            default_shell=os.getenv("HEYSURE_SHELL", "").strip(),
            log_level=os.getenv("LOG_LEVEL", "INFO").strip().upper(),
            hostname=host,
        )

    def capabilities_extra(self) -> List[str]:
        """MCP 工具之外要额外声明的传输层能力字（read.md 5.1 / 9）。"""
        caps: List[str] = []
        if self.enable_remote_terminal:
            caps.append("remote_terminal")
        return caps
