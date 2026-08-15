from __future__ import annotations

import os
import json
import shlex
import socket
from dataclasses import dataclass
from pathlib import Path


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
    device_name: str = "Codex Project Maintainer"
    device_id: str | None = None
    log_level: str = "INFO"

    @classmethod
    def from_env(cls) -> "Config":
        workspace = Path(os.getenv("HEYSURE_CODEX_WORKSPACE", os.getcwd())).resolve()
        state_dir = Path(
            os.getenv("HEYSURE_CODEX_STATE_DIR", workspace / ".heysure-codex-agent")
        ).resolve()
        return cls(
            server=os.getenv("HEYSURE_SERVER", "http://127.0.0.1:3000").rstrip("/"),
            account=os.getenv("HEYSURE_ACCOUNT", ""),
            password=os.getenv("HEYSURE_PASSWORD", ""),
            workspace=workspace,
            state_dir=state_dir,
            codex_command=_argv(os.getenv("CODEX_COMMAND", "codex")),
            worktree_root=_optional_path(os.getenv("HEYSURE_CODEX_WORKTREE_ROOT")),
            worktree_mode=os.getenv("HEYSURE_CODEX_WORKTREE_MODE", "on").lower(),
            device_name=os.getenv("HEYSURE_CODEX_DEVICE_NAME", "Codex Project Maintainer"),
            device_id=os.getenv("HEYSURE_CODEX_DEVICE_ID") or None,
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        )

    def validate(self) -> None:
        if not self.account or not self.password:
            raise ValueError("HEYSURE_ACCOUNT and HEYSURE_PASSWORD are required")
        if not self.workspace.is_dir():
            raise ValueError(f"workspace does not exist: {self.workspace}")
        if self.worktree_mode not in {"on", "off"}:
            raise ValueError("HEYSURE_CODEX_WORKTREE_MODE must be 'on' or 'off'")

    @property
    def hostname(self) -> str:
        return socket.gethostname()

    @property
    def app_server_argv(self) -> list[str]:
        return [*self.codex_command, "app-server", "--listen", "stdio://"]


def _optional_path(value: str | None) -> Path | None:
    return Path(value).resolve() if value else None
