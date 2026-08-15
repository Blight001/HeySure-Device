from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Callable

from .redaction import sanitize


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": time.time(),
            "level": record.levelname,
            "logger": record.name,
            "message": sanitize(record.getMessage()),
        }
        if record.exc_info:
            payload["exception"] = sanitize(self.formatException(record.exc_info))
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def configure_logging(state_dir: Path, level: str) -> Path:
    log_dir = state_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "codex-agent.jsonl"
    root = logging.getLogger()
    root.setLevel(getattr(logging, level, logging.INFO))
    if not any(getattr(handler, "baseFilename", "") == str(log_path) for handler in root.handlers):
        file_handler = RotatingFileHandler(
            log_path, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        file_handler.setFormatter(JsonFormatter())
        root.addHandler(file_handler)
    if not root.handlers or all(isinstance(item, RotatingFileHandler) for item in root.handlers):
        console = logging.StreamHandler()
        console.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(console)
    return log_path


class AgentDiagnostics:
    def __init__(self, *, device_id: str, server: str, workspace: Path) -> None:
        self._lock = threading.RLock()
        self._started_at = time.time()
        self._events: deque[dict[str, Any]] = deque(maxlen=300)
        self._state: dict[str, Any] = {
            "device_id": device_id,
            "server": server,
            "workspace": str(workspace),
            "socket_connected": False,
            "registered": False,
            "authenticated": False,
            "app_server": "stopped",
            "last_error": "",
            "last_command": None,
        }
        self._runtime_provider: Callable[[], dict[str, Any]] | None = None

    def runtime_provider(self, provider: Callable[[], dict[str, Any]]) -> None:
        self._runtime_provider = provider

    def update(self, **values: Any) -> None:
        with self._lock:
            self._state.update(sanitize(values))

    def record(self, kind: str, *, level: str = "info", **detail: Any) -> None:
        event = {
            "timestamp": time.time(),
            "kind": str(kind)[:100],
            "level": str(level)[:20],
            "detail": sanitize(detail),
        }
        with self._lock:
            self._events.append(event)
            if level in {"error", "critical"}:
                self._state["last_error"] = str(detail.get("error") or kind)[:2000]

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            state = dict(self._state)
            events = list(self._events)
        runtime = self._runtime_provider() if self._runtime_provider else {}
        return {
            **state,
            **sanitize(runtime),
            "started_at": self._started_at,
            "uptime_seconds": max(0, int(time.time() - self._started_at)),
            "events": events,
            "now": time.time(),
        }


def read_recent_json_lines(path: Path, limit: int = 200) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    lines = deque(maxlen=max(1, min(int(limit), 500)))
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            lines.append(line)
    output = []
    for line in lines:
        try:
            value = json.loads(line)
            output.append(value if isinstance(value, dict) else {"message": str(value)})
        except json.JSONDecodeError:
            output.append({"message": sanitize(line.rstrip())})
    return output
