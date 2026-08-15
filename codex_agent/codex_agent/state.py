from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any


class StateStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.path = directory / "state.json"
        self._lock = threading.RLock()
        self._data: dict[str, Any] = {"runs": {}, "pendingApprovals": {}, "outbox": []}
        self.directory.mkdir(parents=True, exist_ok=True)
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        if not isinstance(value, dict):
            raise ValueError(f"invalid state document: {self.path}")
        self._data.update(value)

    def _save(self) -> None:
        temporary = self.path.with_suffix(f".{os.getpid()}.tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(self._data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)

    def device_id(self, configured: str | None) -> str:
        with self._lock:
            if configured:
                value = configured
            else:
                value = self._data.get("deviceId") or f"codex-{uuid.uuid4().hex}"
            self._data["deviceId"] = value
            self._save()
            return value

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._data["runs"].get(run_id)
            return dict(value) if value else None

    def runs(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {key: dict(value) for key, value in self._data["runs"].items()}

    def update_run(self, run_id: str, **values: Any) -> dict[str, Any]:
        with self._lock:
            run = self._data["runs"].setdefault(run_id, {"sequence": 0})
            run.update(values)
            self._save()
            return dict(run)

    def next_sequence(self, run_id: str) -> int:
        with self._lock:
            run = self._data["runs"].setdefault(run_id, {"sequence": 0})
            run["sequence"] = int(run.get("sequence", 0)) + 1
            self._save()
            return run["sequence"]

    def put_approval(self, approval_id: str, value: dict[str, Any]) -> None:
        with self._lock:
            self._data["pendingApprovals"][approval_id] = value
            self._save()

    def pop_approval(self, approval_id: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._data["pendingApprovals"].pop(approval_id, None)
            self._save()
            return value

    def append_outbox(self, event: str, payload: dict[str, Any]) -> None:
        with self._lock:
            outbox = self._data.setdefault("outbox", [])
            outbox.append({"event": event, "payload": payload})
            del outbox[:-1000]
            self._save()

    def outbox(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item) for item in self._data.get("outbox", [])]

    def acknowledge_outbox(self, event_id: str) -> bool:
        with self._lock:
            outbox = self._data.get("outbox", [])
            kept = [
                item for item in outbox
                if str(item.get("payload", {}).get("eventId") or "") != event_id
            ]
            if len(kept) == len(outbox):
                return False
            self._data["outbox"] = kept
            self._save()
            return True


class InstanceLock(AbstractContextManager["InstanceLock"]):
    def __init__(self, directory: Path) -> None:
        self.path = directory / "agent.lock"
        self._owned = False
        directory.mkdir(parents=True, exist_ok=True)

    def acquire(self) -> "InstanceLock":
        self._clear_stale_owner()
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError as exc:
            raise RuntimeError(f"another codex_agent instance owns {self.path}") from exc
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            handle.write(str(os.getpid()))
        self._owned = True
        return self

    def _clear_stale_owner(self) -> None:
        if not self.path.exists():
            return
        try:
            pid = int(self.path.read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            return
        if not _pid_alive(pid):
            self.path.unlink(missing_ok=True)

    def release(self) -> None:
        if self._owned:
            self.path.unlink(missing_ok=True)
            self._owned = False

    def __enter__(self) -> "InstanceLock":
        return self.acquire()

    def __exit__(self, *_: object) -> None:
        self.release()


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True
    return True


def _windows_pid_alive(pid: int) -> bool:
    import ctypes

    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return False
    try:
        exit_code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return True
        return exit_code.value == still_active
    finally:
        kernel32.CloseHandle(handle)
