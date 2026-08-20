from __future__ import annotations

import os
import json
import shlex
import socket
from dataclasses import dataclass
from pathlib import Path


PRODUCTION_SERVER_URL = "http://49.234.181.190:58150"
LOCAL_TEST_SERVER_URL = "http://127.0.0.1:3000"


def _is_enabled(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _device_server_defaults() -> tuple[str, str]:
    """Read the aggregate device config when this checkout is embedded in it.

    A standalone codex-agent checkout intentionally falls back to the production
    endpoint, never localhost.
    """
    config_path = Path(__file__).resolve().parents[2] / "device.config.json"
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return PRODUCTION_SERVER_URL, LOCAL_TEST_SERVER_URL
    production = str(raw.get("default_server_url") or PRODUCTION_SERVER_URL).rstrip("/")
    local = str(raw.get("local_test_server_url") or LOCAL_TEST_SERVER_URL).rstrip("/")
    return production, local


def _server_from_env() -> str:
    explicit = os.getenv("HEYSURE_SERVER", "").strip()
    if explicit:
        return explicit.rstrip("/")
    production, local = _device_server_defaults()
    return local if _is_enabled(os.getenv("HEYSURE_LOCAL_TEST")) else production


def _argv(value: str) -> tuple[str, ...]:
    if value.lstrip().startswith("["):
        decoded = json.loads(value)
        if not isinstance(decoded, list) or not all(isinstance(item, str) for item in decoded):
            raise ValueError("CODEX_COMMAND JSON form must be an array of strings")
        parts = decoded
    else:
        parts = shlex.split(value, posix=os.name != "nt")
        if os.name == "nt":
            parts = [_unquote_windows(item) for item in parts]
    if not parts:
        raise ValueError("CODEX_COMMAND cannot be empty")
    return tuple(parts)


def _unquote_windows(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


@dataclass(frozen=True)
class Config:
    server: str
    account: str
    password: str
    workspace: Path
    state_dir: Path
    codex_command: tuple[str, ...]
    worktree_root: Path | None = None
    worktree_mode: str = "on"
    device_name: str = "Codex Project Controller"
    device_id: str | None = None
    log_level: str = "INFO"
    dashboard_host: str = "127.0.0.1"
    dashboard_port: int = 8765

    @classmethod
    def from_env(cls) -> "Config":
        workspace = Path(os.getenv("HEYSURE_CODEX_WORKSPACE", os.getcwd())).resolve()
        state_dir = Path(
            os.getenv("HEYSURE_CODEX_STATE_DIR", workspace / ".heysure-codex-agent")
        ).resolve()
        return cls(
            server=_server_from_env(),
            account=os.getenv("HEYSURE_ACCOUNT", ""),
            password=os.getenv("HEYSURE_PASSWORD", ""),
            workspace=workspace,
            state_dir=state_dir,
            codex_command=_argv(os.getenv("CODEX_COMMAND", "codex")),
            worktree_root=_optional_path(os.getenv("HEYSURE_CODEX_WORKTREE_ROOT")),
            worktree_mode=os.getenv("HEYSURE_CODEX_WORKTREE_MODE", "on").lower(),
            device_name=os.getenv("HEYSURE_CODEX_DEVICE_NAME", "Codex Project Controller"),
            device_id=os.getenv("HEYSURE_CODEX_DEVICE_ID") or None,
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
            dashboard_host=os.getenv("HEYSURE_CODEX_DASHBOARD_HOST", "127.0.0.1"),
            dashboard_port=int(os.getenv("HEYSURE_CODEX_DASHBOARD_PORT", "8765")),
        )

    def validate(self) -> None:
        if not self.account or not self.password:
            raise ValueError("HEYSURE_ACCOUNT and HEYSURE_PASSWORD are required")
        if not self.workspace.is_dir():
            raise ValueError(f"workspace does not exist: {self.workspace}")
        if self.worktree_mode not in {"on", "off"}:
            raise ValueError("HEYSURE_CODEX_WORKTREE_MODE must be 'on' or 'off'")
        if self.dashboard_host not in {"127.0.0.1", "localhost"}:
            raise ValueError("HEYSURE_CODEX_DASHBOARD_HOST must stay on the local loopback")
        if self.dashboard_port != 0 and not 1024 <= self.dashboard_port <= 65535:
            raise ValueError("HEYSURE_CODEX_DASHBOARD_PORT must be 0 or between 1024 and 65535")

    @property
    def hostname(self) -> str:
        return socket.gethostname()

    @property
    def app_server_argv(self) -> list[str]:
        return [*self.codex_command, "app-server", "--listen", "stdio://"]


def _optional_path(value: str | None) -> Path | None:
    return Path(value).resolve() if value else None
